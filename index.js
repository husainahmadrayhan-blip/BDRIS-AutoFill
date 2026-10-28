const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load .env.local and .env without an extra runtime dependency.
// Existing host environment variables always win; .env.local takes precedence
// over .env when both files define the same key.
(function loadLocalEnv(){
  for (const fileName of ['.env.local', '.env']) {
    const envPath = path.join(__dirname, fileName);
    try {
      if (!fs.existsSync(envPath)) continue;
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
        let value = m[2];
        if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        process.env[m[1]] = value;
      }
    } catch (err) { console.warn(`[Environment] Could not read ${fileName}:`, err.message); }
  }
})();

const { launchPuppeteerBrowser } = require('./puppeteer-runtime');
const crypto = require('crypto');
const zlib = require('zlib');
const cors = require('cors');
const { Pool } = require('pg');
const { resolvePdfImageStorage } = require('./pdf-image-storage');
const app = express();

// Restrict cross-origin browser access. Allow this deployed app's own origin,
// plus explicitly configured front-end origins. Never use wildcard CORS with credentials.
const allowedOrigins = new Set(
  [
    ...String(process.env.ALLOWED_ORIGINS || '').split(','),
    process.env.RENDER_EXTERNAL_URL || '',
    process.env.APP_URL || '',
    process.env.FRONTEND_URL || ''
  ]
    .map(v => String(v).trim())
    .filter(Boolean)
    .map(v => { try { return new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v).origin; } catch (_) { return ''; } })
    .filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin (health checks, CLI, same-process tools) do not
    // need CORS headers. Reject unknown browser origins without throwing noisy
    // middleware errors into Render logs.
    if (!origin) return callback(null, false);
    let normalized = '';
    try { normalized = new URL(origin).origin; } catch (_) {}
    if (normalized && allowedOrigins.has(normalized)) return callback(null, normalized);
    return callback(null, false);
  },
  credentials: true
}));
app.use((req,res,next)=>{
  if(req.path==='/' || req.path.endsWith('.html') || req.path.startsWith('/api/')){
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Expires','0');
  }
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
// Explicit font route for Render/deployment environments where nested static
// assets may not be resolved consistently.
app.get('/fonts/:file', (req, res) => {
  const file = path.basename(req.params.file || '');
  const allowed = new Set([
    'NotoSerifBengali-Regular-subset.woff2',
    'NotoSerifBengali-Regular.ttf',
    'NotoSerifBengali-Medium.ttf',
    'NotoSerifBengali-SemiBold.ttf',
    'NotoSerifBengali-Bold.ttf',
    'NotoSansBengali-Regular.ttf',
    'NotoSerifBengali-Condensed.ttf',
    'FreeSerif.ttf',
    'FreeSerifBold.ttf',
    'SolaimanLipi-Thin.ttf',
    'SolaimanLipi-Normal.ttf'
  ]);
  if (!allowed.has(file)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'fonts', file));
});

const sessions = new Map();
// One submit per verification session. Other sessions keep independent pages.
const activeSubmissions = new Set();
async function disposeMakeSession(sessionId, expectedSession) {
    const current = sessions.get(sessionId);
    if (current !== expectedSession) return;
    sessions.delete(sessionId);
    try { if (current.page && !current.page.isClosed()) await current.page.close(); } catch (_) {}
    // NEVER close the shared browser here: other /make requests use it.
}

const LOCAL_DIRECT_MODE = String(process.env.LOCAL_DIRECT_MODE || 'false').toLowerCase() === 'true';

// V200: restored from V5.5 Separate Original Server. eVerify sometimes exposes
// complete parent/name values in allFields before the top-level summary parser.
function cleanEverifyText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u00ad\u061c\u070f\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function hydrateFromAllFields(data) {
  if (!data || !Array.isArray(data.allFields)) return data;
  const rows=data.allFields;
  const norm=v=>String(v??'').toLowerCase().replace(/\s+/g,' ').trim();
  const find=(bn,en)=>rows.find(r=>norm(r?.label)===norm(bn)||norm(r?.englishLabel)===norm(en))||null;
  const pairs=[
    ['nameBn','নিবন্ধিত ব্যক্তির নাম','Registered Person Name'],
    ['fatherBn','পিতার নাম',"Father's Name"],
    ['motherBn','মাতার নাম',"Mother's Name"],
    ['pobBn','জন্মস্থান','Place of Birth'],
    ['fatherNationalityBn','পিতার জাতীয়তা',"Father's Nationality"],
    ['motherNationalityBn','মাতার জাতীয়তা',"Mother's Nationality"]
  ];
  for (const [key,bn,en] of pairs) {
    const r=find(bn,en);
    if (r && ['nameBn','fatherBn','motherBn'].includes(key)) {
      for (const [nameKey,raw] of [[key,r.value],[key.slice(0,-2)+'En',r.englishValue]]) {
        if (raw != null) data[nameKey]=cleanPersonNameValue(raw);
      }
      continue;
    }
    if (r && !String(data[key]||'').trim()) data[key]=cleanEverifyText(r.value||r.englishValue||'');
    const enKey=key.endsWith('Bn')?key.slice(0,-2)+'En':null;
    if (r && enKey && !String(data[enKey]||'').trim()) data[enKey]=cleanEverifyText(r.englishValue||r.value||'');
  }
  for (const key of ['nameBn','nameEn','fatherBn','fatherEn','motherBn','motherEn']) data[key]=cleanPersonNameValue(data[key]);
  const field=(...labels)=>rows.find(r=>labels.some(x=>norm(r?.label)===norm(x)||norm(r?.englishLabel)===norm(x)))||null;
  for (const item of [
    ['dob','জন্ম তারিখ','Date of Birth'],['sex','লিঙ্গ','Sex','Gender'],
    ['brn','জন্ম নিবন্ধন নম্বর','Birth Registration Number','Registration Number'],
    ['regDate','নিবন্ধনের তারিখ','Registration Date'],['issuanceDate','ইস্যুর তারিখ','Issue Date','Issuance Date'],
    ['registrationOffice','নিবন্ধন অফিস','Registration Office']
  ]) {
    const key=item[0],r=field(...item.slice(1));
    if (r && !String(data[key]||'').trim()) data[key]=cleanEverifyText(r.value||r.englishValue||'');
  }
  return data;
}

function hasCompleteVerifiedPersonData(data) {
  return ['nameBn','nameEn','fatherBn','fatherEn','motherBn','motherEn','brn','dob']
    .every(k=>String(data?.[k]||'').trim());
}

function cleanPersonNameValue(value){
  // V256: only remove unwanted suffix marks. Preserve all interior/leading
  // punctuation, invisible marks and original spacing from verified names.
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u061c\u070f\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u034f\u115f\u1160\x60\u2019'".,\s]+$/gu, '');
}



app.use('/api', (req, res, next) => {
  if (LOCAL_DIRECT_MODE && !req.path.startsWith('/auth/admin') && !req.path.startsWith('/admin/')) {
    req.auth = {kind:'local', userId:'local', username:'local', name:'Local User', accessToken:'LOCAL', createdAt:Date.now()};
  }
  next();
});

const AUTH_DIR = path.join(__dirname, '.private');
const AUTH_FILE = path.join(AUTH_DIR, 'users.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });
function hashPassword(password){return crypto.createHash('sha256').update(String(password)).digest('hex');}
function authSecret(){return crypto.createHash('sha256').update(String(process.env.AUTH_SECRET||process.env.ADMIN_PASSWORD||'BDRIS-AUTO-FILL-AUTH-SECRET')).digest();}
function sealUserPayload(user){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',authSecret(),iv);const plain=Buffer.from(JSON.stringify({id:user.id,username:user.username,name:user.name||'',passwordHash:user.passwordHash,accessToken:user.accessToken,enabled:user.enabled!==false,createdAt:user.createdAt||Date.now(),balance:Number(user.balance)||0}),'utf8');const enc=Buffer.concat([cipher.update(plain),cipher.final()]);const tag=cipher.getAuthTag();return Buffer.concat([iv,tag,enc]).toString('base64url');}
function openUserPayload(value){try{const b=Buffer.from(String(value||''),'base64url');if(b.length<28)return null;const decipher=crypto.createDecipheriv('aes-256-gcm',authSecret(),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8'));}catch(_){return null;}}
function createUserLoginLink(user){const params=new URLSearchParams({access:user.accessToken,uid:String(user.id),auth:sealUserPayload(user)});return `/?${params.toString()}`;}
function loadAuthStore(){try{return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));}catch(_){const store={users:[],admin:{username:process.env.ADMIN_USERNAME||'admin',passwordHash:hashPassword(process.env.ADMIN_PASSWORD||'change-this-admin-password')}};fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));return store;}}
const authStore=loadAuthStore();
for(const u of (authStore.users||[])){ if(!Number.isFinite(Number(u.balance))) u.balance=0; }
const authSessions=new Map();
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/i.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: true },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;
let dbReady = false;
let dbWriteQueue = Promise.resolve();
function saveAuthStore(store){
  fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));
  if (!pool || !dbReady) return;
  // Serialize writes so simultaneous admin actions do not interleave snapshots.
  const snapshot = JSON.parse(JSON.stringify(store));
  dbWriteQueue = dbWriteQueue.then(async()=>{
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of snapshot.users || []) {
        await client.query(`INSERT INTO fil_users
          (id, username, name, password_hash, access_token, enabled, device_id, created_at, last_login_at, balance, preview_rate, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
          ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name,
          password_hash=EXCLUDED.password_hash, access_token=EXCLUDED.access_token, enabled=EXCLUDED.enabled,
          device_id=EXCLUDED.device_id, created_at=EXCLUDED.created_at, last_login_at=EXCLUDED.last_login_at,
          balance=EXCLUDED.balance, preview_rate=EXCLUDED.preview_rate, metadata=EXCLUDED.metadata`,
          [String(u.id),u.username,u.name||'',u.passwordHash,u.accessToken,u.enabled!==false,u.deviceId||'',Number(u.createdAt)||Date.now(),u.lastLoginAt==null?null:Number(u.lastLoginAt),Number(u.balance)||0,Number(u.previewRate??4),JSON.stringify(Object.fromEntries(Object.entries(u).filter(([k])=>!['id','username','name','passwordHash','accessToken','enabled','deviceId','createdAt','lastLoginAt','balance','previewRate'].includes(k))))]);
      }
      const ids = (snapshot.users || []).map(u=>String(u.id));
      if (ids.length) await client.query('DELETE FROM fil_users WHERE NOT (id = ANY($1::text[]))', [ids]);
      else await client.query('DELETE FROM fil_users');
      await client.query(`INSERT INTO fil_admin_settings (setting_key, setting_value) VALUES ('admin', $1::jsonb)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`, [JSON.stringify(snapshot.admin || {})]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(()=>{}); console.error('[Neon] Auth data save failed:', err.message); }
    finally { client.release(); }
  }).catch(err=>console.error('[Neon] Auth write queue failed:',err.message));
}
async function initializeDatabase(){
  if (!pool) { console.warn('[Database] DATABASE_URL not set; using local .private/users.json storage.'); return; }
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    await client.query(`CREATE TABLE IF NOT EXISTS fil_users (
      id text PRIMARY KEY, username text NOT NULL UNIQUE, name text NOT NULL DEFAULT '', password_hash text NOT NULL,
      access_token text NOT NULL, enabled boolean NOT NULL DEFAULT true, device_id text NOT NULL DEFAULT '',
      created_at bigint NOT NULL, last_login_at bigint, balance numeric(14,2) NOT NULL DEFAULT 0,
      preview_rate numeric(14,2) NOT NULL DEFAULT 4, metadata jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    await client.query(`CREATE TABLE IF NOT EXISTS fil_admin_settings (setting_key text PRIMARY KEY, setting_value jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    await client.query(`CREATE TABLE IF NOT EXISTS fil_balance_history (
      id bigserial PRIMARY KEY, user_id text NOT NULL, username text NOT NULL, action text NOT NULL,
      change_amount numeric(14,2) NOT NULL, balance_after numeric(14,2) NOT NULL, note text NOT NULL DEFAULT '', created_at bigint NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS fil_payments (
      id text PRIMARY KEY, user_id text NOT NULL, username text NOT NULL, amount numeric(14,2) NOT NULL,
      method text NOT NULL DEFAULT '', transaction_ref text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
      created_at bigint NOT NULL, reviewed_at bigint, reviewed_by text NOT NULL DEFAULT '')`);
    await client.query(`CREATE TABLE IF NOT EXISTS fil_income (
      id bigserial PRIMARY KEY, user_id text NOT NULL, username text NOT NULL, amount numeric(14,2) NOT NULL,
      kind text NOT NULL, note text NOT NULL DEFAULT '', created_at bigint NOT NULL)`);
    // Durable Image Library: metadata/positions and original image bytes live in Neon.
    // Existing local JSON/files are imported on first startup; no destructive migration.
    await client.query(`CREATE TABLE IF NOT EXISTS fil_pdf_images (
      image_id text PRIMARY KEY,
      name text NOT NULL,
      file_name text NOT NULL DEFAULT '',
      mime_type text NOT NULL DEFAULT '',
      image_data bytea,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_fil_pdf_images_name ON fil_pdf_images (lower(name))');
    await client.query(`CREATE TABLE IF NOT EXISTS fil_usage_charges (
      user_id text NOT NULL,
      idempotency_key text NOT NULL,
      amount numeric(14,2) NOT NULL,
      balance_after numeric(14,2) NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY(user_id,idempotency_key)
    )`);
    // Data Stor tables are additive and share AutoFill's existing Neon pool.
    await client.query(`CREATE TABLE IF NOT EXISTS birth_records (
      id bigserial PRIMARY KEY, brn varchar(17) NOT NULL UNIQUE, dob date NOT NULL,
      name_bn varchar(300) NOT NULL DEFAULT '', name_en varchar(300) NOT NULL DEFAULT '',
      gender varchar(20) NOT NULL DEFAULT ''
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS birth_records_dob_idx ON birth_records(dob)');
    await client.query('CREATE INDEX IF NOT EXISTS birth_records_name_bn_idx ON birth_records(name_bn)');
    await client.query('CREATE INDEX IF NOT EXISTS birth_records_name_en_idx ON birth_records(name_en)');
    await client.query(`CREATE TABLE IF NOT EXISTS fil_data_record_unlocks (
      id bigserial PRIMARY KEY, user_id text NOT NULL, record_id bigint NOT NULL,
      price numeric(14,2) NOT NULL DEFAULT 30, created_at bigint NOT NULL,
      CONSTRAINT fil_data_record_unlocks_user_record_unique UNIQUE(user_id,record_id)
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS fil_data_unlocks_user_created_idx ON fil_data_record_unlocks(user_id,created_at DESC)');
    const dbUsers = await client.query('SELECT * FROM fil_users ORDER BY created_at');
    if (!dbUsers.rowCount && (authStore.users||[]).length) {
      // One-time migration of existing local users to Neon on first setup.
      for (const u of authStore.users) {
        await client.query(`INSERT INTO fil_users(id,username,name,password_hash,access_token,enabled,device_id,created_at,last_login_at,balance,preview_rate,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT(id) DO NOTHING`,
          [String(u.id),u.username,u.name||'',u.passwordHash,u.accessToken,u.enabled!==false,u.deviceId||'',Number(u.createdAt)||Date.now(),u.lastLoginAt==null?null:Number(u.lastLoginAt),Number(u.balance)||0,Number(u.previewRate??4),JSON.stringify(Object.fromEntries(Object.entries(u).filter(([k])=>!['id','username','name','passwordHash','accessToken','enabled','deviceId','createdAt','lastLoginAt','balance','previewRate'].includes(k))))]);
      }
    }
    const users = await client.query('SELECT * FROM fil_users ORDER BY created_at');
    if (users.rowCount) authStore.users = users.rows.map(r=>({id:r.id,username:r.username,name:r.name,passwordHash:r.password_hash,accessToken:r.access_token,enabled:r.enabled,deviceId:r.device_id||'',createdAt:Number(r.created_at),lastLoginAt:r.last_login_at==null?null:Number(r.last_login_at),balance:Number(r.balance)||0,previewRate:Number(r.preview_rate??4),...(r.metadata||{})}));
    const admin = await client.query("SELECT setting_value FROM fil_admin_settings WHERE setting_key='admin'");
    if (admin.rowCount && admin.rows[0].setting_value?.username) authStore.admin = admin.rows[0].setting_value;
    else {
      if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'change-this-admin-password') {
        throw new Error('Set a strong ADMIN_PASSWORD in .env before first Neon startup.');
      }
      authStore.admin = {username:process.env.ADMIN_USERNAME||authStore.admin.username||'admin',passwordHash:hashPassword(process.env.ADMIN_PASSWORD)};
      await client.query("INSERT INTO fil_admin_settings(setting_key,setting_value) VALUES('admin',$1::jsonb) ON CONFLICT(setting_key) DO NOTHING",[JSON.stringify(authStore.admin)]);
    }
    dbReady = true;
    fs.writeFileSync(AUTH_FILE,JSON.stringify(authStore,null,2));
    console.log(`[Neon] Connected. Loaded ${authStore.users.length} user(s); schema ready.`);
  } finally { client.release(); }
}
async function recordBalanceChange(user, change, action, note='') {
  if (!pool || !dbReady || !user) return;
  try { await pool.query('INSERT INTO fil_balance_history(user_id,username,action,change_amount,balance_after,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[String(user.id),user.username,action,Number(change)||0,Number(user.balance)||0,String(note||''),Date.now()]); }
  catch(err){ console.error('[Neon] Balance history save failed:',err.message); }
}


// Bangladesh administrative Geo JSON fallback for Union offices.
// The BDRIS result page sometimes leaves the Upazila/District portion blank.
// In that case we resolve the Union -> Upazila -> District hierarchy from a
// cached bilingual Bangladesh geo dataset. The cache is refreshed only when
// needed, so normal Auto Fill remains fast.
const BD_GEO_URL = 'https://iqbalhasandev.github.io/bangladesh-geo-json/bangladesh-geo.json';
const BD_GEO_CACHE = path.join(__dirname, 'data', 'bangladesh-geo.json');
let bdGeoMemory = null;
let bdGeoLoading = null;
function geoNorm(value){
  return String(value ?? '').toLowerCase().normalize('NFKC').replace(/[\u200c\u200d]/g,'').replace(/[^a-z0-9\u0980-\u09ff]+/g,'');
}
function geoClean(value){ return String(value ?? '').replace(/\s+/g,' ').trim(); }
async function loadBangladeshGeo(){
  if (Array.isArray(bdGeoMemory)) return bdGeoMemory;
  if (bdGeoLoading) return bdGeoLoading;
  bdGeoLoading = (async()=>{
    try {
      if (fs.existsSync(BD_GEO_CACHE)) {
        const cached = JSON.parse(fs.readFileSync(BD_GEO_CACHE,'utf8'));
        if (Array.isArray(cached) && cached.length) {
          bdGeoMemory = cached;
          return cached;
        }
      }
    } catch (_) {}
    try {
      if (typeof fetch !== 'function') return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const r = await fetch(BD_GEO_URL, { headers:{'Accept':'application/json'}, signal:controller.signal });
        if (!r.ok) throw new Error(`Geo data HTTP ${r.status}`);
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) throw new Error('Geo data empty');
        fs.mkdirSync(path.dirname(BD_GEO_CACHE), {recursive:true});
        fs.writeFileSync(BD_GEO_CACHE, JSON.stringify(data), 'utf8');
        bdGeoMemory = data;
        return data;
      } finally { clearTimeout(timer); }
    } catch (_) {
      return [];
    }
  })().finally(()=>{bdGeoLoading=null;});
  return bdGeoLoading;
}
async function resolveUnionGeo(unionValue){
  const wanted = geoNorm(String(unionValue || '').replace(/\bunion\s+parishad\b/ig,'').replace(/\bunion\b/ig,'').replace(/ইউনিয়ন\s*পরিষদ|ইউনিয়ন\s*পরিষদ|ইউনিয়ন|ইউনিয়ন/gi,''));
  if (!wanted) return null;
  const tree = await loadBangladeshGeo();
  if (!Array.isArray(tree)) return null;
  let best = null;
  for (const div of tree) {
    for (const district of (div?.districts || [])) {
      for (const upazila of (district?.upazilas || [])) {
        for (const u of (upazila?.unions || [])) {
          const n = geoNorm(u?.name);
          const bn = geoNorm(u?.bn_name);
          if (wanted === n || wanted === bn) return {union:u, upazila, district, division:div};
          if (!best && ((n && (n.includes(wanted) || wanted.includes(n))) || (bn && (bn.includes(wanted) || wanted.includes(bn))))) {
            best = {union:u, upazila, district, division:div};
          }
        }
      }
    }
  }
  return best;
}
// V208: Recover only verified administrative fields, without guessing from the
// applicant's permanent address. This runs for union, municipality and other offices.
function restoreVerifiedUpazilaDistrict(data){
  if(!data || typeof data!=='object') return data;
  const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
  const norm=v=>clean(v).toLowerCase().replace(/[\s:ঃ,./()\-]+/g,'');
  const rows=Array.isArray(data.allFields)?data.allFields:[];
  const get=(names)=>{
    const wanted=names.map(norm);
    const row=rows.find(r=>wanted.includes(norm(r?.englishLabel))||wanted.includes(norm(r?.label)));
    return row?clean(row.englishValue||row.value):'';
  };
  const up=get(['Upazila','উপজেলা','Upazila/Thana','উপজেলা/থানা','Thana']);
  const district=get(['District','Zila','জেলা']);
  const combined=get(['Upazila/Pouroshava/City Corporation, Zila','উপজেলা/পৌরসভা/সিটি কর্পোরেশন, জেলা','Upazila/Pouroshava/Union','উপজেলা/পৌরসভা/ইউনিয়ন']);
  const original=clean(data.upazilaPouroshavaUnion);
  const parts=[];
  for(const v of [original,combined,up,district]){
    if(v && !parts.some(x=>norm(x)===norm(v) || norm(x).includes(norm(v)))) parts.push(v);
  }
  if(parts.length) data.upazilaPouroshavaUnion=parts.join(', ');
  console.log('[MAKE VERIFIED GEO] office='+JSON.stringify(data.registrationOffice||'')+' upazilaDistrict='+JSON.stringify(data.upazilaPouroshavaUnion||'')+' rows='+rows.length);
  return data;
}

function extractGeoFromVerifyAddress(addressEn, addressBn){
  const sources = [String(addressEn || '').trim(), String(addressBn || '').trim()].filter(Boolean);
  for (const raw of sources) {
    const text = raw.replace(/\r/g, '').split(/\n+/).map(v => clean(v)).filter(Boolean).join(', ');
    const parts = text.split(',').map(v => clean(v)).filter(Boolean);
    if (!parts.length) continue;
    const unionIdx = parts.findIndex(v => /\bunion(?:\s+parishad)?\b/i.test(v) || /ইউনিয়ন|ইউনিয়ন/i.test(v));
    const pourIdx = parts.findIndex(v => /\bpou(?:ro|rash)shava\b/i.test(v) || /পৌরসভা/i.test(v));
    if (unionIdx >= 0 && parts[unionIdx + 1] && parts[unionIdx + 2]) {
      return { type:'union', localOffice:clean(parts[unionIdx]), upazila:clean(parts[unionIdx + 1]), district:clean(parts[unionIdx + 2]) };
    }
    if (pourIdx >= 0 && parts[pourIdx + 1] && parts[pourIdx + 2]) {
      return { type:'pourashava', localOffice:clean(parts[pourIdx]), upazila:clean(parts[pourIdx + 1]), district:clean(parts[pourIdx + 2]) };
    }
  }
  return null;
}

function extractGeoFromRegisteredOfficeLocation(locationText){
  // This function runs in Node scope, not inside page.evaluate(); the browser-
  // only `clean()` helper is unavailable here. Use a local Node-safe cleaner.
  const localClean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const raw = localClean(locationText).replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();
  if (!raw) return null;
  const cleanLocation = raw
    .replace(/everify\.bdris\.gov\.bd\s+is\s+the\s+official.*$/i, '')
    .replace(/Back\s+to\s+Previous\s+Page.*$/i, '')
    .replace(/©\s*2026.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleanLocation.split(',').map(v => localClean(v).replace(/[.]+$/g, '').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const cityIdx = parts.findIndex(v => /city\s+corporation|সিটি\s*কর্পোরেশন/i.test(v));
  if (cityIdx >= 0) {
    const district = parts[cityIdx + 1] || parts[parts.length - 1] || '';
    return { type:'city', localOffice:parts[0] || '', cityCorporation:parts[cityIdx], upazila:'', district };
  }
  if (parts.length >= 3) {
    return { type:'local', localOffice:parts[0], upazila:parts[1], district:parts[2] };
  }
  return { type:'local', localOffice:parts[0], upazila:'', district:parts[1] };
}

async function applyUnionGeoFallback(data){
  if (!data || typeof data !== 'object') return data;
  const office = geoClean(data.registrationOffice);
  const fields = Array.isArray(data.allFields) ? data.allFields : [];
  const isUnion = /union\s*(parishad)?|ইউনিয়ন|ইউনিয়ন/i.test(office) || fields.some(r => /union|ইউনিয়ন|ইউনিয়ন/i.test(`${r?.label||''} ${r?.englishLabel||''}`));
  if (!isUnion) return data;

  let unionName = '';
  const unionRow = fields.find(r => /^(union|ইউনিয়ন|ইউনিয়ন)$/i.test(geoClean(r?.englishLabel || r?.label)) || /^(ইউনিয়ন|ইউনিয়ন)$/i.test(geoClean(r?.label)));
  if (unionRow) unionName = geoClean(unionRow.englishValue || unionRow.value);
  if (!unionName) unionName = office;
  const hit = await resolveUnionGeo(unionName);
  if (!hit) return data;

  const upEn = geoClean(hit.upazila?.name);
  const distEn = geoClean(hit.district?.name);
  const current = geoClean(data.upazilaPouroshavaUnion);
  const currentNorm = geoNorm(current);
  const pieces = [];
  if (upEn && !currentNorm.includes(geoNorm(upEn))) pieces.push(upEn);
  if (distEn && !currentNorm.includes(geoNorm(distEn))) pieces.push(distEn);
  // Only fill what is missing. Never overwrite an already populated value.
  if (!current && (upEn || distEn)) data.upazilaPouroshavaUnion = [upEn, distEn].filter(Boolean).join(' ');
  else if (pieces.length) data.upazilaPouroshavaUnion = [current, ...pieces].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  data.geoResolved = {source:'bangladesh-geo-json', union:geoClean(hit.union?.name || hit.union?.bn_name), upazila:upEn, district:distEn};
  return data;
}

app.post('/api/debug-geo', async (req, res) => {
    try {
        const d = req.body || {};
        const mark = (v) => {
            try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
        };
        console.log('\n================ GEO DEBUG =================');
        console.log('[GEO][CLIENT] source:', d.source || 'unknown');
        console.log('[EVERIFY][LOCATION] Location Of the Registered Office:', d.registerOfficeLocation || 'EMPTY');
        console.log('[EVERIFY][LOCATION] Registration Office:', d.registrationOffice || 'EMPTY');
        console.log('[GEO][CLIENT] permanentAddressEn:', d.permanentAddressEn || 'EMPTY');
        console.log('[GEO][CLIENT] permanentAddressBn:', d.permanentAddressBn || 'EMPTY');
        console.log('[GEO][CLIENT] verifyGeo:', mark(d.verifyGeo || null));
        console.log('[GEO][CLIENT] resolved.upazilaPouroshavaUnion:', d.resolvedValue || 'EMPTY');
        console.log('[GEO][CLIENT] DOM field exists:', !!d.domFieldExists);
        console.log('[GEO][CLIENT] DOM value BEFORE:', d.domBefore || 'EMPTY');
        console.log('[GEO][CLIENT] DOM value AFTER :', d.domAfter || 'EMPTY');
        console.log('[GEO][CLIENT] matching allFields:', mark(d.matchingRows || []));
        if (!d.domFieldExists) console.log('[GEO][FAIL] HTML target #in_upazilaPouroshavaUnion পাওয়া যায়নি।');
        else if (!d.resolvedValue) console.log('[GEO][FAIL] Backend response-এ upazilaPouroshavaUnion EMPTY।');
        else if (d.domAfter !== d.resolvedValue) console.log('[GEO][FAIL] Value response থেকে DOM-এ বসেনি।');
        else console.log('[GEO][OK] District/Upazila value DOM-এ successfully বসেছে।');
        console.log('=============== END GEO DEBUG ===============\n');
        res.json({ ok: true });
    } catch (err) {
        console.error('[GEO][DEBUG ERROR]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});


app.get('/api/health',(req,res)=>res.json({ok:true,service:'BDRIS AutoFill',time:Date.now(),database:pool?(dbReady?'neon-connected':'neon-connecting'):'local-json',pdfImageStorage:{writable:true,persistent:PDF_IMAGE_STORAGE_PERSISTENT}}));
app.get('/api/runtime/browser',(req,res)=>res.json({ok:true,cacheDir:process.env.PUPPETEER_CACHE_DIR,serviceDir:__dirname,node:process.version}));

// Public lightweight health-check endpoint for uptime monitoring.
// Kept outside authentication so monitoring services can reach it.
app.get('/ping',(req,res)=>res.status(200).send('Server is active'));

// Use /var/data only when Render confirms that the persistent disk is mounted
// and the directory passes a real write probe; otherwise use ephemeral storage.
const pdfImageStorage = resolvePdfImageStorage();
const PDF_IMAGE_DIR = pdfImageStorage.directory;
const PDF_IMAGE_STORAGE_PERSISTENT = pdfImageStorage.persistent;
const PDF_IMAGE_INDEX = path.join(PDF_IMAGE_DIR, 'library.json');
console.log(`[MAKE PDF IMAGE] storage initialized; persistent=${PDF_IMAGE_STORAGE_PERSISTENT}`);

// V195: import the original standalone Make image registry without replacing user uploads.
const ORIGINAL_PDF_IMAGE_DIR = path.join(__dirname, 'original-office-images');
function restoreOriginalOfficeImages(){
  const sourceIndex=path.join(ORIGINAL_PDF_IMAGE_DIR,'library.json');
  if(!fs.existsSync(sourceIndex))return;
  try{
    const original=JSON.parse(fs.readFileSync(sourceIndex,'utf8'));
    const current=fs.existsSync(PDF_IMAGE_INDEX)?JSON.parse(fs.readFileSync(PDF_IMAGE_INDEX,'utf8')):{images:[]};
    if(!Array.isArray(current.images))current.images=[];
    let changed=false;
    for(const old of (Array.isArray(original.images)?original.images:[])){
      if(!old?.name || !old?.fileName)continue;
      const src=path.join(ORIGINAL_PDF_IMAGE_DIR,path.basename(old.fileName));
      const dest=path.join(PDF_IMAGE_DIR,path.basename(old.fileName));
      if(!fs.existsSync(src))continue;
      const existing=current.images.find(x=>x.id===old.id || String(x.name||'').trim().toLowerCase()===String(old.name).trim().toLowerCase());
      // Never overwrite an existing image; repair only empty/incomplete records.
      if(existing?.fileName && fs.existsSync(path.join(PDF_IMAGE_DIR,path.basename(existing.fileName))))continue;
      if(!fs.existsSync(dest))fs.copyFileSync(src,dest);
      if(existing){existing.fileName=path.basename(old.fileName);existing.mimeType=old.mimeType||'image/png';if(!existing.position&&old.position)existing.position=old.position;}
      else current.images.push({...old,fileName:path.basename(old.fileName)});
      changed=true;
    }
    if(changed){fs.writeFileSync(PDF_IMAGE_INDEX,JSON.stringify(current,null,2));console.log('[MAKE PDF IMAGE] restored original office image records into active library');}
  }catch(err){console.warn('[MAKE PDF IMAGE] original library restore failed:',err.message);}
}
restoreOriginalOfficeImages();

function loadPDFImageLibrary(){
  try { return JSON.parse(fs.readFileSync(PDF_IMAGE_INDEX,'utf8')); }
  catch(_){ return {images:[]}; }
}
let pdfImagePersistQueue = Promise.resolve();
function savePDFImageLibrary(store){
  fs.writeFileSync(PDF_IMAGE_INDEX, JSON.stringify(store,null,2));
  // Queue snapshots so simultaneous image/position updates cannot overwrite a newer
  // Neon snapshot. The JSON/file store remains a local cache and offline fallback.
  if (!pool || !dbReady) return Promise.resolve(false);
  const snapshot = JSON.parse(JSON.stringify(store || {images:[]}));
  pdfImagePersistQueue = pdfImagePersistQueue.then(async()=>{
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const images = Array.isArray(snapshot.images) ? snapshot.images : [];
      const ids = images.map(x=>String(x.id));
      for (const image of images) {
        const fileName = path.basename(String(image.fileName || ''));
        let bytes = null;
        if (fileName) {
          const filePath = path.join(PDF_IMAGE_DIR, fileName);
          if (fs.existsSync(filePath)) bytes = fs.readFileSync(filePath);
        }
        await client.query(`INSERT INTO fil_pdf_images(image_id,name,file_name,mime_type,image_data,metadata,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
          ON CONFLICT(image_id) DO UPDATE SET name=EXCLUDED.name,file_name=EXCLUDED.file_name,
          mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,metadata=EXCLUDED.metadata,
          created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`,
          [String(image.id),String(image.name||''),fileName,String(image.mimeType||''),bytes,
           JSON.stringify(image),Number(image.createdAt)||Date.now(),Number(image.updatedAt)||Date.now()]);
      }
      if (ids.length) await client.query('DELETE FROM fil_pdf_images WHERE NOT (image_id = ANY($1::text[]))',[ids]);
      else await client.query('DELETE FROM fil_pdf_images');
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      console.error('[Neon] Image Library persistence failed:', err.message);
      throw err;
    } finally { client.release(); }
  });
  return pdfImagePersistQueue;
}
async function savePDFImageLibraryForResponse(store,res){
  try {
    if (!pool || !dbReady) throw new Error('Neon database is not ready');
    const saved = await savePDFImageLibrary(store);
    if (saved !== true) throw new Error('Image Library was not persisted to Neon');
    return true;
  } catch (_) {
    if (!res.headersSent) res.status(503).json({ok:false,error:'Neon Image Library save failed. The change was not confirmed in Neon; check DATABASE_URL/Neon connection and retry.'});
    return false;
  }
}
async function restorePDFImageLibraryFromNeon(){
  if (!pool || !dbReady) return false;
  const result = await pool.query('SELECT image_id,name,file_name,mime_type,image_data,metadata,created_at,updated_at FROM fil_pdf_images ORDER BY created_at');
  const local = loadPDFImageLibrary();
  const localImages = Array.isArray(local.images) ? local.images : [];
  if (!result.rowCount) {
    // First-time additive migration: preserve the existing library and its positions.
    await savePDFImageLibrary({images:localImages});
    console.log(`[Neon] Imported ${localImages.length} existing Image Library slot(s).`);
    return true;
  }
  const restored = [];
  for (const row of result.rows) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const image = {...metadata,id:String(row.image_id),name:String(row.name),fileName:path.basename(String(row.file_name||'')),mimeType:String(row.mime_type||''),createdAt:Number(row.created_at)||Date.now(),updatedAt:Number(row.updated_at)||Date.now()};
    if (row.image_data && image.fileName) {
      fs.mkdirSync(PDF_IMAGE_DIR,{recursive:true});
      fs.writeFileSync(path.join(PDF_IMAGE_DIR,image.fileName),row.image_data);
    }
    restored.push(image);
  }
  // Keep any locally defined office slots that are not present in Neon, without
  // replacing a database ID, saved position, image or office mapping.
  for (const image of localImages) {
    if (!restored.some(x=>String(x.id)===String(image.id) || String(x.name||'').trim().toLowerCase()===String(image.name||'').trim().toLowerCase())) restored.push(image);
  }
  fs.writeFileSync(PDF_IMAGE_INDEX,JSON.stringify({images:restored},null,2));
  if (restored.length !== result.rowCount) await savePDFImageLibrary({images:restored});
  console.log(`[Neon] Restored ${result.rowCount} Image Library record(s), including saved positions.`);
  return true;
}
// Keep one consistent naming scheme for the PDF Image library.
function safeImageName(name){ return String(name||'').trim().replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').slice(0,120); }
// Keep one consistent naming scheme for the PDF Image library.
// Older uploads may still have names such as `zon-01`, `zon-2` or
// `চট্টগ্রাম সিটি zon-03`; migrate only the name, never the image file/id.
const PDF_IMAGE_NAME_MIGRATIONS = {
  'zon-01': 'জুন-০১',
  'zon-1': 'জুন-০১',
  'zon-2': 'জুন-০২',
  'zon-02': 'জুন-০২',
  'zon-03': 'জুন-০৩',
  'zon-3': 'জুন-০৩',
  'চট্টগ্রাম সিটি zon-03': 'জুন-০৩',
  'zon-04': 'জুন-০৪',
  'zon-4': 'জুন-০৪',
  'zon-05': 'জুন-০৫',
  'zon-5': 'জুন-০৫',
  'zon-06': 'জুন-০৬',
  'zon-6': 'জুন-০৬',
  'zon-07': 'জুন-০৭',
  'zon-7': 'জুন-০৭',
  'zon-08': 'জুন-০৮',
  'zon-8': 'জুন-০৮',
  'zon-09': 'জুন-০৯',
  'zon-9': 'জুন-০৯'
};
function safeImageName(name){
  const cleaned=String(name||'').trim().replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').slice(0,120);
  return PDF_IMAGE_NAME_MIGRATIONS[cleaned] || cleaned;
}
const DEFAULT_PDF_IMAGE_NAMES = ['জুন-০১','জুন-০২','জুন-০৩','জুন-০৪','জুন-০৫','জুন-০৬','জুন-০৭','জুন-০৮','জুন-০৯','উত্তর','union'];
let pdfImageStore = loadPDFImageLibrary();
if(!Array.isArray(pdfImageStore.images)) pdfImageStore={images:[]};
let migratedPDFImageNames=false;
for(const image of pdfImageStore.images){
  const oldName=String(image?.name||'').trim();
  const newName=PDF_IMAGE_NAME_MIGRATIONS[oldName];
  if(newName && !pdfImageStore.images.some(x=>x!==image && String(x?.name||'').trim()===newName)){
    image.name=newName;
    image.updatedAt=Date.now();
    migratedPDFImageNames=true;
  }
}
if(migratedPDFImageNames) savePDFImageLibrary(pdfImageStore);
let changedDefaultImages=false;
for(const name of DEFAULT_PDF_IMAGE_NAMES){
  if(!pdfImageStore.images.some(x=>x.name===name)){
    pdfImageStore.images.push({id:crypto.randomBytes(12).toString('hex'),name,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now()});
    changedDefaultImages=true;
  }
}
if(changedDefaultImages) savePDFImageLibrary(pdfImageStore);
function pdfImageMeta(x){ return {id:x.id,name:x.name,fileName:x.fileName||'',mimeType:x.mimeType||'',hasImage:!!x.fileName,position:x.position||{x:105,y:247,z:100,w:24,h:10},permanent:!!x.permanent,createdAt:x.createdAt,updatedAt:x.updatedAt}; }
function newToken(){return crypto.randomBytes(32).toString('hex');}
function authUser(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const session=authSessions.get(token);if(!session)return null;if(Date.now()-session.createdAt>7*24*60*60*1000){authSessions.delete(token);return null;}return session;}
app.post('/api/auth/login',async(req,res)=>{
  const {username,password,accessToken,deviceId,userId,auth}=req.body||{};
  if(!username||!password||!deviceId) return res.status(400).json({ok:false,error:'Username, password এবং device তথ্য প্রয়োজন।'});
  let user=null;
  if(accessToken) user=authStore.users.find(u=>u.accessToken===accessToken);
  if(!user&&userId) user=authStore.users.find(u=>u.id===String(userId));
  if(!user&&auth){const r=openUserPayload(auth);if(r&&(!accessToken||r.accessToken===accessToken)&&(!userId||r.id===String(userId||r.id))&&r.username===username&&r.enabled!==false&&r.passwordHash===hashPassword(password)){user={...r,deviceId:'',lastLoginAt:null,balance:Number(r.balance)||0};const i=authStore.users.findIndex(u=>u.id===user.id);if(i>=0)authStore.users[i]=user;else authStore.users.push(user);saveAuthStore(authStore);}}
  if(!user) user=authStore.users.find(u=>u.username===username);
  // If the in-memory user cache is stale, resolve the account from Neon before rejecting login.
  if ((!user || user.username!==username || user.passwordHash!==hashPassword(password)) && pool && dbReady) {
    try {
      const dbUser = await pool.query('SELECT * FROM fil_users WHERE username=$1 LIMIT 1',[username]);
      if (dbUser.rowCount) {
        const row=dbUser.rows[0];
        user={id:String(row.id),username:row.username,name:row.name||'',passwordHash:row.password_hash,accessToken:row.access_token,enabled:row.enabled,deviceId:row.device_id||'',createdAt:Number(row.created_at)||Date.now(),lastLoginAt:row.last_login_at==null?null:Number(row.last_login_at),balance:Number(row.balance)||0,previewRate:Number(row.preview_rate??4)};
        const at=authStore.users.findIndex(u=>String(u.id)===String(user.id));
        if(at>=0)authStore.users[at]=user;else authStore.users.push(user);
      }
    } catch(err) { console.error('[Auth] Neon user lookup failed:',err.message); }
  }
  if(!user||!user.enabled) return res.status(403).json({ok:false,error:'এই User account সক্রিয় নেই।'});
  if(user.username!==username||user.passwordHash!==hashPassword(password)) return res.status(401).json({ok:false,error:'Username বা Password ভুল।'});
  if(user.deviceId&&user.deviceId!==deviceId) return res.status(403).json({ok:false,error:'এই User account অন্য একটি device-এর সাথে যুক্ত আছে।'});
  if(!user.deviceId) user.deviceId=deviceId;
  user.lastLoginAt=Date.now();
  if(pool&&dbReady){
    try { await pool.query('UPDATE fil_users SET device_id=$1,last_login_at=$2 WHERE id=$3',[user.deviceId,user.lastLoginAt,String(user.id)]); }
    catch(err){ console.error('[Auth] Neon login metadata update failed:',err.message); }
  }
  saveAuthStore(authStore);
  const token=newToken();
  authSessions.set(token,{kind:'user',userId:user.id,username:user.username,name:user.name||'',accessToken:user.accessToken,createdAt:Date.now()});
  res.json({ok:true,token,auth:sealUserPayload(user),balance:Number(user.balance)||0,user:{id:user.id,username:user.username,name:user.name||''}});
});
app.post('/api/auth/admin-login',async(req,res)=>{
  const {username,password}=req.body||{};
  let admin=authStore.admin;
  if(pool&&dbReady){
    try { const q=await pool.query("SELECT setting_value FROM fil_admin_settings WHERE setting_key='admin'"); if(q.rowCount&&q.rows[0].setting_value?.username)admin=q.rows[0].setting_value; }
    catch(err){ console.error('[Auth] Neon admin lookup failed:',err.message); }
  }
  if(username!==admin.username||hashPassword(password||'')!==admin.passwordHash)return res.status(401).json({ok:false,error:'Admin username বা password ভুল।'});
  authStore.admin=admin;
  const token=newToken();authSessions.set(token,{kind:'admin',username,createdAt:Date.now()});res.json({ok:true,token});
});
function requireAuth(req,res,next){
  // LOCAL DIRECT MODE: never require a user account for the main local application.
  // Admin endpoints are still protected by requireAdmin.
  if (LOCAL_DIRECT_MODE) {
    req.auth={kind:'local',userId:'local',username:'local',name:'Local User',accessToken:'LOCAL',createdAt:Date.now()};
    return next();
  }
  const session=authUser(req);
  if(!session) return res.status(401).json({ok:false,error:'Login required.'});
  req.auth=session;
  next();
}
function requireUserAuth(req,res,next){
  if (LOCAL_DIRECT_MODE) {
    req.auth={kind:'local',userId:'local',username:'local',name:'Local User',accessToken:'LOCAL',createdAt:Date.now()};
    return next();
  }
  const session=authUser(req);
  if(!session||session.kind!=='user') return res.status(401).json({ok:false,error:'Login required.'});
  req.auth=session;
  next();
}
function requireAdmin(req,res,next){const session=authUser(req);if(!session||session.kind!=='admin')return res.status(403).json({ok:false,error:'Admin access required.'});req.auth=session;next();}
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({ok:true,session:req.auth}));

const passwordChangeRate = new Map();
app.post('/api/auth/change-password', requireUserAuth, async (req,res) => {
  if (!req.auth || req.auth.kind !== 'user') return res.status(401).json({ok:false,error:'AutoFill User হিসেবে লগইন করুন।'});
  const uid = String(req.auth.userId || '');
  const user = authStore.users.find(u => String(u.id) === uid && u.enabled !== false);
  if (!user) return res.status(403).json({ok:false,error:'সক্রিয় User account পাওয়া যায়নি।'});
  const now = Date.now(), rate = passwordChangeRate.get(uid);
  if (rate && now - rate.startedAt < 10 * 60 * 1000 && rate.count >= 5) {
    return res.status(429).json({ok:false,error:'অনেকবার চেষ্টা করেছেন। ১০ মিনিট পরে আবার চেষ্টা করুন।'});
  }
  if (!rate || now - rate.startedAt >= 10 * 60 * 1000) passwordChangeRate.set(uid,{startedAt:now,count:1});
  else rate.count++;
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!currentPassword || newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ok:false,error:'বর্তমান পাসওয়ার্ড দিন এবং নতুন পাসওয়ার্ড ৮ থেকে ১২৮ অক্ষরের রাখুন।'});
  }
  if (currentPassword === newPassword) return res.status(400).json({ok:false,error:'নতুন পাসওয়ার্ডটি বর্তমান পাসওয়ার্ড থেকে আলাদা হতে হবে।'});
  try {
    let currentHash = user.passwordHash;
    if (pool) {
      if (!dbReady) return res.status(503).json({ok:false,error:'Database এখনো প্রস্তুত নয়। পরে চেষ্টা করুন।'});
      const current = await pool.query('SELECT password_hash FROM fil_users WHERE id=$1 AND enabled=true',[uid]);
      if (!current.rowCount) return res.status(403).json({ok:false,error:'সক্রিয় User account পাওয়া যায়নি।'});
      currentHash = current.rows[0].password_hash;
    }
    const currentBytes = Buffer.from(String(currentHash || ''));
    const suppliedBytes = Buffer.from(hashPassword(currentPassword));
    const matches = currentBytes.length === suppliedBytes.length && crypto.timingSafeEqual(currentBytes,suppliedBytes);
    if (!matches) return res.status(401).json({ok:false,error:'বর্তমান পাসওয়ার্ড সঠিক নয়।'});
    const passwordHash = hashPassword(newPassword);
    if (pool) {
      const updated = await pool.query('UPDATE fil_users SET password_hash=$2 WHERE id=$1 AND enabled=true RETURNING id',[uid,passwordHash]);
      if (!updated.rowCount) return res.status(403).json({ok:false,error:'সক্রিয় User account পাওয়া যায়নি।'});
    }
    user.passwordHash = passwordHash;
    if (!pool) saveAuthStore(authStore);
    const currentToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    for (const [token,session] of authSessions) {
      if (token !== currentToken && session.kind === 'user' && String(session.userId) === uid) authSessions.delete(token);
    }
    passwordChangeRate.set(uid,{startedAt:now,count:0});
    res.set('Cache-Control','no-store');
    return res.json({ok:true,message:'পাসওয়ার্ড পরিবর্তন হয়েছে। অন্য সক্রিয় সেশনগুলো বন্ধ করা হয়েছে।'});
  } catch (error) {
    console.error('[Auth] password change failed:',String(error?.message||error));
    return res.status(503).json({ok:false,error:'পাসওয়ার্ড পরিবর্তন করা যায়নি। পরে আবার চেষ্টা করুন।'});
  }
});

async function forwardAutomationRequest(req,res,method,pathSuffix,body){
  const base=String(process.env.AUTOMATION_SERVER_URL||'').replace(/\/+$/,'');
  const apiKey=process.env.AUTOMATION_API_KEY;
  if(!base||!apiKey)return res.status(503).json({ok:false,error:'Automation service is not configured.'});
  try{
    const headers={Authorization:`Bearer ${apiKey}`,'X-Job-Owner':String(req.auth.userId||'local'),'Content-Type':'application/json'};
    const idempotencyKey=req.get('Idempotency-Key');
    if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const response=await fetch(`${base}${pathSuffix}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const payload=await response.json().catch(()=>({ok:false,error:'Automation service returned an invalid response.'}));
    return res.status(response.status).json(payload);
  }catch(error){
    console.error('[Automation Gateway] request failed:',String(error?.message||error).replace(/https?:\/\/\S+/gi,'[url]'));
    return res.status(502).json({ok:false,error:'Automation service is unavailable.'});
  }
}
app.post('/api/automation/jobs',requireUserAuth,(req,res)=>forwardAutomationRequest(req,res,'POST','/api/jobs',req.body));
app.get('/api/automation/jobs/:id',requireUserAuth,(req,res)=>forwardAutomationRequest(req,res,'GET',`/api/jobs/${encodeURIComponent(req.params.id)}`));
app.post('/api/automation/jobs/:id/cancel',requireUserAuth,(req,res)=>forwardAutomationRequest(req,res,'POST',`/api/jobs/${encodeURIComponent(req.params.id)}/cancel`,{}));


const DATA_STOR_UNLOCK_PRICE=30;
function dataStorSameOrigin(req) {
 const origin=String(req.get('origin')||''),host=String(req.get('host')||''),type=String(req.get('content-type')||'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')return false;if(!origin)return true;
 try{const p=new URL(origin);return p.host===host&&(p.protocol==='https:'||p.hostname==='localhost'||p.hostname==='127.0.0.1');}catch(_){return false;}
}
function dataStorNoStore(res){res.set('Cache-Control','no-store, no-cache, must-revalidate');res.set('Pragma','no-cache');}
const dataStorRateBuckets=new Map();
function allowDataStorAction(userId,action,maxCount=60){
 const key=String(userId)+':'+action,now=Date.now();let item=dataStorRateBuckets.get(key);
 if(!item||now-item.startedAt>=60000){item={startedAt:now,count:0};dataStorRateBuckets.set(key,item);}
 item.count++;if(dataStorRateBuckets.size>5000){for(const [k,v] of dataStorRateBuckets)if(now-v.startedAt>120000)dataStorRateBuckets.delete(k);}
 return item.count<=maxCount;
}
function dataStorDob(value){
 const p=String(value||'').trim().split(/[\\/-]/).map(Number);if(p.length!==3||p.some(n=>!Number.isInteger(n)))return '';
 let y,m,d;if(p[0]>=1000)[y,m,d]=p;else[d,m,y]=p;
 if(y<1000||y>9999||m<1||m>12||d<1||d>31)return '';
 const x=new Date(Date.UTC(y,m-1,d));if(x.getUTCFullYear()!==y||x.getUTCMonth()!==m-1||x.getUTCDate()!==d)return '';
 return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function dataStorBrn(value){const s=String(value||'').trim().replace(/\s+/g,'');return /^\d{17}$/.test(s)?s:'';}
function dataStorMask(value){return '•••••••••••••'+String(value||'').slice(-4);}
function dataStorUser(req,res){
 if(!req.auth||req.auth.kind!=='user'){res.status(401).json({ok:false,error:'AutoFill-এ লগইন করুন।'});return null;}
 const user=authStore.users.find(u=>String(u.id)===String(req.auth.userId)&&u.enabled!==false);
 if(!user){res.status(403).json({ok:false,error:'এই AutoFill অ্যাকাউন্ট সক্রিয় নেই।'});return null;}return user;
}
function parseDataStorCsv(text){
 const input=String(text||'').replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<input.length;i++){const ch=input[i];if(ch==='"'){if(quoted&&input[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
 else if(ch===','&&!quoted){row.push(field);field='';}
 else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&input[i+1]==='\n')i++;row.push(field);field='';if(row.some(v=>String(v).trim()))rows.push(row);row=[];}
 else field+=ch;}
 row.push(field);if(row.some(v=>String(v).trim()))rows.push(row);if(rows.length<2)throw new Error('CSV header ও data row প্রয়োজন।');
 const headers=rows.shift().map(v=>String(v||'').trim().toLowerCase().replace(/\s+/g,' '));
 const get=(r,names)=>{for(const n of names){const i=headers.indexOf(n.toLowerCase());if(i>=0)return String(r[i]??'').trim();}return '';};
 const valid=[],seen=new Set(),summary={imported:0,updated:0,skipped:0,invalidBrn:0,invalidDate:0,duplicates:0};
 for(const r of rows){const brn=dataStorBrn(get(r,['brn','birth registration number','birth_registration_number']));if(!brn){summary.invalidBrn++;summary.skipped++;continue;}
 if(seen.has(brn)){summary.duplicates++;continue;}const dob=dataStorDob(get(r,['dob','date of birth','জন্ম তারিখ']));if(!dob){summary.invalidDate++;summary.skipped++;continue;}seen.add(brn);
 const rawGender=get(r,['gender','লিঙ্গ']).toLowerCase();const gender=['m','male','পুরুষ'].includes(rawGender)?'male':(['f','female','নারী','মহিলা'].includes(rawGender)?'female':(['o','other','অন্যান্য'].includes(rawGender)?'other':rawGender));
 valid.push({brn,dob,bn:get(r,['বাংলা নাম','name_bn','namebn','bangla name']),en:get(r,['english name','name_en','nameen','name']),gender});}
 return {rows:valid,summary};
}
app.get('/api/data-stor/stats',requireUserAuth,async(req,res)=>{
 const user=dataStorUser(req,res);if(!user)return;if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});
 try{const q=await pool.query("SELECT count(*)::int total FROM birth_records");const b=await pool.query('SELECT balance FROM fil_users WHERE id=$1 AND enabled=true',[String(user.id)]);if(!b.rowCount)return res.status(401).json({ok:false,error:'AutoFill account পাওয়া যায়নি।'});dataStorNoStore(res);res.json({ok:true,total:Number(q.rows[0]?.total)||0,balance:Number(b.rows[0].balance)||0});}
 catch(e){console.error('[Data Stor] stats failed:',e.message);res.status(503).json({ok:false,error:'Data Stor statistics লোড করা যায়নি।'});}
});
app.get('/api/data-stor/search',requireUserAuth,async(req,res)=>{
 const user=dataStorUser(req,res);if(!user)return;if(!allowDataStorAction(user.id,'search',60))return res.status(429).json({ok:false,error:'অনেক বেশি search করা হয়েছে। এক মিনিট পরে চেষ্টা করুন।'});if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});
 const dobInput=String(req.query.dob||'').trim(),bn=String(req.query.bn||'').trim(),en=String(req.query.en||'').trim(),gender=String(req.query.gender||'all').toLowerCase();
 if(!dobInput&&!bn&&!en)return res.status(400).json({ok:false,error:'জন্মতারিখ অথবা নাম লিখুন।'});
 const where=[],vals=[];if(dobInput){const d=dataStorDob(dobInput);if(!d)return res.status(400).json({ok:false,error:'জন্মতারিখ সঠিক ফরম্যাটে দিন।'});vals.push(d);where.push('dob=$'+vals.length+'::date');}
 if(bn||en){const nameParts=[];if(bn){vals.push('%'+bn+'%');nameParts.push('name_bn ILIKE $'+vals.length);}if(en){vals.push('%'+en+'%');nameParts.push('name_en ILIKE $'+vals.length);}where.push('('+nameParts.join(' OR ')+')');}
 if(['male','female','other'].includes(gender)){if(gender==='other')where.push("lower(gender) NOT IN ('male','female')");else{vals.push(gender);where.push('lower(gender)=$'+vals.length);}}
 const clause=where.length?' WHERE '+where.join(' AND '):'',page=Math.max(1,parseInt(req.query.page||'1',10)||1),limit=Math.max(10,Math.min(100,parseInt(req.query.limit||'30',10)||30));
 try{const count=await pool.query('SELECT count(*)::int total FROM birth_records'+clause,vals);
 const q=await pool.query('SELECT id,brn,dob::text dob,name_bn bn,name_en en,gender FROM birth_records'+clause+' ORDER BY id LIMIT $'+(vals.length+1)+' OFFSET $'+(vals.length+2),[...vals,limit,(page-1)*limit]);
 const ids=q.rows.map(r=>String(r.id)),unlocked=ids.length?await pool.query('SELECT record_id FROM fil_data_record_unlocks WHERE user_id=$1 AND record_id=ANY($2::bigint[])',[String(user.id),ids]):{rows:[]},set=new Set(unlocked.rows.map(r=>String(r.record_id)));
 const b=await pool.query('SELECT balance FROM fil_users WHERE id=$1 AND enabled=true',[String(user.id)]);
 if(!b.rowCount)return res.status(401).json({ok:false,error:'AutoFill account পাওয়া যায়নি।'});
 dataStorNoStore(res);res.json({ok:true,total:Number(count.rows[0]?.total)||0,page,limit,pages:Math.ceil((Number(count.rows[0]?.total)||0)/limit),balance:Number(b.rows[0].balance)||0,results:q.rows.map(r=>{const isUnlocked=set.has(String(r.id));const item={id:Number(r.id),maskedBrn:dataStorMask(r.brn),unlocked:isUnlocked,price:DATA_STOR_UNLOCK_PRICE,dob:r.dob,bn:r.bn,en:r.en,gender:r.gender};if(isUnlocked)item.brn=r.brn;return item;})});}
 catch(e){console.error('[Data Stor] search failed:',e.message);res.status(503).json({ok:false,error:'Search ব্যর্থ হয়েছে।'});}
});
app.get('/api/data-stor/records/:id',requireUserAuth,async(req,res)=>{
 const user=dataStorUser(req,res);if(!user)return;const id=String(req.params.id||'');if(!/^[1-9]\d{0,14}$/.test(id))return res.status(400).json({ok:false,error:'Record ID সঠিক নয়।'});
 if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});
 try{const q=await pool.query('SELECT b.id,b.brn,b.dob::text dob,b.name_bn bn,b.name_en en,b.gender FROM birth_records b JOIN fil_data_record_unlocks u ON u.record_id=b.id WHERE u.user_id=$1 AND b.id=$2',[String(user.id),id]);
 if(!q.rowCount)return res.status(403).json({ok:false,error:'এই রেকর্ডটি আনলক করা নেই।'});dataStorNoStore(res);res.json({ok:true,record:q.rows[0]});}
 catch(e){console.error('[Data Stor] record read failed:',e.message);res.status(503).json({ok:false,error:'Record load ব্যর্থ হয়েছে।'});}
});
app.post('/api/data-stor/records/:id/unlock',requireUserAuth,async(req,res)=>{
 const user=dataStorUser(req,res);if(!user)return;
 if(!dataStorSameOrigin(req))return res.status(403).json({ok:false,error:'অবৈধ অনুরোধ।'});
 const id=String(req.params.id||'');if(!/^[1-9]\d{0,14}$/.test(id)||!Number.isSafeInteger(Number(id)))return res.status(400).json({ok:false,error:'Record ID সঠিক নয়।'});
 if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});
 if(!allowDataStorAction(user.id,'unlock',20))return res.status(429).json({ok:false,error:'অনেক বেশি unlock request হয়েছে। এক মিনিট পরে চেষ্টা করুন।'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const bal=await client.query('SELECT balance,enabled,username FROM fil_users WHERE id=$1 FOR UPDATE',[String(user.id)]);
  if(!bal.rowCount||bal.rows[0].enabled!==true){await client.query('ROLLBACK');return res.status(401).json({ok:false,error:'AutoFill account পাওয়া যায়নি বা নিষ্ক্রিয়।'});}
  const rec=await client.query('SELECT id,brn,dob::text dob,name_bn bn,name_en en,gender FROM birth_records WHERE id=$1',[id]);
  if(!rec.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Record পাওয়া যায়নি।'});}
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[String(user.id),id]);
  const prev=await client.query('SELECT id FROM fil_data_record_unlocks WHERE user_id=$1 AND record_id=$2',[String(user.id),id]);
  const current=Number(bal.rows[0].balance);if(!Number.isFinite(current)||current<0)throw new Error('INVALID_STORED_BALANCE');
  if(prev.rowCount){await client.query('COMMIT');user.balance=current;dataStorNoStore(res);return res.json({ok:true,alreadyUnlocked:true,charged:0,balance:current,record:rec.rows[0]});}
  if(current<DATA_STOR_UNLOCK_PRICE){await client.query('ROLLBACK');dataStorNoStore(res);return res.status(402).json({ok:false,error:'নতুন রেকর্ড আনলক করতে ৳৩০ প্রয়োজন।',balance:current,required:DATA_STOR_UNLOCK_PRICE});}
  const next=Math.round((current-DATA_STOR_UNLOCK_PRICE)*100)/100,now=Date.now(),key='data-stor-record:'+id;
  await client.query('UPDATE fil_users SET balance=$2 WHERE id=$1',[String(user.id),next]);
  await client.query('INSERT INTO fil_usage_charges(user_id,idempotency_key,amount,balance_after,created_at) VALUES($1,$2,$3,$4,$5)',[String(user.id),key,DATA_STOR_UNLOCK_PRICE,next,now]);
  await client.query('INSERT INTO fil_balance_history(user_id,username,action,change_amount,balance_after,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[String(user.id),String(bal.rows[0].username||user.username),'data_stor_unlock',-DATA_STOR_UNLOCK_PRICE,next,'Data Stor record unlock id='+id,now]);
  await client.query('INSERT INTO fil_data_record_unlocks(user_id,record_id,price,created_at) VALUES($1,$2,$3,$4)',[String(user.id),id,DATA_STOR_UNLOCK_PRICE,now]);
  await client.query('COMMIT');user.balance=next;dataStorNoStore(res);
  return res.json({ok:true,alreadyUnlocked:false,charged:DATA_STOR_UNLOCK_PRICE,balance:next,record:rec.rows[0]});
 }catch(e){
  await client.query('ROLLBACK').catch(()=>{});
  console.error('[Data Stor] unlock transaction failed; database error redacted.');
  return res.status(503).json({ok:false,error:'Unlock ব্যর্থ হয়েছে। কোনো charge বা unlock সংরক্ষণ করা হয়নি; পরে আবার চেষ্টা করুন।'});
 }finally{client.release();}
});
app.get('/api/data-stor/admin/stats',requireAdmin,async(req,res)=>{
 if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});
 try{const q=await pool.query('SELECT count(*)::int total FROM birth_records');res.set('Cache-Control','no-store');res.json({ok:true,total:Number(q.rows[0]?.total)||0});}
 catch(e){console.error('[Data Stor] admin stats failed:',e.message);res.status(503).json({ok:false,error:'Data Stor record count লোড করা যায়নি।'});}
});
app.post('/api/data-stor/admin/import',requireAdmin,async(req,res)=>{
 if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon PostgreSQL সংযোগ প্রয়োজন।'});const csv=String(req.body?.csv||'');if(!csv.trim())return res.status(400).json({ok:false,error:'CSV content প্রয়োজন।'});
 let parsed;try{parsed=parseDataStorCsv(csv);}catch(e){return res.status(400).json({ok:false,error:e.message});}if(!parsed.rows.length)return res.status(400).json({ok:false,error:'Valid CSV row পাওয়া যায়নি।',summary:parsed.summary});
 const client=await pool.connect();try{await client.query('BEGIN');for(let i=0;i<parsed.rows.length;i+=500){for(const r of parsed.rows.slice(i,i+500)){const q=await client.query('INSERT INTO birth_records(brn,dob,name_bn,name_en,gender) VALUES($1,$2::date,$3,$4,$5) ON CONFLICT(brn) DO UPDATE SET dob=EXCLUDED.dob,name_bn=EXCLUDED.name_bn,name_en=EXCLUDED.name_en,gender=EXCLUDED.gender RETURNING (xmax=0) AS inserted',[r.brn,r.dob,r.bn,r.en,r.gender]);if(q.rows[0]?.inserted)parsed.summary.imported++;else parsed.summary.updated++;}}await client.query('COMMIT');res.json({ok:true,summary:parsed.summary});}
 catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('[Data Stor] import failed:',e.message);res.status(503).json({ok:false,error:'CSV import ব্যর্থ হয়েছে।',summary:parsed.summary});}finally{client.release();}
});

