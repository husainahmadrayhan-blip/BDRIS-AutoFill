BDRIS AutoFill Render Chrome Fix

This build forces Puppeteer Chrome into .cache/puppeteer during npm install and verifies it before the server starts.

Recommended Render Build Command:
npm install --omit=dev && node render-build.cjs

Recommended Start Command:
npm start

If using Render Blueprint, render.yaml already contains these commands.
