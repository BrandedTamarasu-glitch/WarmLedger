'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function load() {
  const elements = new Map(); const switches = []; const storeCalls = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', hidden: false, children: [], focused: false,
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handler = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      focus() { this.focused = true; },
      getContext() { return {}; }
    });
    return elements.get(id);
  }
  const months = new Map();
  const empty = () => ({ paychecks: [], expenses: [],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] });
  const Store = {
    getAllMonthKeys() { storeCalls.push('keys'); return [...months.keys()]; },
    getMonth(key) { storeCalls.push(`month:${key}`); return months.get(key) || empty(); },
    calcMonthSummary() { return { totalPlannedIncome: 0, totalPlannedExpenses: 0, totalActualExpenses: 0, unresolvedExpenseCount: 0 }; },
    calcCategoryTotals() { return {}; }, calcPaymentMethodTotals() { return { bank: 0, credit_card: 0 }; }
  };
  class ChartStub { destroy() { this.destroyed = true; } }
  const context = vm.createContext({
    Store, Chart: ChartStub, ALLOCATION_TYPES: [], console,
    App: { switchView(view) { switches.push(view); } },
    document: {
      getElementById: element,
      createElement(tag) { const node = element(`created-${tag}-${elements.size}`); node.tag = tag; node.children = []; return node; }
    }
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), elements, element, months, switches, storeCalls };
}

test('strict civil range validation covers incomplete, malformed, reversed, same, 600, and 601 months', () => {
  const { dashboard } = load();
  assert.equal(dashboard.validateDateRange({ from: '', to: '2026-01' }).status, 'incomplete');
  for (const range of [{ from: '2026-1', to: '2026-02' }, { from: 'nope', to: '2026-02' },
    { from: '2026-00', to: '2026-02' }, { from: '2026-01', to: '2026-13' }]) {
    assert.equal(dashboard.validateDateRange(range).status, 'invalid');
  }
  assert.equal(dashboard.validateDateRange({ from: '2026-02', to: '2026-01' }).status, 'reversed');
  const same = dashboard.validateDateRange({ from: '2026-02', to: '2026-02' });
  assert.equal(same.status, 'ready'); assert.deepEqual([...same.months], ['2026-02']);
  const sixHundred = dashboard.validateDateRange({ from: '2000-01', to: '2049-12' });
  assert.equal(sixHundred.status, 'ready'); assert.equal(sixHundred.monthCount, 600);
  const tooWide = dashboard.validateDateRange({ from: '2000-01', to: '2050-01' });
  assert.equal(tooWide.status, 'too-wide'); assert.equal(tooWide.monthCount, 601);
  assert.equal(Object.isFrozen(sixHundred), true); assert.equal(Object.isFrozen(sixHundred.months), true);
});

test('coverage overview is pure, frozen, and preserves null versus entered zero', () => {
  const { dashboard } = load();
  const entries = [
    { monthKey: '2026-01', exists: false, month: { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 } } },
    { monthKey: '2026-02', exists: true, month: { paychecks: [], expenses: [], allocations: { savings: 5, credit_card_debt: 0, investments: 0 } } },
    { monthKey: '2026-03', exists: true, month: {
      paychecks: [
        { plannedAmount: 100, actualAmount: null }, { plannedAmount: 50, actualAmount: 0 }
      ],
      expenses: [
        { plannedAmount: 40, actualAmount: 0 }, { plannedAmount: 10, actualAmount: 8 }
      ], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
    } }
  ];
  const before = JSON.stringify(entries); const overview = dashboard.buildCoverageOverview(entries);
  assert.deepEqual(plain(overview), {
    coverage: { selectedMonths: 3, financialActivityMonths: 2 },
    actualEntries: { enteredCount: 3, missingCount: 1, complete: false },
    plannedTotals: { income: 150, expenses: 50 }
  });
  assert.equal(JSON.stringify(entries), before);
  assert.equal(Object.isFrozen(overview), true); assert.equal(Object.isFrozen(overview.actualEntries), true);
});

test('every render clears stale charts, table, overview, and results before invalid or empty outcomes', () => {
  const { dashboard, element, months, storeCalls } = load();
  let destroyed = 0; dashboard.charts = { stale: { destroy() { destroyed++; } } };
  element('summary-table-container').children = ['stale']; element('dashboard-overview').children = ['stale'];
  dashboard.getDateRange = () => ({ from: 'bad', to: '2026-01' }); dashboard.render();
  assert.equal(destroyed, 1); assert.deepEqual(element('summary-table-container').children, []);
  assert.deepEqual(element('dashboard-overview').children, []); assert.equal(element('dashboard-results').hidden, true);
  assert.equal(element('dashboard-state').hidden, false); assert.deepEqual(storeCalls, []);

  months.set('2026-01', { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] });
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-01' }); dashboard.render();
  assert.equal(element('dashboard-state').hidden, false); assert.equal(element('dashboard-results').hidden, true);
  assert.equal(element('dashboard-state').children.some(child => child.textContent === 'Go to Budget'), true);
});

test('ready render uses only financial activity, exposes overview hooks, and never treats tombstones as activity', () => {
  const { dashboard, element, months } = load();
  months.set('2026-01', { paychecks: [], expenses: [], allocations: { savings: 1, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] });
  months.set('2026-02', { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
    suppressedOccurrences: [{ sourceTemplateId: 'x', occurrenceKey: '2026-02-01#0001' }] });
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-02' });
  const calls = [];
  for (const method of ['renderCategoryTrend', 'renderIncomePct', 'renderProjVsActual', 'renderSavingsRate',
    'renderPaymentMethod', 'renderYoY', 'renderSummaryTable']) dashboard[method] = value => calls.push([method, value]);
  dashboard.render();
  assert.equal(element('dashboard-state').hidden, true); assert.equal(element('dashboard-results').hidden, false);
  assert.equal(element('dashboard-overview').children.length, 3);
  assert.equal(calls.length, 7); assert.ok(calls.every(call => call[1].length === 2));
});

test('missing-actual action states global scope and routes to Data Health with deterministic heading focus', () => {
  const { dashboard, element, switches } = load();
  const entries = [{ monthKey: '2026-01', exists: true, month: {
    paychecks: [{ plannedAmount: 1, actualAmount: null }], expenses: [],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
  } }];
  dashboard.renderOverview(entries);
  const actualCard = element('dashboard-overview').children[1];
  assert.match(actualCard.children[1].textContent, /Data Health reviews the full budget/);
  const button = actualCard.children[2];
  assert.equal(button.textContent, 'Review missing actuals in Data Health'); button.handler();
  assert.deepEqual(switches, ['data-health']); assert.equal(element('data-health-heading').focused, true);
});
