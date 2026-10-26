# V6 merged workflow features

## Implemented in this build
- PDF history API: create/upsert, list, edit, delete; Admin Panel lists entries and can edit title, delete, and download a stored PDF. The existing browser IndexedDB history remains available and newly generated PDFs are synchronized to the server.
- Payment request workflow: user submits amount, method, transaction reference and note; admin can approve/reject pending requests. Approval credits the user's balance once, records balance history, and adds a ledger row.
- Income/recharge ledger API and Admin Panel total/list.
- Record history: UBRN/BRN, DOB, Bangla name, English name, gender and payload. User can create and list records; user API supports edit/delete; Admin Panel lists, edits and deletes records.
- PostgreSQL tables are created on startup for PDF history, payment requests, income ledger and record history. When `DATABASE_URL` is absent, JSON fallback storage is used for these workflows.
- Bot-specific bridge files/routes were not added to this build.

## API endpoints added
- `GET/POST /api/pdf-history`, `PATCH/DELETE /api/pdf-history/:id`
- `GET /api/admin/pdf-history`, `PATCH/DELETE /api/admin/pdf-history/:id`, `GET /api/admin/pdf-history/:id/download`
- `GET/POST /api/payments`
- `GET /api/admin/payments`, `POST /api/admin/payments/:id/review`
- `GET /api/admin/income`
- `GET/POST /api/records`, `PATCH/DELETE /api/records/:id`
- `GET/PATCH/DELETE /api/admin/records` and `/api/admin/records/:id`

## Deploy configuration
Set `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_USERNAME`, and a strong `ADMIN_PASSWORD` in hosting environment. Keep the existing `AUTH_SECRET` if you need existing signed access links to remain valid. For production use, configure persistent storage for PDF image assets if the host filesystem is ephemeral.

### Render deployment

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Runtime: Node.js 22.12 or newer; the server binds to `0.0.0.0` and Render's `PORT`.
- Required Render environment variables: `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`.
- Set `DATABASE_URL` to the pooled connection string for the existing Neon project/branch used locally. `DATABASE_URL_UNPOOLED` is not used by the application and should only be kept for direct maintenance or migrations. `NEON_BRANCH` is informational and is not required by the app.
- Keep the existing `AUTH_SECRET` to preserve generated login links. The admin credentials are initialized in `fil_admin_settings` only when that setting does not exist; changing `ADMIN_PASSWORD` alone does not change an already-initialized database admin password.
- The server creates missing tables with `CREATE TABLE IF NOT EXISTS`; it does not run a table-drop or reset migration at startup. Do not point Render at a different Neon project/branch.
- After deploying, check `https://<service>.onrender.com/api/health` and confirm it reports `database: "neon-connected"`. Never paste connection strings or passwords into logs, commits, or support requests.
- PDF image storage uses `/var/data/pdf-images` only when a Render persistent disk is detected at `/var/data` and a write probe succeeds. Otherwise it falls back to the OS temporary directory and logs that this storage is ephemeral. The health endpoint reports `pdfImageStorage.writable` and `pdfImageStorage.persistent`; temporary storage does not preserve images across restarts or deploys.
- Render's ephemeral filesystem does not preserve local PDF image uploads or JSON fallback storage. Keep PostgreSQL configured and use a mounted persistent disk or the documented image export workflow for uploaded assets.

## Checks performed
- `npm test` passed: `node --check index.js` and `node --check server.js`.
- Inline JavaScript syntax checks passed for `admin.html` and `index.html`.
- ZIP integrity checked after packaging.

## Not claimed as tested
- No live PostgreSQL instance was available in this workspace, so migrations and transaction behavior have not been integration-tested against a real database.
- No live hosting deployment was performed because hosting access/settings were not supplied.
- No live BDRIS or payment-provider end-to-end test was performed. Payment approval is an admin-controlled manual confirmation workflow; it does not automatically verify bKash/Nagad transactions.
