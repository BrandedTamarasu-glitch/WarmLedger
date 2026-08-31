'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const view = fs.readFileSync(path.join(root, 'js', 'data-health-view.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');

test('exact-money helper loads before Store and Data Health uses aggregate audit only', () => {
  assert.ok(html.indexOf('js/exact-money.js') > html.indexOf('js/data-health.js'));
  assert.ok(html.indexOf('js/exact-money.js') < html.indexOf('js/data.js'));
  assert.match(view, /Store\.getExactMoneyAudit\(\)/);
  for (const field of ['scannedValueCount', 'subCentValueCount', 'affectedMonthCount', 'affectedTemplateCount']) {
    assert.match(view, new RegExp(`audit\\.${field}`));
  }
  assert.doesNotMatch(view.slice(view.indexOf('moneyPrecisionDisclosure'), view.indexOf('record(reference)')),
    /audit\.(?:groups|amount|value|label|id|path|monthKey)|innerHTML|insertAdjacentHTML/);
});

test('precision audit is a closed native disclosure with exact passive copy and no action or live region', () => {
  const method = view.slice(view.indexOf('moneyPrecisionDisclosure'), view.indexOf('record(reference)'));
  assert.match(method, /this\.node\('details', 'money-precision-audit'\)/);
  assert.doesNotMatch(method, /\.open\s*=|setAttribute\(['"]open|button|role|aria-live|addEventListener/);
  assert.match(method, /Money precision needs review/);
  assert.match(method, /All \$\{audit\.scannedValueCount\} stored money values use whole-cent precision\./);
  assert.match(method, /Warm Ledger has not changed or rounded them\./);
  assert.match(method, /This check cannot determine whether sub-cent digits were intentional or came from earlier calculations or imports\./);
  assert.match(method, /Exact-money storage and any conversion workflow require a separate reviewed migration\./);
});

test('precision disclosure is responsive and retained in forced colors', () => {
  assert.match(css, /\.money-precision-audit > summary\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /\.money-precision-content p\s*\{[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.money-precision-content\s*\{[^}]*padding:/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.money-precision-audit[\s\S]*\.money-precision-content p/s);
});

test('documentation preserves the aggregate-only audit and migration boundary', () => {
  for (const phrase of ['read-only, aggregate-only audit', 'never displays amounts, record labels, identifiers, month keys',
    'does not round, reject, migrate, or change the ledger', 'separately reviewed conversion and rollback workflow']) {
    assert.match(readme, new RegExp(phrase));
  }
  assert.match(roadmap, /Phase 4A read-only precision audit complete locally/);
  assert.match(roadmap, /storage migration remains deferred/);
  assert.match(roadmap, /audit never rounds, repairs, rejects, or writes data/);
});
