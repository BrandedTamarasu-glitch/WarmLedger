'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');
const budgetSource = fs.readFileSync(require.resolve('../js/budget.js'), 'utf8');

function request(overrides = {}) {
  return { baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'actual',
    section: 'categories', dimensionKey: 'Home [main]', ...overrides };
}

function contributor(overrides = {}) {
  return { kind: 'expense', recordId: 'hostile"] expense', monthKey: '2026-02',
    name: '<Rent & utilities>', category: 'Home [main]', date: '2026-02-02', plannedAmount: 100,
    actualAmount: 0, paymentMethod: 'bank', displayAmount: 0, displayStatus: 'Complete', ...overrides };
}

function explanation(records = [contributor()], overrides = {}) {
  return { status: 'ready', baseline: { monthKey: '2026-01', records: [] },
    comparison: { monthKey: '2026-02', records }, ...overrides };
}

function appHarness({ activeRequest = request(), report = explanation(), refreshError = null } = {}) {
  const switches = []; const announcements = []; const routed = []; const refreshes = []; const fallbacks = [];
  const context = vm.createContext({ console, requestAnimationFrame(callback) { callback(); },
    document: { addEventListener() {}, querySelectorAll() { return []; },
      getElementById() { return { classList: { toggle() {} } }; } },
    DashboardView: {
      savedMonthComparisonExplainRequest: activeRequest,
      refreshSavedMonthComparisonExplanation(candidate, options) {
        refreshes.push({ candidate, options }); if (refreshError) throw refreshError; return report;
      },
      focusSavedMonthComparisonFallback(candidate) { fallbacks.push(candidate); return true; }
    },
    BudgetView: { currentMonth: null, focusSavedMonthComparisonContributor(value) { routed.push(value); } },
    Store: {}, TransfersView: {}, StructureView: {}, DataHealthView: {}, TemplatesView: {}
  });
  vm.runInContext(`${appSource}\nthis.ExportedApp = App;`, context);
  const app = context.ExportedApp; app.currentView = 'dashboard';
  app.switchView = view => { switches.push(view); app.currentView = view; };
  app.announceStatus = message => announcements.push(message);
  return { app, context, switches, announcements, routed, refreshes, fallbacks };
}

test('comparison contributor reruns the exact active explanation before routing to Budget', () => {
  const original = contributor(); const current = structuredClone(original);
  const harness = appHarness({ report: explanation([current]) }); const before = JSON.stringify(original);
  assert.equal(harness.app.openSavedMonthComparisonContributor(original, request()), true);
  assert.equal(JSON.stringify(original), before);
  assert.equal(harness.refreshes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.refreshes[0].candidate)), request());
  assert.equal(harness.context.BudgetView.currentMonth, '2026-02');
  assert.deepEqual(harness.switches, ['budget']);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.routed[0])), current);
  assert.deepEqual(harness.announcements, []);
});

test('changed, disappeared, foreign-side, and forged contributor values fail closed', () => {
  const cases = [
    { candidate: contributor({ name: 'Old name' }), report: explanation([contributor({ name: 'New name' })]) },
    { candidate: contributor(), report: explanation([]) },
    { candidate: contributor({ monthKey: '2026-01' }), report: explanation([contributor()]) },
    { candidate: contributor({ kind: 'income' }), report: explanation([contributor()]) },
    { candidate: contributor({ actualAmount: Number.NaN }), report: explanation([contributor({ actualAmount: null })]) },
    { candidate: { ...contributor(), displayStatus: undefined }, report: explanation([contributor()]) }
  ];
  for (const item of cases) {
    const harness = appHarness({ report: item.report });
    assert.equal(harness.app.openSavedMonthComparisonContributor(item.candidate, request()), false);
    assert.equal(harness.app.currentView, 'dashboard'); assert.deepEqual(harness.routed, []);
    assert.equal(harness.refreshes.length, 1); assert.equal(harness.fallbacks.length, 1);
    assert.match(harness.announcements[0], /changed or is no longer/);
  }
});

