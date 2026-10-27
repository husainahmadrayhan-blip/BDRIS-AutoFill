'use strict';

// Private CSV import into the existing AutoFill Neon database.
// Uses only DATABASE_URL, validates records, and never drops or resets tables.
const fs = require('node:fs');
const readline = require('node:readline');
const { Pool } = require('pg');

// Load local environment files for this standalone CLI; process environment wins.
(function loadLocalEnv() {
  const path = require('node:path');
  for (const fileName of ['.env.local', '.env']) {
    const envPath = path.resolve(process.cwd(), fileName);
    try {
      if (!fs.existsSync(envPath)) continue;
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
        let value = m[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        process.env[m[1]] = value;
      }
    } catch (error) {
      console.error('Could not read local environment file:', fileName);
      process.exit(1);
    }
  }
})();

const args = process.argv.slice(2);
function argValue(name) {
  const exact = args.find(a => a.startsWith(name + '='));
  if (exact) return exact.slice(name.length + 1).replace(/^["']|["']$/g, '');
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const file = argValue('--file');
const dryRun = args.includes('--dry-run');
const batchSize = Math.max(100, Math.min(5000, Number(argValue('--batch-size') || 2000)));
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!file) {
  console.error('Usage: npm run import:data-stor-csv -- --file="data/BRN_DOB_NAME_GENDER.csv" [--dry-run]');
  process.exit(1);
}
if (!databaseUrl) {
  console.error('DATABASE_URL is missing. Set it in your local .env.local or environment.');
  process.exit(1);
}
const absoluteFile = require('node:path').resolve(file);
if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
  console.error('CSV file not found:', absoluteFile);
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 15000 });
const counters = {
  rows: 0, inserted: 0, updated: 0, skipped: 0,
  invalidBRN: 0, invalidDOB: 0, duplicate: 0, failed: 0
};
const seen = new Set();

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(field); field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}
function normalizeHeader(s) {
  return String(s || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_]+/g, '');
}
function normalizeBrn(s) {
  return String(s || '').trim().replace(/[\s-]/g, '');
}
function normalizeDob(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let year, month, day;
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  } else {
    m = value.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (!m) return null;
    day = Number(m[1]); month = Number(m[2]); year = Number(m[3]);
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 ||
      dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
function normalizeText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}
function normalizeGender(raw) {
  const value = normalizeText(raw).toLowerCase();
  if (value === 'male' || value === 'm') return 'male';
  if (value === 'female' || value === 'f') return 'female';
  if (value === 'other' || value === 'o') return 'other';
  return value;
}
function fieldIndex(headers, candidates) {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex(h => candidates.includes(h));
}
async function main() {
  const client = await pool.connect();
  try {
    const schema = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'birth_records'"
    );
    const columns = new Set(schema.rows.map(r => r.column_name));
    const required = ['brn', 'dob', 'name_bn', 'name_en', 'gender'];
    if (!required.every(c => columns.has(c))) {
      throw new Error('Target public.birth_records table is missing expected columns. Found: ' + [...columns].join(', '));
    }
    const stream = fs.createReadStream(absoluteFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let headerMap = null;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      const brns = rows.map(row => row.brn);
      if (dryRun) {
        const existing = await client.query(
          'SELECT brn FROM public.birth_records WHERE brn = ANY($1::text[])',
          [brns]
        );
        const existingSet = new Set(existing.rows.map(row => String(row.brn)));
        for (const row of rows) {
          if (existingSet.has(row.brn)) counters.updated++; else counters.inserted++;
        }
        return;
      }

      const values = [];
      const params = [];
      for (const row of rows) {
        const offset = params.length;
        params.push(row.brn, row.dob, row.name_bn, row.name_en, row.gender);
        values.push(`($${offset + 1}, $${offset + 2}::date, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
      }
      await client.query('BEGIN');
      try {
        const result = await client.query(
          `INSERT INTO public.birth_records (brn, dob, name_bn, name_en, gender)
           VALUES ${values.join(',')}
           ON CONFLICT (brn) DO UPDATE SET
             dob = EXCLUDED.dob, name_bn = EXCLUDED.name_bn,
             name_en = EXCLUDED.name_en, gender = EXCLUDED.gender
           RETURNING (xmax = 0) AS was_inserted`,
          params
        );
        for (const row of result.rows) {
          if (row.was_inserted) counters.inserted++; else counters.updated++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      const fields = parseCsvLine(line);
      if (!headerMap) {
        const headers = fields.map(normalizeHeader);
        const indexes = {
          brn: fieldIndex(fields, ['brn', 'birthregistrationnumber', 'birthregno']),
          dob: fieldIndex(fields, ['dob', 'dateofbirth', 'birthdate']),
          name_bn: fieldIndex(fields, ['বাংলানাম', 'namebn', 'banglaname']),
          name_en: fieldIndex(fields, ['englishname', 'nameen', 'engname']),
          gender: fieldIndex(fields, ['gender', 'sex'])
        };
        if (Object.values(indexes).some(i => i < 0)) {
          throw new Error('CSV header missing required columns (BRN, DOB, বাংলা নাম, English Name, Gender).');
        }
        headerMap = indexes;
        continue;
      }
      counters.rows++;
      const brn = normalizeBrn(fields[headerMap.brn]);
      const dob = normalizeDob(fields[headerMap.dob]);
      if (!/^[0-9]{17}$/.test(brn)) { counters.invalidBRN++; counters.skipped++; continue; }
      if (seen.has(brn)) { counters.duplicate++; counters.skipped++; continue; }
      seen.add(brn);
      if (!dob) { counters.invalidDOB++; counters.skipped++; continue; }
      const row = {
        brn, dob,
        name_bn: normalizeText(fields[headerMap.name_bn]),
        name_en: normalizeText(fields[headerMap.name_en]),
        gender: normalizeGender(fields[headerMap.gender])
      };
            batch.push(row);
      if (batch.length >= batchSize) {
        await flush();
        console.log('Processed CSV rows:', counters.rows.toLocaleString('en-US'));
      }
    }
    if (!headerMap) throw new Error('CSV file is empty or has no header row.');
    await flush();
    console.log(JSON.stringify({ mode: dryRun ? 'DRY RUN - no database changes made' : 'IMPORT COMPLETE', file: absoluteFile, ...counters }, null, 2));
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('CSV import failed:', error.message || 'Unknown error');
    process.exitCode = 1;
  })
  .finally(async () => { await pool.end(); });
