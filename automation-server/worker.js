'use strict';

const path = require('node:path');
const { createBrowserService } = require('./browser');
const { JobQueue } = require('./job-queue');

function parsePositiveInteger(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : fallback;
}

function createWorker(env = process.env) {
  const allowedHosts = String(env.AUTOMATION_ALLOWED_HOSTS || 'example.com')
    .split(',').map(value => value.trim()).filter(Boolean);
  const browser = createBrowserService({
    allowedHosts,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH,
    timeouts: {
      navigation: parsePositiveInteger(env.AUTOMATION_NAVIGATION_TIMEOUT_MS, 30000, 120000),
      selector: parsePositiveInteger(env.AUTOMATION_SELECTOR_TIMEOUT_MS, 10000, 60000)
    }
  });
  const queue = new JobQueue({
    storePath: env.AUTOMATION_JOB_STORE || path.join(__dirname, '..', '.private', 'automation-jobs.json'),
    concurrency: parsePositiveInteger(env.AUTOMATION_CONCURRENCY, 1, 4),
    retryLimit: parsePositiveInteger(env.AUTOMATION_RETRY_LIMIT, 0, 3),
    timeoutMs: parsePositiveInteger(env.AUTOMATION_JOB_TIMEOUT_MS, 60000, 180000),
    execute: browser.execute
  });
  return { queue, browser, allowedHosts };
}

module.exports = { createWorker, parsePositiveInteger };
