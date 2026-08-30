'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const budgetSource = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');

function budgetHarness({ paychecks = [{ id: 'paycheck ] hostile' }, { id: 'second' }], expense = {
  id: 'expense "] hostile', category: 'Category <hostile>'
} } = {}) {
  const focusLog = []; const announcements = []; let renderExpenses = 0;
  const heading = control('expenses-heading', focusLog); const addPaycheck = control('btn-add-paycheck', focusLog);
  const controls = paychecks.map(paycheck => control('', focusLog, {
    fundingExpenseId: expense?.id || 'missing', fundingPaycheckId: paycheck.id
  }));
  const document = {
    createElement() { return {}; },
    getElementById(id) { return id === 'expenses-heading' ? heading : id === 'btn-add-paycheck' ? addPaycheck : null; },
    querySelectorAll(selector) {
      assert.equal(selector, '.expense-table input[data-funding-expense-id][data-funding-paycheck-id]'); return controls;
    }
  };
  const context = { document, Store: { getMonth() { return { paychecks, expenses: expense ? [expense] : [] }; } },
    App: { announceStatus(message) { announcements.push(message); } }, ALLOCATION_TYPES: [], console };
  vm.createContext(context); vm.runInContext(`${budgetSource}\n;globalThis.__view = BudgetView;`, context);
  context.__view.renderExpenses = () => { renderExpenses += 1; };
  return { view: context.__view, controls, heading, addPaycheck, focusLog, announcements,
    get renderExpenses() { return renderExpenses; } };
}

function control(id, focusLog, dataset = {}) {
  return { id, dataset, focus(options) { focusLog.push({ target: this, options }); },
    scrollIntoView(options) { focusLog.push({ scroll: this, options }); } };
}

test('allocation inputs expose stable funding datasets', () => {
  assert.match(budgetSource, /input\.dataset\.fundingExpenseId = expense\.id/);
  assert.match(budgetSource, /input\.dataset\.fundingPaycheckId = paycheck\.id/);
});

test('Budget funding alerts use the shared Store funding boundary without name-column prose', () => {
  assert.match(budgetSource, /Store\.fundingDirection\(assigned - expense\.plannedAmount\) !== 0/);
  assert.match(budgetSource, /expense-funding-alert/);
  assert.doesNotMatch(budgetSource, /Math\.abs\(assigned - expense\.plannedAmount\)\s*>\s*0\.009/);
});

test('exact and null-paycheck routes focus by fixed enumeration with hostile identifiers', () => {
  const exact = budgetHarness(); exact.view.currentMonth = '2026-04';
  exact.view.focusFundingControl('expense "] hostile', 'second');
  assert.equal(exact.focusLog[0].target, exact.controls[1]);
  assert.equal(exact.focusLog[0].options.preventScroll, true);
  assert.equal(exact.focusLog[1].scroll, exact.controls[1]);
  assert.deepEqual(exact.announcements, []);

  const first = budgetHarness(); first.view.focusFundingControl('expense "] hostile', null);
  assert.equal(first.focusLog[0].target, first.controls[0]); assert.deepEqual(first.announcements, []);
});

test('collapsed historical category expands and rerenders before focus', () => {
  const harness = budgetHarness(); harness.view.collapsedCategories.set('Category <hostile>', true);
  harness.view.focusFundingControl('expense "] hostile', 'paycheck ] hostile');
  assert.equal(harness.view.collapsedCategories.get('Category <hostile>'), false);
  assert.equal(harness.renderExpenses, 1); assert.equal(harness.focusLog[0].target, harness.controls[0]);
});

test('no-paycheck and stale routes use deterministic guidance and focus fallbacks', () => {
  const none = budgetHarness({ paychecks: [] }); none.view.focusFundingControl('expense "] hostile');
  assert.equal(none.focusLog[0].target, none.addPaycheck); assert.match(none.announcements[0], /Add a paycheck/);

  const staleExpense = budgetHarness({ expense: null }); staleExpense.view.focusFundingControl('missing');
  assert.equal(staleExpense.focusLog[0].target, staleExpense.heading); assert.match(staleExpense.announcements[0], /bill is no longer available/);

  const stalePaycheck = budgetHarness(); stalePaycheck.view.focusFundingControl('expense "] hostile', 'removed');
  assert.equal(stalePaycheck.focusLog[0].target, stalePaycheck.heading); assert.match(stalePaycheck.announcements[0], /funding control is no longer available/);
});

test('App route synchronizes month, switches, renders, and delegates without Store mutation', () => {
  const start = appSource.indexOf('openBudgetFunding('); const end = appSource.indexOf('\n  },', start);
  const route = appSource.slice(start, end);
  assert.ok(start >= 0); assert.ok(route.indexOf('BudgetView.currentMonth = monthKey') < route.indexOf("this.switchView('budget')"));
  assert.ok(route.indexOf("this.switchView('budget')") < route.indexOf('BudgetView.render()'));
  assert.ok(route.indexOf('BudgetView.render()') < route.indexOf('BudgetView.focusFundingControl(expenseId, paycheckId)'));
  assert.doesNotMatch(route, /Store\.|announceStatus|runMutation/);
});

test('focus routing never interpolates persisted identifiers into selectors or mutates Store', () => {
  const start = budgetSource.indexOf('focusFundingControl('); const end = budgetSource.indexOf('\n  },', start);
  const route = budgetSource.slice(start, end);
  assert.match(route, /querySelectorAll\('\.expense-table input\[data-funding-expense-id\]\[data-funding-paycheck-id\]'\)/);
  assert.match(route, /control\.dataset\.fundingExpenseId === expenseId/);
  assert.match(route, /control\.dataset\.fundingPaycheckId === paycheckId/);
  assert.doesNotMatch(route, /querySelector(?:All)?\s*\(\s*`|Store\.(?:add|update|edit|delete|reorder|clear|copy|apply|commit|restore|start)/);
});
