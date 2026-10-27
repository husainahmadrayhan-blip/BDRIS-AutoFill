'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDataStorDob, normalizeDataStorBrn, maskDataStorBrn, parseDataStorCsv } = require('./data-stor-utils');

test('DOB accepts ISO and local slash or dash formats', () => {
  assert.equal(normalizeDataStorDob('2024-02-29'), '2024-02-29');
  assert.equal(normalizeDataStorDob('29/02/2024'), '2024-02-29');
  assert.equal(normalizeDataStorDob('29-02-2024'), '2024-02-29');
  assert.equal(normalizeDataStorDob('31/12/1999'), '1999-12-31');
});
test('DOB rejects malformed or impossible calendar dates', () => {
  for (const value of ['', '2023-02-29', '31/02/2024', '2024/02/29', '2024-13-01', '99/99/9999', '29-02-1900']) {
    assert.equal(normalizeDataStorDob(value), '', value);
  }
});
test('BRN validation requires exactly 17 digits', () => {
  assert.equal(normalizeDataStorBrn('12345678901234567'), '12345678901234567');
  for (const value of ['', '1234567890123456', '123456789012345678', 'abc12345678901234', '1234567890123456A']) {
    assert.equal(normalizeDataStorBrn(value), '', value);
  }
});
test('masked BRN exposes only its final four digits', () => {
  assert.equal(maskDataStorBrn('12345678901234567'), '•••••••••••••4567');
});
test('CSV parser reads Bengali headers, handles quoted commas, and normalizes values', () => {
  const csv = 'BRN,DOB,বাংলা নাম,English Name,Gender\n' +
    '12345678901234567,29/02/2024,"আব্দুল, করিম","Abdul, Karim",male\n';
  const parsed = parseDataStorCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    brn: '12345678901234567', dob: '2024-02-29',
    nameBn: 'আব্দুল, করিম', nameEn: 'Abdul, Karim', gender: 'male'
  });
  assert.equal(parsed.summary.imported, 0);
});
test('CSV parser counts duplicates and skips malformed BRN and dates', () => {
  const csv = 'BRN,DOB,বাংলা নাম,English Name,Gender\n' +
    '12345678901234567,29/02/2024,A,A,male\n' +
    '12345678901234567,29/02/2024,A,A,male\n' +
    ',29/02/2024,B,B,female\n' +
    '12345678901234568,31/02/2024,C,C,male\n';
  const parsed = parseDataStorCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.summary.duplicates, 1);
  assert.equal(parsed.summary.invalidBrn, 1);
  assert.equal(parsed.summary.invalidDate, 1);
  assert.equal(parsed.summary.skipped, 2);
});
test('CSV parser rejects missing data rows', () => {
  assert.throws(() => parseDataStorCsv('BRN,DOB,বাংলা নাম,English Name,Gender\n'));
});
