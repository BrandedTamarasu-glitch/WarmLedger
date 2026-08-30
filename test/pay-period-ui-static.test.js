'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js', 'transfers.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('visible Transfers route is truthfully presented as Pay periods without compatibility churn', () => {
  assert.match(html, /data-view="transfers">Pay periods</);
  assert.match(html, /id="view-transfers"/);
  assert.match(html, /id="transfers-content"/);
  assert.match(html, /id="pay-periods-heading" tabindex="-1">Pay periods</);
  assert.match(html, /Monthly paycheck funding plan\. Each section shows bills explicitly assigned to that paycheck; these are not calendar pay-period boundaries\./);
  assert.match(source, /const TransfersView/);
});

test('renderer consumes only the frozen projection and does not hide zero-paycheck funding needs', () => {
  assert.match(source, /Store\.getPayPeriodPlan\(this\.currentMonth\)/);
  assert.doesNotMatch(source, /Store\.getMonth\(|calcPaycheckRemaining|paycheckAmounts/);
  assert.doesNotMatch(source, /if\s*\(\s*!plan\.paycheckCount\s*\)[^{]*\{[^}]*return/);
  for (const text of ['Bills needing funding', 'Monthly remaining-funds allocations', 'Monthly funding summary',
    'Planned funding guidance', 'Actual income', 'Assigned to bills', 'Planned remainder']) assert.match(source, new RegExp(text));
  for (const field of ['billsNeedingFunding', 'monthlyAllocations', 'plannedIncome', 'actualIncomeEntered',
    'actualIncomeMissingCount', 'plannedBills', 'fundedAcrossPaychecks', 'billsNeedingFundingAmount',
    'paycheckFundingRemainder', 'overAssignedAmount', 'monthlyAllocationsTotal', 'plannedBalance',
    'reconciliationDifference', 'methodTotals']) assert.match(source, new RegExp(`\\.${field}\\b`));
  assert.match(source, /'No paychecks this month'/);
  assert.match(source, /'1 paycheck this month'/);
  assert.match(source, /`\$\{plan\.paycheckCount\} paychecks this month`/);
  assert.match(source, /apply to the whole month and are not assigned to a specific paycheck/);
});

test('actual zero, funding states, split context, and all methods remain textual', () => {
  assert.match(source, /period\.actualIncome === null \? 'Not entered' : this\.fmt\(period\.actualIncome\)/);
  for (const state of ['remaining', 'balanced', 'over-assigned', 'partially-funded', 'unfunded']) {
    assert.match(source, new RegExp(state));
  }
  assert.match(source, /Fully funded across paychecks/);
  assert.match(source, /Split across/);
  for (const method of ['Keep in bank', 'Plan for credit card', 'Plan for savings', 'Plan for investments']) assert.match(source, new RegExp(method));
  assert.doesNotMatch(source, /bonus|extra paycheck|disposable/i);
});

test('contextual funding controls are safe, dataset-backed, and ready for Wave 3 routing', () => {
  assert.match(source, /button\.dataset\.expenseId = expenseId/);
  assert.match(source, /button\.dataset\.paycheckId = paycheckId/);
  assert.match(source, /App\.openBudgetFunding\(this\.currentMonth, expenseId, paycheckId\)/);
  assert.match(source, /Review funding for \$\{bill\.name\} from Paycheck \$\{paycheckNumber\}/);
  assert.match(source, /`Fund \$\{bill\.name\}`/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML|querySelector\([^)]*expenseId/);
  assert.match(source, /document\.createElement/);
  assert.match(source, /\.textContent = text/);
});

test('Pay periods has narrow targets, wrapping, forced colors, and inherited reduced motion', () => {
  assert.match(css, /\.pay-period-funding-action\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.pay-period-bill-name[^{}]*\{[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*\.pay-period-funding-action\s*\{[^}]*width:\s*100%/is);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.pay-period-card[\s\S]*\.pay-period-state/is);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});
