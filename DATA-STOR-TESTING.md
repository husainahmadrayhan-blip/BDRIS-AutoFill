# Data Stor utility checks

This change extracts the AutoFill Data Stor date normalization, 17-digit BRN validation/masking, and CSV parsing helpers into `data-stor-utils.js`. The API still uses these same helpers through `require('./data-stor-utils')`; no route, wallet, session, database table, or migration logic is replaced.

## Tests added

`data-stor.test.js` covers accepted ISO/day-first DOB formats, impossible dates, BRN length validation, masked BRN output, CSV names containing quoted commas, duplicates, invalid BRNs, invalid dates, and empty data input.

The existing `npm test` now runs the utility syntax check and `node --test data-stor.test.js` before continuing with the previous AutoFill regression tests. The existing build command checks utility syntax too.

## Run

```sh
npm ci
node --check data-stor-utils.js
node --check index.js
node --test data-stor.test.js
npm test
npm run build
npm run test:browser
```

The utility tests do not replace staging Neon tests for actual schema migration, session authorization, one-time charge, duplicate/concurrent unlock, insufficient-balance rollback, or import from the source Data Stor database. The latter requires authorized source and target database credentials set temporarily in a private terminal, never in Git.
