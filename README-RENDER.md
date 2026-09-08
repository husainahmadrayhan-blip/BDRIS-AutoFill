# BDRIS AutoFill — Render Production

This build is prepared for Render Web Service + Render PostgreSQL.

## What is persistent

- Admin-created users and user status
- User balances
- Recharge / balance adjustment transactions
- Certificate metadata and form data
- Generated PDF bytes for admin download
- User/admin activity log

The app automatically creates its PostgreSQL tables on startup when `DATABASE_URL` is present. If `DATABASE_URL` is missing (for local use), it falls back to the existing local JSON store.

## Render deployment

The included `render.yaml` provisions:

- Web service: `bdris-autofill`
- PostgreSQL: `bdris-autofill-db`
- `DATABASE_URL` wired with `fromDatabase`
- Node 22
- Puppeteer Chrome install + runtime verification
- `/ping` health check

Recommended: deploy the Blueprint from the repository containing this `render.yaml`.

## Admin

Open `/admin.html` and use the `ADMIN_USERNAME` / `ADMIN_PASSWORD` values configured in Render.

The dashboard includes:

- Users / active users / total balance
- PDF today, birth/death counts
- Create/enable/disable/delete users
- Balance add/set with transaction history
- Password and device reset
- Certificate search by customer name / BRN / user
- Birth/death filtering
- Certificate PDF download
- Activity log

## Important

The main app remains in the existing direct/local mode from the supplied build. The Admin Panel remains protected by the separate admin login.
