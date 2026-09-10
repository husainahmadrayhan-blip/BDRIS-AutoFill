const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = cacheDir;
try { fs.mkdirSync(cacheDir,{recursive:true}); } catch (_) {}
const args = process.argv.includes('--install-only') ? ['puppeteer','browsers','install','chrome'] : ['puppeteer','browsers','install','chrome'];
try {
  execFileSync(process.platform==='win32'?'npx':'npx', args, {cwd:process.cwd(),env:{...process.env,PUPPETEER_CACHE_DIR:cacheDir},stdio:'inherit'});
} catch (e) {
  if (process.argv.includes('--install-only')) process.exitCode=1;
}
