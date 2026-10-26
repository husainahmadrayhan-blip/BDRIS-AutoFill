# V6 merged project report

## Merged from earlier Make-Server project
- PDF image library page and image assets
- Persistent office image slots
- Image delete/replace lifecycle
- Image position save endpoints
- Portable PDF image library ZIP export
- Bangladesh geo data file

## Retained from V6
- Existing certificate UI/PDF generation, Puppeteer, QR and CAPTCHA flow
- Login, admin login, user management, balance and preview charging
- Optional PostgreSQL persistence for user/balance data
- Existing Bengali font assets

## Bot exclusions
- No WhatsApp bot bridge or `/api/bot/*` endpoint was merged. `server.js` is retained because it is the server entry-point shim, not a bot. `script1.js` is retained as a certificate/template asset and is not referenced as a WhatsApp bot.

## Test status
- `npm test` performs JavaScript syntax checks.
- External deployment was not performed: no hosting account credentials or target service settings were provided. Configure `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_USERNAME`, and a strong `ADMIN_PASSWORD` before production use. Configure persistent disk storage with `PDF_IMAGE_STORAGE_DIR` if your host uses ephemeral filesystems.
- This merge does not claim end-to-end validation against the live BDRIS service or payment provider.
