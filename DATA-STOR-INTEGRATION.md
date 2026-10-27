# Data Stor and account service integration

The BDRIS-AutoFill dashboard opens separate service views for Birth, Death, Data Stor search, PDF Image, PDF History, My Profile, Add Balance, Transaction History, Change Password, How to Use, Contact Support, and Logout. Certificate Preview retains Print and Download actions.

## Data Stor

The integrated service uses the existing AutoFill authentication and PostgreSQL pool. Its search and unlock endpoints use the current AutoFill user and balance; locked records are masked, first unlock costs ৳30, and previously unlocked records should not incur another charge.

The source GitHub repository contains code/schema, not the live record dataset. The target Neon database must be populated by exporting the source database records and using the safe one-time migration/import flow documented in the project. Do not commit live birth records, login credentials, access tokens or database secrets.

## Account service windows

My Profile displays the authenticated AutoFill session fields. Change Password asks for the current password and validates a new password of 8–128 characters server-side. The endpoint updates only the authenticated user's password hash, rate limits repeated attempts, and invalidates other user sessions. Help is shown in its own view, Contact Support opens the existing WhatsApp support contact, and Logout asks for confirmation before clearing the session token.

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

These tests do not replace a real staging Neon check. Before production merge, verify session enforcement, password update, CSV import, successful first unlock charge, zero-cost repeat unlock, insufficient-balance rollback, and the existing AutoFill regression/browser flows against the target staging database.
