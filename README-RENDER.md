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

## Update 3–11: Image Library persistence and billing notes

- The server creates the additive `fil_pdf_images` Neon table at startup when `DATABASE_URL` is configured. Image bytes, IDs, MIME types, names, timestamps and saved position metadata are stored together.
- On first migration, the app imports the Image Library visible in its current local storage. Before deploying, sign in and use **PDF Image → Prepare for GitHub** or **Image Library → Export Permanent ZIP** to keep an independent backup of existing images and positions. The app cannot recover files that are already missing from an ephemeral disk.
- The `fil_usage_charges` table records idempotent certificate-download charges. Preview does not debit the wallet. Download uses the existing per-user `previewRate` value; no new print price is assumed because no separate print rate is configured.
- Image Library now has search and lazy-loaded previews, and the standalone library page has a search filter. No fixed 10-image count limit was found in the current upload API.
- The Data Stor menu opens the existing search site. It is **not** SSO: Data Stor currently uses its own approved-user session cookie, and no documented server-to-server identity endpoint or shared authentication secret was found. Do not put Data Stor credentials in browser code.
- SolaimanLipi Thin and Normal are supported in the certificate font selector and PDF font embedding flow. Their files must exist at `/fonts/SolaimanLipi-Thin.ttf` and `/fonts/SolaimanLipi-Normal.ttf` respectively.
- SutonnyMJ and Suleman Sharif Ambad remain unavailable until their real font files are supplied. No fake font files are included.

The main-branch GitHub Actions workflow runs the build, regression tests and browser smoke test on each push. Check the latest run before treating a deployment as verified.

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
