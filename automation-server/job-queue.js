'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function safeError(error) {
  return String(error?.message || error || 'Job failed.')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:bearer\s+)[\w.-]+/gi, 'Bearer [redacted]')
    .replace(/\b(password|token|secret|cookie|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, 300);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    type: job.type,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.startedAt ? (job.endedAt || Date.now()) - job.startedAt : null,
    attempt: job.attempt,
    logs: [...job.logs],
    error: job.error,
    result: job.result
  };
}

function hashOwner(ownerId) {
  return crypto.createHash('sha256').update(String(ownerId)).digest('hex');
}

class JobQueue {
  constructor({ storePath, concurrency = 1, retryLimit = 0, timeoutMs = 60000, maxPending = 100, execute }) {
    this.storePath = storePath;
    this.concurrency = concurrency;
    this.retryLimit = retryLimit;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.execute = execute;
    this.jobs = new Map();
    this.payloads = new Map();
    this.controllers = new Map();
    this.runningTasks = new Set();
    this.active = 0;
    this.stopped = false;
    this.persistChain = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true });
    let records = [];
    try {
      records = JSON.parse(await fs.promises.readFile(this.storePath, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid automation job store.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const job of records) {
      if (!job || typeof job.id !== 'string') continue;
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.endedAt = Date.now();
        job.error = 'Service restarted before this job completed; it was not replayed.';
      }
      this.jobs.set(job.id, job);
    }
    await this.persist();
  }

  async persist() {
    const snapshot = [...this.jobs.values()].slice(-2000);
    const json = JSON.stringify(snapshot);
    this.persistChain = this.persistChain.then(async () => {
      const tempPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(tempPath, json, { mode: 0o600 });
      await fs.promises.rename(tempPath, this.storePath);
    });
    return this.persistChain;
  }

  async enqueue({ type, ownerId, idempotencyKey, payload }) {
    if (this.stopped) throw new Error('Automation queue is shutting down.');
    const ownerHash = hashOwner(ownerId);
    const idempotencyHash = idempotencyKey ? crypto.createHash('sha256').update(`${ownerHash}:${idempotencyKey}`).digest('hex') : null;
    if (idempotencyHash) {
      const existing = [...this.jobs.values()].find(job => job.idempotencyHash === idempotencyHash);
      if (existing) return { job: publicJob(existing), duplicate: true };
    }
    const pending = [...this.jobs.values()].filter(job => job.status === 'queued').length;
    if (pending >= this.maxPending) throw new Error('Automation queue is full; try again later.');
    if (this.jobs.size >= 2000) {
      for (const [id, job] of this.jobs) {
        if (this.jobs.size < 1800) break;
        if (['completed', 'failed', 'cancelled', 'human_verification_required'].includes(job.status)) this.jobs.delete(id);
      }
    }
    const job = {
      id: crypto.randomUUID(),
      ownerHash,
      idempotencyHash,
      status: 'queued',
      type,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      attempt: 0,
      logs: [],
      error: null,
      result: null
    };
    this.jobs.set(job.id, job);
    this.payloads.set(job.id, payload);
    try {
      await this.persist();
      this.drain();
    } catch (error) {
      this.jobs.delete(job.id);
      this.payloads.delete(job.id);
      throw error;
    }
    return { job: publicJob(job), duplicate: false };
  }

  get(id, ownerId) {
    const job = this.jobs.get(id);
    return job && job.ownerHash === hashOwner(ownerId) ? publicJob(job) : null;
  }

  async cancel(id, ownerId) {
    const job = this.jobs.get(id);
    if (!job || job.ownerHash !== hashOwner(ownerId)) return null;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.endedAt = Date.now();
      job.error = 'Cancelled before execution.';
      this.payloads.delete(id);
      await this.persist();
    } else if (job.status === 'running') {
      this.controllers.get(id)?.abort(new Error('Job cancelled.'));
    }
    return publicJob(job);
  }

  drain() {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      const job = [...this.jobs.values()].find(item => item.status === 'queued' && this.payloads.has(item.id));
      if (!job) return;
      this.active++;
      const task = this.run(job);
      this.runningTasks.add(task);
      void task.finally(() => this.runningTasks.delete(task));
    }
  }

  async run(job) {
    const payload = this.payloads.get(job.id);
    this.payloads.delete(job.id);
    job.status = 'running';
    job.startedAt = Date.now();
    try {
      for (let attempt = 1; attempt <= this.retryLimit + 1; attempt++) {
        if (this.stopped) throw new Error('Automation service is shutting down.');
        job.attempt = attempt;
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        let timer;
        let timedOut = false;
        try {
          const result = await Promise.race([
            this.execute(payload, {
              jobId: job.id,
              signal: controller.signal,
              log: message => {
                job.logs.push({ at: Date.now(), message: safeError(message) });
                job.logs = job.logs.slice(-50);
              }
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                const timeoutError = Object.assign(new Error(`Job exceeded the ${this.timeoutMs} ms execution timeout.`), { code: 'ETIMEDOUT' });
                controller.abort(timeoutError);
                reject(timeoutError);
              }, this.timeoutMs);
            }),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('Job aborted.')), { once: true }))
          ]);
          job.status = 'completed';
          job.result = result;
          job.error = null;
          break;
        } catch (error) {
          const aborted = controller.signal.aborted;
          if (error?.code === 'HUMAN_VERIFICATION_REQUIRED') {
            job.status = 'human_verification_required';
            job.error = safeError(error);
            break;
          }
          if ((!aborted || timedOut) && attempt <= this.retryLimit && !this.stopped) {
            job.logs.push({ at: Date.now(), message: `Attempt ${attempt} failed; retrying: ${safeError(error)}` });
            continue;
          }
          job.status = this.stopped ? 'failed' : aborted && !timedOut ? 'cancelled' : 'failed';
          job.error = safeError(error);
          break;
        } finally {
          clearTimeout(timer);
          this.controllers.delete(job.id);
        }
      }
    } catch (error) {
      job.status = 'failed';
      job.error = safeError(error);
    } finally {
      job.endedAt = Date.now();
      this.active--;
      try {
        await this.persist();
      } catch (error) {
        job.status = 'failed';
        job.error = 'Could not persist job status; inspect the automation server storage.';
        console.error('[Automation Queue] Could not persist execution result:', safeError(error));
      }
      this.drain();
    }
  }

  async shutdown() {
    this.stopped = true;
    for (const [id, job] of this.jobs) {
      if (job.status === 'queued') {
        job.status = 'failed';
        job.endedAt = Date.now();
        job.error = 'Service shutting down; queued job was not executed.';
        this.payloads.delete(id);
      }
    }
    for (const controller of this.controllers.values()) controller.abort(new Error('Automation service is shutting down.'));
    await Promise.allSettled([...this.runningTasks]);
    await this.persist();
  }
}

module.exports = { JobQueue, publicJob, safeError };
