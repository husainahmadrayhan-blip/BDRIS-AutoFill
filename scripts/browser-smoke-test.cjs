'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchPuppeteerBrowser } = require('../puppeteer-runtime');

const root = path.join(__dirname, '..');
const toDataUrl = fileName => `data:font/ttf;base64,${fs.readFileSync(path.join(root, 'fonts', fileName)).toString('base64')}`;

async function main() {
  const browser = await launchPuppeteerBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    const bangla = 'বাংলা যুক্তাক্ষর: ক্ষ, জ্ঞ, শ্র; কার-ফলা: কি, ক্র, প্র; যতিচিহ্ন: ।, ॥';
    const faces = [
      { file: 'NotoSerifBengali-Regular.ttf', family: 'Noto Serif Bengali', weight: 400 },
      { file: 'NotoSerifBengali-Bold.ttf', family: 'Noto Serif Bengali', weight: 700 },
      { file: 'NotoSansBengali-Regular.ttf', family: 'Noto Sans Bengali', weight: 400 },
      { file: 'FreeSerif.ttf', family: 'FreeSerif Bengali', weight: 400 },
      { file: 'FreeSerifBold.ttf', family: 'FreeSerif Bengali', weight: 700 }
    ];
    const fontFaces = faces.map(({ file, family, weight }) =>
      `@font-face{font-family:"${family}";src:url("${toDataUrl(file)}") format("truetype");font-weight:${weight}}`
    ).join('\n');
    const paragraphs = faces.map(({ family, weight }) =>
      `<p style="font:${weight} 20px '${family}'">${bangla}</p>`
    ).join('\n');
    await page.setContent(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>${fontFaces}</style></head><body>${paragraphs}</body></html>`, { waitUntil: 'domcontentloaded' });

    const rendered = await page.evaluate(async () => {
      const sample = document.querySelector('p').textContent;
      const loaded = await Promise.all([
        document.fonts.load('400 20px "Noto Serif Bengali"', sample),
        document.fonts.load('700 20px "Noto Serif Bengali"', sample),
        document.fonts.load('400 20px "Noto Sans Bengali"', sample),
        document.fonts.load('400 20px "FreeSerif Bengali"', sample),
        document.fonts.load('700 20px "FreeSerif Bengali"', sample)
      ]);
      await document.fonts.ready;
      return {
        loaded: loaded.map(faces => faces.length > 0),
        text: sample,
        textWidths: [...document.querySelectorAll('p')].map(element => element.getBoundingClientRect().width)
      };
    });
    assert.ok(rendered.loaded.every(Boolean), 'Every bundled Bengali font face must load in Chrome.');
    assert.equal(rendered.text, bangla);
    assert.ok(rendered.textWidths.every(width => width > 0), 'Bengali text must render in every face at a mobile viewport.');

    const pdf = await page.pdf({ printBackground: true });
    assert.ok(pdf.length > 1000, 'Chrome should produce a non-empty PDF.');
    console.log('Browser smoke test passed: Chrome launched, Bengali fonts loaded, and PDF generation succeeded.');
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Browser smoke test failed:', error.message);
  process.exitCode = 1;
});
