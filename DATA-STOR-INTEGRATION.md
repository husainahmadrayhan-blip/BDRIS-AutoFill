# Data Stor integration in BDRIS-AutoFill

This branch integrates a Data Stor search page into the existing Express application. It intentionally does not deploy the separate Next.js application or use its independent login and wallet.

## Entry points

- Main dashboard: `/`
- Data Stor search: `/data-stor.html`
- Stats: `GET /api/data-stor/stats`
- Search: `GET /api/data-stor/search?dob=YYYY-MM-DD&bn=...&en=...&gender=all&page=1&limit=30`
- Read a record after unlock: `GET /api/data-stor/records/:id`
- Unlock a record: `POST /api/data-stor/records/:id/unlock`
- Authorized Admin CSV import: `POST /api/data-stor/admin/import`

All Data Stor APIs run through the existing AutoFill authentication middleware. The feature uses the existing `DATABASE_URL`/PostgreSQL pool, AutoFill user records in `fil_users`, and their balance. The initial unlock price is set server-side to Tk 30; an already unlocked record returns a zero additional charge. Locked results expose only a masked BRN.

## Existing data

The source repository contains the importer and schema, but not its live database records. To populate the integrated page, export the approved source records to CSV with headers:

```csv
BRN,DOB,বাংলা নাম,English Name,Gender
12345678901234567,2001-12-31,নমুনা নাম,Example Name,male
```

Sign in to AutoFill Admin in the same browser, open the Data Stor card, and use the Admin CSV Import section. The importer accepts ISO dates (`YYYY-MM-DD`) or local dates (`DD/MM/YYYY` or `DD-MM-YYYY`), validates 17-digit BRNs, skips invalid rows, and upserts on the unique BRN. Keep CSV files and real birth-record data out of the Git repository.

The import route accepts at most 45 MB of CSV text; the Express JSON body limit must also be large enough for the request. For larger datasets, split the CSV into smaller chunks before import. Schema creation is additive and does not drop existing tables.

## Checks

Run these in a local checkout with Node.js 22 and dependencies installed:

```sh
npm ci
node --check data-stor-utils.js
node --check index.js
node --test data-stor.test.js
npm run build
npm test
npm run test:browser
```

A real staging database is required to confirm schema creation, user/session authorization, insufficient-balance rollback, duplicate/concurrent unlock, import, and record masking. Do not merge to production until those tests pass against the target Neon database and the existing AutoFill regression suite remains green.
