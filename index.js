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
const app = express();

app.use(cors());
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
let pgPool=null, pgReady=false, pgSyncTimer=null, pgSyncInFlight=false;

const AUTH_DIR = path.join(__dirname, '.private');
const AUTH_FILE = path.join(AUTH_DIR, 'users.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });
function hashPassword(password){return crypto.createHash('sha256').update(String(password)).digest('hex');}
function authSecret(){return crypto.createHash('sha256').update(String(process.env.AUTH_SECRET||process.env.ADMIN_PASSWORD||'BDRIS-AUTO-FILL-AUTH-SECRET')).digest();}
function sealUserPayload(user){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',authSecret(),iv);const plain=Buffer.from(JSON.stringify({id:user.id,username:user.username,name:user.name||'',passwordHash:user.passwordHash,accessToken:user.accessToken,enabled:user.enabled!==false,createdAt:user.createdAt||Date.now(),balance:Number(user.balance)||0,previewRate:Number.isFinite(Number(user.previewRate))&&Number(user.previewRate)>=0?Number(user.previewRate):4,role:user.role||'customer',parentId:user.parentId||'',rate:Number.isFinite(Number(user.rate))?Number(user.rate):Number(user.previewRate)||4}),'utf8');const enc=Buffer.concat([cipher.update(plain),cipher.final()]);const tag=cipher.getAuthTag();return Buffer.concat([iv,tag,enc]).toString('base64url');}
function openUserPayload(value){try{const b=Buffer.from(String(value||''),'base64url');if(b.length<28)return null;const decipher=crypto.createDecipheriv('aes-256-gcm',authSecret(),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8'));}catch(_){return null;}}
function loadAuthStore(){try{return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));}catch(_){const store={users:[],admin:{username:process.env.ADMIN_USERNAME||'admin',passwordHash:hashPassword(process.env.ADMIN_PASSWORD||'change-this-admin-password')}};fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));return store;}}
function saveAuthStore(store){fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2)); queuePgSync();}
function saveAuthStoreLocalOnly(store){try{fs.writeFileSync(AUTH_FILE,JSON.stringify(store,null,2));}catch(_){} }
async function initPostgres(){
  if(!process.env.DATABASE_URL) return;
  try{
    const {Pool}=require('pg');
    pgPool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:5,idleTimeoutMillis:30000});
    await pgPool.query(`CREATE TABLE IF NOT EXISTS bdris_users (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pgPool.query(`CREATE TABLE IF NOT EXISTS bdris_transactions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,certificate_id TEXT,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());`);
    const rows=(await pgPool.query('SELECT data FROM bdris_users ORDER BY updated_at ASC')).rows;
    if(rows.length){
      const merged=new Map();
      for(const r of rows){const u=r.data||{}; if(u.id) merged.set(String(u.id),u);}
      for(const u of (authStore.users||[])){if(u.id && !merged.has(String(u.id))) merged.set(String(u.id),u);}
      authStore.users=Array.from(merged.values());
      saveAuthStoreLocalOnly(authStore);
      for(const u of authStore.users) await pgPool.query('INSERT INTO bdris_users(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',[String(u.id),u]);
    } else if((authStore.users||[]).length){ for(const u of authStore.users) await pgPool.query('INSERT INTO bdris_users(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',[String(u.id),u]); }
    pgReady=true; console.log('🐘 PostgreSQL persistence: READY');
  }catch(e){ pgPool=null; pgReady=false; console.warn('⚠️ PostgreSQL unavailable; using local JSON fallback:',e.message); }
}
async function syncPostgres(){
  if(!pgPool||!pgReady||pgSyncInFlight)return; pgSyncInFlight=true;
  try{
    await pgPool.query('BEGIN');
    for(const u of authStore.users||[]) await pgPool.query('INSERT INTO bdris_users(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',[String(u.id),u]);
    if((authStore.users||[]).length) await pgPool.query('DELETE FROM bdris_users WHERE NOT (id = ANY($1::text[]))',[(authStore.users||[]).map(u=>String(u.id))]);
    await pgPool.query('COMMIT');
  }catch(e){try{await pgPool.query('ROLLBACK')}catch(_){} console.warn('PostgreSQL sync failed:',e.message);} finally{pgSyncInFlight=false;}
}
function queuePgSync(){if(!pgReady)return;clearTimeout(pgSyncTimer);pgSyncTimer=setTimeout(()=>syncPostgres().catch(()=>{}),150);}

const authStore=loadAuthStore();
if(!Array.isArray(authStore.transactions)) authStore.transactions=[];
for(const u of (authStore.users||[])){ if(!Number.isFinite(Number(u.balance))) u.balance=0; if(!Number.isFinite(Number(u.previewRate))||Number(u.previewRate)<0) u.previewRate=4; }
saveAuthStore(authStore);
const authSessions=new Map();
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
const PDF_LAYOUT_FILE = path.join(__dirname, 'data', 'pdf-layout.json');
const PDF_LAYOUT_DEFAULTS = {
  brn: {x:0,y:0}, dob:{x:0,y:0}, inword:{x:0,y:0}, nameBn:{x:0,y:0}, nameEn:{x:0,y:0},
  motherBn:{x:0,y:0}, motherEn:{x:0,y:0}, motherNatBn:{x:0,y:0}, motherNatEn:{x:0,y:0},
  fatherBn:{x:0,y:0}, fatherEn:{x:0,y:0}, fatherNatBn:{x:0,y:0}, fatherNatEn:{x:0,y:0},
  pobBn:{x:0,y:0}, pobEn:{x:0,y:0}, addrBn:{x:0,y:0}, addrEn:{x:0,y:0},
  registrationOffice:{x:0,y:0}, upazilaUnion:{x:0,y:0}, sex:{x:0,y:0}, regDate:{x:0,y:0}, issuanceDate:{x:0,y:0}
};
function loadPDFLayout(){try{const v=JSON.parse(fs.readFileSync(PDF_LAYOUT_FILE,'utf8'));return {...PDF_LAYOUT_DEFAULTS,...v};}catch(_){return JSON.parse(JSON.stringify(PDF_LAYOUT_DEFAULTS));}}
function savePDFLayout(v){fs.mkdirSync(path.dirname(PDF_LAYOUT_FILE),{recursive:true});fs.writeFileSync(PDF_LAYOUT_FILE,JSON.stringify(v,null,2));}
let pdfLayoutStore=loadPDFLayout();
let pdfImageStore = loadPDFImageLibrary();
if(!Array.isArray(pdfImageStore.images)) pdfImageStore={images:[]};
for(const im of pdfImageStore.images){ if(!im.defaultPosition) im.defaultPosition={x:105,y:247,width:24,height:10,zoom:100}; }
let changedDefaultImages=false;
for(const name of DEFAULT_PDF_IMAGE_NAMES){
  if(!pdfImageStore.images.some(x=>x.name===name)){
    pdfImageStore.images.push({id:crypto.randomBytes(12).toString('hex'),name,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now()});
    changedDefaultImages=true;
  }
}
if(changedDefaultImages) savePDFImageLibrary(pdfImageStore);
function pdfImageMeta(x){
  const p=x.defaultPosition||{};
  return {id:x.id,name:x.name,fileName:x.fileName||'',mimeType:x.mimeType||'',hasImage:!!x.fileName,createdAt:x.createdAt,updatedAt:x.updatedAt,
    defaultPosition:{x:Number.isFinite(Number(p.x))?Number(p.x):105,y:Number.isFinite(Number(p.y))?Number(p.y):247,
      width:Number.isFinite(Number(p.width))?Number(p.width):24,height:Number.isFinite(Number(p.height))?Number(p.height):10,
      zoom:Number.isFinite(Number(p.zoom))?Number(p.zoom):100}};
}
function newToken(){return crypto.randomBytes(32).toString('hex');}
function authUser(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const session=authSessions.get(token);if(!session)return null;if(Date.now()-session.createdAt>7*24*60*60*1000){authSessions.delete(token);return null;}return session;}
app.post('/api/auth/subadmin-login',(req,res)=>{const {username,password,deviceId}=req.body||{};const user=authStore.users.find(u=>u.username===username&&u.role==='subadmin');if(!user||!user.enabled)return res.status(403).json({ok:false,error:'Sub Admin account সক্রিয় নেই।'});if(user.passwordHash!==hashPassword(password||''))return res.status(401).json({ok:false,error:'Username বা Password ভুল।'});if(user.deviceId&&deviceId&&user.deviceId!==deviceId)return res.status(403).json({ok:false,error:'এই Sub Admin অন্য device-এর সাথে যুক্ত আছে।'});if(!user.deviceId&&deviceId)user.deviceId=deviceId;user.lastLoginAt=Date.now();saveAuthStore(authStore);const token=newToken();authSessions.set(token,{kind:'subadmin',userId:user.id,username:user.username,name:user.name||'',createdAt:Date.now()});res.json({ok:true,token,user:{id:user.id,username:user.username,name:user.name||'',rate:Number(user.rate||process.env.BASE_RATE||4)},baseRate:Number(process.env.BASE_RATE||4)});});
app.post('/api/auth/login',(req,res)=>{const {username,password,accessToken,deviceId,userId,auth}=req.body||{};if(!username||!password||!accessToken||!deviceId)return res.status(400).json({ok:false,error:'Username, password, access link এবং device তথ্য প্রয়োজন।'});let user=authStore.users.find(u=>u.accessToken===accessToken);if(!user&&userId)user=authStore.users.find(u=>u.id===String(userId));if(auth){const r=openUserPayload(auth);if(r&&r.accessToken===accessToken&&r.id===String(userId||r.id)&&r.username===username&&r.enabled!==false&&r.passwordHash===hashPassword(password)){const stored=authStore.users.find(u=>u.id===r.id);user={...(stored||{}),...r,deviceId:stored?.deviceId||'',lastLoginAt:stored?.lastLoginAt||null,balance:Number(r.balance)||0,previewRate:Number.isFinite(Number(r.previewRate))&&Number(r.previewRate)>=0?Number(r.previewRate):(Number.isFinite(Number(stored?.previewRate))&&Number(stored.previewRate)>=0?Number(stored.previewRate):4)};const i=authStore.users.findIndex(u=>u.id===user.id);if(i>=0)authStore.users[i]=user;else authStore.users.push(user);saveAuthStore(authStore);}}if(!user||!user.enabled)return res.status(403).json({ok:false,error:'এই access link সক্রিয় নেই।'});if(user.username!==username||user.passwordHash!==hashPassword(password))return res.status(401).json({ok:false,error:'Username বা Password ভুল।'});if(user.deviceId&&user.deviceId!==deviceId)return res.status(403).json({ok:false,error:'এই access link অন্য একটি device-এর সাথে যুক্ত আছে।'});if(!user.deviceId)user.deviceId=deviceId;user.lastLoginAt=Date.now();saveAuthStore(authStore);const token=newToken();authSessions.set(token,{kind:'user',userId:user.id,username:user.username,name:user.name||'',accessToken,createdAt:Date.now()});res.json({ok:true,token,auth:sealUserPayload(user),balance:Number(user.balance)||0,user:{id:user.id,username:user.username,name:user.name||''}});});
app.post('/api/auth/admin-login',(req,res)=>{const {username,password}=req.body||{};if(username!==authStore.admin.username||hashPassword(password||'')!==authStore.admin.passwordHash)return res.status(401).json({ok:false,error:'Admin username বা password ভুল।'});const token=newToken();authSessions.set(token,{kind:'admin',username,createdAt:Date.now()});res.json({ok:true,token});});
function requireAuth(req,res,next){const session=authUser(req);if(!session)return res.status(401).json({ok:false,error:'Login required.'});req.auth=session;next();}
function requireAdmin(req,res,next){const session=authUser(req);if(!session||session.kind!=='admin')return res.status(403).json({ok:false,error:'Admin access required.'});req.auth=session;next();}
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({ok:true,session:req.auth}));app.get('/api/balance',requireAuth,(req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId);
  if(!user) return res.status(404).json({ok:false,error:'User not found.'});
  if(!Number.isFinite(Number(user.balance))) user.balance=0;
  res.json({ok:true,balance:Number(user.balance),previewRate:Number.isFinite(Number(user.previewRate))&&Number(user.previewRate)>=0?Number(user.previewRate):4,auth:sealUserPayload(user)});
});
app.post('/api/balance/charge',requireAuth,async (req,res)=>{
  const user=authStore.users.find(u=>u.id===req.auth.userId); if(!user)return res.status(404).json({ok:false,error:'User not found.'});
  const certificateId=String(req.body?.certificateId||'').trim();
  if(certificateId){
    if(pgPool&&pgReady){try{const ex=(await pgPool.query('SELECT data FROM bdris_transactions WHERE user_id=$1 AND certificate_id=$2 LIMIT 1',[String(user.id),certificateId])).rows[0];if(ex?.data)return res.json({ok:true,balance:Number(user.balance)||0,charged:0,alreadyCharged:true,transactionId:ex.data.id,auth:sealUserPayload(user)});}catch(e){}}
    const local=authStore.transactions||[];const ex=local.find(t=>t.userId===user.id&&t.certificateId===certificateId);if(ex)return res.json({ok:true,balance:Number(user.balance)||0,charged:0,alreadyCharged:true,transactionId:ex.id,auth:sealUserPayload(user)});
  }
  const amount=Number.isFinite(Number(user.previewRate))?Math.max(0,Number(user.previewRate)):Number(process.env.BASE_RATE||4); const balance=Number(user.balance)||0; if(balance<amount)return res.status(402).json({ok:false,error:`Certificate Preview-এর জন্য পর্যাপ্ত Balance নেই। প্রয়োজন ৳${amount}।`,balance,required:amount,previewRate:amount});
  user.balance=Math.round((balance-amount)*100)/100; const baseRate=Number(process.env.BASE_RATE||4); const tx={id:newToken(),type:'certificate_preview',userId:user.id,certificateId,amount,baseRate,commission:Math.max(0,amount-baseRate),createdAt:Date.now(),balanceAfter:user.balance};
  authStore.transactions=Array.isArray(authStore.transactions)?authStore.transactions:[];authStore.transactions.push(tx);saveAuthStore(authStore);
  if(pgPool&&pgReady){try{await pgPool.query('CREATE TABLE IF NOT EXISTS bdris_transactions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,certificate_id TEXT,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());');await pgPool.query('INSERT INTO bdris_transactions(id,user_id,certificate_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[tx.id,String(user.id),certificateId,tx]);}catch(e){console.warn('Transaction PG save failed:',e.message);}}
  res.json({ok:true,balance:user.balance,charged:amount,alreadyCharged:false,transactionId:tx.id,auth:sealUserPayload(user)});
});

app.get('/api/subadmin/me',requireSubAdmin,(req,res)=>{const u=authStore.users.find(x=>x.id===req.auth.userId);res.json({ok:true,user:u?{id:u.id,username:u.username,name:u.name||'',rate:Number(u.rate||process.env.BASE_RATE||4)}:null,baseRate:Number(process.env.BASE_RATE||4)});});
app.get('/api/subadmin/customers',requireSubAdmin,(req,res)=>res.json({ok:true,customers:authStore.users.filter(u=>u.role==='customer'&&u.parentId===req.auth.userId).map(u=>{const {passwordHash,...safe}=u;safe.auth=sealUserPayload(u);return safe;})}));
app.post('/api/subadmin/customers',requireSubAdmin,(req,res)=>{const parent=authStore.users.find(u=>u.id===req.auth.userId&&u.role==='subadmin');if(!parent)return res.status(404).json({ok:false,error:'Sub Admin not found.'});const {username,password,name='',rate}=req.body||{};if(!username||!password)return res.status(400).json({ok:false,error:'Username এবং password দিন।'});if(authStore.users.some(u=>u.username===username))return res.status(409).json({ok:false,error:'Username already exists.'});const base=Number(process.env.BASE_RATE||4);const r=Number.isFinite(Number(rate))?Math.max(base,Number(rate)):Math.max(base,Number(parent.rate)||base);const user={id:newToken().slice(0,16),username:String(username),name:String(name),passwordHash:hashPassword(password),accessToken:newToken(),enabled:true,deviceId:'',createdAt:Date.now(),lastLoginAt:null,balance:0,previewRate:r,rate:r,role:'customer',parentId:parent.id};authStore.users.push(user);saveAuthStore(authStore);const {passwordHash,...safe}=user;res.json({ok:true,user:safe,link:`?access=${user.accessToken}&uid=${encodeURIComponent(user.id)}&auth=${encodeURIComponent(sealUserPayload(user))}`});});
app.patch('/api/subadmin/customers/:id',requireSubAdmin,(req,res)=>{const user=authStore.users.find(u=>u.id===req.params.id&&u.role==='customer'&&u.parentId===req.auth.userId);if(!user)return res.status(404).json({ok:false,error:'Customer not found.'});const base=Number(process.env.BASE_RATE||4);if(req.body.setRate!==undefined){const n=Number(req.body.setRate);if(!Number.isFinite(n)||n<base)return res.status(400).json({ok:false,error:'Rate cannot be below base rate.'});user.rate=n;user.previewRate=n;}if(req.body.setBalance!==undefined){const n=Number(req.body.setBalance);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid balance.'});user.balance=n;}if(req.body.addBalance!==undefined){const n=Number(req.body.addBalance);if(!Number.isFinite(n))return res.status(400).json({ok:false,error:'Invalid amount.'});user.balance=Math.round(((Number(user.balance)||0)+n)*100)/100;}saveAuthStore(authStore);const {passwordHash,...safe}=user;res.json({ok:true,user:safe});});
function requireSubAdmin(req,res,next){const session=authUser(req);if(!session||session.kind!=='subadmin')return res.status(403).json({ok:false,error:'Sub Admin access required.'});req.auth=session;next();}
app.get('/api/admin/subadmins',requireAdmin,(req,res)=>res.json({ok:true,subadmins:(authStore.users||[]).filter(u=>u.role==='subadmin').map(u=>{const {passwordHash,...safe}=u;return safe;})}));
app.post('/api/admin/subadmins',requireAdmin,(req,res)=>{const {username,password,name='',rate}=req.body||{};if(!username||!password)return res.status(400).json({ok:false,error:'Username এবং password দিন।'});if(authStore.users.some(u=>u.username===username))return res.status(409).json({ok:false,error:'Username already exists.'});const base=Number(process.env.BASE_RATE||4);const r=Number.isFinite(Number(rate))?Math.max(base,Number(rate)):base;const user={id:newToken().slice(0,16),username:String(username),name:String(name),passwordHash:hashPassword(password),accessToken:'',enabled:true,deviceId:'',createdAt:Date.now(),lastLoginAt:null,balance:0,previewRate:r,rate:r,role:'subadmin',parentId:''};authStore.users.push(user);saveAuthStore(authStore);const {passwordHash,...safe}=user;res.json({ok:true,user:safe});});
app.get('/api/admin/commissions',requireAdmin,async(req,res)=>{let rows=[];if(pgPool&&pgReady){try{await pgPool.query('CREATE TABLE IF NOT EXISTS bdris_transactions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,certificate_id TEXT,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());');rows=(await pgPool.query('SELECT data FROM bdris_transactions')).rows.map(r=>r.data||{});}catch(_){}}if(!rows.length)rows=authStore.transactions||[];const subadmins=(authStore.users||[]).filter(u=>u.role==='subadmin').map(s=>({id:s.id,username:s.username,name:s.name||'',customers:(authStore.users||[]).filter(c=>c.role==='customer'&&c.parentId===s.id).length,commission:rows.filter(t=>t.userId&&((authStore.users||[]).find(c=>c.id===t.userId)?.parentId===s.id)).reduce((a,t)=>a+Number(t.commission||0),0)}));res.json({ok:true,subadmins});});
app.get('/api/admin/users',requireAdmin,async (req,res)=>{
  if(pgPool&&pgReady){try{const rows=(await pgPool.query('SELECT data FROM bdris_users ORDER BY updated_at ASC')).rows;const dbUsers=rows.map(r=>r.data||{}).filter(u=>u.id);const merged=new Map(dbUsers.map(u=>[String(u.id),u]));for(const u of authStore.users||[]){if(u.id)merged.set(String(u.id),u);}authStore.users=Array.from(merged.values());saveAuthStoreLocalOnly(authStore);}catch(e){console.warn('Admin user refresh failed:',e.message);}}
  const users=(authStore.users||[]).map(u=>{const {passwordHash,...safe}=u;safe.auth=sealUserPayload(u);return safe;});
  res.json({ok:true,users});
});

app.post('/api/admin/users',requireAdmin,(req,res)=>{const {username,password,name=''}=req.body||{};if(!username||!password)return res.status(400).json({ok:false,error:'Username এবং password দিন।'});if(authStore.users.some(u=>u.username===username))return res.status(409).json({ok:false,error:'Username already exists.'});const user={id:newToken().slice(0,16),username,name,passwordHash:hashPassword(password),accessToken:newToken(),enabled:true,deviceId:'',createdAt:Date.now(),lastLoginAt:null,balance:0,previewRate:Number(process.env.BASE_RATE||4),rate:Number(process.env.BASE_RATE||4),role:'customer',parentId:''};authStore.users.push(user);saveAuthStore(authStore);const {passwordHash,...safe}=user;res.json({ok:true,user:safe,link:`?access=${user.accessToken}&uid=${encodeURIComponent(user.id)}&auth=${encodeURIComponent(sealUserPayload(user))}`});});
app.patch('/api/admin/users/:id',requireAdmin,(req,res)=>{const user=authStore.users.find(u=>u.id===req.params.id);if(!user)return res.status(404).json({ok:false,error:'User not found.'});if(typeof req.body.enabled==='boolean')user.enabled=req.body.enabled;if(req.body.resetDevice)user.deviceId='';if(req.body.newPassword)user.passwordHash=hashPassword(req.body.newPassword);if(req.body.setBalance!==undefined){const n=Number(req.body.setBalance);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid balance.'});user.balance=Math.round(n*100)/100;}if(req.body.addBalance!==undefined){const n=Number(req.body.addBalance);if(!Number.isFinite(n))return res.status(400).json({ok:false,error:'Invalid balance amount.'});user.balance=Math.round(((Number(user.balance)||0)+n)*100)/100;}if(req.body.setPreviewRate!==undefined){const n=Number(req.body.setPreviewRate);if(!Number.isFinite(n)||n<0)return res.status(400).json({ok:false,error:'Invalid preview rate.'});user.previewRate=Math.round(n*100)/100;}saveAuthStore(authStore);const {passwordHash,...safe}=user;safe.auth=sealUserPayload(user);res.json({ok:true,user:safe});});
app.delete('/api/admin/users/:id',requireAdmin,(req,res)=>{const i=authStore.users.findIndex(u=>u.id===req.params.id);if(i<0)return res.status(404).json({ok:false,error:'User not found.'});authStore.users.splice(i,1);saveAuthStore(authStore);res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(req.path.startsWith('/auth/'))return next();return requireAuth(req,res,next);});


/* =========================================================
   SHARED PDF IMAGE LIBRARY
========================================================= */
app.get('/api/pdf-layout',(req,res)=>res.json({ok:true,layout:pdfLayoutStore,defaults:PDF_LAYOUT_DEFAULTS}));
app.get('/api/admin/pdf-layout',requireAdmin,(req,res)=>res.json({ok:true,layout:pdfLayoutStore,defaults:PDF_LAYOUT_DEFAULTS}));
app.patch('/api/admin/pdf-layout',requireAdmin,(req,res)=>{
  const incoming=req.body?.layout||{};
  const next={};
  for(const key of Object.keys(PDF_LAYOUT_DEFAULTS)){
    const p=incoming[key]||pdfLayoutStore[key]||PDF_LAYOUT_DEFAULTS[key];
    next[key]={x:Math.max(-30,Math.min(30,Number(p.x)||0)),y:Math.max(-30,Math.min(30,Number(p.y)||0))};
  }
  pdfLayoutStore=next; savePDFLayout(pdfLayoutStore); res.json({ok:true,layout:pdfLayoutStore});
});
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
    image={id:crypto.randomBytes(12).toString('hex'),name:cleanName,fileName:'',mimeType:'',createdAt:Date.now(),updatedAt:Date.now(),defaultPosition:{x:105,y:247,width:24,height:10,zoom:100}};
    store.images.push(image);
  }
  if(!dataUrl){ savePDFImageLibrary(store); return res.json({ok:true,image:pdfImageMeta(image),needsUpload:!image.fileName}); }
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
  savePDFImageLibrary(store);
  res.json({ok:true,image:pdfImageMeta(image)});
});

app.patch('/api/pdf-images/:id', (req,res)=>{
  const body=req.body||{};
  const requested=body.name===undefined ? '' : safeImageName(body.name);
  let store=loadPDFImageLibrary();
  const image=store.images.find(x=>x.id===req.params.id);
  if(!image) return res.status(404).json({ok:false,error:'Image পাওয়া যায়নি।'});
  if(body.name!==undefined){
    if(!requested) return res.status(400).json({ok:false,error:'নতুন Image-এর নাম দিন।'});
    const duplicate=store.images.find(x=>x.name===requested && x.id!==image.id);
    if(duplicate) return res.status(409).json({ok:false,error:'এই নামে আরেকটি Image আগে থেকেই আছে।'});
    image.name=requested;
  }
  if(body.defaultPosition){
    const q=body.defaultPosition;
    const x=Math.max(0,Math.min(210,Number(q.x)));
    const y=Math.max(0,Math.min(297,Number(q.y)));
    const width=Math.max(8,Math.min(180,Number(q.width)));
    const height=Math.max(5,Math.min(250,Number(q.height)));
    const zoom=Math.max(50,Math.min(300,Number(q.zoom)));
    if([x,y,width,height,zoom].every(Number.isFinite)) image.defaultPosition={x,y,width,height,zoom};
    else return res.status(400).json({ok:false,error:'Image position-এর X/Y/Width/Height/Zoom সঠিক নয়।'});
  }
  image.updatedAt=Date.now();
  savePDFImageLibrary(store);
  res.json({ok:true,image:pdfImageMeta(image)});
});

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
    // Keep Puppeteer's cache fixed to the application directory so the build-time
    // Chrome installation and runtime lookup always use the same location.
    const cacheDir = path.join(__dirname, '.cache', 'puppeteer');
    process.env.PUPPETEER_CACHE_DIR = cacheDir;

    let executablePath = null;
    try {
        executablePath = await puppeteer.executablePath();
    } catch (_) {
        executablePath = null;
    }

    // If Render skipped the postinstall step or the cache was cleared, install
    // the exact browser revision on first use, then resolve the path again.
    if (!executablePath || typeof executablePath !== 'string' || !fs.existsSync(executablePath)) {
        const { execFileSync } = require('child_process');
        try {
            execFileSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
                cwd: __dirname,
                env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
                stdio: 'inherit'
            });
            executablePath = await puppeteer.executablePath();
        } catch (installError) {
            throw new Error('Chrome install failed: ' + (installError?.message || installError));
        }
    }

    const options = { ...browserLaunchOptions };
    if (executablePath && typeof executablePath === 'string' && fs.existsSync(executablePath)) {
        options.executablePath = executablePath;
    } else {
        throw new Error('Chrome executable not found after installation.');
    }

    return puppeteer.launch(options);
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

let sharedBDRISBrowser = null;
let sharedPDFBrowser = null;
async function getSharedPDFBrowser() {
    if (sharedPDFBrowser) {
        try {
            if (sharedPDFBrowser.connected) return sharedPDFBrowser;
        } catch (_) {}
        sharedPDFBrowser = null;
    }
    sharedPDFBrowser = await launchBrowser();
    return sharedPDFBrowser;
}

async function getSharedBDRISBrowser() {
    if (sharedBDRISBrowser) {
        try {
            if (sharedBDRISBrowser.connected) return sharedBDRISBrowser;
        } catch (_) {}
        sharedBDRISBrowser = null;
    }
    sharedBDRISBrowser = await launchBrowser();
    return sharedBDRISBrowser;
}

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


app.post('/api/certificates',requireAuth,async(req,res)=>{const userId=req.auth.userId;const rec={id:String(req.body?.id||newToken()),userId,data:req.body?.data||{},certificateType:req.body?.certificateType||'new',registrationMode:req.body?.registrationMode||'birth',selectedBengaliFont:req.body?.selectedBengaliFont||'',currentData:req.body?.currentData||null,selectedPDFImageId:req.body?.selectedPDFImageId||'',selectedPDFImageName:req.body?.selectedPDFImageName||'',imagePositionX:Number(req.body?.imagePositionX||105),imagePositionY:Number(req.body?.imagePositionY||247),imageZoom:Number(req.body?.imageZoom||100),imageWidth:Number(req.body?.imageWidth||24),imageHeight:Number(req.body?.imageHeight||10),createdAt:Number(req.body?.createdAt||Date.now()),pdfBase64:String(req.body?.pdfBase64||'')};authStore.certificates=Array.isArray(authStore.certificates)?authStore.certificates:[];const i=authStore.certificates.findIndex(x=>x.id===rec.id);if(i>=0)authStore.certificates[i]=rec;else authStore.certificates.push(rec);saveAuthStore(authStore);if(pgPool&&pgReady){try{await pgPool.query('CREATE TABLE IF NOT EXISTS bdris_certificates (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());');await pgPool.query('INSERT INTO bdris_certificates(id,user_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,created_at=NOW()',[rec.id,String(userId),rec]);}catch(e){console.warn('Certificate history PG save failed:',e.message);}}res.json({ok:true,id:rec.id});});
app.get('/api/certificates',requireAuth,async(req,res)=>{let rows=(authStore.certificates||[]).filter(x=>x.userId===req.auth.userId);if(pgPool&&pgReady){try{await pgPool.query('CREATE TABLE IF NOT EXISTS bdris_certificates (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());');const q=(await pgPool.query('SELECT data FROM bdris_certificates WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500',[String(req.auth.userId)])).rows.map(r=>r.data||{});if(q.length)rows=q;}catch(_){}}res.json({ok:true,certificates:rows});});

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

        // Fast eVerify load: keep document/scripts/XHR and the CAPTCHA image,
        // but skip fonts/media/tracking images that are not needed to fetch data.
        await page.setRequestInterception(true);
        page.on('request', request => {
            const type = request.resourceType();
            const url = request.url();
            if (type === 'font' || type === 'media' || type === 'stylesheet' ||
                (type === 'image' && !/captcha/i.test(url))) {
                request.abort().catch(() => {});
            } else {
                request.continue().catch(() => {});
            }
        });

        await page.goto(
            'https://everify.bdris.gov.bd/',
            {
                waitUntil: 'domcontentloaded',
                timeout: 12000
            }
        );

        await page.waitForSelector(
            'input',
            {
                timeout: 5000
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

        ], 3500);


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
                timeout: 5500
            }).catch(() => {}),

            page.waitForFunction(() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const html = document.documentElement?.innerHTML || '';
                const hasRows = document.querySelectorAll('table tr').length > 1;
                const hasResultContainer = !!document.querySelector('#result, .result, .details, [class*="result" i], [id*="result" i]');
                const hasKnownResult = /নিবন্ধিত ব্যক্তির নাম|পিতার নাম|মাতার নাম|registered person|father.?s name|mother.?s name/i.test(text);
                const hasCaptchaError = /captcha|ক্যাপচা|invalid|incorrect|সঠিক নয়|সঠিক নয়|ভুল কোড|verification failed/i.test(text);
                return hasRows || hasResultContainer || hasKnownResult || hasCaptchaError || /certificate\/verify/i.test(html);
            }, { timeout: 5500, polling: 75 }).catch(() => {})
        ]);

        // Give a fast AJAX response a very small settling window. This is not a
        // fixed 20-second wait and does not block on unrelated network requests.
        await new Promise(resolve => setTimeout(resolve, 60));

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
                        label: cells[0], value: cells[1],
                        englishLabel: cells[2], englishValue: cells[3]
                    });
                } else if (cells.length === 3) {
                    // Some newer eVerify result blocks omit the English label.
                    records.push({
                        label: cells[0], value: cells[1],
                        englishLabel: cells[0], englishValue: cells[2]
                    });
                } else if (cells.length === 2) {
                    // New/older certificate layouts may be simple Label/Value rows.
                    records.push({
                        label: cells[0], value: cells[1],
                        englishLabel: cells[0], englishValue: cells[1]
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
                    const rb = norm(row.label);
                    const re = norm(row.englishLabel);
                    const bnMatch = bn && (rb === bn || rb.includes(bn) || bn.includes(rb));
                    const enMatch = en && (re === en || re.includes(en) || en.includes(re));
                    return (bnMatch && enMatch) || bnMatch || enMatch;
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

async function startServer(){
  await initPostgres();
  getSharedBDRISBrowser().catch(()=>{});
  app.listen(
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

    }
  );
}
startServer().catch(err=>{console.error('Fatal startup error:',err);process.exit(1);});