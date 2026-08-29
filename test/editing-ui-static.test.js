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

test('create and edit saves use structural IDs and one atomic mutation boundary', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /Store\.editPaycheck\(this\.currentMonth, existing\.id, updates\)/);
  assert.match(source, /Store\.addPaycheck\(this\.currentMonth, \{ earnerId, amount, date \}\)/);
  assert.match(source, /Store\.editExpense\(this\.currentMonth, existing\.id, updates\)/);
  assert.match(source, /categoryId, categoryItemId, name: customName, paycheckAmounts: \{\}/);
  assert.doesNotMatch(source, /Store\.updatePaycheck\([^\n]+earner/);
  assert.doesNotMatch(source, /Store\.updateExpense\([^\n]+category/);
  assert.match(source, /const title = existing \? 'Edit Paycheck' : 'Add Paycheck'/);
  assert.match(source, /const title = existing \? 'Edit Expense' : 'Add Expense'/);
});

test('edit modals prefill detached records and select definitions by stable ID', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /option\.value = earner\.id/);
  assert.match(source, /existing\.earnerId === earner\.id/);
  assert.match(source, /field-amount'\)\.value = existing \? existing\.amount : ''/);
  assert.match(source, /field-date'\)\.value = existing \? existing\.date : ''/);
  assert.match(source, /option\.value = category\.id/);
  assert.match(source, /existing\.categoryId === category\.id/);
  assert.match(source, /field-name'\)\.value = existing && existing\.categoryItemId === null \? existing\.name : ''/);
  assert.match(source, /field-method'\)\.value = existing \? existing\.paymentMethod : 'bank'/);
});

test('forms expose archived current references but only list active new choices', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /const earners = Store\.getEarners\(\)/);
  assert.match(source, /currentEarner\.name\} \(Archived\)/);
  assert.match(source, /const categories = Store\.getCategories\(\)/);
  assert.match(source, /currentCategory\.name\} \(Archived\)/);
  assert.match(source, /Store\.getCategoryItems\(cat\.id\)/);
  assert.match(source, /currentItem\.name\} \(Archived\)/);
  assert.match(source, /No active earners available/);
  assert.match(source, /No active categories available/);
});

test('preset and custom expense provenance is explicit', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /const categoryItemId = document\.getElementById\('field-preset'\)\.value \|\| null/);
  assert.match(source, /categoryId !== existing\.categoryId \|\| categoryItemId !== existing\.categoryItemId/);
  assert.match(source, /categoryItemId === null && customName !== existing\.name/);
  assert.match(source, /document\.getElementById\('field-name'\)\.disabled = isPreset/);
});

test('successful edits restore focus to the safely located replacement control', () => {
  const source = fs.readFileSync(budgetPath, 'utf8');

  assert.match(source, /button\.dataset\.editType === type && button\.dataset\.recordId === id/);
  assert.match(source, /if \(existing\) this\.focusEditControl\('paycheck', existing\.id\)/);
  assert.match(source, /if \(existing\) this\.focusEditControl\('expense', existing\.id\)/);
  assert.doesNotMatch(source, /querySelector\s*\(\s*`[^`]*\$\{/);
});
