const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Keep Puppeteer cache identical during build and runtime. This must be set
// BEFORE requiring Puppeteer so its configuration resolves the same cache.
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache', 'puppeteer');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const cors = require('cors');
let dbPool = null;
try { const { Pool } = require('pg'); if (process.env.DATABASE_URL) dbPool = new Pool({connectionString:process.env.DATABASE_URL, ssl:process.env.DATABASE_URL.includes('localhost') ? false : {rejectUnauthorized:false}, max:5, connectionTimeoutMillis:8000, idleTimeoutMillis:30000}); } catch (e) { console.warn('PostgreSQL module unavailable:', e.message); }
const app = express();

app.use(cors());
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
    'NotoSerifBengali-Condensed.ttf'
  ]);
  if (!allowed.has(file)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'fonts', file));
});

const sessions = new Map();
const LOCAL_DIRECT_MODE = String(process.env.LOCAL_DIRECT_MODE || 'false').toLowerCase() === 'true';

// LOCAL DIRECT FINAL: main application APIs never require a user login.
// Admin endpoints remain protected separately by requireAdmin.
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
function sealUserPayload(user){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',authSecret(),iv);const plain=Buffer.from(JSON.stringify({id:user.id,username:user.username,name:user.name||'',passwordHash:user.passwordHash,accessToken:user.accessToken,enabled:user.enabled!==false,createdAt:user.createdAt||Date.now(),balance:Number(user.balance)||0,previewRate:Number.isFinite(Number(user.previewRate))&&Number(user.previewRate)>=0?Number(user.previewRate):4}),'utf8');const enc=Buffer.concat([cipher.update(plain),cipher.final()]);const tag=cipher.getAuthTag();return Buffer.concat([iv,tag,enc]).toString('base64url');}
function openUserPayload(value){try{const b=Buffer.from(String(value||''),'base64url');if(b.length<28)return null;const decipher=crypto.createDecipheriv('aes-256-gcm',authSecret(),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8'));}catch(_){return null;}}
function loadAuthStore(){try{return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));}catch(_){const store={users:[],admin:{username:process.env.ADMIN_USERNAME||'admin',passwordHash:hashPassword(process.env.ADMIN_PASSWORD||'change-this-admin-password')}};fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));return store;}}
function saveAuthStore(store){fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));}
const authStore=loadAuthStore();
for(const u of (authStore.users||[])){ if(!Number.isFinite(Number(u.balance))) u.balance=0; }
saveAuthStore(authStore);
const authSessions=new Map();
async function initPersistentDb(){
  if(!dbPool) return false;
  let lastErr=null;
  for(let attempt=1;attempt<=5;attempt++){
    try{
      await dbPool.query(`CREATE TABLE IF NOT EXISTS bdris_users (id text primary key, username text unique not null, name text default '', password_hash text not null, access_token text unique not null, enabled boolean default true, device_id text default '', created_at bigint, last_login_at bigint, balance numeric default 0, preview_rate numeric default 4)`);
      await dbPool.query(`CREATE TABLE IF NOT EXISTS bdris_balance_history (id bigserial primary key, user_id text not null, change_amount numeric not null, balance_after numeric not null, action text, note text, created_at timestamptz default now())`);
      await dbPool.query(`CREATE TABLE IF NOT EXISTS bdris_pdf_images (id text primary key, name text unique not null, mime_type text default '', data_base64 text default '', office text default '', zone_number text default '', x numeric default 105, y numeric default 247, w numeric default 24, h numeric default 10, z numeric default 100, created_at bigint, updated_at bigint)`);
      const r=await dbPool.query('SELECT * FROM bdris_users ORDER BY created_at ASC');
      if(r.rows.length){
        authStore.users = r.rows.map(row=>({id:row.id,username:row.username,name:row.name||'',passwordHash:row.password_hash,accessToken:row.access_token,enabled:row.enabled!==false,deviceId:row.device_id||'',createdAt:Number(row.created_at)||Date.now(),lastLoginAt:row.last_login_at?Number(row.last_login_at):null,balance:Number(row.balance)||0,previewRate:Number(row.preview_rate)>=0?Number(row.preview_rate):4}));
        saveAuthStore(authStore);
      } else if(authStore.users.length){ await persistAllUsers(); }
      const im=await dbPool.query('SELECT * FROM bdris_pdf_images ORDER BY created_at ASC');
      if(im.rows.length){
        pdfImageStore.images=im.rows.map(row=>({id:row.id,name:row.name,fileName:'',mimeType:row.mime_type||'',dataBase64:row.data_base64||'',office:row.office||'',zoneNumber:row.zone_number||'',imagePositionX:Number(row.x),imagePositionY:Number(row.y),imageWidth:Number(row.w),imageHeight:Number(row.h),imageZoom:Number(row.z),createdAt:Number(row.created_at)||Date.now(),updatedAt:Number(row.updated_at)||Date.now()}));
        savePDFImageLibrary(pdfImageStore);
      } else { await persistAllImages(); }
      console.log('✅ PostgreSQL persistence ready'); return true;
    }catch(e){ lastErr=e; console.warn(`⚠️ PostgreSQL init attempt ${attempt}/5 failed:`,e.message); if(attempt<5) await new Promise(r=>setTimeout(r,1000*attempt)); }
  }
  console.error('❌ PostgreSQL init failed after retries:',lastErr?.message||'unknown error'); return false;
}
async function persistUser(user){ if(!dbPool||!user)return; await dbPool.query(`INSERT INTO bdris_users(id,username,name,password_hash,access_token,enabled,device_id,created_at,last_login_at,balance,preview_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,access_token=EXCLUDED.access_token,enabled=EXCLUDED.enabled,device_id=EXCLUDED.device_id,created_at=EXCLUDED.created_at,last_login_at=EXCLUDED.last_login_at,balance=EXCLUDED.balance,preview_rate=EXCLUDED.preview_rate`,[user.id,user.username,user.name||'',user.passwordHash,user.accessToken,user.enabled!==false,user.deviceId||'',user.createdAt||Date.now(),user.lastLoginAt||null,Number(user.balance)||0,Number.isFinite(Number(user.previewRate))?Number(user.previewRate):4]); }
async function persistAllUsers(){ if(!dbPool)return; for(const u of authStore.users) await persistUser(u); }
async function recordBalanceHistory(user,change,action,note){ if(!dbPool||!user)return; await dbPool.query(`INSERT INTO bdris_balance_history(user_id,change_amount,balance_after,action,note) VALUES($1,$2,$3,$4,$5)`,[user.id,change,Number(user.balance)||0,action,note||'']); }
async function persistImageRecord(img){ if(!dbPool||!img)return; await dbPool.query(`INSERT INTO bdris_pdf_images(id,name,mime_type,data_base64,office,zone_number,x,y,w,h,z,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,mime_type=EXCLUDED.mime_type,data_base64=EXCLUDED.data_base64,office=EXCLUDED.office,zone_number=EXCLUDED.zone_number,x=EXCLUDED.x,y=EXCLUDED.y,w=EXCLUDED.w,h=EXCLUDED.h,z=EXCLUDED.z,updated_at=EXCLUDED.updated_at`,[img.id,img.name,img.mimeType||'',img.dataBase64||'',img.office||'',img.zoneNumber||'',Number(img.imagePositionX??105),Number(img.imagePositionY??247),Number(img.imageWidth??24),Number(img.imageHeight??10),Number(img.imageZoom??100),img.createdAt||Date.now(),img.updatedAt||Date.now()]); }
async function persistAllImages(){ if(!dbPool)return; for(const img of pdfImageStore.images||[]) await persistImageRecord(img); }


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

