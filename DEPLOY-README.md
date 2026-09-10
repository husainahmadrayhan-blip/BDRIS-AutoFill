# BDRIS AutoFill — Git/Render Ready

## Production
1. Create a PostgreSQL database and set `DATABASE_URL` on Render.
2. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a long random `AUTH_SECRET`.
3. Keep `BASE_RATE` at the main-admin minimum/base rate (default 4).
4. Deploy from GitHub with `npm ci` and `node server.js`.
5. Render health check: `/ping`.

## Billing behavior
- New data: first explicit Preview charges once.
- Repeated Preview of the same data does not charge again.
- Edit existing History: Preview is free.
- Download/Print does not charge by itself.
- Customer rate cannot be below BASE_RATE.
- Sub-admin commission is the amount above BASE_RATE.

## Local
Set DATABASE_URL only if you want PostgreSQL locally; otherwise JSON fallback is retained.
