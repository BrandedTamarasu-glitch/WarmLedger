'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Monthly Review consumes the frozen read-only projection inside the existing closed checklist', () => {
  assert.match(source, /Store\.getMonthReadiness\(this\.currentMonth\)/);
  assert.match(source, /renderClearedChecklist\(Store\.getClearedChecklist\(this\.currentMonth\),\s*Store\.getMonthReadiness\(this\.currentMonth\)\)/);
  assert.match(source, /content\.append\(this\.monthReadinessSummary\(readiness\)\)/);
  const summary = source.slice(source.indexOf('  monthReadinessSummary('), source.indexOf('  clearedChecklistItem('));
  assert.doesNotMatch(summary, /addEventListener|runMutation|announce|button|input|dialog|dataset/);
  assert.doesNotMatch(summary, /innerHTML|insertAdjacentHTML/);
});

test('summary renders exact constant state, bounded checks and all honest availability states', () => {
  assert.match(source, /`Month state — \$\{readiness\.stateLabel\}`/);
  assert.match(source, /this\.element\('h4', 'monthly-review-readiness-state', `Month state — \$\{readiness\.stateLabel\}`\)/);
  assert.doesNotMatch(source, /this\.element\('h5', 'monthly-review-readiness-state'/);
  for (const status of ['Checklist complete', 'Checklist needs attention', 'Saved month is empty',
    'No saved month', 'Checklist unavailable']) assert.match(source, new RegExp(status));
  for (const fact of ['Actual amounts', 'Record dates', 'Manual clearing']) assert.match(source, new RegExp(fact));
  assert.match(source, /readiness\.counts\.actualsMissing/);
  assert.match(source, /readiness\.counts\.datesMissing/);
  assert.match(source, /readiness\.counts\.notManuallyCleared/);
  assert.match(source, /readiness\.checks\.actualsComplete/);
  assert.match(source, /readiness\.checks\.datesComplete/);
  assert.match(source, /readiness\.checks\.manualClearingComplete/);
  assert.match(source, /This month remains editable\. These checks are a manual review aid—not bank verification, reconciliation, payment confirmation, or month close\./);
});

test('summary avoids lifecycle scores, unrelated domains and new persisted or interactive state', () => {
  const summary = source.slice(source.indexOf('  monthReadinessSummary('), source.indexOf('  clearedChecklistItem('));
  assert.doesNotMatch(summary, /percent|percentage|score|progress|transition|persist|storage|funding|allocation|recurring|template|statement|account/i);
  assert.doesNotMatch(summary, /ready to reconcile|reconciled|balanced|paid|safe to spend/i);
});

test('summary reflows at 320px and remains explicit in forced colors and reduced motion', () => {
  assert.match(css, /\.monthly-review-readiness-facts\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)[^}]*min-width:\s*0/is);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.monthly-review-readiness-facts\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.monthly-review-readiness-limitation/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.monthly-review-cleared/s);
});