app.get('/api/health',(req,res)=>res.json({ok:true,service:'BDRIS AutoFill',time:Date.now()}));
app.get('/api/runtime/browser',(req,res)=>res.json({ok:true,cacheDir:process.env.PUPPETEER_CACHE_DIR,serviceDir:__dirname,node:process.version}));

// Public lightweight health-check endpoint for uptime monitoring.
// Kept outside authentication so monitoring services can reach it.
app.get('/ping',(req,res)=>res.status(200).send('Server is active'));

const PDF_IMAGE_DIR = path.join(__dirname, 'data', 'pdf-images');
const PDF_IMAGE_INDEX = path.join(PDF_IMAGE_DIR, 'library.json');
fs.mkdirSync(PDF_IMAGE_DIR, { recursive: true });
function loadPDFImageLibrary(){
  try { return JSON.parse(fs.readFileSync(PDF_IMAGE_INDEX,'utf8')); }
  catch(_){ return {images:[]}; }
}
function savePDFImageLibrary(store){ fs.writeFileSync(PDF_IMAGE_INDEX, JSON.stringify(store,null,2)); }
function safeImageName(name){ return String(name||'').trim().replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').slice(0,120); }
const DEFAULT_PDF_IMAGE_NAMES = ['জুন-০৭','জুন-০৮','জুন-০৯','উত্তর','চট্টগ্রাম সিটি zon-03','zon-2','zon-01','zon-05','union'];
let pdfImageStore = loadPDFImageLibrary();
if(!Array.isArray(pdfImageStore.images)) pdfImageStore={images:[]};
let changedDefaultImages=false;
for(const name of DEFAULT_PDF_IMAGE_NAMES){
  if(!pdfImageStore.images.some(x=>x.name===name)){
    pdfImageStore.images.push({id:crypto.randomBytes(12).toString('hex'),name,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now()});
    changedDefaultImages=true;
  }
}
if(changedDefaultImages) savePDFImageLibrary(pdfImageStore);
let dbPersistentReady=false;
const DB_READY = dbPool ? initPersistentDb().then(ok=>{dbPersistentReady=!!ok;return ok;}).catch(()=>false) : Promise.resolve(false);
function pdfImageMeta(x){ return {id:x.id,name:x.name,fileName:x.fileName||'',mimeType:x.mimeType||'',hasImage:!!(x.fileName||x.dataBase64),office:x.office||'',zoneNumber:x.zoneNumber||'',imagePositionX:Number(x.imagePositionX??105),imagePositionY:Number(x.imagePositionY??247),imageWidth:Number(x.imageWidth??24),imageHeight:Number(x.imageHeight??10),imageZoom:Number(x.imageZoom??100),createdAt:x.createdAt,updatedAt:x.updatedAt}; }
function newToken(){return crypto.randomBytes(32).toString('hex');}
function authUser(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const session=authSessions.get(token);if(!session)return null;if(Date.now()-session.createdAt>7*24*60*60*1000){authSessions.delete(token);return null;}return session;}
app.post('/api/auth/login',async(req,res)=>{
  if(dbPool && !(await ensureDbReady())) return res.status(503).json({ok:false,error:'Database is still starting. Please retry in a moment.'});
  const {username,password,accessToken,deviceId,userId,auth}=req.body||{};
  if(!username||!password||!deviceId) return res.status(400).json({ok:false,error:'Username, password এবং device তথ্য প্রয়োজন।'});
  let user=null;
  if(accessToken) user=authStore.users.find(u=>u.accessToken===accessToken);
  if(!user&&userId) user=authStore.users.find(u=>u.id===String(userId));
  if(!user&&auth){const r=openUserPayload(auth);if(r&&(!accessToken||r.accessToken===accessToken)&&(!userId||r.id===String(userId||r.id))&&r.username===username&&r.enabled!==false&&r.passwordHash===hashPassword(password)){const stored=authStore.users.find(u=>u.id===r.id);user=stored||{...r,deviceId:'',lastLoginAt:null,balance:Number(r.balance)||0,previewRate:Number(r.previewRate)>=0?Number(r.previewRate):4};if(!stored)authStore.users.push(user);saveAuthStore(authStore);}}
  if(!user) user=authStore.users.find(u=>u.username===username);
  if(!user||!user.enabled) return res.status(403).json({ok:false,error:'এই User account সক্রিয় নেই।'});
  if(user.username!==username||user.passwordHash!==hashPassword(password)) return res.status(401).json({ok:false,error:'Username বা Password ভুল।'});
  if(user.deviceId&&user.deviceId!==deviceId) return res.status(403).json({ok:false,error:'এই User account অন্য একটি device-এর সাথে যুক্ত আছে।'});
  if(!user.deviceId) user.deviceId=deviceId;
  user.lastLoginAt=Date.now(); saveAuthStore(authStore); persistUser(user).catch(e=>console.warn('user persist:',e.message));
  const token=newToken();
  authSessions.set(token,{kind:'user',userId:user.id,username:user.username,name:user.name||'',accessToken:user.accessToken,createdAt:Date.now()});
  res.json({ok:true,token,auth:sealUserPayload(user),balance:Number(user.balance)||0,user:{id:user.id,username:user.username,name:user.name||''}});
});
app.post('/api/auth/admin-login',(req,res)=>{const {username,password}=req.body||{};if(username!==authStore.admin.username||hashPassword(password||'')!==authStore.admin.passwordHash)return res.status(401).json({ok:false,error:'Admin username বা password ভুল।'});const token=newToken();authSessions.set(token,{kind:'admin',username,createdAt:Date.now()});res.json({ok:true,token});});
async function ensureDbReady(){
  if(!dbPool) return true;
  await DB_READY;
  return dbPersistentReady;
}
async function requireAuth(req,res,next){
  // LOCAL DIRECT MODE: never require a user account for the main local application.
  // Admin endpoints are still protected by requireAdmin.
  if (LOCAL_DIRECT_MODE) {
    req.auth={kind:'local',userId:'local',username:'local',name:'Local User',accessToken:'LOCAL',createdAt:Date.now()};
    return next();
  }
  if(dbPool && !(await ensureDbReady())) return res.status(503).json({ok:false,error:'Database is still starting. Please retry in a moment.'});
  const session=authUser(req);
  if(!session) return res.status(401).json({ok:false,error:'Login required.'});
  req.auth=session;
  next();
}
async function requireAdmin(req,res,next){if(dbPool && !(await ensureDbReady())) return res.status(503).json({ok:false,error:'Database is still starting. Please retry in a moment.'});const session=authUser(req);if(!session||session.kind!=='admin')return res.status(403).json({ok:false,error:'Admin access required.'});req.auth=session;next();}
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({ok:true,session:req.auth}));
app.get('/api/balance',requireAuth,async(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId);
  if(!user)return res.status(404).json({ok:false,error:'User not found.'});
  if(dbPool){
    const r=await dbPool.query('SELECT balance, preview_rate FROM bdris_users WHERE id=$1',[user.id]);
    if(!r.rows.length)return res.status(404).json({ok:false,error:'User not found in database.'});
    user.balance=Number(r.rows[0].balance)||0;
    user.previewRate=Number(r.rows[0].preview_rate)>=0?Number(r.rows[0].preview_rate):4;
  }
  res.json({ok:true,balance:Number(user.balance)||0,previewRate:Number(user.previewRate)>=0?Number(user.previewRate):4,auth:sealUserPayload(user)});
});