test('mismatched requests never rerun attacker-selected comparison details', () => {
  for (const forged of [request({ basis: 'planned' }), request({ dimensionKey: 'Other' }),
    request({ baselineMonth: '2025-12' }), { ...request(), section: undefined }]) {
    const harness = appHarness();
    assert.equal(harness.app.openSavedMonthComparisonContributor(contributor(), forged), false);
    assert.equal(harness.refreshes.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.refreshes[0].candidate)), request());
    assert.deepEqual(harness.routed, []); assert.equal(harness.app.currentView, 'dashboard');
  }
  const missing = appHarness({ activeRequest: null });
  assert.equal(missing.app.openSavedMonthComparisonContributor(contributor(), request()), false);
  assert.equal(missing.refreshes.length, 0); assert.equal(missing.fallbacks.length, 1);
});

test('refresh failure remains on Dashboard, announces generic copy, and restores safe focus', () => {
  const harness = appHarness({ refreshError: new Error('private saved value') });
  assert.equal(harness.app.openSavedMonthComparisonContributor(contributor(), request()), false);
  assert.equal(harness.app.currentView, 'dashboard'); assert.deepEqual(harness.routed, []);
  assert.ok(harness.refreshes.length >= 1); assert.equal(harness.fallbacks.length, 1);
  assert.match(harness.announcements.at(-1), /could not be refreshed/);
  assert.doesNotMatch(harness.announcements.join(' '), /private|Rent|hostile/);
});

function budgetHarness() {
  const controls = []; const focused = [];
  const context = vm.createContext({ console, Store: {}, App: {}, requestAnimationFrame(callback) { callback(); },
    document: {
      querySelectorAll(selector) { assert.equal(selector, '[data-edit-type][data-record-id]'); return controls; },
      getElementById(id) { return id === 'expenses-heading'
        ? { focus(options) { focused.push(['heading', options]); } } : null; }
    }
  });
  vm.runInContext(`${budgetSource}\nthis.ExportedBudget = BudgetView;`, context);
  const view = context.ExportedBudget; let renders = 0; view.render = () => { renders++; };
  return { view, controls, focused, renders: () => renders };
}

test('Budget expands the current category and uses fixed selector enumeration for expense Edit focus', () => {
  const found = budgetHarness(); found.view.collapsedCategories.set('Home [main]', true);
  found.controls.push({ dataset: { editType: 'expense', recordId: 'hostile"] expense' },
    focus(options) { found.focused.push(['edit', options]); } });
  found.view.focusSavedMonthComparisonContributor(contributor());
  assert.equal(found.view.collapsedCategories.get('Home [main]'), false);
  assert.equal(found.renders(), 1);
  assert.equal(JSON.stringify(found.focused), JSON.stringify([['edit', { preventScroll: true }]]));

  const missing = budgetHarness(); missing.view.focusSavedMonthComparisonContributor(contributor());
  assert.equal(JSON.stringify(missing.focused), JSON.stringify([['heading', { preventScroll: true }]]));
});

test('comparison route never interpolates hostile values into selectors and performs no writes', () => {
  const routeStart = appSource.indexOf('  savedMonthComparisonRequestFingerprint(');
  const routeEnd = appSource.indexOf('\n  refreshAllViews(', routeStart);
  const focusStart = budgetSource.indexOf('  focusSavedMonthComparisonContributor(');
  const focusEnd = budgetSource.indexOf('\n  focusMoveControl(', focusStart);
  const implementation = `${appSource.slice(routeStart, routeEnd)}\n${budgetSource.slice(focusStart, focusEnd)}`;
  assert.match(implementation, /refreshSavedMonthComparisonExplanation\(activeRequest\)/);
  assert.match(implementation, /querySelectorAll\('\[data-edit-type\]\[data-record-id\]'\)/);
  assert.doesNotMatch(implementation, /CSS\.escape|querySelector\(`|querySelectorAll\(`/);
  assert.doesNotMatch(implementation, /Store\.(?:add|update|edit|delete|commit|import|restore|set)/);
});
