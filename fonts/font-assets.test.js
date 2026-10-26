'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

const fontAssets = [
  ['NotoSansBengali-Regular.ttf', /Noto Sans Bengali/],
  ['NotoSerifBengali-Regular.ttf', /Noto Serif Bengali/],
  ['NotoSerifBengali-Bold.ttf', /Noto Serif Bengali/],
  ['FreeSerif.ttf', /FreeSerif Bengali/],
  ['FreeSerifBold.ttf', /FreeSerif Bengali/]
];

test('bundled Bengali font assets exist, are TTF files, and are served by the app', () => {
  for (const [fileName, family] of fontAssets) {
    const file = path.join(__dirname, fileName);
    assert.ok(fs.statSync(file).size > 1000, `${fileName} should be present and non-empty.`);
    const header = fs.readFileSync(file).subarray(0, 4).toString('hex');
    assert.ok(['00010000', '4f54544f', '74727565'].includes(header), `${fileName} should have a valid TrueType/OpenType signature.`);
    assert.ok(html.includes(fileName), `${fileName} should be referenced in the UI or PDF font stylesheet.`);
    assert.ok(html.includes(`url('/fonts/${fileName}')`), `${fileName} should use the expected local font URL.`);
    assert.match(server, new RegExp(`'${fileName}'`), `${fileName} should be allowed by the font route.`);
    assert.match(html, new RegExp(`font-family:\\s*['"]?${family.source.replaceAll('/', '\\/')}`));
  }

  for (const option of ['NotoSerifBengali-Regular', 'NotoSerifBengali-Bold', 'NotoSansBengali-Regular', 'FreeSerif-Regular', 'FreeSerif-Bold']) {
    assert.ok(html.includes(`value="${option}"`), `${option} should be selectable in the font menu.`);
  }
  assert.ok(html.includes("src:url('/fonts/NotoSerifBengali-Bold.ttf') format('truetype');font-weight:700"));
  assert.ok(html.includes("src:url('/fonts/FreeSerifBold.ttf') format('truetype');font-weight:700"));
  assert.ok(fs.existsSync(path.join(__dirname, 'LICENSE-FreeFont.txt')));
  assert.ok(fs.existsSync(path.join(__dirname, 'LICENSE-FreeFont-README.txt')));
  assert.ok(fs.existsSync(path.join(__dirname, 'OFL-NotoSansBengali.txt')));
  assert.ok(fs.existsSync(path.join(__dirname, 'OFL-NotoSerifBengali.txt')));
});
