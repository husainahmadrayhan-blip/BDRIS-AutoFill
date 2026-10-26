'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, createShutdown, validateJob } = require('../server');
const { createUrlValidator, isPublicAddress } = require('../browser');
const { JobQueue } = require('../job-queue');

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fil-automation-test-'));
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups) await cleanup();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return { storePath: path.join(directory, 'jobs.json'), addCleanup: cleanup => cleanups.push(cleanup) };
}

async function waitFor(queue, id, status, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = [...queue.jobs.values()].find(item => item.id === id);
    if (job?.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job status ${status}.`);
}

test('accepts only the declared, constrained job shapes', () => {
  assert.equal(validateJob({ type: 'navigate', url: 'https://example.com' }), null);
  assert.equal(validateJob({ type: 'fill-form', url: 'https://example.com', fields: [{ selector: '#name', value: 'sample' }] }), null);
  assert.match(validateJob({ type: 'navigate', url: 'https://example.com', javascript: 'alert(1)' }), /Unsupported job property/);
  assert.match(validateJob({ type: 'execute', url: 'https://example.com' }), /Supported task types/);
  assert.match(validateJob({ type: 'fill-form', url: 'https://example.com', fields: [] }), /between 1 and 20/);
});

test('blocks private, reserved, and unapproved URL targets', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.20.1.2', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  const validateUrl = createUrlValidator(['example.com']);
  await assert.rejects(validateUrl('http://example.com'), /HTTPS/);
  await assert.rejects(validateUrl('https://example.com/?token=secret'), /query strings/);
  await assert.rejects(validateUrl('https://localhost'), /not in AUTOMATION_ALLOWED_HOSTS/);
});

test('requires authentication, validates job input, and enforces job ownership', async t => {
  const { storePath, addCleanup } = await temporaryStore(t);
  const key = crypto.randomBytes(32).toString('hex');
  const queue = new JobQueue({
    storePath, concurrency: 1, retryLimit: 0, timeoutMs: 1000,
    execute: async payload => ({ ok: true, url: payload.url })
  });
  await queue.initialize();
  const browser = { validateUrl: async value => new URL(value), close: async () => {} };
  const app = createApp({ queue, browser, apiKey: key });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  addCleanup(async () => {
    await queue.shutdown();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauthenticated = await fetch(`${base}/health`);
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedJob = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'navigate', url: 'https://example.com' })
  });
  assert.equal(unauthenticatedJob.status, 401);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Job-Owner': 'user-a' };
  const invalid = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ type: 'run-code', url: 'https://example.com' }) });
  assert.equal(invalid.status, 400);
  const submitted = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ type: 'navigate', url: 'https://example.com' }) });
  assert.equal(submitted.status, 202);
  const { job } = await submitted.json();
  const completed = await waitFor(queue, job.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.url, 'https://example.com');
  const forbidden = await fetch(`${base}/api/jobs/${job.id}`, { headers: { Authorization: `Bearer ${key}`, 'X-Job-Owner': 'user-b' } });
  assert.equal(forbidden.status, 404);
  const authenticatedHealth = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(authenticatedHealth.status, 200);
});

test('deduplicates idempotent requests and marks interrupted jobs failed after restart', async t => {
  const { storePath, addCleanup } = await temporaryStore(t);
  let release;
  const execute = () => new Promise(resolve => { release = resolve; });
  const queue = new JobQueue({ storePath, concurrency: 1, retryLimit: 0, timeoutMs: 10000, execute });
  await queue.initialize();
  addCleanup(() => queue.shutdown());
  const first = await queue.enqueue({ type: 'navigate', ownerId: 'owner', idempotencyKey: 'once', payload: { url: 'https://example.com' } });
  const duplicate = await queue.enqueue({ type: 'navigate', ownerId: 'owner', idempotencyKey: 'once', payload: { url: 'https://example.com' } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, first.job.id);
  await waitFor(queue, first.job.id, 'running');
  const restarted = new JobQueue({ storePath, concurrency: 1, retryLimit: 0, timeoutMs: 1000, execute: async () => ({ ok: true }) });
  await restarted.initialize();
  addCleanup(() => restarted.shutdown());
  assert.equal(restarted.get(first.job.id, 'owner').status, 'failed');
  assert.match(restarted.get(first.job.id, 'owner').error, /restarted/);
  release?.({ ok: true });
});

test('retries a failed attempt only up to the configured limit', async t => {
  const { storePath, addCleanup } = await temporaryStore(t);
  let attempts = 0;
  const queue = new JobQueue({
    storePath, concurrency: 1, retryLimit: 1, timeoutMs: 1000,
    execute: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary navigation failure');
      return { ok: true };
    }
  });
  await queue.initialize();
  addCleanup(() => queue.shutdown());
  const { job } = await queue.enqueue({ type: 'navigate', ownerId: 'owner', payload: {} });
  const completed = await waitFor(queue, job.id, 'completed');
  assert.equal(completed.attempt, 2);
  assert.equal(attempts, 2);
  assert.match(completed.logs[0].message, /retrying/);
});

test('handles execution timeouts and sanitizes errors', async t => {
  const { storePath, addCleanup } = await temporaryStore(t);
  const queue = new JobQueue({
    storePath, concurrency: 1, retryLimit: 0, timeoutMs: 30,
    execute: () => new Promise(() => {})
  });
  await queue.initialize();
  addCleanup(() => queue.shutdown());
  const { job } = await queue.enqueue({ type: 'navigate', ownerId: 'owner', payload: {} });
  const failed = await waitFor(queue, job.id, 'failed');
  assert.match(failed.error, /timeout/i);
  assert.ok(failed.endedAt - failed.startedAt >= 0);
});

test('stops for human verification and exposes a non-bypass status', async t => {
  const { storePath, addCleanup } = await temporaryStore(t);
  const queue = new JobQueue({
    storePath, concurrency: 1, retryLimit: 2, timeoutMs: 1000,
    execute: async () => { throw Object.assign(new Error('Human verification required.'), { code: 'HUMAN_VERIFICATION_REQUIRED' }); }
  });
  await queue.initialize();
  addCleanup(() => queue.shutdown());
  const { job } = await queue.enqueue({ type: 'fill-form', ownerId: 'owner', payload: {} });
  const stopped = await waitFor(queue, job.id, 'human_verification_required');
  assert.match(stopped.error, /Human verification/);
  assert.equal(stopped.attempt, 1);
});

test('graceful shutdown is idempotent and waits for queue and browser cleanup', async () => {
  const calls = [];
  const server = { close: callback => { calls.push('server'); callback(); } };
  const queue = { shutdown: async () => { calls.push('queue'); } };
  const browser = { close: async () => { calls.push('browser'); } };
  const shutdown = createShutdown(server, queue, browser);
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  assert.deepEqual(calls, ['server', 'queue', 'browser']);
});

test('launches Chromium, visits an approved test page, and closes its browser context', { timeout: 45000 }, async () => {
  const { createBrowserService } = require('../browser');
  const browser = createBrowserService({
    allowedHosts: ['example.com'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    timeouts: { navigation: 15000, selector: 3000 }
  });
  try {
    const result = await browser.execute(
      { type: 'navigate', url: 'https://example.com', waitUntil: 'domcontentloaded' },
      { jobId: 'browser-test', signal: new AbortController().signal, log: () => {} }
    );
    assert.equal(result.ok, true);
    assert.equal(result.host, 'example.com');
    assert.equal(result.status, 200);
    assert.equal(browser.activeContextCount, 0);
  } finally {
    await browser.close();
  }
});
