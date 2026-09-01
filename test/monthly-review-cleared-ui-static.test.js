'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');

test('Monthly Review adds one closed manual checklist with unavailable and independent count states', () => {
  assert.match(source, /Store\.getClearedChecklist\(this\.currentMonth\)/);
  assert.match(source, /this\.element\('details', 'monthly-review-cleared'\)/);
  assert.doesNotMatch(source, /details\.open\s*=\s*true[^\n]*renderClearedChecklist/);
  assert.match(source, /Manual cleared checklist/);
  assert.match(source, /Manual cleared marks are unavailable for this budget version/);
  for (const count of ['paycheckCount', 'expenseCount', 'eligibleCount', 'ineligibleCount', 'clearedCount', 'unclearedCount']) {
    assert.match(source, new RegExp(`checklist\\.counts\\.${count}`));
  }
});

test('eligible records receive one native checkbox and ineligible records receive exact reason text', () => {
  assert.match(source, /checkbox\.type = 'checkbox'/);
  assert.match(source, /if \(item\.eligible\) \{[\s\S]*checkbox = document\.createElement\('input'\)/);
  assert.match(source, /item\.actualAmount === null \? 'Actual not entered'/);
  for (const reason of ['Actual amount and date must be entered', 'Actual amount must be entered',
    'Date must be entered']) assert.match(source, new RegExp(reason));
  assert.doesNotMatch(source, /select all|bulk|automatic clearing/i);
});

test('single-record mutation is atomic and focus restoration uses fixed selectors plus dataset equality', () => {
  assert.match(source, /App\.runMutation\(\(\) => Store\.setRecordCleared\(\{ monthKey: this\.currentMonth, kind: item\.kind,/);
  assert.match(source, /recordId: item\.recordId, cleared/);
  assert.match(source, /querySelectorAll\('\[data-cleared-kind\]\[data-record-id\]'\)/);
  assert.match(source, /control\.dataset\.clearedKind === kind && control\.dataset\.recordId === id && !control\.disabled/);
  assert.match(source, /onFailure: \(\) => \{\s*this\.renderMonthlyReview\(\); this\.restoreClearedFocus\(item\.kind, item\.recordId\);\s*\}/);
  assert.doesNotMatch(source, /querySelector\(`[^`]*\$\{(?:item|id|kind)/);
});

test('cleared checklist is wrap-safe, touch-sized, responsive, and forced-color aware', () => {
  assert.match(css, /\.monthly-review-cleared > summary\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /\.monthly-review-cleared-label\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.monthly-review-cleared-counts\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.monthly-review-cleared-label input/s);
});

test('documentation preserves the manual-only state and deferred boundaries', () => {
  for (const phrase of ['initially closed **Manual cleared checklist**', 'entered zero is eligible',
    'does not mean paid, bank-verified, reconciled, matched, settled, balance-confirmed, or month closed',
    'no bulk or automatic clearing controls']) assert.match(readme, new RegExp(phrase.replaceAll('*', '\\*')));
  assert.match(roadmap, /Phase 5A manual cleared-record checklist complete locally/);
  assert.match(roadmap, /reconciliation and month close remain deferred/);
});
