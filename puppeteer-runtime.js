'use strict';

const fs = require('node:fs');
const path = require('node:path');

const cacheDirectory = path.join(__dirname, '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = cacheDirectory;

const puppeteer = require('puppeteer');

async function launchPuppeteerBrowser({ executablePath, extraArgs = [] } = {}) {
  const configuredPath = executablePath ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROMIUM_PATH;
  let resolvedPath = configuredPath;

  if (configuredPath) {
    if (!fs.existsSync(configuredPath)) {
      throw new Error('The configured Chrome executable does not exist. Check PUPPETEER_EXECUTABLE_PATH, CHROME_PATH, or CHROMIUM_PATH.');
    }
  } else {
    try {
      resolvedPath = await puppeteer.executablePath();
    } catch (error) {
      throw new Error('Puppeteer could not resolve its managed Chrome. Run `npm run install:browser` during the build.', { cause: error });
    }
    if (typeof resolvedPath !== 'string' || !resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error('Puppeteer managed Chrome is missing. Run `npm run install:browser` during the build.');
    }
  }

  const args = process.platform === 'linux'
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    : [];

  return puppeteer.launch({
    headless: true,
    executablePath: resolvedPath,
    args: [...args, ...extraArgs]
  });
}

module.exports = { launchPuppeteerBrowser, puppeteer, cacheDirectory };
