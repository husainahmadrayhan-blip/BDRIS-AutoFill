'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = __dirname;
const cacheDir = path.join(root, '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = cacheDir;
fs.mkdirSync(cacheDir, { recursive: true });

function findChrome(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: current, depth } = stack.pop();
    if (depth > 8) continue;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(current, e.name);
      if (e.isFile() && e.name === 'chrome') return p;
      if (e.isDirectory() && !e.name.startsWith('.')) stack.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

function installChrome() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('[Render] Puppeteer cache:', cacheDir);
  console.log('[Render] Installing Puppeteer Chrome...');
  const r = spawnSync(npx, ['puppeteer', 'browsers', 'install', 'chrome'], {
    cwd: root, env: process.env, stdio: 'inherit'
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}

(async () => {
  installChrome();

  // Do NOT use puppeteer.executablePath() for verification: on some Puppeteer
  // builds it is Promise-like, which previously produced "Promise { <pending> }".
  const chrome = findChrome(cacheDir);
  if (!chrome || !fs.existsSync(chrome)) {
    console.error('[Render] Chrome install verification FAILED.');
    console.error('[Render] Expected a Chrome binary under:', cacheDir);
    process.exit(1);
  }

  console.log('[Render] Chrome VERIFIED:', chrome);
  console.log('[Render] Chrome size:', fs.statSync(chrome).size, 'bytes');
})().catch(err => {
  console.error('[Render] Chrome build verification failed:', err.message || err);
  process.exit(1);
});
