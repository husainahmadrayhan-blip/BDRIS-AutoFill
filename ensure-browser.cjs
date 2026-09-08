'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const cacheDir = path.join(root, '.cache', 'puppeteer');
// Build and runtime MUST use the same Puppeteer cache.
process.env.PUPPETEER_CACHE_DIR = cacheDir;

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

async function verifyManagedChrome() {
  try {
    const puppeteer = require('puppeteer');
    // Puppeteer 25.x can expose executablePath() as a Promise.
    const executable = await puppeteer.executablePath();
    if (typeof executable === 'string' && executable && fs.existsSync(executable)) {
      console.log('[BDRIS] Puppeteer Chrome verified:', executable);
      return true;
    }
    console.error('[BDRIS] Puppeteer Chrome not found at:', executable || '(empty path)');
    return false;
  } catch (e) {
    console.error('[BDRIS] Puppeteer verification failed:', e.message);
    return false;
  }
}

(async () => {
  // During npm install, always install and verify managed Chrome if system Chrome is absent.
  if (process.argv.includes('--install-only')) {
    installManagedChrome();
    if (!(await verifyManagedChrome())) process.exit(1);
    process.exit(0);
  }

  // Before start, verify the browser; if a build artifact did not retain the cache,
  // repair it before the server starts instead of allowing a runtime PDF error.
  if (!(await verifyManagedChrome())) {
    installManagedChrome();
    if (!(await verifyManagedChrome())) process.exit(1);
  }
})();
