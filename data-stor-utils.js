'use strict';

function dataStorDob(value) {
  const p = String(value || '').trim().split(/[\\/-]/).map(Number);
  if (p.length !== 3 || p.some(n => !Number.isInteger(n))) return '';
  let y, m, d;
  if (p[0] >= 1000) [y, m, d] = p;
  else [d, m, y] = p;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const x = new Date(Date.UTC(y, m - 1, d));
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return '';
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function dataStorBrn(value) {
  const s = String(value || '').trim().replace(/\s+/g, '');
  return /^\d{17}$/.test(s) ? s : '';
}
function dataStorMask(value) { return '•••••••••••••' + String(value || '').slice(-4); }
function parseDataStorCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => String(v).trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field); if (row.some(v => String(v).trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV header ও data row প্রয়োজন।');
  const headers = rows.shift().map(v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const get = (r, names) => { for (const name of names) { const i = headers.indexOf(name.toLowerCase()); if (i >= 0) return String(r[i] ?? '').trim(); } return ''; };
  const valid = [], seen = new Set();
  const summary = { imported: 0, updated: 0, skipped: 0, invalidBrn: 0, invalidDate: 0, duplicates: 0 };
  for (const r of rows) {
    const brn = dataStorBrn(get(r, ['brn', 'birth registration number', 'birth_registration_number']));
    if (!brn) { summary.invalidBrn++; summary.skipped++; continue; }
    if (seen.has(brn)) { summary.duplicates++; continue; }
    seen.add(brn);
    const dob = dataStorDob(get(r, ['dob', 'date of birth', 'জন্ম তারিখ']));
    if (!dob) { summary.invalidDate++; summary.skipped++; continue; }
    const g = get(r, ['gender', 'লিঙ্গ']).toLowerCase();
    const gender = ['m', 'male', 'পুরুষ'].includes(g) ? 'male' : (['f', 'female', 'নারী', 'মহিলা'].includes(g) ? 'female' : (['o', 'other', 'অন্যান্য'].includes(g) ? 'other' : g));
    valid.push({ brn, dob, bn: get(r, ['বাংলা নাম', 'name_bn', 'namebn', 'bangla name']), en: get(r, ['english name', 'name_en', 'nameen', 'name']), gender });
  }
  return { rows: valid, summary };
}
module.exports = { dataStorDob, dataStorBrn, dataStorMask, parseDataStorCsv };