app.get('/api/services',requireUserAuth,(req,res)=>{
 const user=authStore.users.find(u=>String(u.id)===String(req.auth.userId));
 if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});
 const rate=Math.max(0,Math.round(Number(user.previewRate??4)*100)/100);
 res.set('Cache-Control','no-store');
 res.json({ok:true,services:[{id:'birth-certificate',name:'Birth Certificate PDF',icon:'📄',rate,previewFree:true,chargeOn:'successful-download'}],balance:Number(user.balance)||0});
});
app.get('/api/account/history',requireUserAuth,async(req,res)=>{
 const user=authStore.users.find(u=>String(u.id)===String(req.auth.userId));
 if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});
 if(!pool||!dbReady)return res.json({ok:true,local:true,transactions:[],recharges:[],work:[]});
 try{
  const uid=String(user.id);
  const [balances,payments,charges]=await Promise.all([
   pool.query('SELECT id,action,change_amount,balance_after,note,created_at FROM fil_balance_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[uid]),
   pool.query('SELECT id,amount,method,transaction_ref,status,created_at,reviewed_at FROM fil_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[uid]),
   pool.query('SELECT idempotency_key,amount,balance_after,created_at FROM fil_usage_charges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[uid])
  ]);
  res.set('Cache-Control','no-store');
  res.json({ok:true,local:false,
   transactions:balances.rows.map(x=>({id:String(x.id),type:String(x.action||'balance'),amount:Number(x.change_amount)||0,balanceAfter:Number(x.balance_after)||0,note:String(x.note||''),createdAt:Number(x.created_at)||0})),
   recharges:payments.rows.map(x=>({id:x.id,amount:Number(x.amount)||0,method:x.method,transactionRef:x.transaction_ref,status:x.status,createdAt:Number(x.created_at)||0,reviewedAt:x.reviewed_at==null?null:Number(x.reviewed_at)})),
   work:charges.rows.map(x=>({id:x.idempotency_key,service:'Birth Certificate PDF',amount:Number(x.amount)||0,balanceAfter:Number(x.balance_after)||0,createdAt:Number(x.created_at)||0}))
  });
 }catch(err){console.error('[Account history] query failed:',err.message);res.status(503).json({ok:false,error:'Account history ডাটাবেস থেকে লোড করা যায়নি।'});}
});

app.get('/api/balance',requireUserAuth,async(req,res)=>{
 const user=authStore.users.find(u=>u.id===req.auth.userId);if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});
 if(pool&&dbReady){try{const q=await pool.query('SELECT balance FROM fil_users WHERE id=$1 AND enabled=true',[String(user.id)]);if(!q.rowCount)return res.status(401).json({ok:false,error:'AutoFill account পাওয়া যায়নি।'});dataStorNoStore(res);return res.json({ok:true,balance:Number(q.rows[0].balance)||0,charged:0,local:false});}catch(e){console.error('[Balance] authoritative lookup failed.');return res.status(503).json({ok:false,error:'Database balance লোড করা যায়নি।'});}}
 dataStorNoStore(res);return res.json({ok:true,balance:Number(user.balance)||0,charged:0,local:true});
});
// Preview is deliberately free. Keep the old endpoint as a compatibility alias.
app.post('/api/balance/charge',requireUserAuth,(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId);
  if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});
  return res.json({ok:true,balance:Number(user.balance)||0,charged:0,local:!pool,operation:'preview'});
});
// Charge only after a valid PDF has been generated, and make each request idempotent.
const localUsageCharges = new Map();
app.post('/api/balance/charge-download',requireUserAuth,async(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId);
  if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});
  const key=String(req.get('Idempotency-Key')||'').trim();
  if(!key || key.length>160)return res.status(400).json({ok:false,error:'Download reference missing or invalid.'});
  const amount=Math.max(0,Math.round(Number(user.previewRate??4)*100)/100);
  if(pool && dbReady){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const prior=await client.query('SELECT amount,balance_after FROM fil_usage_charges WHERE user_id=$1 AND idempotency_key=$2',[String(user.id),key]);
      if(prior.rowCount){
        const latest=await client.query('SELECT balance FROM fil_users WHERE id=$1',[String(user.id)]);
        const currentBalance=latest.rowCount?Number(latest.rows[0].balance)||0:Number(user.balance)||0;
        await client.query('COMMIT');
        user.balance=currentBalance;
        return res.json({ok:true,balance:currentBalance,charged:0,alreadyCharged:true,local:false});
      }
      const locked=await client.query('SELECT balance FROM fil_users WHERE id=$1 FOR UPDATE',[String(user.id)]);
      const current=locked.rowCount?Number(locked.rows[0].balance)||0:Number(user.balance)||0;
      if(current<amount){await client.query('ROLLBACK');return res.status(402).json({ok:false,error:'Balance পর্যাপ্ত নয়।',balance:current,required:amount});}
      const next=Math.round((current-amount)*100)/100;
      if(locked.rowCount) await client.query('UPDATE fil_users SET balance=$2 WHERE id=$1',[String(user.id),next]);
      await client.query('INSERT INTO fil_usage_charges(user_id,idempotency_key,amount,balance_after,created_at) VALUES($1,$2,$3,$4,$5)',[String(user.id),key,amount,next,Date.now()]);
      await client.query('INSERT INTO fil_balance_history(user_id,username,action,change_amount,balance_after,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[String(user.id),user.username,'download_charge',-amount,next,'Certificate download',Date.now()]);
      await client.query('COMMIT');
      user.balance=next; saveAuthStore(authStore);
      return res.json({ok:true,balance:next,charged:amount,local:false});
    }catch(err){
      await client.query('ROLLBACK').catch(()=>{});
      console.error('[Billing] Download charge failed:',err.message);
      return res.status(503).json({ok:false,error:'Download charge সম্পন্ন হয়নি। আবার চেষ্টা করুন।'});
    }finally{client.release();}
  }
  const userKey=String(user.id)+':'+key;
  if(localUsageCharges.has(userKey))return res.json({ok:true,balance:Number(user.balance)||0,charged:0,alreadyCharged:true,local:true});
  const current=Number(user.balance)||0;
  if(current<amount)return res.status(402).json({ok:false,error:'Balance পর্যাপ্ত নয়।',balance:current,required:amount});
  user.balance=Math.round((current-amount)*100)/100;
  localUsageCharges.set(userKey,{amount,balance:user.balance});
  saveAuthStore(authStore); await recordBalanceChange(user,-amount,'download_charge','Certificate download');
  return res.json({ok:true,balance:user.balance,charged:amount,local:true});
});
app.get('/api/admin/users',requireAdmin,(req,res)=>res.json({ok:true,users:authStore.users.map(u=>{const {passwordHash,accessToken,...safe}=u;return {...safe,loginLink:createUserLoginLink(u)};})}));
app.post('/api/admin/users',requireAdmin,(req,res)=>{const {username,password,name=''}=req.body||{};const cleanUsername=String(username||'').trim();if(!cleanUsername||!password)return res.status(400).json({ok:false,error:'Username এবং password দিন।'});if(cleanUsername.length<3||cleanUsername.length>64)return res.status(400).json({ok:false,error:'Username ৩ থেকে ৬৪ অক্ষরের হতে হবে।'});if(String(password).length<8)return res.status(400).json({ok:false,error:'Password কমপক্ষে ৮ অক্ষরের হতে হবে।'});if(authStore.users.some(u=>u.username.toLowerCase()===cleanUsername.toLowerCase()))return res.status(409).json({ok:false,error:'এই Username আগে থেকেই আছে।'});const user={id:newToken().slice(0,16),username:cleanUsername,name:String(name||'').trim(),passwordHash:hashPassword(password),accessToken:newToken(),enabled:true,deviceId:'',createdAt:Date.now(),lastLoginAt:null,balance:0,previewRate:4};authStore.users.push(user);saveAuthStore(authStore);const {passwordHash,accessToken,...safe}=user;res.json({ok:true,user:safe,link:createUserLoginLink(user),message:'User তৈরি হয়েছে। User link ও Username/Password দিয়ে লগইন করুন।'});});
app.patch('/api/admin/users/:id',requireAdmin,async(req,res)=>{const user=authStore.users.find(u=>u.id===req.params.id);if(!user)return res.status(404).json({ok:false,error:'User not found.'});const before=Number(user.balance)||0;if(typeof req.body.enabled==='boolean')user.enabled=req.body.enabled;if(req.body.resetDevice)user.deviceId='';if(req.body.newPassword){if(String(req.body.newPassword).length<8)return res.status(400).json({ok:false,error:'Password কমপক্ষে ৮ অক্ষরের হতে হবে।'});user.passwordHash=hashPassword(req.body.newPassword);}for(const k of ['name','nameBn','nameEn','birthRegNo','birthDateBn','birthDateEn'])if(req.body[k]!==undefined)user[k]=String(req.body[k]??'').trim();if(req.body.setPreviewRate!==undefined){const n=Number(req.body.setPreviewRate);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid preview rate.'});user.previewRate=Math.round(n*100)/100;}if(req.body.setBalance!==undefined){const n=Number(req.body.setBalance);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid balance.'});user.balance=Math.round(n*100)/100;}if(req.body.addBalance!==undefined){const n=Number(req.body.addBalance);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid balance amount.'});user.balance=Math.round(((Number(user.balance)||0)+n)*100)/100;}saveAuthStore(authStore);if(Number(user.balance)!==before)await recordBalanceChange(user,Number(user.balance)-before,req.body.addBalance!==undefined?'admin_add_balance':'admin_set_balance','Admin balance update');const {passwordHash,accessToken,...safe}=user;res.json({ok:true,user:safe});});
app.delete('/api/admin/users/:id',requireAdmin,async(req,res)=>{const i=authStore.users.findIndex(u=>u.id===req.params.id);if(i<0)return res.status(404).json({ok:false,error:'User not found.'});const [user]=authStore.users.splice(i,1);saveAuthStore(authStore);if(pool&&dbReady){await pool.query('DELETE FROM fil_balance_history WHERE user_id=$1',[String(user.id)]).catch(()=>{});await pool.query('DELETE FROM fil_payments WHERE user_id=$1',[String(user.id)]).catch(()=>{});}res.json({ok:true});});
app.get('/api/admin/users/:id/balance-history',requireAdmin,async(req,res)=>{if(!pool||!dbReady)return res.json({ok:true,history:[]});const r=await pool.query('SELECT action,change_amount,balance_after,created_at,note FROM fil_balance_history WHERE user_id=$1 ORDER BY id DESC LIMIT 300',[String(req.params.id)]);res.json({ok:true,history:r.rows.map(x=>({action:x.action,change:Number(x.change_amount),balanceAfter:Number(x.balance_after),createdAt:Number(x.created_at),note:x.note}))});});
app.get('/api/admin/payments',requireAdmin,async(req,res)=>{if(!pool||!dbReady)return res.json({ok:true,items:[]});const r=await pool.query('SELECT * FROM fil_payments ORDER BY created_at DESC LIMIT 1000');res.json({ok:true,items:r.rows.map(x=>({id:x.id,userId:x.user_id,username:x.username,amount:Number(x.amount),method:x.method,transactionRef:x.transaction_ref,status:x.status,createdAt:Number(x.created_at)}))});});
app.post('/api/payments',requireUserAuth,async(req,res)=>{if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Recharge জন্য DATABASE_URL সংযুক্ত করতে হবে।'});const user=authStore.users.find(u=>u.id===req.auth.userId);if(!user)return res.status(401).json({ok:false,error:'User account পাওয়া যায়নি।'});const amount=Number(req.body?.amount),method=String(req.body?.method||'').trim().slice(0,80),transactionRef=String(req.body?.transactionRef||'').trim().slice(0,160);if(!Number.isFinite(amount)||amount<=0||amount>1000000)return res.status(400).json({ok:false,error:'সঠিক recharge amount দিন।'});if(!method||!transactionRef)return res.status(400).json({ok:false,error:'Payment method ও transaction reference প্রয়োজন।'});const id=newToken().slice(0,20);await pool.query('INSERT INTO fil_payments(id,user_id,username,amount,method,transaction_ref,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,String(user.id),user.username,amount,method,transactionRef,'pending',Date.now()]);res.json({ok:true,id,status:'pending'});});
app.post('/api/admin/payments/:id/review',requireAdmin,async(req,res)=>{if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Database is not connected.'});const status=String(req.body?.status||'');if(!['approved','rejected'].includes(status))return res.status(400).json({ok:false,error:'Invalid payment status.'});const client=await pool.connect();try{await client.query('BEGIN');const pr=await client.query('SELECT * FROM fil_payments WHERE id=$1 FOR UPDATE',[String(req.params.id)]);if(!pr.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Payment not found.'});}const payment=pr.rows[0];if(payment.status!=='pending'){await client.query('ROLLBACK');return res.status(409).json({ok:false,error:'Payment ইতিমধ্যে review করা হয়েছে।'});}await client.query('UPDATE fil_payments SET status=$2,reviewed_at=$3,reviewed_by=$4 WHERE id=$1',[payment.id,status,Date.now(),req.auth.username]);if(status==='approved'){const ur=await client.query('UPDATE fil_users SET balance=balance+$2 WHERE id=$1 RETURNING balance,username',[payment.user_id,payment.amount]);if(ur.rowCount){await client.query('INSERT INTO fil_balance_history(user_id,username,action,change_amount,balance_after,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[payment.user_id,ur.rows[0].username,'recharge_approved',payment.amount,ur.rows[0].balance,'Payment '+payment.id,Date.now()]);await client.query('INSERT INTO fil_income(user_id,username,amount,kind,note,created_at) VALUES($1,$2,$3,$4,$5,$6)',[payment.user_id,ur.rows[0].username,payment.amount,'recharge','Approved payment '+payment.id,Date.now()]);const mem=authStore.users.find(u=>u.id===payment.user_id);if(mem)mem.balance=Number(ur.rows[0].balance);}}await client.query('COMMIT');if(status==='approved')saveAuthStore(authStore);res.json({ok:true,status});}catch(err){await client.query('ROLLBACK').catch(()=>{});console.error('[Neon] Payment review failed:',err.message);res.status(500).json({ok:false,error:'Payment review failed.'});}finally{client.release();}});
app.get('/api/admin/income',requireAdmin,async(req,res)=>{if(!pool||!dbReady)return res.json({ok:true,items:[],total:0});const r=await pool.query('SELECT * FROM fil_income ORDER BY created_at DESC LIMIT 1000');const items=r.rows.map(x=>({id:x.id,userId:x.user_id,username:x.username,amount:Number(x.amount),kind:x.kind,note:x.note,createdAt:Number(x.created_at)}));res.json({ok:true,items,total:items.reduce((s,x)=>s+x.amount,0)});});
app.use('/api',(req,res,next)=>{if(req.path.startsWith('/auth/'))return next();return requireUserAuth(req,res,next);});


/* =========================================================
   SHARED PDF IMAGE LIBRARY
========================================================= */
// V194: bridge used by integrated WhatsApp Make bot. Match only verified registrar office.
function stripPDFOfficeLabel(value){
  return String(value||'').normalize('NFKC')
    .replace(/^\s*(?:location\s+of\s+the\s+)?registered\s+office\s*[:：-]\s*/i,'')
    .replace(/^\s*(?:registration\s+office|office\s+name|নিবন্ধন\s*অফিস|নিবন্ধিত\s*অফিস)\s*[:ঃ：-]\s*/i,'')
    .trim();
}
function normalizePDFOfficeName(value){
  // One canonical key for all office names: case-insensitive, whitespace and
  // punctuation tolerant, Bangla digits normalized, and Zone 1 == Zone 01.
  let s = cleanEverifyText(stripPDFOfficeLabel(value)).normalize('NFKC');
  s = s.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).toLowerCase();
  s = s.replace(/[‐‑‒–—_]/g, '-');
  s = s.replace(/অঞ্চল|জোন|জুন/g, 'zone').replace(/\bzon\b/g, 'zone');
  s = s.replace(/(?:zone)\s*[-_/ ]*0*(\d{1,2})(?!\d)/gi, (_, number) => `zone-${Number(number)}`);
  return s.replace(/[^a-z0-9\u0980-\u09ff]+/g, '');
}
function extractPDFOfficeZone(value){
  const s = cleanEverifyText(value).replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).toLowerCase().replace(/অঞ্চল|জোন|জুন/g, 'zone').replace(/\bzon\b/g,'zone');
  const m = s.match(/zone\s*[-_/ ]*0*(\d{1,2})(?!\d)/i);
  return m ? `zone-${Number(m[1])}` : '';
}

function matchVerifiedRegistrarImage(registeredOffice, images) {
  const supplied=String(registeredOffice||'').normalize('NFKC').trim();
  const raw=stripPDFOfficeLabel(supplied);
  const office=normalizePDFOfficeName(raw);
  if(!office)return null;
  const available=(images||[]).filter(x=>x && x.fileName && fs.existsSync(path.join(PDF_IMAGE_DIR,path.basename(x.fileName))));
  // Canonical equality resolves all capitalization styles and leading-zero
  // variants without selecting a merely similar office.
  const exact=available.find(x=>normalizePDFOfficeName(x.name)===office);
  if(exact){
    console.log(`[MAKE PDF IMAGE] matched by canonical Registered Office: ${raw} -> ${exact.name}`);
    return exact;
  }
  const officialNormalized=normalizePDFOfficeName(raw);
  const originalExact=available.find(x=>normalizePDFOfficeName(x.name)===officialNormalized);
  if(originalExact)return originalExact;

  // V201: Some eVerify results contain only the first/local office name, e.g.
  // Registered Office = GAZNAPUR while the saved image is named
  // "Gaznapur Nabiganj, Habiganj". Match a whole leading word sequence, but
  // only when it identifies exactly one image, so unrelated offices are never
  // selected just because they share a short substring.
  const officeTokens = cleanEverifyText(raw).normalize('NFKC')
    .replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))
    .toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) || [];
  if (officeTokens.length) {
    const localOfficeCandidates = available.filter(x => {
      const nameTokens = cleanEverifyText(x.name).normalize('NFKC')
        .replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))
        .toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) || [];
      return nameTokens.length >= officeTokens.length &&
        officeTokens.every((token, i) => nameTokens[i] === token);
    });
    if (localOfficeCandidates.length === 1) {
      console.log(`[MAKE PDF IMAGE] matched by unique registered-office prefix: ${raw} -> ${localOfficeCandidates[0].name}`);
      return localOfficeCandidates[0];
    }
    if (localOfficeCandidates.length > 1) {
      console.warn(`[MAKE PDF IMAGE] ambiguous registered-office prefix: ${raw} (${localOfficeCandidates.length} candidates)`);
    }
  }

  const z=office.match(/(?:zone|zon|জোন|জুন)\s*[- ]*0?(\d{1,2})(?!\d)/i);
  if(z){
    const n=Number(z[1]);
    // Zone aliases are only used when the verified office identifies a city corporation.
    // Prevent choosing a different city's image with the same zone number.
    const city=/dhaka south|ঢাকা দক্ষিণ|dscc/i.test(raw)?'south':/dhaka north|ঢাকা উত্তর|dncc/i.test(raw)?'north':/chattogram|chittagong|চট্টগ্রাম/i.test(raw)?'ctg':'';
    const candidates=available.filter(x=>{
      const name=norm(x.name);
      const m=name.match(/(?:zone|zon|জোন|জুন)\s*[- ]*0?(\d{1,2})(?!\d)/i);
      if(!m || Number(m[1])!==n)return false;
      if(city==='south' && /north|উত্তর|chattogram|chittagong|চট্টগ্রাম/i.test(name))return false;
      if(city==='north' && /south|দক্ষিণ|chattogram|chittagong|চট্টগ্রাম/i.test(name))return false;
      if(city==='ctg' && /dhaka|ঢাকা/i.test(name))return false;
      return true;
    });
    if(candidates.length===1)return candidates[0];
  }
  return null;
}
app.get('/api/bot/pdf-image-match',(req,res)=>{
  res.set('Cache-Control','no-store');
  const registeredOffice=String(req.query.registeredOffice||'').trim();
  if(!registeredOffice)return res.status(400).json({ok:false,error:'registeredOffice required'});
  // Repair missing bundled seed files before lookup. This is safe for working
  // uploads: the restore routine never overwrites an existing valid image.
  restoreOriginalOfficeImages();
  const store=loadPDFImageLibrary();
  const image=matchVerifiedRegistrarImage(registeredOffice,store.images);
  if(image){
    console.log(`[MAKE PDF IMAGE] API match: ${JSON.stringify(registeredOffice)} -> ${image.name} (${image.fileName})`);
    return res.json({ok:true,matched:true,image:pdfImageMeta(image),registeredOffice});
  }
  const imageNames=(Array.isArray(store.images)?store.images:[]).map(x=>({name:x?.name||'',hasImage:!!x?.fileName,fileExists:!!(x?.fileName&&fs.existsSync(path.join(PDF_IMAGE_DIR,path.basename(x.fileName))))}));
  console.warn(`[MAKE PDF IMAGE] API no match: office=${JSON.stringify(registeredOffice)} storage=${PDF_IMAGE_DIR} images=${imageNames.length} available=${imageNames.filter(x=>x.hasImage&&x.fileExists).length} names=${JSON.stringify(imageNames)}`);
  return res.json({ok:true,matched:false,image:null,registeredOffice,debug:{imageNames:imageNames.map(x=>x.name),imageCount:imageNames.length,availableCount:imageNames.filter(x=>x.hasImage&&x.fileExists).length}});
});

