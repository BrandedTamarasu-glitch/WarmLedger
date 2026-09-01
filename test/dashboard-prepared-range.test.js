'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modelsSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard-models.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');

function fixture() {
  const monthKeys = ['2026-01', '2026-02'];
  const months = {
    '2026-01': { exists: true, paycheckCount: 2, expenseCount: 1, suppressedOccurrenceCount: 0,
      summary: { totalPlannedIncome: 100, totalActualIncome: 80, unresolvedIncomeCount: 1,
        totalPlannedExpenses: 40, totalActualExpenses: 0, unresolvedExpenseCount: 1, totalAllocated: 5 },
      allocations: { savings: 5 }, categoryTotals: { Home: { planned: 40, actual: 0, unresolvedCount: 1 } },
      paymentMethodTotals: { bank: 0, credit_card: 0, savings: 0, investments: 0 }, incompletePaymentMethods: ['bank'] },
    '2026-02': { exists: true, paycheckCount: 1, expenseCount: 1, suppressedOccurrenceCount: 0,
      summary: { totalPlannedIncome: 120, totalActualIncome: 120, unresolvedIncomeCount: 0,
        totalPlannedExpenses: 20, totalActualExpenses: 0, unresolvedExpenseCount: 0, totalAllocated: 0 },
      allocations: { savings: 0 }, categoryTotals: { Home: { planned: 20, actual: 0, unresolvedCount: 0 } },
      paymentMethodTotals: { bank: 0, credit_card: 0, savings: 0, investments: 0 }, incompletePaymentMethods: [] }
  };
  return Object.freeze({ basis: 'actual', monthKeys: Object.freeze(monthKeys), months: Object.freeze(months) });
}

function load() {
  let prepares = 0; const prepared = fixture(); const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '', replaceChildren() {}, focus() {} });
    return elements.get(id);
  };
  const forbidden = () => { throw new Error('aggregate rescanned after preparation'); };
  const context = vm.createContext({ console, ALLOCATION_TYPES: [{ key: 'savings', label: 'Savings' }],
    Store: { prepareDashboardRange({ monthKeys, basis }) { prepares++; assert.equal([...monthKeys].join(','), prepared.monthKeys.join(',')); assert.equal(basis, 'actual'); return prepared; },
      getMonth: forbidden, calcMonthSummary: forbidden, calcCategoryTotals: forbidden, calcPaymentMethodTotals: forbidden },
    document: { getElementById: element }, App: {} });
  vm.runInContext(modelsSource, context); vm.runInContext(dashboardSource, context);
  return { dashboard: vm.runInContext('DashboardView', context), prepared, prepares: () => prepares, element };
}

test('one dashboard render prepares once and shares the identical snapshot with every report builder', () => {
  const { dashboard, prepared, prepares, element } = load(); const received = [];
  dashboard.renderUpcoming = dashboard.renderMonthReviewQueue = dashboard.compareSavedMonths =
    dashboard.clearRenderedOutput = dashboard.renderForecast = () => {};
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-02' });
  dashboard.basis = 'actual';
  dashboard.renderState = () => {}; dashboard.renderOverview = value => received.push(value);
  for (const method of ['renderCategoryTrend', 'renderIncomePct', 'renderProjVsActual', 'renderSavingsRate',
    'renderPaymentMethod', 'renderYoY', 'renderSummaryTable']) dashboard[method] = value => received.push(value);
  dashboard.render();
  assert.equal(prepares(), 1); assert.equal(received.length, 8);
  assert.ok(received.every(value => value === prepared)); assert.equal(element('dashboard-results').hidden, false);
});

test('prepared models and CSV preserve incomplete-versus-zero output without aggregate rescans', () => {
  const { dashboard, prepared, prepares } = load();
  const category = dashboard.buildCategoryTrendModel(prepared, 'actual');
  assert.deepEqual([...category.datasets[0].data], [null, 0]);
  const payment = dashboard.buildPaymentMethodModel(prepared, 'actual');
  assert.deepEqual([...payment.datasets[0].data], [null, 0]);
  const csv = dashboard.buildCsv(prepared, 'actual');
  assert.match(csv, /"Category spending","Home","","","Incomplete"/);
  assert.match(csv, /"Category spending","Home","","0","Complete"/);
  assert.equal(prepares(), 0);
});

test('prepared coverage retains record counts and ignores tombstone-only months', () => {
  const { dashboard, prepared } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard.buildCoverageOverview(prepared))), {
    coverage: { selectedMonths: 2, financialActivityMonths: 2 },
    actualEntries: { enteredCount: 3, missingCount: 2, complete: false },
    plannedTotals: { income: 220, expenses: 60 }
  });
});
