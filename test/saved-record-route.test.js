'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');
const budgetSource = fs.readFileSync(require.resolve('../js/budget.js'), 'utf8');

function result(overrides = {}) {
  return {
    kind: 'expense', monthKey: '2026-04', recordId: 'hostile"] expense',
    primaryLabel: '<Rent & utilities>', secondaryLabel: 'Home [main]', date: '2026-04-02',
    plannedAmount: 100, actualAmount: null, paymentMethod: 'bank', matchedFields: ['name'], ...overrides
  };
}

function appHarness(report) {
  const focused = [];
  const summary = { focus(options) { focused.push(['summary', options]); } };
  const heading = { focus(options) { focused.push(['heading', options]); } };
  const actions = [];
  const switches = []; const announcements = []; const routed = [];
  const context = vm.createContext({
    console,
    requestAnimationFrame(callback) { callback(); },
    document: {
      addEventListener() {},
      querySelectorAll(selector) {
        if (selector === '[data-record-kind][data-month-key][data-record-id]') return actions;
        return [];
      },
      getElementById(id) {
        if (id === 'dashboard-record-finder') return { querySelector(selector) { assert.equal(selector, 'summary'); return summary; } };
        if (id === 'dashboard-heading') return heading;
        return { classList: { toggle() {} } };
      }
    },
    DashboardView: { rerunSavedRecordSearch() { return report; } },
    BudgetView: { currentMonth: null, focusSavedRecordResult(value) { routed.push(value); } },
    Store: {}, TransfersView: {}, StructureView: {}, DataHealthView: {}, TemplatesView: {}
  });
  vm.runInContext(`${appSource}\nthis.ExportedApp = App;`, context);
  const app = context.ExportedApp;
  app.currentView = 'dashboard';
  app.switchView = view => { switches.push(view); app.currentView = view; };
  app.announceStatus = message => announcements.push(message);
  return { app, context, actions, focused, switches, announcements, routed, summary };
}

test('valid paycheck and expense results rerun and exactly revalidate before routing', () => {
  for (const original of [result(), result({
    kind: 'income', recordId: 'paycheck <one>', primaryLabel: 'Earner & One', secondaryLabel: 'Paycheck',
    paymentMethod: undefined, matchedFields: ['earner'], actualAmount: 0
  })]) {
    if (original.paymentMethod === undefined) delete original.paymentMethod;
    const refreshed = structuredClone(original);
    const harness = appHarness({ results: [refreshed] });
    const before = JSON.stringify(original);
    assert.equal(harness.app.openSavedRecordResult(original), true);
    assert.equal(JSON.stringify(original), before);
    assert.equal(harness.context.BudgetView.currentMonth, '2026-04');
    assert.deepEqual(harness.switches, ['budget']);
    assert.equal(harness.routed.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.routed[0])), refreshed);
    assert.deepEqual(harness.announcements, []);
  }
});

test('changed fingerprints remain on Dashboard and focus the refreshed matching action', () => {
  const original = result(); const refreshed = result({ primaryLabel: 'Changed saved label' });
  const harness = appHarness({ results: [refreshed] });
  const action = {
    dataset: { recordKind: refreshed.kind, monthKey: refreshed.monthKey, recordId: refreshed.recordId },
    focus(options) { harness.focused.push(['action', options]); }
  };
  harness.actions.push(action);
  assert.equal(harness.app.openSavedRecordResult(original), false);
  assert.equal(harness.app.currentView, 'dashboard');
  assert.deepEqual(harness.switches, []);
  assert.deepEqual(harness.routed, []);
  assert.match(harness.announcements[0], /changed or is no longer/);
  assert.equal(JSON.stringify(harness.focused), JSON.stringify([['action', { preventScroll: true }]]));
});

test('removed, missing-request, and refresh-failure paths use safe finder focus fallback', () => {
  const missing = appHarness({ results: [] });
  assert.equal(missing.app.openSavedRecordResult(result()), false);
  assert.equal(JSON.stringify(missing.focused), JSON.stringify([['summary', { preventScroll: true }]]));
  assert.equal(missing.app.currentView, 'dashboard');

  const failed = appHarness(null);
  failed.context.DashboardView.rerunSavedRecordSearch = () => { throw new Error('private query must not escape'); };
  assert.equal(failed.app.openSavedRecordResult(result()), false);
  assert.equal(JSON.stringify(failed.focused), JSON.stringify([['summary', { preventScroll: true }]]));
  assert.doesNotMatch(failed.announcements[0], /private|query|recordId|Rent/);
});

function budgetHarness() {
  const controls = [];
  const focused = []; const headings = {
    'paychecks-heading': { focus(options) { focused.push(['paychecks-heading', options]); } },
    'expenses-heading': { focus(options) { focused.push(['expenses-heading', options]); } }
  };
  const context = vm.createContext({
    console, Store: {}, App: {},
    requestAnimationFrame(callback) { callback(); },
    document: {
      querySelectorAll(selector) { assert.equal(selector, '[data-edit-type][data-record-id]'); return controls; },
      getElementById(id) { return headings[id] || null; }
    }
  });
  vm.runInContext(`${budgetSource}\nthis.ExportedBudget = BudgetView;`, context);
  const view = context.ExportedBudget; let renders = 0; view.render = () => { renders++; };
  return { view, controls, focused, renders: () => renders };
}

test('Budget helper expands expense category and focuses existing edit controls by dataset equality', () => {
  const expense = budgetHarness();
  expense.view.collapsedCategories.set('Home [main]', true);
  expense.controls.push({
    dataset: { editType: 'expense', recordId: 'hostile"] expense' },
    focus(options) { expense.focused.push(['expense', options]); }
  });
  expense.view.focusSavedRecordResult(result());
  assert.equal(expense.view.collapsedCategories.get('Home [main]'), false);
  assert.equal(expense.renders(), 1);
  assert.equal(JSON.stringify(expense.focused), JSON.stringify([['expense', { preventScroll: true }]]));

  const income = budgetHarness();
  income.controls.push({ dataset: { editType: 'paycheck', recordId: 'p<1>' },
    focus(options) { income.focused.push(['income', options]); } });
  income.view.focusSavedRecordResult(result({ kind: 'income', recordId: 'p<1>' }));
  assert.equal(income.renders(), 1);
  assert.equal(JSON.stringify(income.focused), JSON.stringify([['income', { preventScroll: true }]]));
});

test('route implementation uses fixed selector enumeration and never interpolates record data into selectors', () => {
  const routeStart = appSource.indexOf('  focusSavedRecordSearchFallback(');
  const routeEnd = appSource.indexOf('\n  refreshAllViews(', routeStart);
  const route = appSource.slice(routeStart, routeEnd);
  const focusStart = budgetSource.indexOf('  focusSavedRecordResult(');
  const focusEnd = budgetSource.indexOf('\n  focusMoveControl(', focusStart);
  const focus = budgetSource.slice(focusStart, focusEnd);
  assert.match(route, /rerunSavedRecordSearch\(\)/);
  assert.match(route, /savedRecordResultFingerprint/);
  assert.match(route, /querySelectorAll\('\[data-record-kind\]\[data-month-key\]\[data-record-id\]'\)/);
  assert.match(focus, /querySelectorAll\('\[data-edit-type\]\[data-record-id\]'\)/);
  assert.doesNotMatch(`${route}\n${focus}`, /CSS\.escape|querySelector\(`|querySelectorAll\(`/);
  assert.doesNotMatch(`${route}\n${focus}`, /Store\.(?:add|update|edit|delete|commit|import|restore|set)/);
});
