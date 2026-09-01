const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Structure exposes truthful local account management without financial claims', () => {
  const html = read('index.html'); const source = read('js/structure.js');
  assert.match(html, /id="structure-accounts-heading"[^>]*>Accounts</);
  assert.match(html, /Accounts are local planning labels only\. They do not connect to a bank, prove payment, or reconcile activity\./);
  for (const call of ['createAccount', 'updateAccount', 'reorderAccounts', 'getAccountUsage']) assert.match(source, new RegExp(`Store\\.${call}`));
  assert.match(source, /No accounts yet\. Account selection remains optional\./);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});

test('Budget and Templates expose compatible optional account selectors only for schema 6', () => {
  const budget = read('js/budget.js'); const templates = read('js/templates.js');
  for (const source of [budget, templates]) {
    assert.match(source, /ACCOUNTS_UNAVAILABLE/);
    assert.match(source, /No account selected/);
    assert.match(source, /\(Archived\)/);
    assert.match(source, /credit_card:\s*\['credit_card'\]/);
    assert.match(source, /bank:\s*\['bank', 'cash', 'other'\]/);
  }
  assert.match(budget, /Deposit account/); assert.match(budget, /Payment account/);
  assert.match(templates, /Deposit account/); assert.match(templates, /Payment account/);
  assert.doesNotMatch(budget, /selectedId\s*\|\|\s*['"]cash/);
  assert.doesNotMatch(templates, /selectedId\s*\|\|\s*['"]cash/);
});

test('account and account-migration failures have stable truthful user messages', () => {
  const app = read('js/app.js');
  const requiredCodes = [
    'ACCOUNTS_MIGRATION_REQUIRES_MANUAL_CLEARING', 'INVALID_ACCOUNTS_MIGRATION_PREVIEW',
    'STALE_ACCOUNTS_MIGRATION_PREVIEW', 'ACCOUNTS_ALREADY_MIGRATED',
    'ACCOUNTS_MIGRATION_VALIDATION_FAILED', 'ACCOUNTS_UNAVAILABLE', 'ACCOUNT_NOT_FOUND',
    'ACCOUNT_ARCHIVED', 'ACCOUNT_INCOMPATIBLE', 'DUPLICATE_ACCOUNT_NAME',
    'INVALID_ACCOUNT_KIND', 'DANGLING_ACCOUNT_REFERENCE', 'INCOMPATIBLE_ACCOUNT_KIND'
  ];
  for (const code of requiredCodes) assert.match(app, new RegExp(`${code}:\\s*'[^']+'`), `${code} needs a stable message`);
  assert.match(app, /ACCOUNTS_MIGRATION_REQUIRES_MANUAL_CLEARING:\s*'Accounts require the current manual-clearing data format\. Complete the earlier storage upgrades before adding accounts\.'/);
});
