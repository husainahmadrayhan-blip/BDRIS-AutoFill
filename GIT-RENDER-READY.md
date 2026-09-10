# BDRIS AutoFill — Git + Render Ready

## Render
- Build: `npm ci && npx puppeteer browsers install chrome`
- Start: `node server.js`
- Health: `/ping`
- `render.yaml` is included.

## Git
```bash
git init
git add .
git commit -m "Final BDRIS AutoFill Render ready"
git branch -M main
```

Push this folder to your GitHub repository, then create a Render Web Service from that repository.

## Important
Set `ADMIN_PASSWORD` and `AUTH_SECRET` as Render environment variables before using the admin panel. Do not commit real secrets.

The main local application remains direct/no-login as configured in this build; admin routes remain protected.
