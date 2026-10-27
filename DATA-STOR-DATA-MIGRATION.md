# Data Stor record migration

## Why search can return no records

The AutoFill app creates an empty `birth_records` table when setting up its target database. Creating the table does not copy the live records from the separate source Data Stor database. If `GET /api/data-stor/stats` returns `total: 0`, search is working against an empty target table, so no query can return a record.

The live source database credentials and its records are not part of either public Git repository. Do not commit database URLs, credentials, BRNs, or exported records to Git.

## One-time migration

The repository includes a one-time script that copies the source `birth_records` into the AutoFill target `birth_records` table. It uses the existing `pg` dependency, validates 17-digit BRNs, inserts missing records by unique BRN, and does not overwrite target records already present. The source URL is used only for this migration command, not by the running app.

Deploy/start the updated AutoFill app once first so its additive startup migration creates the target `birth_records` table. Then run the one-time transfer in a trusted local checkout with Node dependencies installed:

**PowerShell**
```powershell
$env:SOURCE_DATA_STOR_DATABASE_URL = "PASTE_SOURCE_DATA_STOR_NEON_URL_HERE"
$env:DATABASE_URL = "PASTE_TARGET_AUTOFILL_NEON_URL_HERE"
npm run migrate:data-stor
Remove-Item Env:SOURCE_DATA_STOR_DATABASE_URL
Remove-Item Env:DATABASE_URL
```

Use the actual connection strings from the two database owners' private environment settings. Never put either URL in a source file or commit it. This command must be run only by someone authorized to access both databases. It does not migrate the source app's users, sessions, wallets, or payment tables.

The script reports source row count, rows scanned, inserted rows, rows skipped/already present, and the target row count. It exits with an error if the source or target connection is missing or the source table cannot be read.

## Verify

After migration, log in to AutoFill and open the Data Stor card. The stats should show a non-zero record count. Try searching by a known DOB or a Bengali/English name. When both names are supplied, the updated search matches either name field, while the DOB and gender filters remain restrictive.

If the source table is empty or the migration reports connection/schema errors, resolve that with the database owner before trying production. Do not reset or drop either database.
