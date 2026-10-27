'use strict';

// One-time migration only. SOURCE_DATA_STOR_DATABASE_URL is never used by the app at runtime.
const { Pool } = require('pg');

const sourceUrl = String(process.env.SOURCE_DATA_STOR_DATABASE_URL || '').trim();
const targetUrl = String(process.env.DATABASE_URL || '').trim();
if (!sourceUrl || !targetUrl) {
  console.error('Set SOURCE_DATA_STOR_DATABASE_URL (source Data Stor DB) and DATABASE_URL (target AutoFill DB).');
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  console.error('Source and target connection strings are identical. No migration was run.');
  process.exit(1);
}

const source = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 15000 });
const target = new Pool({ connectionString: targetUrl, max: 1, connectionTimeoutMillis: 15000 });
const BATCH_SIZE = 500;

async function main() {
  const sourceCheck = await source.query('SELECT count(*)::bigint AS total FROM birth_records');
  const sourceTotal = Number(sourceCheck.rows[0]?.total || 0);
  console.log('Source birth_records:', sourceTotal.toLocaleString('en-US'));
  if (!sourceTotal) {
    console.log('Source birth_records is empty. No records were copied.');
    return;
  }

  let lastId = 0;
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  for (;;) {
    const batch = await source.query(
      'SELECT id, brn, dob::text AS dob, name_bn, name_en, gender FROM birth_records WHERE id > $1 ORDER BY id LIMIT $2',
      [lastId, BATCH_SIZE]
    );
    if (!batch.rows.length) break;
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      for (const row of batch.rows) {
        if (!/^\\d{17}$/.test(String(row.brn || '')) || !row.dob) {
          skipped++;
          continue;
        }
        const result = await client.query(
          'INSERT INTO birth_records (brn, dob, name_bn, name_en, gender) VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT (brn) DO NOTHING',
          [String(row.brn), String(row.dob), String(row.name_bn || ''), String(row.name_en || ''), String(row.gender || '')]
        );
        if (result.rowCount) inserted++;
        else skipped++;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    scanned += batch.rows.length;
    lastId = Number(batch.rows[batch.rows.length - 1].id);
    console.log('Scanned', scanned.toLocaleString('en-US'), '/', sourceTotal.toLocaleString('en-US'));
  }
  const targetCount = await target.query('SELECT count(*)::bigint AS total FROM birth_records');
  console.log(JSON.stringify({
    sourceTotal,
    scanned,
    inserted,
    skippedOrAlreadyPresent: skipped,
    targetTotalAfterMigration: Number(targetCount.rows[0]?.total || 0)
  }, null, 2));
}

main()
  .catch(error => {
    // Never print connection strings or credentials.
    console.error('Data Stor record migration failed:', String(error?.message || error).replace(/postgres(?:ql)?:\\/\\/[^\\s]+/gi, '[database-url]'));
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([source.end(), target.end()]);
  });
