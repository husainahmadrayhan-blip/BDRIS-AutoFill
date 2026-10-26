# FIL — New Admin Panel

This package replaces the old `admin.html` UI with a new responsive Admin Console. It does not restore the old page as the UI; it creates a new page that uses the existing server's admin APIs.

## Sections
- Dashboard: user totals, active users, pending recharges, income summary
- Users List: add, edit, block/unblock, balance changes, charge rate, balance history, delete
- Wallet & Recharge: review pending payment requests and approve/reject
- Earnings & Payments: income ledger
- PDF History: search, edit title, download, delete
- Record History: search, copy, edit, delete BRN/UBRN, DOB, Bengali/English name, gender

## Run locally
```powershell
npm install
npm test
$env:PORT = "3001"
node server.js
```
Open `http://localhost:3001/admin.html`.

Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `AUTH_SECRET`, and `DATABASE_URL` as environment variables before production use. See `NEON-POSTGRESQL-SETUP.txt`.

## Validation limits
JavaScript syntax checks were run. The panel still requires end-to-end testing against the user's actual database configuration and application data.
