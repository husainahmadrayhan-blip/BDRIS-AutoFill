'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createWorker } = require('./worker');

function loadAutomationEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    process.env[match[1]] = value;
  }
}

function validateJob(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object is required.';
  const allowedKeys = new Set(['type', 'url', 'selector', 'waitUntil', 'fields']);
  if (Object.keys(body).some(key => !allowedKeys.has(key))) return 'Unsupported job property.';
  if (!['navigate', 'fill-form'].includes(body.type)) return 'Supported task types are navigate and fill-form.';
  if (typeof body.url !== 'string') return 'A URL is required.';
  if (body.waitUntil !== undefined && !['load', 'domcontentloaded', 'networkidle0', 'networkidle2'].includes(body.waitUntil)) return 'Invalid navigation wait mode.';
  if (body.selector !== undefined && (typeof body.selector !== 'string' || body.selector.length > 200 || /[\r\n]/.test(body.selector))) return 'Invalid selector.';
  if (body.type === 'navigate') {
    if (body.fields !== undefined) return 'navigate does not accept form fields.';
  } else {
    if (!Array.isArray(body.fields) || body.fields.length < 1 || body.fields.length > 20) return 'fill-form requires between 1 and 20 fields.';
    for (const field of body.fields) {
      if (!field || Object.keys(field).some(key => !['selector', 'value'].includes(key)) ||
          typeof field.selector !== 'string' || !field.selector.trim() || field.selector.length > 200 ||
          typeof field.value !== 'string' || field.value.length > 512) return 'Each form field needs a selector and a string value under 512 characters.';
    }
  }
  return null;
}

function createApp({ queue, browser, apiKey, rateLimit = 30 }) {
  if (!apiKey || apiKey.length < 32) throw new Error('AUTOMATION_API_KEY must contain at least 32 characters.');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  const requests = new Map();
  app.use((req, res, next) => {
    const supplied = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const left = Buffer.from(supplied);
    const right = Buffer.from(apiKey);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    const now = Date.now();
    const key = crypto.createHash('sha256').update(supplied).digest('hex');
    const recent = (requests.get(key) || []).filter(time => now - time < 60000);
    if (recent.length >= rateLimit) return res.status(429).json({ ok: false, error: 'Rate limit exceeded.' });
    recent.push(now);
    requests.set(key, recent);
    next();
  });

  app.get('/health', (req, res) => res.json({
    ok: true,
    service: 'puppeteer-automation',
    browserReady: browser.preflightSuccessful,
    queue: { queued: [...queue.jobs.values()].filter(job => job.status === 'queued').length, active: queue.active }
  }));

  app.post('/api/jobs', async (req, res) => {
    const error = validateJob(req.body);
    if (error) return res.status(400).json({ ok: false, error });
    try {
      await browser.validateUrl(req.body.url);
      const ownerId = String(req.get('X-Job-Owner') || 'api-key-owner').slice(0, 100);
      const idempotencyKey = req.get('Idempotency-Key') || '';
      if (idempotencyKey.length > 128) return res.status(400).json({ ok: false, error: 'Idempotency-Key is too long.' });
      const { job, duplicate } = await queue.enqueue({
        type: req.body.type,
        ownerId,
        idempotencyKey,
        payload: req.body
      });
      return res.status(duplicate ? 200 : 202).json({ ok: true, duplicate, job });
    } catch (error) {
      return res.status(400).json({ ok: false, error: String(error.message || error).slice(0, 300) });
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = queue.get(req.params.id, String(req.get('X-Job-Owner') || 'api-key-owner').slice(0, 100));
    return job ? res.json({ ok: true, job }) : res.status(404).json({ ok: false, error: 'Job not found.' });
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const job = await queue.cancel(req.params.id, String(req.get('X-Job-Owner') || 'api-key-owner').slice(0, 100));
    return job ? res.json({ ok: true, job }) : res.status(404).json({ ok: false, error: 'Job not found.' });
  });
  return app;
}

function createShutdown(server, queue, browser) {
  let shutdownPromise;
  return signal => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`[Automation] ${signal}: graceful shutdown started.`);
      let shutdownError;
      const serverClosed = new Promise((resolve, reject) => {
        try {
          server.close(error => error ? reject(error) : resolve());
        } catch (error) {
          reject(error);
        }
      });
      try { await queue.shutdown(); } catch (error) { shutdownError = error; }
      try { await browser.close(); } catch (error) { shutdownError ||= error; }
      try { await serverClosed; } catch (error) { shutdownError ||= error; }
      if (shutdownError) throw shutdownError;
      console.log('[Automation] Shutdown complete.');
    })();
    return shutdownPromise;
  };
}

async function start() {
  loadAutomationEnv();
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (!apiKey || apiKey.length < 32) throw new Error('Set AUTOMATION_API_KEY to a random value at least 32 characters long.');
  const { queue, browser, allowedHosts } = createWorker();
  await queue.initialize();
  await browser.preflight();
  const app = createApp({ queue, browser, apiKey });
  const port = Number(process.env.AUTOMATION_PORT || process.env.PORT || 3001);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[Automation] Listening on 0.0.0.0:${port}; host allowlist: ${allowedHosts.join(', ')}; concurrency: ${queue.concurrency}.`);
  });
  server.on('error', error => {
    console.error('[Automation] HTTP server failed:', error.message);
    process.exitCode = 1;
  });
  const shutdown = createShutdown(server, queue, browser);
  const signalHandler = signal => {
    void shutdown(signal).catch(error => {
      console.error('[Automation] Graceful shutdown failed:', String(error.message || error).slice(0, 300));
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => signalHandler('SIGINT'));
  process.once('SIGTERM', () => signalHandler('SIGTERM'));
}

if (require.main === module) start().catch(error => {
  console.error('[Automation] Startup failed:', String(error.message || error).slice(0, 300));
  process.exitCode = 1;
});

module.exports = { createApp, createShutdown, loadAutomationEnv, start, validateJob };
