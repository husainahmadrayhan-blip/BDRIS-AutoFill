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
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\\r?\\n/)) {
        const m = line.match(/^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/);
        if (!m || Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
        let value = m[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\\s+#.*$/, '');
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
const batchSize = Math.max(50, Math.min(2000, Number(argValue('--batch-size') || 500)));
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
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}
function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1800 || y > new Date().getUTCFullYear()) return null;
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
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
      if (dryRun) {
        for (const row of batch) {
          if (row.wasExisting) counters.updated++; else counters.inserted++;
        }
        batch = [];
        return;
      }
      await client.query('BEGIN');
      try {
        for (const row of batch) {
          const result = await client.query(
            'INSERT INTO public.birth_records (brn, dob, name_bn, name_en, gender) VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT (brn) DO UPDATE SET dob = EXCLUDED.dob, name_bn = EXCLUDED.name_bn, name_en = EXCLUDED.name_en, gender = EXCLUDED.gender',
            [row.brn, row.dob, row.name_bn, row.name_en, row.gender]
          );
          if (result.rowCount) {
            // PostgreSQL reports one affected row for both insert and update.
            // Determine prior existence before upsert for accurate counts.
            if (row.wasExisting) counters.updated++; else counters.inserted++;
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
      batch = [];
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
      if (!dob) { counters.invalidDOB++; counters.skipped++; continue; }
      if (seen.has(brn)) { counters.duplicate++; counters.skipped++; continue; }
      seen.add(brn);
      const row = {
        brn, dob,
        name_bn: String(fields[headerMap.name_bn] || '').trim(),
        name_en: String(fields[headerMap.name_en] || '').trim(),
        gender: String(fields[headerMap.gender] || '').trim()
      };
      const existing = await client.query('SELECT 1 FROM public.birth_records WHERE brn = $1 LIMIT 1', [brn]);
      row.wasExisting = existing.rowCount > 0;
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
