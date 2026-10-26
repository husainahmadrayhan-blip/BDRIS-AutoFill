'use strict';

async function check(name, url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  console.log(`${name}: HTTP ${response.status}`);
}

async function main() {
  const mainUrl = process.env.MAIN_HEALTH_URL || 'http://127.0.0.1:3000/api/health';
  await check('Main server health', mainUrl);
  if (process.env.AUTOMATION_SERVER_URL) {
    if (!process.env.AUTOMATION_API_KEY) throw new Error('AUTOMATION_API_KEY is required to check the automation service.');
    await check('Automation server health', `${process.env.AUTOMATION_SERVER_URL.replace(/\/+$/, '')}/health`, {
      Authorization: `Bearer ${process.env.AUTOMATION_API_KEY}`
    });
  } else {
    console.log('Automation server health: skipped (AUTOMATION_SERVER_URL is unset).');
  }
}

main().catch(error => {
  console.error('Health check failed:', error.message);
  process.exitCode = 1;
});
