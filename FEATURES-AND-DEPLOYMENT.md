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
- Puppeteer installs its matching Chrome for Testing during `npm run build` into the repository's configured `.cache/puppeteer` directory. The same cache is used at runtime; Chrome is not downloaded when the server starts. Run `npm run test:browser` locally to verify Chrome launch and PDF font embedding. Linux uses Puppeteer's headless mode with the no-sandbox flags required by Render's container.
- Bundled Bengali faces are Noto Sans Bengali Regular, Noto Serif Bengali Regular/Bold, FreeSerif Bengali Regular/Bold, plus the existing Noto Serif Bengali Condensed face. Noto fonts are SIL Open Font License 1.1; FreeSerif is GNU GPL v3-or-later with its document-embedding exception. License texts are in `fonts/`. The selector and generated PDF use the selected face and weight, with the selected TTF embedded as PDF font data. SolaimanLipi files were not present in the supplied project, so that face and a SolaimanLipi Thin weight are not claimed or offered.
- Render's ephemeral filesystem does not preserve local PDF image uploads or JSON fallback storage. Keep PostgreSQL configured and use a mounted persistent disk or the documented image export workflow for uploaded assets.

## Checks performed
- `npm test` passed: `node --check index.js` and `node --check server.js`.
- Inline JavaScript syntax checks passed for `admin.html` and `index.html`.
- ZIP integrity checked after packaging.

## Not claimed as tested
- No live PostgreSQL instance was available in this workspace, so migrations and transaction behavior have not been integration-tested against a real database.
- No live hosting deployment was performed because hosting access/settings were not supplied.
- No live BDRIS or payment-provider end-to-end test was performed. Payment approval is an admin-controlled manual confirmation workflow; it does not automatically verify bKash/Nagad transactions.


## Update branch notes — 2026-10-27

The branch `fix/neon-pdf-image-persistence-2026-10-27` contains additional in-progress work. These changes are not a claim of a completed production deployment.

- Certificate preview no longer calls the old preview-charge function; preview is intended to remain free.
- Added a Certificate Print button that opens the generated PDF in a browser tab. The app cannot verify that a physical print completed.
- Added responsive preview CSS, Image Library name search, lazy thumbnail loading, and opt-in registrar-office image auto-selection using the existing `/api/bot/pdf-image-match` endpoint.
- Added a regression test file for the UI and additive image metadata migration, and a GitHub Actions workflow intended to run `npm test`.
- Neon image metadata now includes an additive `file_size` column. Removed image records are soft-deleted from the active list rather than deleting their database rows, so historical bytes may remain in Neon for recovery.
- Static JavaScript parsing and targeted source assertions were checked through the GitHub source contents. The full `npm test`, real Neon CRUD/migration, browser viewport, print, and Render redeploy checks have not yet been confirmed in this environment.

## Remaining work / explicitly not verified

- Data Stor is a separate Next.js application with its own session, database, and wallet rules. The current menu entry opens its existing search page; shared login/SSO or a server-side proxy is not implemented. Do not expose Data Stor credentials or copy its database into AutoFill without a separately reviewed integration.
- Download and Print charge rates are not configured as explicit separate rates in the current AutoFill code. Do not infer them from `previewRate`; preview must remain free. Define and approve the rate and print billing trigger before implementing a debit.
- SutonnyMJ and Suleman Sharif Ambad font files were not found at the expected repository paths. Their actual font binaries and licensing/encoding details are required before adding them to the selector or claiming PDF embedding support.
- The updated branch has not been merged into `main`, and a Render deployment of these latest commits has not been verified.
- A complete project ZIP, runtime/browser tests, live DB checks, and responsive visual checks remain outstanding.


## Follow-up hardening — 2026-10-27

- Neon image row mapping now applies metadata first and authoritative database columns afterward, so stale JSON metadata cannot override the saved ID, file name, MIME type, position, file size, permanence flag, or timestamps.
- Both position-save API aliases now preserve extra existing position properties (for example rotation/alignment/scale) while updating the standard x/y/z/w/h fields.
- Added source regression checks for these two preservation rules.
- These are source-level changes only until the latest branch CI and live database/browser tests report results. Do not merge or deploy solely on the basis of static checks.
