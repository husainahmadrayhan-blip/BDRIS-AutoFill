'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const enabled = !!connectionString;
const pool = enabled ? new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: /sslmode=require/i.test(connectionString) ? { rejectUnauthorized: false } : undefined
}) : null;

async function initDb(){
  if(!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      access_token TEXT UNIQUE NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      device_id TEXT DEFAULT '',
      created_at BIGINT NOT NULL,
      last_login_at BIGINT,
      last_active_at BIGINT,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      pdf_limit INTEGER NOT NULL DEFAULT 0,
      pdf_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      previous_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      new_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pdf_limit INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pdf_used INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      customer_name TEXT DEFAULT '',
      brn TEXT DEFAULT '',
      certificate_type TEXT DEFAULT 'new',
      registration_mode TEXT DEFAULT 'birth',
      status TEXT DEFAULT 'completed',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      current_data JSONB,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      pdf BYTEA
    );
    CREATE INDEX IF NOT EXISTS idx_certificates_created_at ON certificates(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_certificates_brn ON certificates(brn);
    CREATE INDEX IF NOT EXISTS idx_certificates_customer_name ON certificates(customer_name);
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at DESC);
  `);
  return true;
}

async function query(text, params){ if(!pool) return null; return pool.query(text, params); }
async function transaction(fn){ if(!pool) return fn(null); const client=await pool.connect(); try{await client.query('BEGIN'); const out=await fn(client); await client.query('COMMIT'); return out;}catch(e){await client.query('ROLLBACK'); throw e;}finally{client.release();} }

async function upsertUser(user){
  if(!pool || !user) return;
  await query(`INSERT INTO users(id,username,name,password_hash,access_token,enabled,device_id,created_at,last_login_at,last_active_at,balance,pdf_limit,pdf_used)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,access_token=EXCLUDED.access_token,enabled=EXCLUDED.enabled,device_id=EXCLUDED.device_id,created_at=EXCLUDED.created_at,last_login_at=EXCLUDED.last_login_at,last_active_at=EXCLUDED.last_active_at,balance=EXCLUDED.balance,pdf_limit=EXCLUDED.pdf_limit,pdf_used=EXCLUDED.pdf_used`,
    [user.id,user.username,user.name||'',user.passwordHash,user.accessToken,user.enabled!==false,user.deviceId||'',user.createdAt||Date.now(),user.lastLoginAt||null,user.lastActiveAt||null,Number(user.balance)||0,Number(user.pdfLimit)||0,Number(user.pdfUsed)||0]);
}
async function getUsers(){ if(!pool) return null; const r=await query('SELECT id,username,name,password_hash as "passwordHash",access_token as "accessToken",enabled,device_id as "deviceId",created_at as "createdAt",last_login_at as "lastLoginAt",last_active_at as "lastActiveAt",balance,pdf_limit as "pdfLimit",pdf_used as "pdfUsed" FROM users ORDER BY created_at DESC'); return r.rows.map(u=>({...u,balance:Number(u.balance)||0})); }
async function getUser(id){ if(!pool) return null; const r=await query('SELECT id,username,name,password_hash as "passwordHash",access_token as "accessToken",enabled,device_id as "deviceId",created_at as "createdAt",last_login_at as "lastLoginAt",last_active_at as "lastActiveAt",balance,pdf_limit as "pdfLimit",pdf_used as "pdfUsed" FROM users WHERE id=$1',[id]); return r.rows[0] ? {...r.rows[0],balance:Number(r.rows[0].balance)||0} : null; }
async function logTransaction({user,type,amount,previousBalance,newBalance,note='',meta={}}){ if(!pool) return; await query('INSERT INTO transactions(user_id,username,type,amount,previous_balance,new_balance,note,meta,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[user?.id||null,user?.username||null,type,Number(amount)||0,Number(previousBalance)||0,Number(newBalance)||0,note,meta,Date.now()]); }
async function logActivity({user,action,meta={}}){ if(!pool) return; await query('INSERT INTO activity_log(user_id,username,action,meta,created_at) VALUES($1,$2,$3,$4,$5)',[user?.id||null,user?.username||null,action,meta,Date.now()]); }
async function saveCertificate(c){ if(!pool) return; await query(`INSERT INTO certificates(id,user_id,username,customer_name,brn,certificate_type,registration_mode,status,created_at,updated_at,form_data,current_data,meta,pdf)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
 ON CONFLICT(id) DO UPDATE SET customer_name=EXCLUDED.customer_name,brn=EXCLUDED.brn,certificate_type=EXCLUDED.certificate_type,registration_mode=EXCLUDED.registration_mode,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,form_data=EXCLUDED.form_data,current_data=EXCLUDED.current_data,meta=EXCLUDED.meta,pdf=COALESCE(EXCLUDED.pdf,certificates.pdf)`,
 [c.id,c.userId||null,c.username||null,c.customerName||'',c.brn||'',c.certificateType||'new',c.registrationMode||'birth',c.status||'completed',c.createdAt||Date.now(),c.updatedAt||Date.now(),c.formData||{},c.currentData||null,c.meta||{},c.pdf||null]); }
async function deleteCertificate(id){ if(!pool) return; await query('DELETE FROM certificates WHERE id=$1',[id]); }

module.exports={enabled,pool,initDb,query,transaction,upsertUser,getUsers,getUser,logTransaction,logActivity,saveCertificate,deleteCertificate};