app.post('/api/balance/charge',requireAuth,async(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId);
  if(!user)return res.status(404).json({ok:false,error:'User not found.'});
  const amount=Math.max(0,Number.isFinite(Number(user.previewRate))?Number(user.previewRate):4);
  if(dbPool){
    const client=await dbPool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT balance, preview_rate FROM bdris_users WHERE id=$1 FOR UPDATE',[user.id]);
      if(!r.rows.length){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'User not found in database.'});}
      const current=Number(r.rows[0].balance)||0;
      const rate=Math.max(0,Number.isFinite(Number(r.rows[0].preview_rate))?Number(r.rows[0].preview_rate):4);
      if(current<rate){await client.query('ROLLBACK');user.balance=current;user.previewRate=rate;return res.status(402).json({ok:false,error:`Balance কম। Preview করতে ৳${rate} প্রয়োজন।`,balance:current,previewRate:rate});}
      const next=Math.round((current-rate)*100)/100;
      await client.query('UPDATE bdris_users SET balance=$1 WHERE id=$2',[next,user.id]);
      await client.query('INSERT INTO bdris_balance_history(user_id,change_amount,balance_after,action,note) VALUES($1,$2,$3,$4,$5)',[user.id,-rate,next,'preview_charge','Certificate Preview charge']);
      await client.query('COMMIT');
      user.balance=next; user.previewRate=rate; saveAuthStore(authStore);
      return res.json({ok:true,balance:next,charged:rate,previewRate:rate,auth:sealUserPayload(user)});
    }catch(e){try{await client.query('ROLLBACK');}catch(_){};console.error('balance charge transaction failed:',e.message);return res.status(503).json({ok:false,error:'Balance save failed. টাকা কাটা হয়নি; আবার চেষ্টা করুন।'});}finally{client.release();}
  }
  user.balance=Number(user.balance)||0;
  if(user.balance<amount)return res.status(402).json({ok:false,error:`Balance কম। Preview করতে ৳${amount} প্রয়োজন।`,balance:user.balance,previewRate:amount});
  const oldBalance=user.balance;
  user.balance=Math.round((user.balance-amount)*100)/100;
  try{
    await recordBalanceHistory(user,-amount,'preview_charge','Certificate Preview charge');
    await persistUser(user);
    saveAuthStore(authStore);
  }catch(e){
    user.balance=oldBalance;
    return res.status(503).json({ok:false,error:'Balance save failed. টাকা কাটা হয়নি; আবার চেষ্টা করুন।'});
  }
  res.json({ok:true,balance:user.balance,charged:amount,previewRate:amount,auth:sealUserPayload(user)});
});


