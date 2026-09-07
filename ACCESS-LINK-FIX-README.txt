BDRIS AutoFill — Access Link Final Fix

IMPORTANT
- Deploy this ZIP to the SAME Render Web Service that serves the public app.
- Open /admin.html from that deployed URL. Do NOT open admin.html with file://.
- Create a NEW user after deployment. New links contain access=, uid= and an encrypted auth payload.
- The encrypted payload allows the generated user link to recover its user record if Render Free loses the local users.json after a restart/deploy.
- Set Render Environment Variable AUTH_SECRET to a long random secret. If omitted, ADMIN_PASSWORD is used as the encryption secret.
- Existing old links without auth= still require their user record to exist on the current service.
- Never commit .private/users.json or plaintext passwords to GitHub.