// Import a prepared PDF Image bundle into the shared Neon library. The bundle
// contains library.json plus image files; each image and saved position is
// persisted centrally so every signed-in user sees the same library.
function readImageZipBundle(buffer){
  const files=new Map();
  let eocd=-1;
  for(let p=Math.max(0,buffer.length-65557);p<=buffer.length-22;p++){
    if(buffer.readUInt32LE(p)===0x06054b50)eocd=p;
  }
  if(eocd<0)throw new Error('ZIP ফাইলটি সঠিক নয়।');
  const count=buffer.readUInt16LE(eocd+10), centralOffset=buffer.readUInt32LE(eocd+16);
  let p=centralOffset;
  for(let n=0;n<count;n++){
    if(p+46>buffer.length||buffer.readUInt32LE(p)!==0x02014b50)throw new Error('ZIP directory invalid.');
    const method=buffer.readUInt16LE(p+10), compressedSize=buffer.readUInt32LE(p+20), nameLen=buffer.readUInt16LE(p+28), extraLen=buffer.readUInt16LE(p+30), commentLen=buffer.readUInt16LE(p+32), localOffset=buffer.readUInt32LE(p+42);
    const name=buffer.subarray(p+46,p+46+nameLen).toString('utf8').replace(/\\/g,'/');
    p+=46+nameLen+extraLen+commentLen;
    if(!name||name.endsWith('/')||name.startsWith('/')||name.split('/').includes('..'))continue;
    if(localOffset+30>buffer.length||buffer.readUInt32LE(localOffset)!==0x04034b50)continue;
    const localNameLen=buffer.readUInt16LE(localOffset+26), localExtraLen=buffer.readUInt16LE(localOffset+28), start=localOffset+30+localNameLen+localExtraLen;
    const packed=buffer.subarray(start,start+compressedSize);
    let data;
    if(method===0)data=Buffer.from(packed);
    else if(method===8)data=zlib.inflateRawSync(packed);
    else continue;
    files.set(name,data);
  }
  return files;
}
app.post('/api/pdf-images/import-bundle',async(req,res)=>{
  try{
    if(!pool||!dbReady)return res.status(503).json({ok:false,error:'Neon database প্রস্তুত নয়।'});
    const raw=String(req.body?.dataUrl||'');
    const match=raw.match(/^data:application\\/(?:zip|x-zip-compressed|octet-stream);base64,([A-Za-z0-9+/=]+)$/i);
    if(!match)return res.status(400).json({ok:false,error:'ZIP ফাইল নির্বাচন করুন।'});
    const zip=Buffer.from(match[1],'base64');
    if(!zip.length||zip.length>18*1024*1024)return res.status(413).json({ok:false,error:'ZIP সর্বোচ্চ 18 MB হতে পারবে।'});
    const files=readImageZipBundle(zip);
    const libraryEntry=[...files.entries()].find(([name])=>/(?:^|\\/)library\\.json$/i.test(name));
    if(!libraryEntry)throw new Error('ZIP-এর ভিতরে library.json পাওয়া যায়নি।');
    const parsed=JSON.parse(libraryEntry[1].toString('utf8'));
    if(!Array.isArray(parsed.images))throw new Error('library.json-এ images list নেই।');
    const store=loadPDFImageLibrary(); let imported=0, skipped=0;
    for(const old of parsed.images){
      const name=safeImageName(old?.name); if(!name){skipped++;continue;}
      const oldFile=path.basename(String(old.fileName||'')); let bytes=oldFile?files.get(oldFile)||files.get('pdf-images/'+oldFile):null;
      if(!bytes&&oldFile){for(const [filePath,data] of files){if(path.basename(filePath)===oldFile){bytes=data;break;}}}
      const existing=store.images.find(x=>x.id===String(old.id||'')||String(x.name||'').trim().toLowerCase()===name.toLowerCase());
      const image=existing||{id:/^[a-f0-9]{16,64}$/i.test(String(old.id||''))?String(old.id):crypto.randomBytes(12).toString('hex'),name,fileName:'',mimeType:'',createdAt:Number(old.createdAt)||Date.now(),updatedAt:Date.now()};
      image.name=name;
      if(old.position&&['x','y','z','w','h'].every(k=>Number.isFinite(Number(old.position[k]))))image.position={x:Number(old.position.x),y:Number(old.position.y),z:Number(old.position.z),w:Number(old.position.w),h:Number(old.position.h)};
      image.permanent=old.permanent===true||image.permanent===true;
      if(bytes&&bytes.length&&bytes.length<=12*1024*1024){
        const ext=String(oldFile.split('.').pop()||'').toLowerCase();
        const mime=String(old.mimeType|| (ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg')).toLowerCase();
        if(!['image/png','image/jpeg','image/jpg','image/webp'].includes(mime)){skipped++;continue;}
        const safeExt=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
        image.fileName=image.id+'.'+safeExt;image.mimeType=mime==='image/jpg'?'image/jpeg':mime;fs.writeFileSync(path.join(PDF_IMAGE_DIR,image.fileName),bytes);
      }
      image.updatedAt=Date.now();
      if(!existing)store.images.push(image);
      imported++;
    }
    if(!await savePDFImageLibraryForResponse(store,res))return;
    return res.json({ok:true,imported,skipped,total:store.images.length,message:'Image Library ও saved positions Neon-এ সংরক্ষিত হয়েছে; সব User একই library দেখবে।'});
  }catch(e){return res.status(400).json({ok:false,error:e.message||'ZIP import ব্যর্থ।'});}
});

app.get('/api/pdf-images', (req,res)=>{
  res.set('Cache-Control','no-store');
  const store=loadPDFImageLibrary();
  res.json({ok:true,images:(store.images||[]).map(pdfImageMeta)});
});

app.post('/api/pdf-images', async (req,res)=>{
  const {name,dataUrl}=req.body||{};
  const cleanName=safeImageName(name);
  if(!cleanName) return res.status(400).json({ok:false,error:'Image-এর নাম দিন।'});
  let store=loadPDFImageLibrary();
  const requestedId = String(req.body?.id || '').trim();
  let image = requestedId ? store.images.find(x=>x.id===requestedId) : null;
  if(!image) image=store.images.find(x=>x.name===cleanName);
  if(!image){
    image={id:crypto.randomBytes(12).toString('hex'),name:cleanName,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now()};
    store.images.push(image);
  }
  if(!dataUrl){ if(!await savePDFImageLibraryForResponse(store,res))return; return res.json({ok:true,image:pdfImageMeta(image),needsUpload:!image.fileName}); }
  const match=String(dataUrl).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if(!match) return res.status(400).json({ok:false,error:'শুধু PNG, JPG/JPEG অথবা WEBP image upload করা যাবে।'});
  const mime=match[1].toLowerCase()==='image/jpg'?'image/jpeg':match[1].toLowerCase();
  const buffer=Buffer.from(match[2],'base64');
  if(!buffer.length || buffer.length>12*1024*1024) return res.status(400).json({ok:false,error:'Image সর্বোচ্চ 12 MB হতে পারবে।'});
  const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
  const fileName=image.id+'.'+ext;
  for(const ext2 of ['png','jpg','webp']){ const old=path.join(PDF_IMAGE_DIR,image.id+'.'+ext2); if(old!==path.join(PDF_IMAGE_DIR,fileName)) try{fs.unlinkSync(old)}catch(_){} }
  fs.writeFileSync(path.join(PDF_IMAGE_DIR,fileName),buffer);
  image.fileName=fileName; image.mimeType=mime; image.updatedAt=Date.now();
  if(!await savePDFImageLibraryForResponse(store,res))return;
  res.json({ok:true,image:pdfImageMeta(image)});
});

app.patch('/api/pdf-images/:id', async (req,res)=>{
  const requested=safeImageName(req.body?.name);
  if(!requested) return res.status(400).json({ok:false,error:'নতুন Image-এর নাম দিন।'});
  let store=loadPDFImageLibrary();
  const image=store.images.find(x=>x.id===req.params.id);
  if(!image) return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  const duplicate=store.images.find(x=>x.name===requested && x.id!==image.id);
  if(duplicate) return res.status(409).json({ok:false,error:'এই নামে আরেকটি Image আগে থেকেই আছে।'});
  image.name=requested; image.updatedAt=Date.now();
  if(!await savePDFImageLibraryForResponse(store,res))return;
  res.json({ok:true,image:pdfImageMeta(image)});
});

// V196: permanent office slots. These names survive image delete/replace and server restarts.
const PERMANENT_OFFICE_IMAGE_NAMES = [
  'Zone - 01, Dhaka South City Corporation',
  'Zone - 02, Dhaka South City Corporation',
  'Zone - 03, Dhaka South City Corporation',
  'Zone - 06, Dhaka South City Corporation',
  'Zone - 07, Dhaka South City Corporation',
  'Zone - 08, Dhaka South City Corporation',
  'Zone - 09, Dhaka South City Corporation',
  'Zone - 10, Dhaka South City Corporation',
  'Zone-10, Dhaka North City Corporation',
  'Ward-31, Chattogram City Corporation',
  'Ward-06 Chattogram City Corporation'
];
function ensurePermanentOfficeImageSlots(){
  const store=loadPDFImageLibrary(); let changed=false;
  for(const name of PERMANENT_OFFICE_IMAGE_NAMES){
    if(!(store.images||[]).some(x=>String(x.name||'').trim().toLowerCase()===name.toLowerCase())){
      store.images.push({id:crypto.randomBytes(12).toString('hex'),name,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now(),permanent:true}); changed=true;
    }
  }
  for(const x of store.images||[]){
    if(PERMANENT_OFFICE_IMAGE_NAMES.some(n=>n.toLowerCase()===String(x.name||'').trim().toLowerCase()) && x.permanent!==true){x.permanent=true;changed=true;}
  }
  if(changed)savePDFImageLibrary(store);
}
ensurePermanentOfficeImageSlots();

// Delete only the uploaded binary; keep permanent office slot so it can be replaced later.
app.delete('/api/pdf-images/:id', async (req,res)=>{
  const store=loadPDFImageLibrary();
  const image=(store.images||[]).find(x=>x.id===req.params.id);
  if(!image)return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  if(image.fileName){try{fs.unlinkSync(path.join(PDF_IMAGE_DIR,image.fileName));}catch(_){} }
  image.fileName=''; image.mimeType=''; image.updatedAt=Date.now();
  if(!image.permanent){ store.images=store.images.filter(x=>x.id!==image.id); }
  if(!await savePDFImageLibraryForResponse(store,res))return;
  res.json({ok:true,deleted:true,slotKept:!!image.permanent,image:image.permanent?pdfImageMeta(image):null});
});


// V197: local position editor + portable permanent image-library ZIP backup.
app.patch('/api/pdf-images/:id/position',async (req,res)=>{
  const store=loadPDFImageLibrary();
  const image=(store.images||[]).find(x=>x.id===req.params.id);
  if(!image)return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  const old=image.position||{};
  const n=(key,def)=>{const raw=req.body?.[key];if(raw!==undefined&&raw!==null&&raw!==''&&Number.isFinite(Number(raw)))return Number(raw);const previous=old[key];return previous!==undefined&&previous!==null&&previous!==''&&Number.isFinite(Number(previous))?Number(previous):def;};
  image.position={x:n('x',105),y:n('y',247),z:n('z',100),w:n('w',24),h:n('h',10)};
  image.updatedAt=Date.now(); if(!await savePDFImageLibraryForResponse(store,res))return;
  res.json({ok:true,image:pdfImageMeta(image)});
});
// V199 compatibility alias for older clients/proxies that do not preserve PATCH.
app.post('/api/pdf-images/:id/position',async (req,res)=>{
  const store=loadPDFImageLibrary();
  const image=(store.images||[]).find(x=>x.id===req.params.id);
  if(!image)return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  const old=image.position||{};
  const n=(key,def)=>{const raw=req.body?.[key];if(raw!==undefined&&raw!==null&&raw!==''&&Number.isFinite(Number(raw)))return Number(raw);const previous=old[key];return previous!==undefined&&previous!==null&&previous!==''&&Number.isFinite(Number(previous))?Number(previous):def;};
  image.position={x:n('x',105),y:n('y',247),z:n('z',100),w:n('w',24),h:n('h',10)};
  image.updatedAt=Date.now(); if(!await savePDFImageLibraryForResponse(store,res))return;
  return res.json({ok:true,image:pdfImageMeta(image)});
});

function crc32(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function makeStoreZip(files){
  const locals=[],centrals=[];let off=0;
  for(const f of files){const name=Buffer.from(f.name.replace(/\\/g,'/'));const data=Buffer.isBuffer(f.data)?f.data:Buffer.from(f.data);const crc=crc32(data);
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0,6);lh.writeUInt16LE(0,8);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(data.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(name.length,26);
    locals.push(lh,name,data);
    const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(off,42);centrals.push(ch,name);off+=lh.length+name.length+data.length;
  }
  const central=Buffer.concat(centrals),local=Buffer.concat(locals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);return Buffer.concat([local,central,end]);
}
function sendPermanentPDFImageZip(req,res){
  const store=loadPDFImageLibrary();
  const files=[{name:'pdf-images/library.json',data:Buffer.from(JSON.stringify(store,null,2))}];
  for(const x of store.images||[]){
    if(!x.fileName)continue;
    const fileName=path.basename(x.fileName), fp=path.join(PDF_IMAGE_DIR,fileName);
    if(fs.existsSync(fp))files.push({name:'pdf-images/'+fileName,data:fs.readFileSync(fp)});
  }
  const zip=makeStoreZip(files);
  res.set({'Content-Type':'application/zip','Content-Disposition':'attachment; filename="MAKE-Permanent-Office-Images.zip"','Content-Length':String(zip.length)}).send(zip);
}
// Keep both URLs: the old Make UI already calls /api/pdf-images/export.
app.get('/api/pdf-images/export',sendPermanentPDFImageZip);
app.get('/api/pdf-images/export.zip',sendPermanentPDFImageZip);

app.get('/image-library',(req,res)=>res.sendFile(path.join(__dirname,'image-library.html')));


app.get('/api/pdf-images/:id', (req,res)=>{
  res.set('Cache-Control','no-store');
  const store=loadPDFImageLibrary();
  const image=(store.images||[]).find(x=>x.id===req.params.id);
  if(!image) return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  if(!image.fileName) return res.status(404).json({ok:false,error:'এই নামের জন্য এখনো Image upload করা হয়নি।'});
  const filePath=path.join(PDF_IMAGE_DIR,image.fileName);
  if(!fs.existsSync(filePath)) return res.status(404).json({ok:false,error:'Image file পাওয়া যায়নি।'});
  if(String(req.query.raw||'')==='1') return res.type(image.mimeType||'image/jpeg').sendFile(filePath);
  const data=fs.readFileSync(filePath).toString('base64');
  res.json({ok:true,id:image.id,name:image.name,updatedAt:image.updatedAt,mimeType:image.mimeType||'image/jpeg',dataUrl:`data:${image.mimeType||'image/jpeg'};base64,${data}`});
});

const launchBrowser = launchPuppeteerBrowser;

async function findFirst(page, selectors, timeout = 10000) {
    // Check all candidate selectors in one browser-side poll instead of waiting
    // sequentially for every selector. This avoids several 5-10s waits when BDRIS
    // changes an element id/name.
    try {
        const found = await page.waitForFunction((sels) => {
            for (const selector of sels) {
                try {
                    const el = document.querySelector(selector);
                    if (el) return selector;
                } catch (_) {}
            }
            return false;
        }, { timeout, polling: 100 }, selectors);
        const selector = await found.jsonValue();
        if (!selector) return null;
        const element = await page.$(selector);
        return element ? { element, selector } : null;
    } catch (err) {
        // A navigation can detach the execution context during selector polling.
        // Do not return a misleading "captcha input missing" when the frame changed.
        if (/detached Frame|Execution context was destroyed|Cannot find context/i.test(String(err?.message || err))) {
            throw new Error('BDRIS পেজ যাচাই চলাকালে পরিবর্তিত হয়েছে। নতুন CAPTCHA session নিয়ে পুনরায় চেষ্টা করুন।');
        }
        return null;
    }
}

// Use one warm Chromium process for both BDRIS lookup and PDF rendering.
// Starting two separate Chrome processes on Render Free wastes memory and makes
// the first Certificate Preview unnecessarily slow.
let sharedBrowser = null;
let sharedBrowserPromise = null;
async function getSharedBrowser() {
    if (sharedBrowser) {
        try { if (sharedBrowser.connected) return sharedBrowser; } catch (_) {}
        sharedBrowser = null;
    }
    if (sharedBrowserPromise) return sharedBrowserPromise;
    sharedBrowserPromise = (async()=>{
        try {
            sharedBrowser = await launchBrowser();
            return sharedBrowser;
        } finally {
            sharedBrowserPromise = null;
        }
    })();
    return sharedBrowserPromise;
}
async function getSharedPDFBrowser() { return getSharedBrowser(); }
async function getSharedBDRISBrowser() { return getSharedBrowser(); }

async function setInputValue(element, value) {
    await element.evaluate((input, nextValue) => {
        const descriptor =
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
            );

        if (descriptor && descriptor.set) {
            descriptor.set.call(input, nextValue);
        } else {
            input.value = nextValue;
        }

        input.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        input.dispatchEvent(
            new Event('change', { bubbles: true })
        );
    }, value);
}


/* =========================================================
   PDF GENERATE
========================================================= */



app.post('/api/generate-pdf', async (req, res) => {
    const { html } = req.body;

    if (!html) {
        return res.status(400).json({
            ok: false,
            error: 'HTML content required'
        });
    }

    let browser;
    let page;

    try {
        // Reuse a warm Chromium process. Starting Chrome for every preview was
        // the main source of the noticeable delay on Render.
        browser = await getSharedPDFBrowser();
        page = await browser.newPage();

        // PDF print uses CSS A4 dimensions; a large deviceScaleFactor is not
        // required and only adds rasterization work. Keep text/SVG vector and
        // let the source image determine image quality.
        await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });

        await page.setContent(html, {
            waitUntil: 'domcontentloaded'
        });

        // The generated HTML embeds the exact Bengali font as a data URL, so
        // one font-readiness wait is enough; four separate font.load() calls
        // were unnecessary work on every preview.
        await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
        });

        await page.emulateMediaType('print');

        const pdf = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            scale: 1,
            margin: {
                top: '0mm',
                bottom: '0mm',
                left: '0mm',
                right: '0mm'
            }
        });

        // Keep Puppeteer's native PDF output. Text and SVG remain vector.
        // The certificate background is supplied as a 300-DPI high-quality JPEG
        // to keep the downloaded PDF compact without rasterizing the text.
        // If the native PDF is below 550 KB, harmless PDF comment padding is
        // added before %%EOF so the downloaded file is approximately 550 KB.
        // This padding does not change the certificate content.
        const TARGET_PDF_BYTES = 550 * 1024;
        let finalPdf = Buffer.from(pdf);
        if (finalPdf.length < TARGET_PDF_BYTES) {
            const eof = finalPdf.lastIndexOf(Buffer.from('%%EOF'));
            if (eof > 0) {
                const needed = TARGET_PDF_BYTES - finalPdf.length;
                const prefix = Buffer.from('% BDRIS quality-size padding\n');
                const chunks = [];
                let remaining = needed;
                while (remaining > 0) {
                    const n = Math.min(remaining, prefix.length);
                    chunks.push(prefix.subarray(0, n));
                    remaining -= n;
                }
                finalPdf = Buffer.concat([finalPdf.subarray(0, eof), ...chunks, finalPdf.subarray(eof)]);
            }
        }

        await page.close().catch(() => {});

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename=Birth_Certificate.pdf',
            'Content-Length': String(finalPdf.length),
            'Cache-Control': 'no-store'
        });
        res.status(200).send(finalPdf);

    } catch (err) {

        if (page) await page.close().catch(() => {});

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


/* =========================================================
   STEP 1
   BDRIS OPEN + BRN + DOB + CAPTCHA
========================================================= */

app.post('/api/init-search', async (req, res) => {

    const { brn, dob } = req.body;

    if (!brn || !dob) {
        return res.status(400).json({
            ok: false,
            error: 'BRN এবং জন্ম তারিখ প্রদান করুন।'
        });
    }

    let browser;
    let page;

    try {

        browser = await getSharedBDRISBrowser();

        page = await browser.newPage();

        console.log('[MAKE VERIFY NAV] opening eVerify',JSON.stringify({at:new Date().toISOString()}));
        try {
            await page.goto('https://everify.bdris.gov.bd/', {
                waitUntil: 'domcontentloaded', timeout: 30000
            });
        } catch (navError) {
            if (!/Navigation timeout/i.test(String(navError?.message || ''))) throw navError;
            console.warn('[MAKE VERIFY NAV] timeout at eVerify; retrying with a fresh page',JSON.stringify({url:page.url(),error:String(navError?.message||navError)}));
            await page.close().catch(() => {});
            page = await browser.newPage();
            try {
                await page.goto('https://everify.bdris.gov.bd/', {
                    waitUntil: 'domcontentloaded', timeout: 45000
                });
            } catch (retryError) {
                throw new Error(`[MAKE VERIFY NAV] eVerify failed after retry: ${retryError?.message || retryError}`);
            }
        }

        console.log('[MAKE VERIFY NAV] loaded',JSON.stringify({url:page.url()}));
        await page.waitForSelector(
            'input',
            {
                timeout: 15000
            }
        );


        /* BRN */

        const brnField = await findFirst(page, [

            '#ubrn',

            '#RegistrationNumber',

            'input[name="RegistrationNumber"]',

            'input[name="UBRN"]',

            'input[maxlength="17"]',

            'input[id*="Registration"]'

        ]);


        /* DOB */

        const dobField = await findFirst(page, [

            '#BirthDate',

            '#RecordDateOfBirth',

            'input[name="BirthDate"]',

            'input[name="RecordDateOfBirth"]',

            'input[type="date"]',

            'input[id*="DateOfBirth"]'

        ]);


        if (!brnField || !dobField) {

            await page.close().catch(() => {});

            const missing = [

                !brnField && 'BRN',

                !dobField && 'জন্ম তারিখ'

            ]
                .filter(Boolean)
                .join(' ও ');

            return res.status(500).json({
                ok: false,
                error:
                    `BDRIS-এর ${missing} field পাওয়া যায়নি।`
            });
        }


        await setInputValue(
            brnField.element,
            brn
        );

        await setInputValue(
            dobField.element,
            dob
        );


        /* CAPTCHA */

        const captcha = await findFirst(page, [

            '#CaptchaImage',

            '#captchaImage',

            'img[id*="captcha" i]',

            'img[src*="captcha" i]',

            'img[alt*="captcha" i]'

        ], 5000);


        if (!captcha) {

            await page.close().catch(() => {});

            return res.status(500).json({
                ok: false,
                error:
                    'BDRIS-এর captcha ইমেজ পাওয়া যায়নি।'
            });
        }


        // Original RUN Server waited for image load and non-zero layout.
        // Prefer screenshot of the real CAPTCHA; if hidden, capture the image
        // bytes from its src rather than failing the entire verification.
        let captchaBase64;
        try {
            await captcha.element.evaluate(async (img) => {
                if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) return;
                await new Promise(resolve => {
                    const finish=()=>resolve();
                    img.addEventListener('load',finish,{once:true});
                    img.addEventListener('error',finish,{once:true});
                    setTimeout(finish,3000);
                });
            });
            await page.waitForFunction((selector) => {
                const el=document.querySelector(selector);
                if(!el)return false;
                const r=el.getBoundingClientRect(), style=getComputedStyle(el);
                return r.width>0 && r.height>0 && style.display!=='none' && style.visibility!=='hidden';
            }, {timeout:5000,polling:50}, captcha.selector);
            captchaBase64=await captcha.element.screenshot({encoding:'base64'});
        } catch (captureError) {
            console.warn('[MAKE CAPTCHA] element screenshot fallback:', captureError.stack || captureError.message);
            captchaBase64=await captcha.element.evaluate(async img=>{
                if(!img.naturalWidth || !img.naturalHeight)throw new Error('CAPTCHA image not loaded');
                const canvas=document.createElement('canvas');
                canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
                const ctx=canvas.getContext('2d');
                ctx.drawImage(img,0,0);
                return canvas.toDataURL('image/png').split(',')[1];
            });
        }


        const sessionId =
            crypto.randomUUID();


        sessions.set(
            sessionId,
            {
                browser,
                page,
                brn: String(brn).trim(),
                dob
            }
        );


        /* 3 মিনিট session */

        setTimeout(() => {
            // Do not close a page while an active CAPTCHA submission is using it.
            if (sessions.has(sessionId) && !activeSubmissions.has(sessionId)) {
                void disposeMakeSession(sessionId, sessions.get(sessionId));
            }
        }, 3 * 60 * 1000);


        res.json({

            ok: true,

            sessionId,

            captchaImage:
                `data:image/png;base64,${captchaBase64}`

        });


    } catch (err) {

        if (browser) {
            if (page) await page.close().catch(() => {});
        }

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


/* =========================================================
   STEP 2
   CAPTCHA SUBMIT + DATA EXTRACTION
========================================================= */

app.post('/api/submit-captcha', async (req, res) => {

    const {
        sessionId,
        captcha,
        captureVerified = false
    } = req.body;


    if (!sessions.has(sessionId)) {

        return res.status(400).json({

            ok: false,

            error:
                'সেশন এক্সপায়ার হয়ে গেছে। আবার চেষ্টা করুন।'

        });
    }


    if (activeSubmissions.has(sessionId)) {
        return res.status(409).json({ok:false, error:'এই /make session-এর CAPTCHA যাচাই ইতিমধ্যে চলছে। অনুগ্রহ করে ফলাফলের জন্য অপেক্ষা করুন।'});
    }
    const session = sessions.get(sessionId);
    const {
        browser,
        page,
        brn: sessionBrn,
        dob: sessionDob
    } = session;
    activeSubmissions.add(sessionId);

    try {
        if (page.isClosed()) throw new Error('BDRIS session page বন্ধ হয়ে গেছে। নতুন CAPTCHA নিয়ে আবার চেষ্টা করুন।');

        // V285: BDRIS CAPTCHA is the only verification path.

        /* CAPTCHA INPUT */

        const captchaField =
            await findFirst(page, [

                '#CaptchaInputText',

                '#CaptchaText',

                'input[name="CaptchaInputText"]',

                'input[name="CaptchaText"]',

                'input[id*="Captcha" i]',

                'input[name*="captcha" i]'

            ]);


        if (!captchaField) {

            throw new Error(
                'BDRIS-এর captcha input field পাওয়া যায়নি।'
            );
        }


        await setInputValue(
            captchaField.element,
            captcha
        );


        /* SEARCH BUTTON */

        console.log('[MAKE VERIFY SUBMIT] starting',JSON.stringify({url:page.url(),session:String(sessionId).slice(0,8)}));
        const resultNavigation = page.waitForNavigation({waitUntil:'domcontentloaded',timeout:12000}).catch(()=>null);
        const clicked =
            await page.evaluate(() => {

                const candidates =
                    [
                        ...document.querySelectorAll(
                            'button, input[type="submit"], input[type="button"]'
                        )
                    ];


                const button =
                    candidates.find(element => {

                        const text =
                            `${element.innerText || ''} ${element.value || ''}`
                                .toLowerCase();

                        return (

                            element.id === 'btnSearch' ||

                            element.id === 'btnVerify' ||

                            /search|verify|সার্চ|যাচাই/
                                .test(text)

                        );

                    }) || candidates[0];


                if (!button) {
                    return false;
                }


                button.click();

                return true;

            });


        console.log('[MAKE VERIFY SUBMIT] click result',JSON.stringify({clicked,url:page.url()}));
        if (!clicked) {

            throw new Error(
                'BDRIS-এর search button পাওয়া যায়নি।'
            );
        }


        /* RESULT LOAD — FAST / AJAX FRIENDLY */
        // BDRIS can return the result through navigation OR AJAX. Waiting for
        // networkidle2 and then waiting for two exact table rows caused a hard
        // 20-second timeout even when the CAPTCHA was correct. Detect any real
        // result/error signal first, then let the extractor decide what fields
        // are actually available.
        const resultWaitStarted=Date.now();
        await Promise.race([
            resultNavigation,
            page.waitForFunction(() => {
                const t=(document.body?.innerText||'');
                const hasNames=/পিতার নাম|মাতার নাম|father.?s name|mother.?s name/i.test(t);
                const hasError=/invalid captcha|incorrect captcha|ভুল ক্যাপচা|ভুল কোড|captcha সঠিক নয়/i.test(t);
                return hasNames || hasError;
            }, {timeout:15000,polling:200}).catch(()=>null)
        ]);
        console.log('[MAKE RESULT WAIT]',JSON.stringify({ms:Date.now()-resultWaitStarted,url:page.url()}));

        /* RESULT CHECK */
        const pageSignal = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            return {
                text,
                hasRows: document.querySelectorAll('table tr').length > 1,
                hasKnownResult: /নিবন্ধিত ব্যক্তির নাম|পিতার নাম|মাতার নাম|registered person|father.?s name|mother.?s name/i.test(text),
                hasCaptchaError: /captcha|ক্যাপচা|invalid|incorrect|সঠিক নয়|সঠিক নয়|ভুল কোড|verification failed/i.test(text)
            };
        }).catch(() => ({text:'',hasRows:false,hasKnownResult:false,hasCaptchaError:false}));

        if (pageSignal.hasCaptchaError && !pageSignal.hasKnownResult && !pageSignal.hasRows) {
            throw new Error('CAPTCHA সঠিক হয়নি অথবা BDRIS যাচাই সম্পন্ন করতে পারেনি। নতুন CAPTCHA নিয়ে আবার চেষ্টা করুন।');
        }


        /* =====================================================
           MAIN EXTRACTION
        ===================================================== */

        const extractResult = () => page.evaluate(() => {


            function clean(value) {

                // Browser page.evaluate must return serializable values. If a future
                // extractor accidentally produces a Promise-like object, never expose
                // its default string representation as "[object Promise]".
                if (value && typeof value === 'object' && typeof value.then === 'function') {
                    return '';
                }

                return String(
                    value ?? ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();

            }


            function norm(value) {

                return clean(value)
                    .toLowerCase()
                    .replace(
                        /[^a-z0-9\u0980-\u09ff]+/g,
                        ''
                    );

            }


            /* সব table row */

            const rows =
                [
                    ...document.querySelectorAll(
                        'table tr'
                    )
                ];


            const records = [];


            /*
             BDRIS-এর detail row:

             বাংলা Label
             বাংলা Value
             English Label
             English Value
            */

            for (const row of rows) {

                const cells =
                    [
                        ...row.querySelectorAll(
                            'td, th'
                        )
                    ].map(cell =>
                        clean(cell.textContent)
                    );


                if (cells.length >= 4) {

                    records.push({

                        label: cells[0],

                        value: cells[1],

                        englishLabel: cells[2],

                        englishValue: cells[3]

                    });

                }

            }


            /*
             সবচেয়ে গুরুত্বপূর্ণ অংশ:

             একই row থেকে বাংলা + English
             value নেওয়া হচ্ছে।
            */

            // This callback executes INSIDE Chromium, not Node.js. Never reference
            // the Node-only cleanPersonNameValue from page.evaluate.
            function cleanPersonName(value) {
                // V256: match server-side trailing-only cleanup; preserve interior spacing.
                return String(value ?? '')
                    .replace(/\u3164[\s\u3164]*[vV]\s*$/g, '')
                    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u061c\u070f\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u034f\u115f\u1160\x60\u2019'".,\s]+$/gu, '');
            }

            function findRow(
                bengaliLabel,
                englishLabel
            ) {

                const bn =
                    norm(bengaliLabel);

                const en =
                    norm(englishLabel);


                return records.find(row => {

                    return (

                        norm(row.label) === bn

                        &&

                        norm(row.englishLabel) === en

                    );

                }) || null;

            }


            /* ============================
               PERSON NAME
            ============================ */

            const person =
                findRow(
                    'নিবন্ধিত ব্যক্তির নাম',
                    'Registered Person Name'
                );


            /* ============================
               FATHER
            ============================ */

            const fatherName =
                findRow(
                    'পিতার নাম',
                    "Father's Name"
                );


            const fatherNationality =
                findRow(
                    'পিতার জাতীয়তা',
                    "Father's Nationality"
                )
                ||
                findRow(
                    'পিতার জাতীয়তা',
                    "Father's Nationality"
                );


            /* ============================
               MOTHER
            ============================ */

            const motherName =
                findRow(
                    'মাতার নাম',
                    "Mother's Name"
                );


            const motherNationality =
                findRow(
                    'মাতার জাতীয়তা',
                    "Mother's Nationality"
                )
                ||
                findRow(
                    'মাতার জাতীয়তা',
                    "Mother's Nationality"
                );


            /* ============================
               PLACE OF BIRTH
            ============================ */

            const pob =
                findRow(
                    'জন্মস্থান',
                    'Place of Birth'
                );


            /* ============================
               RESULT
            ============================ */

            // DEBUG ONLY: capture the exact eVerify
            // "Location of the Register office" text from the rendered page.
            // This is intentionally kept separate from the existing autofill logic
            // so the diagnostic cannot change what the app fills.
            const eVerifyRawText = String(document.body?.innerText || document.documentElement?.innerText || '');
            const eVerifyVisibleText = clean(eVerifyRawText);
            let registerOfficeLocation = '';
            const locationPatterns = [
                /Location\s+of\s+the\s+Register(?:ed)?\s+office\s*[:：]\s*([\s\S]*?)(?=everify\.bdris\.gov\.bd\s+is\s+the\s+official|Back\s+to\s+Previous\s+Page|©|$)/i,
                /Location\s+of\s+the\s+Register(?:ed)?\s+office\s*[:：]\s*([^\r\n]+)/i,
                /রেজিস্টার(?:িং)?\s*অফিসের\s*অবস্থান\s*[:：]\s*([\s\S]*?)(?=everify\.bdris\.gov\.bd|পূর্ববর্তী|©|$)/i
            ];
            for (const re of locationPatterns) {
                const m = eVerifyRawText.match(re);
                if (m?.[1]) { registerOfficeLocation = clean(m[1]); break; }
            }

            const result = {

                nameBn:
                    cleanPersonName(person?.value),

                nameEn:
                    cleanPersonName(person?.englishValue),


                fatherBn:
                    cleanPersonName(fatherName?.value),

                fatherEn:
                    cleanPersonName(fatherName?.englishValue),


                fatherNationalityBn:
                    fatherNationality?.value || '',

                fatherNationalityEn:
                    fatherNationality?.englishValue || '',


                motherBn:
                    cleanPersonName(motherName?.value),

                motherEn:
                    cleanPersonName(motherName?.englishValue),


                motherNationalityBn:
                    motherNationality?.value || '',

                motherNationalityEn:
                    motherNationality?.englishValue || '',


                pobBn:
                    pob?.value || '',

                pobEn:
                    pob?.englishValue || '',


                dob: '',

                sex: '',

                brn: '',

                regDate: '',

                issuanceDate: '',

                registrationOffice: '',
                registerOfficeLocation,

                upazilaPouroshavaUnion: '',

                // QR target: first try to capture the verification/QR URL
                // exposed by the actual BDRIS result page.
                qrLink: (() => {
                    // Prefer the exact BDRIS certificate verification URL that eVerify
                    // exposes. Do not accidentally select the generic eVerify search page.
                    const html = document.documentElement?.innerHTML || '';
                    const exact = html.match(/https?:\/\/bdris\.gov\.bd\/certificate\/verify\?key=[^\"'<>\s]+/i);
                    if (exact && exact[0]) return exact[0].replace(/&amp;/g, '&');

                    const nodes = [...document.querySelectorAll('a[href], img[src], iframe[src]')];
                    const candidates = nodes.map(el => el.href || el.src || '').filter(Boolean);
                    const preferred = candidates.find(url => /bdris\.gov\.bd\/certificate\/verify\?/i.test(url));
                    if (preferred) return preferred;
                    const hit = candidates.find(url => /qr|verify|verification|ubrn/i.test(url));
                    return hit || '';
                })(),

                // Keep the small code printed under the QR tied to the same
                // verification QR returned by eVerify, when the page exposes it.
                qrLabel: (() => {
                    const html = document.documentElement?.innerHTML || '';
                    const urlMatch = html.match(/https?:\/\/bdris\.gov\.bd\/certificate\/verify\?key=[^\"'<>\s]+/i);
                    const url = urlMatch ? urlMatch[0] : '';
                    const nodes = [...document.querySelectorAll('[data-code], [data-qr-code], [data-qr-label]')];
                    for (const el of nodes) {
                        const raw = el.getAttribute('data-code') || el.getAttribute('data-qr-code') || el.getAttribute('data-qr-label') || '';
                        if (/^[A-Za-z]{4,5}$/.test(raw.trim())) return raw.trim().toUpperCase();
                    }
                    // If the source page does not expose a printed code, leave it
                    // empty so the browser can derive one from the exact QR URL.
                    return '';
                })(),

                allFields:
                    records

            };


            /* =================================================
               SUMMARY TABLE
            ================================================= */

            const tables =
                [
                    ...document.querySelectorAll(
                        'table'
                    )
                ];


            if (tables.length) {

                const summaryRows =
                    [
                        ...tables[0]
                            .querySelectorAll('tr')
                    ];


                for (
                    let i = 0;
                    i + 1 < summaryRows.length;
                    i++
                ) {

                    const labels =
                        [
                            ...summaryRows[i]
                                .querySelectorAll(
                                    'td, th'
                                )
                        ].map(cell =>
                            clean(cell.textContent)
                        );


                    const values =
                        [
                            ...summaryRows[i + 1]
                                .querySelectorAll(
                                    'td, th'
                                )
                        ].map(cell =>
                            clean(cell.textContent)
                        );


                    if (
                        !labels.length ||
                        labels.length !== values.length
                    ) {
                        continue;
                    }


                    labels.forEach(
                        (label, index) => {

                            const value =
                                values[index];


                            const key =
                                norm(label);


                            if (
                                key ===
                                norm('Date of Birth')
                            ) {
                                result.dob =
                                    value;
                            }


                            if (
                                key ===
                                norm(
                                    'Birth Registration Number'
                                )
                            ) {
                                result.brn =
                                    value;
                            }


                            if (
                                key ===
                                norm('Sex')
                            ) {
                                result.sex =
                                    value;
                            }


                            if (
                                key ===
                                norm(
                                    'Registration Date'
                                )
                            ) {
                                result.regDate =
                                    value;
                            }


                            if (
                                key ===
                                norm(
                                    'Issuance Date'
                                )
                            ) {
                                result.issuanceDate =
                                    value;
                            }


                            if (
                                key === norm('Registration Office') ||
                                key === norm('নিবন্ধন অফিস') ||
                                key === norm('নিবন্ধন কার্যালয়') ||
                                key === norm('নিবন্ধন কার্যালয়')
                            ) {
                                result.registrationOffice = value;
                            }

                            if (
                                key === norm('Upazila/Pouroshava/City Corporation, Zila') ||
                                key === norm('উপজেলা/পৌরসভা/সিটি কর্পোরেশন, জেলা') ||
                                key === norm('Upazila/Pouroshava/Union') ||
                                key === norm('উপজেলা/পৌরসভা/ইউনিয়ন') ||
                                key === norm('Upazila') ||
                                key === norm('উপজেলা') ||
                                key === norm('Pouroshava') ||
                                key === norm('Pourashava') ||
                                key === norm('পৌরসভা') ||
                                key === norm('Union') ||
                                key === norm('ইউনিয়ন') ||
                                key === norm('ইউনিয়ন') ||
                                key === norm('City Corporation') ||
                                key === norm('সিটি কর্পোরেশন')
                            ) {
                                if (!result.upazilaPouroshavaUnion && value) {
                                    result.upazilaPouroshavaUnion = value;
                                }
                            }

                        }
                    );

                }

            }


            /* =====================================================
               OFFICE / LOCAL GOVERNMENT MAPPING

               Rules:
               1) City Corporation:
                  Registration Office = ZONE - NN,
                  Upazila/Pouroshava/Union = CITY CORPORATION name

               2) Union:
                  Registration Office = online Registration Office name
                  Upazila/Pouroshava/Union = Upazila + District

               3) Pourashava:
                  Registration Office = online Registration Office name
                  Upazila/Pouroshava/Union = District + Upazila
            ===================================================== */
            const officeRaw = clean(result.registrationOffice);

            // Address/office values are not always returned in separate rows by
            // eVerify. Prefer exact field labels first, then fall back to a
            // combined label. This prevents a combined "Upazila/Pouroshava/Union"
            // value from being mistaken for the union office itself.
            const findRows = (tests) => {
                const wanted = tests.map(norm).filter(Boolean);
                return records.filter(r => {
                    const bn = norm(r.label);
                    const en = norm(r.englishLabel);
                    return wanted.some(w => w && (bn === w || en === w));
                });
            };
            const findFieldValue = (tests, options = {}) => {
                const exact = findRows(tests)[0];
                if (exact) return clean(exact.englishValue || exact.value || '');
                const wanted = tests.map(norm).filter(Boolean);
                const row = records.find(r => {
                    const bn = norm(r.label);
                    const en = norm(r.englishLabel);
                    return wanted.some(w => w && (bn.includes(w) || en.includes(w)));
                });
                return clean(row?.englishValue || row?.value || '');
            };

            // Geo hierarchy fields must be exact-label only. The generic BDRIS
            // label `Upazila/Pouroshava/City Corporation, Zila` contains both
            // `Upazila` and `Zila`; partial matching here incorrectly copies the
            // combined value into District/Upazila.
            const exactFieldValue = (tests) => {
                const row = findRows(tests)[0];
                return clean(row?.englishValue || row?.value || '');
            };
            const district = exactFieldValue(['District', 'Zila', 'জেলা']);
            const upazila = exactFieldValue(['Upazila', 'উপজেলা']);
            // Keep the exact eVerify geo fields available to the Node-side
            // domestic/foreign guard without changing the existing fill data.
            result.district = district;
            result.upazila = upazila;
            const unionRows = findRows(['Union', 'ইউনিয়ন', 'ইউনিয়ন']);
            const pourRows = findRows(['Pouroshava', 'Pourashava', 'পৌরসভা']);
            const cityRows = findRows(['City Corporation', 'সিটি কর্পোরেশন']);

            // BDRIS sometimes returns only the combined field
            // `Upazila/Pouroshava/Union` instead of separate Upazila/Union rows.
            // Keep the combined value available as a fallback, but do not use its
            // label for City/Union/Pourashava classification.
            const combinedGeoRows = findRows([
                'Upazila/Pouroshava/Union',
                'উপজেলা/পৌরসভা/ইউনিয়ন',
                'উপজেলা/পৌরসভা/ইউনিয়ন',
                'Upazila/Pouroshava/City Corporation, Zila',
                'উপজেলা/পৌরসভা/সিটি কর্পোরেশন, জেলা'
            ]);
            const combinedGeoValue = clean(combinedGeoRows[0]?.englishValue || combinedGeoRows[0]?.value || '');
            const unionName = clean(
                unionRows[0]?.englishValue || unionRows[0]?.value ||
                findFieldValue(['Union', 'ইউনিয়ন', 'ইউনিয়ন'])
            );
            const pourashavaName = clean(
                pourRows[0]?.englishValue || pourRows[0]?.value ||
                findFieldValue(['Pouroshava', 'Pourashava', 'পৌরসভা'])
            );

            const allText = records.map(r => clean(r.englishValue || r.value || '')).filter(Boolean).join(' | ');
            const allBnText = records.map(r => clean(r.value || '')).filter(Boolean).join(' | ');
            const allLabels = records.map(r => `${clean(r.label)} | ${clean(r.englishLabel)}`).join(' | ');
            const textForOffice = `${officeRaw} | ${registerOfficeLocation} | ${allText} | ${allBnText} | ${allLabels}`;

            function stripKnownLocationParts(value) {
                let v = clean(value);
                for (const part of [upazila, district]) {
                    if (!part) continue;
                    const re = new RegExp(`(?:^|[ ,/-])${String(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[ ,/-])`, 'ig');
                    v = v.replace(re, ' ');
                }
                return v.replace(/^[,\s-]+|[,\s-]+$/g, '').replace(/\s*,\s*/g, ', ').trim();
            }

            function normalizeUnionBase(value) {
                let v = stripKnownLocationParts(value);
                v = v.replace(/\bunion\s+parishad\b/ig, '')
                     .replace(/\bunion\b/ig, '')
                     .replace(/ইউনিয়ন\s*পরিষদ|ইউনিয়ন\s*পরিষদ|ইউনিয়ন|ইউনিয়ন/gi, '')
                     .replace(/\s*,\s*/g, ', ')
                     .trim();
                // Known BDRIS spelling correction requested for the union example.
                v = v.replace(/\bmahmupur\b/ig, 'Mahmud Pur')
                     .replace(/মাহমুপুর/gi, 'মাহমুদ পুর');
                const parts = v.split(',').map(clean).filter(Boolean);
                return parts[0] || v;
            }

            function formatUnionOffice(value) {
                const base = normalizeUnionBase(value);
                if (!base) return '';
                if (/ইউনিয়ন|ইউনিয়ন/i.test(value)) {
                    return /পরিষদ/i.test(value) ? clean(value) : `${base} ইউনিয়ন পরিষদ`;
                }
                return `${base} Union Parishad`.replace(/\s+/g, ' ').trim();
            }

            function extractCityCorporation(text) {
                const t = clean(text);
                const en = t.match(/(?:Dhaka\s+(?:South|North)\s+|[A-Z][A-Za-z.&'()\/-]*\s+)*City\s+Corporation/i);
                if (en) {
                    const v = clean(en[0]);
                    if (/dhaka\s+south/i.test(v)) return 'Dhaka South City Corporation';
                    if (/dhaka\s+north/i.test(v)) return 'Dhaka North City Corporation';
                    if (/mymensingh/i.test(v)) return 'Mymensingh City Corporation';
                    return v.replace(/\s+/g, ' ').trim();
                }
                const bn = t.match(/[^|,]*সিটি\s*কর্পোরেশন/);
                if (bn) return clean(bn[0]);
                return '';
            }

            let cityCorporation = '';
            // City Corporation detection must never scan every field/label.
            // A generic field label can contain the words `City Corporation`
            // even for Union/Pouroshava registrations. Only the actual City row
            // value and registration-office value are authoritative here.
            for (const candidate of [
                clean(cityRows[0]?.englishValue || cityRows[0]?.value || ''),
                officeRaw,
                clean(registerOfficeLocation)
            ]) {
                cityCorporation = extractCityCorporation(candidate);
                if (cityCorporation) break;
            }

            const zoneMatch = officeRaw.match(/(?:ZON(?:E)?|জোন)\s*[- ]?\s*(\d{1,2})/i);
            const isZoneOffice = !!zoneMatch;
            // IMPORTANT: Do not classify by labels alone. The combined BDRIS label
            // `Upazila/Pouroshava/City Corporation, Zila` contains all three words,
            // so using textForOffice here makes ordinary Union records look like City
            // Corporation records. That causes the City branch to run first and leaves
            // District/Upazila blank. Classification must be based on actual values or
            // the registration-office value.
            // eVerify may expose the local-government information only in the
            // rendered `Location Of the Registered Office` text, e.g.
            // `WARD-31, CHATTOGRAM CITY CORPORATION, CHATTOGRAM.`. In that case
            // registrationOffice itself is only `WARD-31`, so classification must
            // also consider the exact eVerify location string.
            const officeLocationCity = extractCityCorporation(registerOfficeLocation);
            const officeLocationParts = registerOfficeLocation.split(',').map(clean).filter(Boolean);
            // Browser-context parser: Node-side helpers are not visible inside page.evaluate().
            // Parse eVerify's own `Location Of the Registered Office` locally here.
            const officeLocationGeo = (() => {
                const raw = String(registerOfficeLocation || '').replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();
                if (!raw) return null;
                const cleanLocation = raw
                    .replace(/everify\.bdris\.gov\.bd\s+is\s+the\s+official.*$/i, '')
                    .replace(/Back\s+to\s+Previous\s+Page.*$/i, '')
                    .replace(/©\s*2026.*$/i, '')
                    .replace(/\s+/g, ' ').trim();
                const parts = cleanLocation.split(',').map(v => clean(v).replace(/[.]+$/g, '').trim()).filter(Boolean);
                if (parts.length < 2) return null;
                const cityIdx = parts.findIndex(v => /city\s+corporation|সিটি\s*কর্পোরেশন/i.test(v));
                if (cityIdx >= 0) {
                    return { type:'city', localOffice:parts[0] || '', cityCorporation:parts[cityIdx], upazila:'', district:parts[cityIdx + 1] || parts[parts.length - 1] || '' };
                }
                if (parts.length >= 3) return { type:'local', localOffice:parts[0], upazila:parts[1], district:parts[2] };
                return { type:'local', localOffice:parts[0], upazila:'', district:parts[1] };
            })();
            const officeLocationDistrict = officeLocationGeo?.district || (officeLocationParts.length ? officeLocationParts[officeLocationParts.length - 1].replace(/[.]+$/g, '').trim() : '');

            // eVerify can show the complete Union office only in
            // `Location Of the Registered Office`, for example:
            // `TALMA UNION PARISHAD`
            // while the separate `Registration Office` row contains only
            // `TALMA`. Never discard the more complete eVerify value.
            const officeLocationUnion = (() => {
                const v = clean(registerOfficeLocation);
                return /(?:union\s+parishad|union\b|ইউনিয়ন\s*পরিষদ|ইউনিয়ন\s*পরিষদ|ইউনিয়ন|ইউনিয়ন)/i.test(v) ? v : '';
            })();

            const hasCityOffice = !!cityCorporation || !!officeLocationCity || officeLocationGeo?.type === 'city' || isZoneOffice || /city\s+corporation|সিটি\s*কর্পোরেশন/i.test(registerOfficeLocation);
            const hasUnionOffice = !!unionName || !!officeLocationUnion || /union\s*(parishad)?|ইউনিয়ন|ইউনিয়ন/i.test(`${officeRaw} | ${unionRows[0]?.englishValue || unionRows[0]?.value || ''}`);
            const hasPourOffice = !!pourashavaName || /pouroshava|pourashava|পৌরসভা/i.test(`${officeRaw} | ${pourRows[0]?.englishValue || pourRows[0]?.value || ''}`);

            if (hasCityOffice) {
                const zoneNumber = zoneMatch?.[1] || '';
                const zone = zoneNumber ? `Zone - ${String(zoneNumber).padStart(2, '0')}` : clean(officeRaw);
                let city = cityCorporation || extractCityCorporation(registerOfficeLocation) || clean(officeRaw);
                const textForCity = `${officeRaw} | ${registerOfficeLocation} | ${allText} | ${allBnText}`;
                if (/dhaka\s+south|ঢাকা\s*দক্ষিণ|দক্ষিণ\s*সিটি/i.test(textForCity)) city = 'Dhaka South City Corporation';
                else if (/dhaka\s+north|ঢাকা\s*উত্তর|উত্তর\s*সিটি/i.test(textForCity)) city = 'Dhaka North City Corporation';
                else if (/mymensingh\s+city|ময়মনসিংহ.*সিটি|ময়মনসিংহ.*সিটি/i.test(textForCity)) city = 'Mymensingh City Corporation';
                if (!/city\s+corporation|সিটি\s*কর্পোরেশন/i.test(city)) city = `${city} City Corporation`;
                city = clean(city).replace(/\s+/g, ' ').trim();
                const cityName = city
                    .replace(/\s+(?:South|North)\s+City\s+Corporation$/i, '')
                    .replace(/\s+City\s+Corporation$/i, '')
                    .trim() || 'Dhaka';
                // Registration Office remains the exact eVerify row value.
                result.upazilaPouroshavaUnion = officeLocationDistrict
                    ? `${city}, ${officeLocationDistrict}`
                    : `${city}, ${cityName}`;
            } else if (officeLocationGeo?.type === 'local' && officeLocationGeo.upazila && officeLocationGeo.district) {
                // eVerify's own Registered Office Location is authoritative for this
                // path. Example: GAZNAPUR, NABIGANJ, HABIGANJ.
                // Do not replace the actual eVerify Registration Office value.
                result.upazilaPouroshavaUnion = [officeLocationGeo.upazila, officeLocationGeo.district]
                    .filter(Boolean).join(' ').trim();
            } else if (hasUnionOffice) {
                // Prefer the complete eVerify Location value when it explicitly
                // contains the Union Parishad name. This fixes cases where
                // Registration Office = `TALMA` but eVerify Location =
                // `TALMA UNION PARISHAD`.

                result.upazilaPouroshavaUnion = [upazila, district].filter(Boolean).join(' ').trim();
                if (!result.upazilaPouroshavaUnion && combinedGeoValue) {
                    result.upazilaPouroshavaUnion = combinedGeoValue;
                }
            } else if (hasPourOffice) {

                result.upazilaPouroshavaUnion = [district, upazila].filter(Boolean).join(' ').trim();
                if (!result.upazilaPouroshavaUnion && combinedGeoValue) {
                    result.upazilaPouroshavaUnion = combinedGeoValue;
                }
            } else {
                // Keep the exact eVerify Registration Office row value.
                // If the source gives a combined local-government field but no
                // separate classification, retain its value instead of blanking it.
                if (!result.upazilaPouroshavaUnion) {
                    result.upazilaPouroshavaUnion = combinedGeoValue || findFieldValue([
                        'Upazila/Pouroshava/City Corporation, Zila',
                        'উপজেলা/পৌরসভা/সিটি কর্পোরেশন, জেলা',
                        'Upazila/Pouroshava/Union',
                        'উপজেলা/পৌরসভা/ইউনিয়ন',
                        'উপজেলা/পৌরসভা/ইউনিয়ন'
                    ]);
                }
            }
            return result;

        });
        let data=await extractResult();

        /* =====================================================
           CHECK
        ===================================================== */

        // Wait for complete verified fields, not an arbitrary sleep or a generic table.
        // Do not resubmit CAPTCHA while the original verification may still be loading.
        const requiredVerifiedFields = [
            ['nameBn','নিবন্ধিত ব্যক্তির বাংলা নাম'], ['nameEn','নিবন্ধিত ব্যক্তির ইংরেজি নাম'],
            ['fatherBn','পিতার বাংলা নাম'], ['fatherEn','পিতার ইংরেজি নাম'],
            ['motherBn','মাতার বাংলা নাম'], ['motherEn','মাতার ইংরেজি নাম'],
            ['brn','জন্ম নিবন্ধন নম্বর'], ['dob','জন্ম তারিখ'],
            ['registrationOffice','Registration Office']
        ];
        const missing = d => requiredVerifiedFields.filter(([key])=>!String(d?.[key]||'').trim());
        const waitStarted=Date.now();
        let attempt=0, previousSignature='';
        while(true){
            hydrateFromAllFields(data);
            const absent=missing(data);
            const signature=JSON.stringify({rows:data?.allFields?.length||0,missing:absent.map(x=>x[0])});
            if(signature!==previousSignature){
                console.log('[MAKE RESULT POLL]',JSON.stringify({attempt,elapsedMs:Date.now()-waitStarted,rows:data?.allFields?.length||0,missing:absent.map(x=>x[0]),url:page.url()}));
                previousSignature=signature;
            }
            if(!absent.length) break;
            if(Date.now()-waitStarted>=20000){
                const diag=await page.evaluate(()=>({url:location.href,title:document.title,rows:document.querySelectorAll('table tr').length,bodyLength:(document.body?.innerText||'').length,formCount:document.forms.length})).catch(()=>({url:page.url()}));
                console.warn('[MAKE RESULT INCOMPLETE]',JSON.stringify({elapsedMs:Date.now()-waitStarted,attempt,missing:absent.map(x=>x[0]),page:diag}));
                throw new Error('BDRIS result সম্পূর্ণ পাওয়া যায়নি। খালি ফিল্ড: '+absent.map(x=>x[1]).join(', ')+'। PDF তৈরি বন্ধ করা হয়েছে; আবার যাচাই করুন।');
            }
            await new Promise(r=>setTimeout(r,500));
            attempt++;
            try{data=await extractResult();}catch(err){
                console.warn('[MAKE RESULT EXTRACTION RETRY]',String(err?.message||err).slice(0,180));
                if(page.isClosed()) throw err;
            }
        }
        console.log('[MAKE RESULT READY]',JSON.stringify({elapsedMs:Date.now()-waitStarted,attempt,rows:data?.allFields?.length||0}));

        // Union records can omit the Upazila/District value. Fill only the missing
        // pieces from the cached Bangladesh administrative Geo JSON. City Corporation
        // and Pourashava behaviour is intentionally left unchanged.
        // Registration Office is authoritative: use only the value captured
        // from the actual eVerify `Registration Office` row. No geo/location
        // mapping is allowed to replace or shorten it.
        data.registrationOffice = String(data.registrationOffice || '').replace(/\s+/g, ' ').trim();

        // DIRECT eVerify GEO FIX: resolve District/Upazila from eVerify's own
        // `Location Of the Registered Office` after page.evaluate() returns.
        // This is intentionally outside page.evaluate so the Node-side parser is
        // always available and does not depend on browser-context scope.
        try {
            const locationGeo = extractGeoFromRegisteredOfficeLocation(data?.registerOfficeLocation || '');
            if (locationGeo) {
                data.verifyGeo = locationGeo;
                if (locationGeo.type === 'city') {
                    const city = String(locationGeo.cityCorporation || '').replace(/\s+/g, ' ').trim();
                    const district = String(locationGeo.district || '').replace(/\s+/g, ' ').trim();
                    if (city) {
                        data.upazilaPouroshavaUnion = district ? `${city}, ${district}` : city;
                    }
                } else if (locationGeo.type === 'local') {
                    data.upazilaPouroshavaUnion = [locationGeo.upazila, locationGeo.district]
                        .filter(Boolean).join(' ').trim();

                }
            }
            console.log('[EVERIFY][GEO] Direct Location parser:', JSON.stringify({
                location: data?.registerOfficeLocation || '',
                parsed: data?.verifyGeo || null,
                finalValue: data?.upazilaPouroshavaUnion || ''
            }, null, 2));
        } catch (geoErr) {
            console.warn('[EVERIFY][GEO] Direct Location parse failed:', geoErr.message);
        }

        // Original RUN Server fallback: only use verified address if the official
        // registered-office location has not produced a GEO result.
        if (!data.verifyGeo && !String(data.upazilaPouroshavaUnion || '').trim()) {
            const addressGeo = extractGeoFromVerifyAddress(data.permanentAddressEn, data.permanentAddressBn);
            if (addressGeo) {
                data.verifyGeo = addressGeo;
                data.upazilaPouroshavaUnion = [addressGeo.upazila, addressGeo.district].filter(Boolean).join(' ').trim();
                console.log('[EVERIFY][GEO] original address fallback:', JSON.stringify(addressGeo));
            }
        }
        await applyUnionGeoFallback(data);

        /* =====================================================
           VERIFIED ONLINE COPY (V202)
        ===================================================== */
        let verifiedScreenshot = '';
        if (captureVerified) {
            // Capture the actual BDRIS eVerify result page before the live page is closed.
            // This is never synthesized from Gemini or from the local PDF template.
            const screenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(err => { console.error('[MAKE VERIFIED SCREENSHOT]',err.stack||err.message); throw err; });
            verifiedScreenshot = `data:image/png;base64,${screenshotBase64}`;
        }

        /* =====================================================
           CLOSE
        ===================================================== */

        await disposeMakeSession(sessionId, session);

        res.json({

            ok: true,

            data,
            verifiedScreenshot

        });


    } catch (err) {
        console.error('[MAKE SESSION ERROR]', JSON.stringify({session:String(sessionId).slice(0,8),message:String(err?.message||err)}));
        await disposeMakeSession(sessionId, session);
        res.status(500).json({ok:false,error:err.message});
    } finally {
        activeSubmissions.delete(sessionId);
    }

});



/* =========================================================
   QR GENERATOR
   ---------------------------------------------------------
   No Python dependency. Node 18+ built-in fetch is used to
   obtain a PNG from the QR generator service, then the image
   is returned as a data URL so Puppeteer can embed it in the
   PDF without loading any external resource.
========================================================= */
// V282: Use the existing local QR generator first. The encoded content must
// remain a real, record-specific URL; never synthesize an official QR target.
app.post('/api/qr', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'QR Link দিন।' });
    if (!/^https:\/\//i.test(text)) return res.status(400).json({ok:false,error:'QR-এর জন্য বৈধ verification URL প্রয়োজন।'});
    const { spawn } = require('child_process');
    const script = path.resolve(__dirname, '..', 'qr_generator.py');
    const runLocal = (command, args) => new Promise((resolve, reject) => {
        const child = spawn(command, [...args, script], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
        let output = '', error = '';
        const timer = setTimeout(() => child.kill(), 12000);
        child.stdout.on('data', chunk => { output += chunk.toString(); if(output.length > 3000000) child.kill(); });
        child.stderr.on('data', chunk => { error += chunk.toString().slice(0, 1000); });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(error.slice(0, 150) || 'Local QR process failed'));
            try { const parsed = JSON.parse(output); if(parsed.ok && /^data:image\/png;base64,/.test(parsed.dataUrl)) return resolve(parsed.dataUrl); } catch (_) {}
            reject(new Error('Local QR output invalid'));
        });
        child.stdin.end(JSON.stringify({ text }));
    });
    let localError = null;
    for (const [command, args] of (process.platform === 'win32' ? [['py',['-3']],['python',[]]] : [['python3',[]],['python',[]]])) {
        try { const dataUrl = await runLocal(command,args); return res.json({ok:true,dataUrl, generator:'local'}); }
        catch (err) { localError = err; }
    }
    try {
        const endpoint = 'https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=png&margin=4&data=' + encodeURIComponent(text);
        const response = await fetch(endpoint, { headers: {'Accept':'image/png'}, signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('QR service HTTP ' + response.status);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) throw new Error('Invalid QR PNG');
        return res.json({ok:true,dataUrl:'data:image/png;base64,'+buffer.toString('base64'),generator:'fallback'});
    } catch (err) {
        console.warn('[MAKE QR] local and fallback failed:', String(localError?.message||''),String(err?.message||''));
        return res.status(502).json({ok:false,error:'QR তৈরি করা যায়নি: local generator ও fallback দুটিই ব্যর্থ।'});
    }
});

app.get('/admin.html',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));

/* =========================================================
   HOME
========================================================= */

app.get('/', (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            'index.html'
        )
    );

});


/* =========================================================
   SERVER
========================================================= */

const port =
    process.env.PORT || 3000;


async function startServer(){
  try { await initializeDatabase(); await restorePDFImageLibraryFromNeon(); }
  catch(err) { console.error('[Database] DATABASE_URL is set but Neon connection/schema setup failed:',err.message); process.exitCode=1; return; }
  app.listen(port,'0.0.0.0',()=>{
    console.log(''); console.log('==========================================');
    console.log('🚀 BDRIS SMART AUTO FILL READY'); console.log('==========================================');
    console.log(`🌐 Local: http://localhost:${port}`);
    console.log(`📱 Same-device: http://127.0.0.1:${port}`);
    console.log(pool ? '🗄️ Database: Neon PostgreSQL connected' : '🗄️ Database: local JSON fallback (not durable cloud storage)');
    console.log('ℹ️ If running on a PC, open the PC LAN IP from the phone.'); console.log('');
    setTimeout(() => { getSharedBrowser().catch(() => {}); },2500);
  });
}
startServer();