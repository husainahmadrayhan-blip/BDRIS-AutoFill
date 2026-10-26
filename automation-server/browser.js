'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { launchPuppeteerBrowser } = require('../puppeteer-runtime');

class HumanVerificationRequiredError extends Error {
  constructor() {
    super('CAPTCHA, OTP, or a security verification step requires human completion.');
    this.code = 'HUMAN_VERIFICATION_REQUIRED';
  }
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    const [c] = octets.slice(2);
    return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
    );
  }
  if (!net.isIPv6(address)) return false;
  const normalized = address.toLowerCase().split('%')[0];
  return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
}

function createUrlValidator(allowedHosts) {
  const allowed = allowedHosts.map(host => host.toLowerCase().replace(/\.$/, ''));
  const dnsCache = new Map();
  const validateUrl = async function validateUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('URL must be a string under 2048 characters.');
    let url;
    try { url = new URL(value); } catch { throw new Error('A valid HTTPS URL is required.'); }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || net.isIP(hostname)) {
      throw new Error('Only HTTPS URLs without credentials, query strings, or fragments are allowed.');
    }
    if (!allowed.includes(hostname)) {
      throw new Error('URL host is not in AUTOMATION_ALLOWED_HOSTS.');
    }
    if (!dnsCache.has(hostname)) {
      dnsCache.set(hostname, dns.lookup(hostname, { all: true, verbatim: true }).then(addresses => {
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          throw new Error('URL resolves to a non-public network address.');
        }
        return addresses;
      }).catch(error => {
        dnsCache.delete(hostname);
        throw error;
      }));
    }
    await dnsCache.get(hostname);
    return url;
  };
  validateUrl.resolveAddresses = async hostname => {
    if (!dnsCache.has(hostname)) await validateUrl(`https://${hostname}/`);
    return dnsCache.get(hostname);
  };
  return validateUrl;
}

function createBrowserService({ allowedHosts, executablePath, timeouts = {} }) {
  const validateUrl = createUrlValidator(allowedHosts);
  const activeContexts = new Set();
  let browserPromise;
  let closing = false;
  let preflightSuccessful = null;

  async function getBrowser() {
    if (closing) throw new Error('Automation browser is shutting down.');
    if (!browserPromise) {
      browserPromise = (async () => {
        const resolverRules = [];
        for (const hostname of allowedHosts) {
          const addresses = await validateUrl.resolveAddresses(hostname);
          const address = addresses.find(entry => net.isIPv4(entry.address)) || addresses[0];
          resolverRules.push(`MAP ${hostname} ${address.address}`);
        }
        try {
          const instance = await launchPuppeteerBrowser({
            executablePath,
            extraArgs: [`--host-resolver-rules=${resolverRules.join(',')}`]
          });
          instance.once('disconnected', () => { browserPromise = null; });
          console.log('[Automation] Puppeteer-managed Chromium launched.');
          return instance;
        } catch (error) {
          browserPromise = null;
          const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 300);
          throw new Error(`Chrome/Chromium launch failed. Check PUPPETEER_EXECUTABLE_PATH and host sandbox/shared-library support. ${message}`);
        }
      })();
    }
    return browserPromise;
  }

  async function execute(job, { signal, log }) {
    const { type, url: inputUrl } = job;
    const target = await validateUrl(inputUrl);
    const instance = await getBrowser();
    const context = await instance.createBrowserContext();
    activeContexts.add(context);
    let page;
    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeouts.selector || 10000);
      page.setDefaultNavigationTimeout(timeouts.navigation || 30000);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const requestUrl = request.url();
        if (requestUrl === 'about:blank' || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
          void request.continue().catch(() => {});
          return;
        }
        void validateUrl(requestUrl)
          .then(() => request.continue())
          .catch(() => request.abort('blockedbyclient').catch(() => {}));
      });
      const abort = () => { void context.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        log(`Navigating to approved host ${target.hostname}.`);
        const response = await page.goto(target.href, { waitUntil: job.waitUntil || 'domcontentloaded' });
        if (!response || response.status() >= 400) throw new Error(`Navigation returned HTTP ${response?.status() || 'no response'}.`);
        const verificationNeeded = await page.evaluate(() => {
          const controls = [...document.querySelectorAll('input,textarea,select')];
          const hints = controls.map(node =>
            `${node.id || ''} ${node.name || ''} ${node.autocomplete || ''} ${node.getAttribute('aria-label') || ''} ${node.placeholder || ''}`
          ).join(' ');
          const text = document.body?.innerText || '';
          return /captcha|one[- ]time (?:password|code)|\botp\b|verification code|security code/i.test(`${hints} ${text}`);
        });
        if (verificationNeeded) throw new HumanVerificationRequiredError();
        if (type === 'fill-form') {
          for (const field of job.fields) {
            const element = await page.$(field.selector);
            if (!element) throw new Error(`Form selector was not found: ${field.selector}`);
            const metadata = await element.evaluate(node => ({
              tag: node.tagName.toLowerCase(),
              type: String(node.type || '').toLowerCase(),
              disabled: Boolean(node.disabled),
              readOnly: Boolean(node.readOnly),
              description: `${node.id || ''} ${node.name || ''} ${node.autocomplete || ''} ${node.getAttribute('aria-label') || ''} ${node.placeholder || ''}`.toLowerCase()
            }));
            if (/captcha|one.?time|otp|verification|security code/.test(`${metadata.description} ${field.selector.toLowerCase()}`)) {
              throw new HumanVerificationRequiredError();
            }
            if (!['input', 'textarea', 'select'].includes(metadata.tag) ||
                ['password', 'hidden', 'file', 'submit', 'button', 'image'].includes(metadata.type) ||
                /password|passcode/.test(metadata.description) ||
                metadata.disabled || metadata.readOnly) {
              throw new Error('Refusing to fill a non-editable, sensitive, CAPTCHA, or OTP control.');
            }
            await page.locator(field.selector).fill(field.value);
          }
          const invalidControls = await page.$$eval('input:invalid,select:invalid,textarea:invalid', nodes => nodes.length);
          log(`Filled ${job.fields.length} field(s); validation reports ${invalidControls} invalid control(s). No form was submitted.`);
          return { ok: true, host: target.hostname, filledFieldCount: job.fields.length, invalidControls };
        }
        let selectorFound = null;
        if (job.selector) {
          await page.waitForSelector(job.selector);
          selectorFound = true;
        }
        log('Approved page navigation completed.');
        return { ok: true, host: target.hostname, status: response.status(), selectorFound };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } finally {
      activeContexts.delete(context);
      await context.close().catch(() => {});
    }
  }

  async function close() {
    closing = true;
    await Promise.all([...activeContexts].map(context => context.close().catch(() => {})));
    const instance = await browserPromise?.catch(() => null);
    browserPromise = null;
    if (instance?.connected) await instance.close().catch(() => {});
  }

  async function preflight() {
    try {
      const instance = await getBrowser();
      console.log('[Automation] Chromium startup preflight succeeded.');
      if (instance.connected) await instance.close();
      browserPromise = null;
      preflightSuccessful = true;
      return true;
    } catch (error) {
      preflightSuccessful = false;
      console.error('[Automation] Chrome/Chromium startup preflight failed:', String(error.message || error).slice(0, 300));
      return false;
    }
  }

  return {
    execute,
    close,
    preflight,
    validateUrl,
    get activeContextCount() { return activeContexts.size; },
    get preflightSuccessful() { return preflightSuccessful; }
  };
}

module.exports = { createBrowserService, createUrlValidator, isPublicAddress };
