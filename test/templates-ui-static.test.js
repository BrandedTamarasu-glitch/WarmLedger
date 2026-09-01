'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'templates.js'), 'utf8');

test('TemplatesView documents isolated integration hooks and uses the frozen Store APIs', () => {
  assert.match(source, /requiredElementIds: Object\.freeze/);
  for (const method of [
    'getIncomeTemplates', 'getExpenseTemplates', 'addIncomeTemplate', 'addExpenseTemplate',
    'updateIncomeTemplate', 'updateExpenseTemplate', 'setIncomeTemplateArchived',
    'setExpenseTemplateArchived', 'reorderIncomeTemplates', 'reorderExpenseTemplates'
  ]) assert.match(source, new RegExp(`Store\\.${method}\\(`));
  assert.doesNotMatch(source, /Store\.getData\(/);
});

test('every declared integration ID is used and expense section IDs stay plural', () => {
  const declaration = source.match(/requiredElementIds: Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(declaration);
  const ids = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, [
    'btn-add-income-template', 'btn-add-expense-template',
    'templates-income', 'templates-expenses',
    'templates-income-heading', 'templates-expenses-heading',
    'template-readiness', 'template-readiness-heading',
    'template-readiness-disabled', 'template-readiness-suggestions',
    'template-activation-month', 'template-activation-preview',
    'template-activation-dialog', 'template-activation-content',
    'template-activation-cancel', 'template-activation-confirm'
  ]);
  ids.forEach(id => assert.match(source, new RegExp(id)));
  assert.doesNotMatch(source, /templates-expense(?:['"`]|-heading)/);
  assert.match(source, /kind === 'expense' \? 'expenses' : kind/g);
});

test('cards expose textual states and keyboard-native ordered actions', () => {
  assert.match(source, /record\.archived \? 'Archived' : record\.enabled \? 'Enabled' : 'Disabled'/);
  assert.match(source, /'Move up'/);
  assert.match(source, /'Move down'/);
  assert.match(source, /button\.disabled = disabled/);
  assert.match(source, /moved to position \$\{to \+ 1\} of \$\{records\.length\}/);
});

test('forms cover all frozen cadences, inclusive bounds, clamping, and structural IDs', () => {
  for (const cadence of ['monthly', 'twice-monthly', 'weekly', 'biweekly']) assert.match(source, new RegExp(`\\['${cadence}',`));
  assert.match(source, /Start date \(inclusive\)/);
  assert.match(source, /End date \(inclusive, optional\)/);
  assert.match(source, /Short months use their final day/);
  assert.match(source, /both occurrences remain if they land together/);
  assert.match(source, /input\.earnerId =/);
  assert.match(source, /input\.categoryId =/);
  assert.match(source, /input\.categoryItemId =/);
  assert.match(source, /monthly\.required = cadence === 'monthly'/);
  assert.match(source, /first\.required = cadence === 'twice-monthly'/);
  assert.match(source, /second\.required = cadence === 'twice-monthly'/);
  assert.match(source, /anchor\.required = cadence === 'weekly' \|\| cadence === 'biweekly'/);
  assert.match(source, /monthly\.disabled = cadence !== 'monthly'/);
});

test('persisted labels and preview values use inert DOM sinks', () => {
  assert.match(source, /node\.textContent = text/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\b(?:onclick|onchange)\s*=/i);
  assert.doesNotMatch(source, /querySelector(?:All)?\s*\(\s*`[^`]*\$\{/);
  assert.match(source, /buildPreview\(preview\)/);
});

test('focus restoration compares dataset values without selector interpolation', () => {
  assert.match(source, /control\.dataset\.templateKind === kind/);
  assert.match(source, /control\.dataset\.recordId === id/);
  assert.match(source, /control\.dataset\.templateAction === action/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /showTemplateModal\(kind, record, event\.currentTarget\)/);
});

test('template drafts can be safely seeded without changing normal new-template defaults', () => {
  assert.match(source, /showTemplateModal\(kind, existing, trigger, draft = null\)/);
  assert.match(source, /const initial = existing \|\| draft/);
  assert.match(source, /if \(!existing && !draft\) document\.getElementById\('field-template-enabled'\)\.checked = true/);
  assert.match(source, /monthlyExpenseDraft\(expense, startDate\)/);
  assert.match(source, /enabled: false/);
  assert.match(source, /nextMonthStart\(date\)/);
});