app.get('/api/admin/users',requireAdmin,(req,res)=>res.json({ok:true,users:authStore.users.map(u=>{const {passwordHash,...safe}=u;safe.auth=sealUserPayload(u);return safe;})}));
app.post('/api/admin/users',requireAdmin,(req,res)=>{const {username,password,name=''}=req.body||{};if(!username||!password)return res.status(400).json({ok:false,error:'Username এবং password দিন।'});if(authStore.users.some(u=>u.username===username))return res.status(409).json({ok:false,error:'Username already exists.'});const user={id:newToken().slice(0,16),username,name,passwordHash:hashPassword(password),accessToken:newToken(),enabled:true,deviceId:'',createdAt:Date.now(),lastLoginAt:null,balance:0,previewRate:4};authStore.users.push(user);saveAuthStore(authStore);persistUser(user).catch(e=>console.warn('user persist:',e.message));const {passwordHash,...safe}=user;res.json({ok:true,user:safe,link:`?access=${user.accessToken}&uid=${encodeURIComponent(user.id)}&auth=${encodeURIComponent(sealUserPayload(user))}`});});
app.patch('/api/admin/users/:id',requireAdmin,async(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.params.id);
  if(!user)return res.status(404).json({ok:false,error:'User not found.'});
  const body=req.body||{};
  if(typeof body.enabled==='boolean')user.enabled=body.enabled;
  if(body.resetDevice)user.deviceId='';
  if(body.newPassword)user.passwordHash=hashPassword(body.newPassword);
  if(body.setPreviewRate!==undefined){const n=Number(body.setPreviewRate);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid preview rate.'});user.previewRate=Math.round(n*100)/100;}
  const wantsSet=body.setBalance!==undefined, wantsAdd=body.addBalance!==undefined;
  if(wantsSet||wantsAdd){
    if(wantsSet&&wantsAdd)return res.status(400).json({ok:false,error:'Use setBalance or addBalance, not both.'});
    const n=Number(wantsSet?body.setBalance:body.addBalance);
    if(!Number.isFinite(n)||(wantsSet&&n<0))return res.status(400).json({ok:false,error:'Invalid balance.'});
    if(dbPool){
      const client=await dbPool.connect();
      try{
        await client.query('BEGIN');
        const r=await client.query('SELECT balance FROM bdris_users WHERE id=$1 FOR UPDATE',[user.id]);
        if(!r.rows.length){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'User not found in database.'});}
        const old=Number(r.rows[0].balance)||0;
        const next=wantsSet?Math.round(n*100)/100:Math.round((old+n)*100)/100;
        if(next<0){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Balance cannot be negative.'});}
        const change=Math.round((next-old)*100)/100;
        await client.query('UPDATE bdris_users SET balance=$1, preview_rate=$2, enabled=$3, device_id=$4, password_hash=$5, name=$6 WHERE id=$7',[next,Number(user.previewRate)>=0?Number(user.previewRate):4,user.enabled!==false,user.deviceId||'',user.passwordHash,user.name||'',user.id]);
        if(change!==0)await client.query('INSERT INTO bdris_balance_history(user_id,change_amount,balance_after,action,note) VALUES($1,$2,$3,$4,$5)',[user.id,change,wantsSet?'admin_set_balance':'admin_add_balance',wantsSet?'Admin Set Balance':'Admin Add Balance']);
        await client.query('COMMIT');
        user.balance=next; saveAuthStore(authStore);
      }catch(e){try{await client.query('ROLLBACK');}catch(_){};console.error('admin balance transaction failed:',e.message);return res.status(503).json({ok:false,error:'Balance save failed. কোনো পরিবর্তন সংরক্ষণ করা হয়নি।'});}finally{client.release();}
    }else{
      const old=Number(user.balance)||0; const next=wantsSet?Math.round(n*100)/100:Math.round((old+n)*100)/100;
      if(next<0)return res.status(400).json({ok:false,error:'Balance cannot be negative.'}); user.balance=next;
      if(next!==old)await recordBalanceHistory(user,next-old,wantsSet?'admin_set_balance':'admin_add_balance',wantsSet?'Admin Set Balance':'Admin Add Balance');
    }
  }
  saveAuthStore(authStore);
  if(dbPool){
    try{await persistUser(user);}catch(e){return res.status(503).json({ok:false,error:'User data save failed. কোনো পরিবর্তন নিশ্চিতভাবে সংরক্ষণ করা যায়নি।'});}
  } else {try{await persistUser(user);}catch(_){} }
  const {passwordHash,...safe}=user;safe.auth=sealUserPayload(user);res.json({ok:true,user:safe});
});

