'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dataStorDob, dataStorBrn, dataStorMask, parseDataStorCsv } = require('./data-stor-utils');

test('DOB accepts ISO and supported local separators', () => {
  assert.equal(dataStorDob('2024-02-29'), '2024-02-29');
  assert.equal(dataStorDob('2024/02/29'), '2024-02-29');
  assert.equal(dataStorDob('29/02/2024'), '2024-02-29');
  assert.equal(dataStorDob('29-02-2024'), '2024-02-29');
  assert.equal(dataStorDob('31/12/1999'), '1999-12-31');
});
test('DOB rejects malformed and impossible calendar dates', () => {
  for (const value of ['', '2023-02-29', '31/02/2024', '2024-13-01', '99/99/9999', '29-02-1900']) {
    assert.equal(dataStorDob(value), '', value);
  }
});
test('BRN validation requires 17 decimal digits', () => {
  assert.equal(dataStorBrn('12345678901234567'), '12345678901234567');
  for (const value of ['', '1234567890123456', '123456789012345678', 'abc12345678901234', '1234567890123456A']) {
    assert.equal(dataStorBrn(value), '', value);
  }
});
test('masked BRN reveals only the final four digits', () => {
  assert.equal(dataStorMask('12345678901234567'), '•••••••••••••4567');
});
test('CSV parser handles Bengali headers and quoted names with commas', () => {
  const csv = 'BRN,DOB,বাংলা নাম,English Name,Gender\n' +
    '12345678901234567,29/02/2024,"আব্দুল, করিম","Abdul, Karim",male\n';
  const parsed = parseDataStorCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], { brn:'12345678901234567', dob:'2024-02-29', bn:'আব্দুল, করিম', en:'Abdul, Karim', gender:'male' });
  assert.equal(parsed.summary.imported, 0);
});
test('CSV counts duplicate, invalid BRN and invalid date rows', () => {
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
test('CSV requires a header and at least one non-empty row', () => {
  assert.throws(() => parseDataStorCsv('BRN,DOB,বাংলা নাম,English Name,Gender\n'));
});
