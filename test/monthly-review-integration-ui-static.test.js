'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const budget = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');

test('Budget contains one labelled Monthly Review integration region before detailed records', () => {
  assert.equal((html.match(/id="monthly-review-container"/g) || []).length, 1);
  assert.match(html, /id="monthly-review-container"[^>]*aria-labelledby="monthly-review-heading"/);
  assert.ok(html.indexOf('id="monthly-review-container"') < html.indexOf('id="paychecks-list"'));
  assert.match(budget, /heading\.id = 'monthly-review-heading'/);
  assert.match(budget, /document\.getElementById\('monthly-review-container'\)/);
});

test('Monthly Review styling is scoped, readable, touch-sized, and narrow-screen safe', () => {
  for (const selector of [
    '.monthly-review-container:empty', '.monthly-review', '.monthly-review-header', '.monthly-review-status',
    '.monthly-review-states', '.monthly-review-grid', '.monthly-review-group', '.monthly-review-metrics',
    '.monthly-review-metric-value', '.monthly-review-destination-list', '.monthly-review-destination',
    '.monthly-review-drilldown', '.monthly-review-item', '.monthly-review-actions',
    '.monthly-review-action'
  ]) assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(210px, 100%\), 1fr\)\)/);
  assert.match(styles, /\.monthly-review-action \{[^}]*min-height: 44px/);
  assert.match(styles, /\.monthly-review-action:focus-visible/);
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]*?\.monthly-review-container/);
  assert.match(styles, /@media \(forced-colors: active\)[\s\S]*?\.monthly-review-action:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.doesNotMatch(styles, /body\s*\{[^}]*overflow-x\s*:\s*hidden/);
});

test('Monthly Review persisted labels stay in safe DOM construction', () => {
  const start = budget.indexOf('  renderMonthlyReview()');
  const end = budget.indexOf('  focusEditControl(', start);
  const reviewSource = budget.slice(start, end > start ? end : budget.length);
  assert.ok(start >= 0);
  assert.doesNotMatch(reviewSource, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(reviewSource, /\b(?:onclick|onchange)\s*=/i);
  assert.doesNotMatch(reviewSource, /querySelector\s*\(\s*`[^`]*\$\{/);
  assert.match(budget, /if \(text !== undefined\) node\.textContent = text/);
});
