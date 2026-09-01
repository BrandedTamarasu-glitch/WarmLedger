'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Budget actual account fields are schema 7 gated, explicit, and independently persisted', () => {
  const source = read('js/budget.js');
  assert.match(source, /Store\.getStatus\(\)\.residentSchemaVersion === 7/);
  for (const text of ['Actual deposit account', 'Actual payment account', 'No actual account entered',
    'Enter an actual amount and a saved date to record an actual account label.']) assert.match(source, new RegExp(text));
  assert.match(source, /actualInput\.value !== '' && dateInput\.value !== ''/);
  assert.match(source, /select\.disabled = !eligible/);
  assert.match(source, /updates\.actualAccountId/);
  assert.doesNotMatch(source, /actualAccountId\s*=\s*updates\.accountId|updates\.actualAccountId\s*=\s*updates\.accountId/);
});

test('Pay periods renders the closed actual account disclosure from its dedicated projection', () => {
  const source = read('js/transfers.js');
  for (const text of ['Entered actual accounts', 'Eligible paychecks', 'Eligible expenses',
    'Paychecks with entered actual account', 'Expenses with entered actual account', 'Income by account',
    'Expenses by account', 'No actual account labels entered for this month.', 'Funding math difference']) {
    assert.match(source, new RegExp(text));
  }
  assert.match(source, /Store\.getActualAccountSummary\(this\.currentMonth\)/);
  assert.match(source, /if \(summary\.incomeAccounts\.length\)/);
  assert.match(source, /if \(summary\.expenseAccounts\.length\)/);
  assert.doesNotMatch(source, /Funding reconciliation difference/);
  assert.match(source, /They do not verify payment, bank activity, transfers, balances, or reconciliation\./);
});

test('actual account disclosure retains narrow reflow and forced-color affordances', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.pay-period-actual-accounts > summary\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.pay-period-actual-list dt\s*\{[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.pay-period-actual-accounts/is);
});
