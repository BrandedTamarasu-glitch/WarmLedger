'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const budget = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'js', 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Monthly Review consumes frozen next steps and routes through fixed dataset equality', () => {
  assert.match(budget, /Store\.getNextReviewSteps\(this\.currentMonth\)/);
  assert.match(budget, /item\.kind === kind && item\.routeTarget === routeTarget/);
  assert.match(budget, /\['recurring', 'dates', 'actuals', 'funding', 'manual-clearing'\]/);
  assert.match(budget, /routeTarget === 'recurring-preview'/);
  assert.match(budget, /control\.dataset\.reviewStepKind === kind &&[\s\S]*control\.dataset\.reviewRouteTarget === routeTarget/);
  assert.match(budget, /App\.openRecurringPreview\(trigger\)/);
  assert.match(budget, /querySelectorAll\('\[data-review-kind\]\[data-record-id\]'\)/);
  assert.match(budget, /control\.dataset\.editType === missing\.kind && control\.dataset\.recordId === missing\.record\.id/);
  assert.doesNotMatch(budget, /querySelector\s*\(\s*`[^`]*\$\{/);
  const renderer = budget.slice(budget.indexOf('  renderNextReviewSteps('), budget.indexOf('  renderClearedChecklist('));
  assert.doesNotMatch(renderer, /innerHTML|runMutation|localStorage|setRecordCleared/);
  assert.match(renderer, /No current review steps are listed/);
});

test('Dashboard has an initially closed bounded saved-month review disclosure', () => {
  const disclosure = html.match(/<details id="dashboard-review-queue"[\s\S]*?<\/details>/)?.[0] || '';
  assert.ok(disclosure); assert.doesNotMatch(disclosure, /\sopen(?:\s|>)/);
  for (const value of ['6', '12', '24']) assert.match(disclosure, new RegExp(`name="dashboard-review-months" value="${value}"`));
  assert.match(disclosure, /value="12" checked/);
  assert.doesNotMatch(disclosure, /aria-live|Export|Print/);
  assert.match(dashboard, /Store\.getMonthReviewQueue\(\{ anchorMonth: this\.localCivilMonth\(\), lookbackMonths: this\.reviewQueueLookback \}\)/);
  assert.match(dashboard, /BudgetView\.routeReviewNavigation\(item\.monthKey, kind, this\.reviewRouteTarget\(kind\)\)/);
  assert.match(dashboard, /current\.emptyMonths\.includes\(monthKey\)/);
});

test('review navigation presentation reflows, preserves 44px targets, and is print-hidden', () => {
  assert.match(css, /\.monthly-review-next-action \{[^}]*min-height: 44px/s);
  assert.match(css, /\.dashboard-review-actions \.btn, \.dashboard-review-item > \.btn \{[^}]*min-height: 44px/s);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.dashboard-review-queue-controls[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.dashboard-review-queue/);
  assert.match(css, /@media print[\s\S]*\.dashboard-review-queue/);
});
