const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
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
  console.log('[BDRIS] Using browser:', found);
  process.exit(0);
}
if (process.argv.includes('--install-only')) {
  console.log('[BDRIS] No system Chrome found. Installing Puppeteer managed Chrome...');
  try {
    process.env.PUPPETEER_CACHE_DIR = path.join(root, '.cache', 'puppeteer');
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
      cwd: root,
      env: { ...process.env, PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR },
      stdio: 'inherit'
    });
    console.log('[BDRIS] Managed Chrome installation completed.');
    process.exit(0);
  } catch (e) {
    console.error('[BDRIS] Managed Chrome installation failed:', e.message);
    process.exit(1);
  }
}
console.log('[BDRIS] No system Chrome found. Puppeteer will resolve its managed browser.');
