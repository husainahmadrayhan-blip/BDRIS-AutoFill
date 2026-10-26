// Regression test: Make Server eVerify GEO parsing + registrar image selection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const indexFile = path.join(__dirname, 'index.js');
const source = fs.readFileSync(indexFile, 'utf8');
const stripBlock = source.slice(source.indexOf('function stripPDFOfficeLabel'), source.indexOf("app.get('/api/bot/pdf-image-match'"));
const geoStart = source.indexOf('function extractGeoFromRegisteredOfficeLocation');
const geoEnd = source.indexOf('\nasync function applyUnionGeoFallback', geoStart);
assert(geoStart >= 0 && geoEnd > geoStart, 'Geo parser function found');
const geoFn = source.slice(geoStart, geoEnd);
const ctx = {
  cleanEverifyText: v => String(v ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim(),
  fs: { existsSync: () => true },
  path: { join: (...v) => v.join('/'), basename: v => String(v).split(/[\\/]/).pop() },
  PDF_IMAGE_DIR: '/images',
  console
};
vm.createContext(ctx);
vm.runInContext(stripBlock + '\n' + geoFn, ctx);
const images = [
  { name: 'Zone - 01, Dhaka South City Corporation', fileName: 'zone01.png' },
  { name: 'Zone - 10, Dhaka South City Corporation', fileName: 'zone10.png' },
  { name: 'Gaznapur Nabiganj, Habiganj', fileName: 'gaznapur.png' }
];
assert.equal(ctx.matchVerifiedRegistrarImage('ZONE - 1, DHAKA SOUTH CITY CORPORATION', images)?.name, images[0].name);
assert.equal(ctx.matchVerifiedRegistrarImage('Zone - 01, Dhaka South City Corporation', images)?.name, images[0].name);
assert.equal(ctx.matchVerifiedRegistrarImage('zone-1, dhaka south city corporation', images)?.name, images[0].name);
assert.equal(ctx.matchVerifiedRegistrarImage('GAZNAPUR', images)?.name, images[2].name);
const geo = ctx.extractGeoFromRegisteredOfficeLocation('ZONE - 1, NAGAR BHABAN, DHAKA SOUTH CITY CORPORATION, DHAKA.');
assert.equal(geo.type, 'city');
assert.equal(geo.cityCorporation, 'DHAKA SOUTH CITY CORPORATION');
assert.equal(geo.district, 'DHAKA');
console.log('PASS: Zone 1/01/case-insensitive image matching');
console.log('PASS: GAZNAPUR unique prefix matching');
console.log('PASS: eVerify registered-office GEO parser');
