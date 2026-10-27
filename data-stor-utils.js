'use strict';

function normalizeDataStorDob(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  let year, month, day;
  if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else if (local) { day = Number(local[1]); month = Number(local[2]); year = Number(local[3]); }
  else return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 ||
      day < 1 || day > 31 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
function normalizeDataStorBrn(value) {
  const text = String(value || '').trim();
  return /^\d{17}$/.test(text) ? text : '';
}
function maskDataStorBrn(value) { return '•••••••••••••' + String(value || '').slice(-4); }
function parseDataStorCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i=0; i<input.length; i++) {
    const ch=input[i];
    if (ch === '"') {
      if (quoted && input[i+1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i+1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => String(v).trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field); if (row.some(v => String(v).trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV header ও অন্তত একটি data row প্রয়োজন।');
  const headers = rows.shift().map(v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const get = (r, names) => {
    for (const name of names) { const i = headers.indexOf(name.toLowerCase()); if (i >= 0) return String(r[i] ?? '').replace(/\s+/g, ' ').trim(); }
    return '';
  };
  const valid = [], seen = new Set();
  const summary = { imported: 0, updated: 0, skipped: 0, invalidDate: 0, invalidBrn: 0, duplicates: 0 };
  for (const r of rows) {
    if (!r.some(v => String(v ?? '').trim())) { summary.skipped++; continue; }
    const brn = normalizeDataStorBrn(get(r, ['brn', 'birth registration number', 'birth_registration_number']));
    if (!brn) { summary.invalidBrn++; summary.skipped++; continue; }
    if (seen.has(brn)) { summary.duplicates++; continue; }
    seen.add(brn);
    const dob = normalizeDataStorDob(get(r, ['dob', 'date of birth', 'জন্ম তারিখ']));
    if (!dob) { summary.invalidDate++; summary.skipped++; continue; }
    const nameBn = get(r, ['বাংলা নাম', 'name_bn', 'namebn', 'bangla name']);
    const nameEn = get(r, ['english name', 'name_en', 'nameen', 'name']);
    const g = get(r, ['gender', 'লিঙ্গ']).toLowerCase();
    const gender = ['m','male','পুরুষ'].includes(g) ? 'male' :
      (['f','female','নারী','মহিলা'].includes(g) ? 'female' : (['o','other','অন্যান্য'].includes(g) ? 'other' : g));
    valid.push({ brn, dob, nameBn, nameEn, gender });
  }
  return { rows: valid, summary };
}
module.exports = { normalizeDataStorDob, normalizeDataStorBrn, maskDataStorBrn, parseDataStorCsv };
