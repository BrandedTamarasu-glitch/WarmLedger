'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'budget.js'), 'utf8');

function harness({ view = 'dashboard', refreshedAction = null } = {}) {
  const calls = { announcements: [], budgetRenders: 0, dashboardRenders: 0, switches: [], storeReads: 0 };
  const summary = { focus(options) { calls.focused = 'summary'; calls.focusOptions = options; } };
  const heading = { focus(options) { calls.focused = 'heading'; calls.focusOptions = options; } };
  const action = refreshedAction ? {
    dataset: refreshedAction,
    focus(options) { calls.focused = 'action'; calls.focusOptions = options; }
  } : null;
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '#dashboard-review-queue [data-review-kind][data-month-key]');
      return action ? [action] : [];
    },
    querySelector(selector) {
      assert.equal(selector, '#dashboard-review-queue > summary'); return summary;
    },
    getElementById(id) { return id === 'monthly-review-next-steps-heading' ? heading : null; }
  };
  const Store = new Proxy({
    getNextReviewSteps() { calls.storeReads += 1; return { steps: [] }; }
  }, { set() { throw new Error('routing must not mutate Store'); } });
  const App = {
    currentView: view,
    announceStatus(message) { calls.announcements.push(message); },
    switchView(target) { calls.switches.push(target); }
  };
  const DashboardView = { renderMonthReviewQueue() { calls.dashboardRenders += 1; } };
  const context = vm.createContext({ document, Store, App, DashboardView, Date, Intl, Math, Object,
    requestAnimationFrame(callback) { callback(); } });
  vm.runInContext(`${source}\n;globalThis.__view = BudgetView;`, context, { filename: 'budget.js' });
  context.__view.render = () => { calls.budgetRenders += 1; };
  return { view: context.__view, calls, Store };
}

test('stale Dashboard route refreshes in place and focuses the exact surviving action', () => {
  const { view, calls } = harness({ refreshedAction: { reviewKind: 'actuals', monthKey: '2026-04' } });
  view.currentMonth = '2026-08';
  assert.equal(view.routeReviewNavigation('2026-04', 'actuals', 'budget-actuals'), false);
  assert.equal(view.currentMonth, '2026-08');
  assert.equal(calls.dashboardRenders, 1); assert.equal(calls.budgetRenders, 0);
  assert.deepEqual(calls.switches, []); assert.equal(calls.focused, 'action');
  assert.equal(calls.focusOptions.preventScroll, true);
  assert.deepEqual(calls.announcements, ['Review needs changed. Review the refreshed month.']);
});

test('stale Dashboard route focuses its disclosure summary when no exact action survives', () => {
  const { view, calls } = harness({ refreshedAction: { reviewKind: 'funding', monthKey: '2026-04' } });
  assert.equal(view.routeReviewNavigation('2026-04', 'actuals', 'budget-actuals'), false);
  assert.equal(calls.focused, 'summary'); assert.equal(calls.dashboardRenders, 1);
  assert.equal(calls.budgetRenders, 0); assert.deepEqual(calls.switches, []);
});

test('stale Budget route preserves the existing hidden-view-independent fallback', () => {
  const { view, calls } = harness({ view: 'budget' });
  assert.equal(view.routeReviewNavigation('2026-04', 'actuals', 'budget-actuals'), false);
  assert.equal(view.currentMonth, '2026-04'); assert.equal(calls.budgetRenders, 1);
  assert.equal(calls.dashboardRenders, 0); assert.equal(calls.focused, 'heading');
  assert.deepEqual(calls.switches, []);
});

test('stale routing is read-only', () => {
  const { view, calls, Store } = harness();
  const before = Object.keys(Store).sort();
  assert.equal(view.routeReviewNavigation('2026-04', 'dates', 'budget-dates'), false);
  assert.deepEqual(Object.keys(Store).sort(), before); assert.equal(calls.storeReads, 1);
});
