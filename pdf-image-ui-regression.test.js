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
