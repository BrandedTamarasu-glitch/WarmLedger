'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const app = read('js/app.js');
const data = read('js/data.js');
const schema = read('js/data-schema.js');
const recurrence = read('js/recurrence.js');
const evidence = read('scripts/browser-evidence.js');
const readme = read('README.md');
const icon = fs.readFileSync(path.join(root, 'icon.png'));
const packageJson = JSON.parse(read('package.json'));

test('visible application identity is Warm Ledger', () => {
  assert.match(html, /<title>Warm Ledger<\/title>/);
  assert.match(html, /<link rel="icon" href="icon\.png" type="image\/png">/);
  assert.match(html, /class="nav-brand">Warm Ledger<\/div>/);
  assert.match(html, /Warm Ledger could not safely open the data stored in this browser/);
  assert.doesNotMatch(html, /ZeroBudget|Zero-Based Budget/);
  assert.doesNotMatch(app, /ZeroBudget|Zero-Based Budget/);
  assert.match(app, /Warm Ledger backup/);
  assert.match(app, /closing Warm Ledger/);
  assert.equal(packageJson.name, 'warm-ledger');
  assert.deepEqual(packageJson.scripts, {
    test: 'node --test',
    'test:browser': 'node scripts/browser-evidence.js'
  });
  assert.equal(packageJson.private, true);
});

test('new downloads use Warm Ledger filenames while serialized formats remain legacy-compatible', () => {
  assert.match(app, /`warm-ledger-preserved-data-\$\{this\.fileTimestamp\(\)\}\.txt`/);
  assert.match(app, /`warm-ledger-backup-\$\{this\.fileTimestamp\(\)\}\.json`/);
  assert.doesNotMatch(app, /`zerobudget-(?:preserved-data|backup)-/);
  assert.match(schema, /const BACKUP_FORMAT = 'zerobudget-backup'/);
  assert.match(schema, /const SNAPSHOT_FORMAT = 'zerobudget-snapshot'/);
});

test('storage origins, keys, global APIs, and compatibility evidence identifiers stay frozen', () => {
  assert.match(data, /const STORAGE_KEY = 'zeroBudget_data'/);
  assert.match(data, /const CORRUPT_KEY = 'zeroBudget_corrupt'/);
  assert.match(data, /const SNAPSHOT_PREFIX = 'zeroBudget_snapshot:'/);
  assert.match(evidence, /localStorage\.getItem\('zeroBudgetData'\)/);
  assert.match(schema, /root\.ZeroBudgetSchema = api/);
  assert.match(data, /root\.ZeroBudgetStore = api/);
  assert.match(recurrence, /root\.ZeroBudgetRecurrence = api/);
  assert.match(html, /<script src="js\/data-schema\.js"><\/script>[\s\S]*<script src="js\/recurrence\.js"><\/script>[\s\S]*<script src="js\/data\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="css\/styles\.css">/);
});

test('error-code identities remain machine contracts while only displayed product wording changes', () => {
  for (const code of ['INVALID_IMPORT', 'SNAPSHOT_WRITE_FAILED', 'FILE_TOO_LARGE', 'EVIDENCE_WRITE_FAILED',
    'CLOCK_FAILED', 'IDENTIFIER_GENERATION_FAILED', 'UNKNOWN']) assert.match(app, new RegExp(`\\b${code}:`));
  assert.doesNotMatch(app, /zeroBudget_data|zeroBudget_corrupt|zeroBudget_snapshot:/);
});

test('repository presentation names Warm Ledger and discloses legacy compatibility', () => {
  assert.match(readme, /^# Warm Ledger\s*$/m);
  assert.match(readme, /Warm Ledger is a calm, local, dependency-free budgeting application/);
  assert.match(readme, /previously named ZeroBudget/);
  assert.match(readme, /keep using the same local project path/);
  assert.match(readme, /legacy storage keys and backup\/snapshot format identifiers are intentionally unchanged/);
  assert.match(readme, /Warm Ledger or legacy ZeroBudget JSON backup/);
});

test('application icon is an exact 256px RGBA PNG', () => {
  assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.equal(icon.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
  assert.equal(icon[24], 8, 'icon must use 8-bit channels');
  assert.equal(icon[25], 6, 'PNG color type 6 is RGBA');
});
