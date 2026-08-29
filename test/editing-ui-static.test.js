'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budgetPath = path.join(__dirname, '..', 'js', 'budget.js');

test('editing controls are visible, accessibly named, and listener-driven', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /'button', 'btn btn-sm btn-edit', 'Edit'/);
  assert.match(source, /`Edit paycheck for \$\{p\.earner\}`/);
  assert.match(source, /showPaycheckModal\(p\)/);
  assert.match(source, /`Edit \$\{expense\.name\}`/);
  assert.match(source, /showExpenseModal\(expense\)/);

  assert.doesNotMatch(source, /\b(?:onclick|onchange)\s*=/i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /querySelector\s*\(\s*`[^`]*\$\{/);
});

test('edit saves use the existing mutation boundary and update methods', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source,
    /App\.runMutation\(\(\) => existing\s*\?\s*Store\.updatePaycheck\(this\.currentMonth, existing\.id, \{ earner, amount, date \}\)/s);
  assert.match(source,
    /App\.runMutation\(\(\) => existing\s*\?\s*Store\.updateExpense\(this\.currentMonth, existing\.id, \{ category, name, paymentMethod \}\)/s);
  assert.match(source, /const title = existing \? 'Edit Paycheck' : 'Add Paycheck'/);
  assert.match(source, /const title = existing \? 'Edit Expense' : 'Add Expense'/);
});

test('edit modals prefill detached record values and preserve option selection', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /option\.selected = Boolean\(existing && existing\.earner === earner\)/);
  assert.match(source, /field-amount'\)\.value = existing \? existing\.amount : ''/);
  assert.match(source, /field-date'\)\.value = existing \? existing\.date : ''/);
  assert.match(source, /option\.selected = Boolean\(existing && existing\.category === category\.name\)/);
  assert.match(source, /field-name'\)\.value = existing \? existing\.name : ''/);
  assert.match(source, /field-method'\)\.value = existing \? existing\.paymentMethod : 'bank'/);
});

test('successful edits restore focus to the safely located replacement control', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /button\.dataset\.editType === type && button\.dataset\.recordId === id/);
  assert.match(source, /if \(existing\) this\.focusEditControl\('paycheck', existing\.id\)/);
  assert.match(source, /if \(existing\) this\.focusEditControl\('expense', existing\.id\)/);
  assert.doesNotMatch(source, /querySelector\s*\(\s*`[^`]*\$\{/);
});
