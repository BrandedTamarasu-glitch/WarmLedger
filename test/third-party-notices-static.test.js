'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const notices = read('THIRD_PARTY_NOTICES.md');
const chart = fs.readFileSync(path.join(root, 'js/chart.min.js'));

test('third-party notices pin the vendored Chart.js bundle and provenance', () => {
  const checksum = crypto.createHash('sha256').update(chart).digest('hex');
  assert.match(notices, /Warm Ledger vendors Chart\.js in `js\/chart\.min\.js`/);
  assert.match(notices, /Version: 4\.4\.7/);
  assert.match(notices, /Upstream project: https:\/\/github\.com\/chartjs\/Chart\.js/);
  assert.match(notices, /Upstream release: https:\/\/github\.com\/chartjs\/Chart\.js\/releases\/tag\/v4\.4\.7/);
  assert.match(notices, /License: MIT/);
  assert.match(notices, /Bundled artifact: `js\/chart\.min\.js`/);
  assert.match(notices, new RegExp(`SHA-256: ${checksum}`));
  assert.match(notices, /Manual update procedure:/);
  assert.match(notices, /Run `npm test`/);
  assert.match(notices, /run `npm run test:browser`/);
  assert.match(read('README.md'), /THIRD_PARTY_NOTICES\.md/);
});