app.get('/api/admin/users/:id/balance-history',requireAdmin,async(req,res)=>{if(!dbPool)return res.json({ok:true,history:[]});const r=await dbPool.query('SELECT id,change_amount,balance_after,action,note,created_at FROM bdris_balance_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',[req.params.id]);res.json({ok:true,history:r.rows});});
app.delete('/api/admin/users/:id',requireAdmin,async(req,res)=>{const i=authStore.users.findIndex(u=>u.id===req.params.id);if(i<0)return res.status(404).json({ok:false,error:'User not found.'});const id=authStore.users[i].id;authStore.users.splice(i,1);saveAuthStore(authStore);if(dbPool)await dbPool.query('DELETE FROM bdris_users WHERE id=$1',[id]).catch(()=>{});res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(req.path.startsWith('/auth/'))return next();return requireAuth(req,res,next);});


/* =========================================================
   SHARED PDF IMAGE LIBRARY
========================================================= */
app.get('/api/pdf-images', (req,res)=>{
  res.set('Cache-Control','no-store');
  const store=loadPDFImageLibrary();
  res.json({ok:true,images:(store.images||[]).map(pdfImageMeta)});
});

app.post('/api/pdf-images', (req,res)=>{
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
  if(!dataUrl){ savePDFImageLibrary(store); persistImageRecord(image).catch(e=>console.warn('image persist:',e.message)); return res.json({ok:true,image:pdfImageMeta(image),needsUpload:!(image.fileName||image.dataBase64)}); }
  const match=String(dataUrl).match(/^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
  if(!match) return res.status(400).json({ok:false,error:'PNG, JPG/JPEG, WEBP অথবা SVG image upload করা যাবে।'});
  const mime=match[1].toLowerCase()==='image/jpg'?'image/jpeg':match[1].toLowerCase();
  const buffer=Buffer.from(match[2],'base64');
  if(!buffer.length || buffer.length>12*1024*1024) return res.status(400).json({ok:false,error:'Image সর্বোচ্চ 12 MB হতে পারবে।'});
  const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':mime==='image/svg+xml'?'svg':'jpg';
  const fileName=image.id+'.'+ext;
  for(const ext2 of ['png','jpg','webp','svg']){ const old=path.join(PDF_IMAGE_DIR,image.id+'.'+ext2); if(old!==path.join(PDF_IMAGE_DIR,fileName)) try{fs.unlinkSync(old)}catch(_){} }
  fs.writeFileSync(path.join(PDF_IMAGE_DIR,fileName),buffer);
  image.fileName=fileName; image.mimeType=mime; image.dataBase64=buffer.toString('base64'); image.updatedAt=Date.now();
  savePDFImageLibrary(store); persistImageRecord(image).catch(e=>console.warn('image persist:',e.message));
  res.json({ok:true,image:pdfImageMeta(image)});
});

app.patch('/api/pdf-images/:id', (req,res)=>{
  const requested=safeImageName(req.body?.name);
  if(!requested) return res.status(400).json({ok:false,error:'নতুন Image-এর নাম দিন।'});
  let store=loadPDFImageLibrary();
  const image=store.images.find(x=>x.id===req.params.id);
  if(!image) return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  const duplicate=store.images.find(x=>x.name===requested && x.id!==image.id);
  if(duplicate) return res.status(409).json({ok:false,error:'এই নামে আরেকটি Image আগে থেকেই আছে।'});
  image.name=requested; image.updatedAt=Date.now();
  savePDFImageLibrary(store);
  persistImageRecord(image).catch(e=>console.warn('image persist:',e.message));
  res.json({ok:true,image:pdfImageMeta(image)});
});

app.get('/api/pdf-images/:id', (req,res)=>{
  res.set('Cache-Control','no-store');
  const store=loadPDFImageLibrary();
  const image=(store.images||[]).find(x=>x.id===req.params.id);
  if(!image) return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  if(!image.fileName && !image.dataBase64) return res.status(404).json({ok:false,error:'এই নামের জন্য এখনো Image upload করা হয়নি।'});
  if(String(req.query.raw||'')==='1'){ if(image.fileName){const filePath=path.join(PDF_IMAGE_DIR,image.fileName); if(fs.existsSync(filePath)) return res.type(image.mimeType||'image/jpeg').sendFile(filePath);} if(image.dataBase64) return res.type(image.mimeType||'image/jpeg').send(Buffer.from(image.dataBase64,'base64')); return res.status(404).send('Image file পাওয়া যায়নি।'); }
  const data=image.dataBase64 || (image.fileName ? fs.readFileSync(path.join(PDF_IMAGE_DIR,image.fileName)).toString('base64') : '');
  res.json({ok:true,id:image.id,name:image.name,updatedAt:image.updatedAt,mimeType:image.mimeType||'image/jpeg',dataUrl:`data:${image.mimeType||'image/jpeg'};base64,${data}`,office:image.office||'',zoneNumber:image.zoneNumber||'',imagePositionX:Number(image.imagePositionX??105),imagePositionY:Number(image.imagePositionY??247),imageWidth:Number(image.imageWidth??24),imageHeight:Number(image.imageHeight??10),imageZoom:Number(image.imageZoom??100)});
});

app.get('/api/pdf-image-presets', requireAuth, (req,res)=>res.json({ok:true,presets:(pdfImageStore.images||[]).filter(x=>x.office&&x.zoneNumber).map(pdfImageMeta)}));
app.patch('/api/pdf-images/:id/position', requireAdmin, async (req,res)=>{const image=pdfImageStore.images.find(x=>x.id===req.params.id);if(!image)return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});image.office=String(req.body.office||'').trim();image.zoneNumber=String(req.body.zoneNumber||'').replace(/\D/g,'').padStart(2,'0');image.imagePositionX=Math.max(0,Math.min(210,Number(req.body.x)||105));image.imagePositionY=Math.max(0,Math.min(297,Number(req.body.y)||247));image.imageWidth=Math.max(4,Math.min(80,Number(req.body.w)||24));image.imageHeight=Math.max(3,Math.min(40,Number(req.body.h)||10));image.imageZoom=Math.max(50,Math.min(300,Number(req.body.z)||100));image.updatedAt=Date.now();savePDFImageLibrary(pdfImageStore);await persistImageRecord(image).catch(()=>{});res.json({ok:true,image:pdfImageMeta(image)});});
app.delete('/api/pdf-images/:id', requireAdmin, async (req,res)=>{const i=pdfImageStore.images.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});const image=pdfImageStore.images[i];pdfImageStore.images.splice(i,1);savePDFImageLibrary(pdfImageStore);if(dbPool)await dbPool.query('DELETE FROM bdris_pdf_images WHERE id=$1',[image.id]).catch(()=>{});for(const ext of ['png','jpg','webp','svg'])try{fs.unlinkSync(path.join(PDF_IMAGE_DIR,image.id+'.'+ext))}catch(_){}res.json({ok:true});});

