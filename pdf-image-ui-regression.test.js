'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('certificate preview does not invoke billing', () => {
  const start = html.indexOf('async function previewPDF(options={})');
  const end = html.indexOf('async function printCertificate()', start);
  assert.ok(start >= 0 && end > start, 'preview handler should exist');
  const previewHandler = html.slice(start, end);
  assert.doesNotMatch(previewHandler, /chargeForPreview|\/api\/balance\/charge/);
});

test('PDF image library has search and no fixed ten-image UI cap', () => {
  assert.match(html, /id="pdfImageSearch"/);
  assert.match(html, /visibleImages=pdfImageLibrary\.filter/);
  assert.match(html, /visibleImages\.forEach\(img=>/);
  assert.doesNotMatch(html, /pdfImageLibrary\.slice\(0\s*,\s*10\)/);
  assert.doesNotMatch(html, /pdfImageLibrary\.length\s*>=\s*10/);
});

test('registration-office matching calls the existing matching endpoint and selects the returned image', () => {
  assert.match(html, /async function autoSelectOfficeImage\(\)/);
  assert.match(html, /id="autoSelectOfficeImage" type="checkbox"/);
  assert.match(html, /runOfficeImageAutoSelect\(true\)/);
  assert.match(html, /\/api\/bot\/pdf-image-match\?registeredOffice=/);
  assert.match(html, /await selectPDFImage\(image\)/);
  assert.match(server, /app\.get\('\/api\/bot\/pdf-image-match'/);
});

test('Neon image metadata stores file size and keeps migration additive', () => {
  assert.match(server, /file_size bigint NOT NULL DEFAULT 0/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false/);
  assert.match(server, /WHERE deleted=false ORDER BY created_at/);
  assert.match(server, /UPDATE fil_images SET deleted=true/);
  assert.doesNotMatch(server, /DELETE FROM fil_images WHERE NOT/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS file_size bigint NOT NULL DEFAULT 0/);
  assert.match(server, /file_size=EXCLUDED\.file_size/);
  assert.match(server, /fileSize:Number\(row\.file_size\)\|\|0/);
  assert.match(server, /image\.fileSize=buffer\.length/);
});

test('missing saved image positions are not silently fabricated or reused', () => {
  assert.match(server, /position:x\.position&&Object\.keys\(x\.position\)\.length\?x\.position:null/);
  assert.match(html, /const hasSavedPosition=applySavedPDFImagePosition\(img\.id\)/);
  assert.match(html, /এই Image-এর saved position পাওয়া যায়নি/);
  assert.match(html, /অন্য Image-এর position ব্যবহার করা হয়নি/);
});

test('async helpers that await work are declared async', () => {
  for (const name of ['savePDFImagePosition', 'generateQRImage', 'loadPDFImageLibrary', 'selectPDFImage', 'previewPDF', 'printCertificate']) {
    assert.match(html, new RegExp('async\\s+function\\s+' + name + '\\s*\\('), name + ' should be async');
  }
});

test('Neon metadata cannot override authoritative image columns', () => {
  const rowMapping = server.slice(server.indexOf('const image = {...(row.metadata||{})'), server.indexOf('if (row.image_data', server.indexOf('const image = {...(row.metadata||{})')));
  assert.ok(rowMapping.indexOf('...(row.metadata||{})') < rowMapping.indexOf('id:row.id'));
  assert.match(rowMapping, /position:row\.position\|\|\{\}/);
  assert.match(rowMapping, /fileSize:Number\(row\.file_size\)\|\|0/);
});

test('position updates preserve existing extra transform and alignment metadata', () => {
  const handlers = server.match(/image\.position=\{\.\.\.old,x:n\('x',105\),y:n\('y',247\),z:n\('z',100\),w:n\('w',24\),h:n\('h',10\)\};/g) || [];
  assert.equal(handlers.length, 2, 'PATCH and POST compatibility handlers should preserve old position metadata');
});

test('image uploads validate actual PNG, JPEG, and WEBP file signatures', () => {
  assert.match(server, /buffer\.subarray\(0,8\)\.equals\(Buffer\.from\(\[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a\]\)\)/);
  assert.match(server, /buffer\[0\]===0xff && buffer\[1\]===0xd8 && buffer\[2\]===0xff/);
  assert.match(server, /buffer\.toString\('ascii',0,4\)==='RIFF' && buffer\.toString\('ascii',8,12\)==='WEBP'/);
  assert.match(server, /Image file-এর content ও MIME type মিলছে না/);
});
