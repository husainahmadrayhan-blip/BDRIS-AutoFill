'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const cacheDir = path.join(root, '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = cacheDir;

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

const candidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files','Google','Chrome','Application','chrome.exe') : null,
  process.platform === 'win32' ? path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe') : null,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

const found = candidates.find(p => typeof p === 'string' && fs.existsSync(p));
if (found) {
  process.env.PUPPETEER_EXECUTABLE_PATH = found;
  console.log('[BDRIS] Using system browser:', found);
  process.exit(0);
}

function installManagedChrome() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('[BDRIS] No system Chrome found. Installing Puppeteer managed Chrome into:', cacheDir);
  try {
    execFileSync(npx, ['puppeteer', 'browsers', 'install', 'chrome'], {
      cwd: root, env: process.env, stdio: 'inherit'
    });
  } catch (e) {
    console.error('[BDRIS] Puppeteer Chrome installation failed.');
    process.exit(1);
  }
}

(async () => {
  let chrome = findChrome(cacheDir);
  if (!chrome) installManagedChrome();
  chrome = findChrome(cacheDir);
  if (!chrome) {
    console.error('[BDRIS] Puppeteer Chrome not found under:', cacheDir);
    process.exit(1);
  }
  process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
  console.log('[BDRIS] Puppeteer Chrome verified:', chrome);
})();
