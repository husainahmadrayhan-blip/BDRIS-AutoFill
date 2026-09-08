'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const cacheDir = path.join(__dirname, '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = cacheDir;
console.log('[Render] Installing Puppeteer Chrome into:', cacheDir);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const r = spawnSync(npx, ['puppeteer', 'browsers', 'install', 'chrome'], {
  cwd: __dirname,
  env: process.env,
  stdio: 'inherit'
});
if (r.status !== 0) process.exit(r.status || 1);
const puppeteer = require('puppeteer');
const executable = puppeteer.executablePath();
const fs = require('fs');
if (!executable || !fs.existsSync(executable)) {
  console.error('[Render] Chrome install verification failed:', executable || '(empty path)');
  process.exit(1);
}
console.log('[Render] Chrome verified:', executable);