const browserLaunchOptions = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
    ]
};

// Puppeteer 25 may expose executablePath() as a Promise in some environments.
// Resolve it before passing it to launch(), otherwise Chromium receives
// "[object Promise]" as the executable path.
async function launchBrowser() {
    const cacheDir = path.join(__dirname, '.cache', 'puppeteer');
    process.env.PUPPETEER_CACHE_DIR = cacheDir;
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files','Google','Chrome','Application','chrome.exe') : null,
        process.platform === 'win32' ? path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe') : null,
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
    ].filter(Boolean);
    let executablePath = candidates.find(p => typeof p === 'string' && fs.existsSync(p)) || null;
    if (!executablePath) {
        try {
            const resolved = await puppeteer.executablePath();
            if (typeof resolved === 'string' && resolved && fs.existsSync(resolved)) executablePath = resolved;
        } catch (_) {}
    }
    const options = { ...browserLaunchOptions };
    if (executablePath) options.executablePath = executablePath;
    try {
        return await puppeteer.launch(options);
    } catch (firstError) {
        if (executablePath) {
            try { return await puppeteer.launch({ ...browserLaunchOptions }); } catch (_) {}
        }
        throw new Error('Chrome/Chromium could not be started. Install Chrome or run `npx puppeteer browsers install chrome`. Original error: ' + (firstError?.message || firstError));
    }
}

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
    } catch (_) {
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

        await page.goto(
            'https://everify.bdris.gov.bd/',
            {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            }
        );

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


        const captchaBase64 =
            await captcha.element.screenshot({
                encoding: 'base64'
            });


        const sessionId =
            crypto.randomUUID();


        sessions.set(
            sessionId,
            {
                browser,
                page
            }
        );


        /* 3 মিনিট session */

        setTimeout(() => {

            if (sessions.has(sessionId)) {

                const session =
                    sessions.get(sessionId);

                session.page
                    .close()
                    .catch(() => {});

                sessions.delete(sessionId);
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
        captcha
    } = req.body;


    if (!sessions.has(sessionId)) {

        return res.status(400).json({

            ok: false,

            error:
                'সেশন এক্সপায়ার হয়ে গেছে। আবার চেষ্টা করুন।'

        });
    }


    const {
        browser,
        page
    } = sessions.get(sessionId);


    try {

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
        await Promise.race([
            page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 8000
            }).catch(() => {}),

            page.waitForFunction(() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const html = document.documentElement?.innerHTML || '';
                const hasRows = document.querySelectorAll('table tr').length > 1;
                const hasResultContainer = !!document.querySelector('#result, .result, .details, [class*="result" i], [id*="result" i]');
                const hasKnownResult = /নিবন্ধিত ব্যক্তির নাম|পিতার নাম|মাতার নাম|registered person|father.?s name|mother.?s name/i.test(text);
                const hasCaptchaError = /captcha|ক্যাপচা|invalid|incorrect|সঠিক নয়|সঠিক নয়|ভুল কোড|verification failed/i.test(text);
                return hasRows || hasResultContainer || hasKnownResult || hasCaptchaError || /certificate\/verify/i.test(html);
            }, { timeout: 8000, polling: 100 }).catch(() => {})
        ]);

        // Give a fast AJAX response a very small settling window. This is not a
        // fixed 20-second wait and does not block on unrelated network requests.
        await new Promise(resolve => setTimeout(resolve, 150));

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

        const data = await page.evaluate(() => {


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

            const result = {

                nameBn:
                    person?.value || '',

                nameEn:
                    person?.englishValue || '',


                fatherBn:
                    fatherName?.value || '',

                fatherEn:
                    fatherName?.englishValue || '',


                fatherNationalityBn:
                    fatherNationality?.value || '',

                fatherNationalityEn:
                    fatherNationality?.englishValue || '',


                motherBn:
                    motherName?.value || '',

                motherEn:
                    motherName?.englishValue || '',


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

            const district = findFieldValue(['District', 'Zila', 'জেলা']);
            const upazila = findFieldValue(['Upazila', 'উপজেলা']);
            const unionRows = findRows(['Union', 'ইউনিয়ন', 'ইউনিয়ন']);
            const pourRows = findRows(['Pouroshava', 'Pourashava', 'পৌরসভা']);
            const cityRows = findRows(['City Corporation', 'সিটি কর্পোরেশন']);
            const unionName = clean(unionRows[0]?.englishValue || unionRows[0]?.value || findFieldValue(['Union', 'ইউনিয়ন', 'ইউনিয়ন']));
            const pourashavaName = clean(pourRows[0]?.englishValue || pourRows[0]?.value || findFieldValue(['Pouroshava', 'Pourashava', 'পৌরসভা']));

            const allText = records.map(r => clean(r.englishValue || r.value || '')).filter(Boolean).join(' | ');
            const allBnText = records.map(r => clean(r.value || '')).filter(Boolean).join(' | ');
            const allLabels = records.map(r => `${clean(r.label)} | ${clean(r.englishLabel)}`).join(' | ');
            const textForOffice = `${officeRaw} | ${allText} | ${allBnText} | ${allLabels}`;

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
            for (const candidate of [
                clean(cityRows[0]?.englishValue || cityRows[0]?.value || ''),
                officeRaw, allText, allBnText, textForOffice
            ]) {
                cityCorporation = extractCityCorporation(candidate);
                if (cityCorporation) break;
            }

            const zoneMatch = officeRaw.match(/(?:ZON(?:E)?|জোন)\s*[- ]?\s*(\d{1,2})/i);
            const isZoneOffice = !!zoneMatch;
            const hasCityOffice = !!cityCorporation || isZoneOffice || /city\s+corporation|সিটি\s*কর্পোরেশন/i.test(textForOffice);
            const hasUnionOffice = !!unionRows.length || /union\s*(parishad)?|ইউনিয়ন|ইউনিয়ন/i.test(textForOffice);
            const hasPourOffice = !!pourRows.length || /pouroshava|pourashava|পৌরসভা/i.test(textForOffice);

            if (hasCityOffice) {
                const zoneNumber = zoneMatch?.[1] || '';
                const zone = zoneNumber ? `Zone - ${String(zoneNumber).padStart(2, '0')}` : clean(officeRaw);
                let city = cityCorporation || clean(officeRaw);
                const textForCity = `${officeRaw} | ${allText} | ${allBnText}`;
                if (/dhaka\s+south|ঢাকা\s*দক্ষিণ|দক্ষিণ\s*সিটি/i.test(textForCity)) city = 'Dhaka South City Corporation';
                else if (/dhaka\s+north|ঢাকা\s*উত্তর|উত্তর\s*সিটি/i.test(textForCity)) city = 'Dhaka North City Corporation';
                else if (/mymensingh\s+city|ময়মনসিংহ.*সিটি|ময়মনসিংহ.*সিটি/i.test(textForCity)) city = 'Mymensingh City Corporation';
                if (!/city\s+corporation|সিটি\s*কর্পোরেশন/i.test(city)) city = `${city} City Corporation`;
                city = clean(city).replace(/\s+/g, ' ').trim();
                const cityName = city
                    .replace(/\s+(?:South|North)\s+City\s+Corporation$/i, '')
                    .replace(/\s+City\s+Corporation$/i, '')
                    .trim() || 'Dhaka';
                result.registrationOffice = zone ? `${zone}, ${city}` : city;
                result.upazilaPouroshavaUnion = `${city}, ${cityName}`;
            } else if (hasUnionOffice) {
                const unionSource = unionName || officeRaw;
                const formatted = formatUnionOffice(unionSource);
                if (formatted) result.registrationOffice = formatted;
                result.upazilaPouroshavaUnion = [upazila, district].filter(Boolean).join(' ').trim();
            } else if (hasPourOffice) {
                const office = pourashavaName || officeRaw;
                result.registrationOffice = office;
                result.upazilaPouroshavaUnion = [district, upazila].filter(Boolean).join(' ').trim();
            } else {
                result.registrationOffice = officeRaw;
                // If the source gives a combined local-government field but no
                // separate classification, retain its value instead of blanking it.
                if (!result.upazilaPouroshavaUnion) {
                    result.upazilaPouroshavaUnion = findFieldValue([
                        'Upazila/Pouroshava/City Corporation, Zila',
                        'উপজেলা/পৌরসভা/সিটি কর্পোরেশন, জেলা',
                        'Upazila/Pouroshava/Union',
                        'উপজেলা/পৌরসভা/ইউনিয়ন'
                    ]);
                }
            }
            return result;

        });


        /* =====================================================
           CHECK
        ===================================================== */

        if (
            !data.allFields.length &&
            !data.nameBn &&
            !data.nameEn &&
            !data.brn
        ) {

            throw new Error(
                'BDRIS থেকে কোনো result data পাওয়া যায়নি। captcha সঠিক ছিল কি না যাচাই করুন।'
            );
        }


        // Union records can omit the Upazila/District value. Fill only the missing
        // pieces from the cached Bangladesh administrative Geo JSON. City Corporation
        // and Pourashava behaviour is intentionally left unchanged.
        await applyUnionGeoFallback(data);

        /* =====================================================
           CLOSE
        ===================================================== */

        await page.close().catch(() => {});

        sessions.delete(sessionId);


        res.json({

            ok: true,

            data

        });


    } catch (err) {

        sessions.delete(sessionId);

        await browser
            .close()
            .catch(() => {});


        res.status(500).json({

            ok: false,

            error: err.message

        });

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
app.post('/api/qr', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'QR Link দিন।' });

    try {
        const endpoint =
            'https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=png&margin=4&data=' +
            encodeURIComponent(text);

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Accept': 'image/png' },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            throw new Error(`QR service HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('image/png')) {
            throw new Error('QR service returned an invalid image');
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error('QR image is empty');

        return res.json({
            ok: true,
            dataUrl: 'data:image/png;base64,' + buffer.toString('base64')
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: 'QR তৈরি করা যায়নি: ' + (err?.message || 'QR service error')
        });
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


(async()=>{ await DB_READY; app.listen(
    port,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            '🚀 BDRIS SMART AUTO FILL READY'
        );
        console.log(
            '=========================================='
        );
        console.log(
            `🌐 Local: http://localhost:${port}`
        );
        console.log(`📱 Same-device: http://127.0.0.1:${port}`);
        console.log('ℹ️ If running on a PC, open the PC LAN IP from the phone.');
        console.log('');
        // Warm Chrome in the background after startup so the first Preview does not
        // pay the full browser-launch cost. Fail silently; the normal lazy path remains.
        setTimeout(() => {
            getSharedBrowser().catch(() => {});
        }, 2500);

    }
); })().catch(err=>{ console.error('Server startup failed:',err); process.exit(1); });