# Data Stor integration in BDRIS-AutoFill

The current AutoFill app has a built-in Data Stor service view. The dashboard opens it in a separate browser tab using the existing AutoFill session. It does not require a second deployment, second login, or second Neon database.

## Routes

- Dashboard: `/`
- Data Stor service view: open the **Data Stor Search** card from the dashboard (the app uses a `service=data-stor` view).
- Stats: `GET /api/data-stor/stats`
- Search: `GET /api/data-stor/search?dob=YYYY-MM-DD&bn=...&en=...&gender=all&page=1&limit=30`
- Read an unlocked record: `GET /api/data-stor/records/:id`
- Unlock a record: `POST /api/data-stor/records/:id/unlock`
- Authorized Admin CSV import: `POST /api/data-stor/admin/import`

The Data Stor APIs use AutoFill's current user authentication, enabled user accounts, existing PostgreSQL pool from `DATABASE_URL`, `fil_users.balance`, `fil_usage_charges`, and `fil_balance_history`. The server-side initial unlock price is ৳30. An already-unlocked record should return zero additional charge. Locked records expose only a masked BRN.

## Importing existing records

The source Git repository contains code and schema, not its live record dataset. The source database records therefore need to be exported to CSV and imported into the target AutoFill Neon database. Do not put actual birth-record data or credentials in Git.

CSV headers may be:

```csv
BRN,DOB,বাংলা নাম,English Name,Gender
12345678901234567,2001-12-31,নমুনা নাম,Example Name,male
```

Supported dates are `YYYY-MM-DD`, `DD/MM/YYYY`, and `DD-MM-YYYY`. The importer validates 17-digit BRNs, skips invalid rows, removes duplicate BRNs within the import, and upserts by BRN. Sign in to the existing AutoFill Admin in the same browser and use the Data Stor import control available in the service UI.

The database schema additions are non-destructive (`CREATE TABLE/INDEX IF NOT EXISTS`). Search and unlock require a working `DATABASE_URL` and a database containing imported rows. A CSV import should be tested first against a staging Neon database, not production-only data.

## Account service windows

The dashboard includes separate views for My Profile, Change Password, How to Use, Contact Support, and confirmed Logout. The change-password API requires the authenticated AutoFill user session plus the current password, limits repeated attempts, updates only that user's password hash in PostgreSQL, and invalidates other sessions for that user. Certificate Preview continues to expose both Print and Download.

## Checks

With Node.js 22 and dependencies installed, run:

```sh
npm ci
node --check data-stor-utils.js
node --check index.js
node --test data-stor.test.js
npm run build
npm test
npm run test:browser
```

Local utility checks do not replace real staging checks for AutoFill authentication, SQL migration, insufficient-balance rollback, repeated/concurrent unlock, CSV import, and older AutoFill flows. Do not merge into production until the complete test suite and a real staging database test have passed.
