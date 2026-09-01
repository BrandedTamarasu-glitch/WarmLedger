'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function month(paychecks, expenses, allocations = {}) {
  return {
    paychecks, expenses,
    allocations: { savings: 0, credit_card_debt: 0, investments: 0, ...allocations },
    suppressedOccurrences: []
  };
}

function paycheck(id, plannedAmount, actualAmount) {
  return { id, earnerId: 'earner-example-1', earner: 'Example Earner', plannedAmount, actualAmount,
    date: '', sourceTemplateId: null, occurrenceKey: null };
}

function expense(id, category, plannedAmount, actualAmount, paymentMethod) {
  return { id, categoryId: 'category-example-1', category, categoryItemId: 'item-example-1', name: id,
    date: '', paycheckAmounts: {}, plannedAmount, actualAmount, paymentMethod,
    sourceTemplateId: null, occurrenceKey: null };
}

function fixture() {
  const data = makeV3Budget();
  data.months = {
    '2026-01': month(
      [paycheck('jan-income', 1000, null), paycheck('jan-zero', 50, 0)],
      [expense('jan-home', 'Home', 400, 350, 'bank'), expense('jan-food', 'Food', 100, null, 'credit_card')],
      { savings: 100, credit_card_debt: 25 }
    ),
    '2026-02': month(
      [paycheck('feb-income', 1200, 1100)],
      [expense('feb-home', 'Home', 500, 0, 'bank'), expense('feb-fun', 'Fun', 50, 40, 'credit_card')],
      { savings: 150, investments: 20 }
    ),
    '2025-12': month([paycheck('old-income', 999999, 999999)], [], {})
  };
  return data;
}

function persistedFor(version) {
  const v3 = fixture();
  if (version === 3) return v3;
  const v4 = Schema.migrateV3ToV4ExactMoney(v3);
  if (version === 4) return v4;
  const v5 = Schema.migrateV4ToV5(v4);
  for (const saved of Object.values(v5.months)) {
    saved.paychecks.forEach(record => { record.cleared = false; });
    saved.expenses.forEach(record => { record.cleared = false; });
  }
  return v5;
}

function loaded(version = 3) {
  const raw = JSON.stringify(persistedFor(version));
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: () => { throw new Error('comparison used clock'); },
    uuid: () => { throw new Error('comparison used uuid'); } });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw, status: store.getStatus() };
}

function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertFrozen);
}

test('planned comparison returns the canonical immutable row model and comparison-minus-baseline deltas', () => {
  const { store } = loaded();
  const result = store.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.availableMonths, ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(result.rowModel.columns, ['Section', 'Metric', 'Baseline', 'Comparison', 'Delta', 'Status']);
  assert.deepEqual(result.rowModel.rows.map(item => [item.Section, item.Metric]), [
    ['Summary', 'Planned income'], ['Summary', 'Planned expenses'], ['Summary', 'Planned remainder'],
    ['Allocations', 'Planned Savings allocation'], ['Allocations', 'Planned Credit Card Debt allocation'],
    ['Allocations', 'Planned Investments allocation'], ['Categories', 'Food'], ['Categories', 'Fun'],
    ['Categories', 'Home'], ['Payment methods', 'Bank'], ['Payment methods', 'Credit Card'],
    ['Payment methods', 'Savings'], ['Payment methods', 'Investments']
  ]);
  assert.deepEqual(result.rowModel.rows.slice(0, 3).map(item => [item.Baseline, item.Comparison, item.Delta]),
    [[1050, 1200, 150], [500, 550, 50], [425, 480, 55]]);
  assert.deepEqual(result.rowModel.rows.find(item => item.Metric === 'Fun'), {
    Section: 'Categories', Metric: 'Fun', Baseline: 0, Comparison: 50, Delta: 50, Status: 'Complete',
    sectionKey: 'categories', dimensionKey: 'Fun', drilldownEligible: true
  });
  assert.deepEqual(result.rowModel.rows[0], { Section: 'Summary', Metric: 'Planned income', Baseline: 1050,
    Comparison: 1200, Delta: 150, Status: 'Complete', sectionKey: 'summary', dimensionKey: '',
    drilldownEligible: false });
  assert.deepEqual(result.rowModel.rows.find(item => item.Section === 'Payment methods' && item.Metric === 'Bank')
    .dimensionKey, 'bank');
  assertFrozen(result);
});

test('actual comparison propagates unresolved values narrowly while preserving entered and absent zero', () => {
  const { store } = loaded();
  const rows = store.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'actual' }).rowModel.rows;
  const byMetric = metric => rows.find(row => row.Metric === metric);
  assert.deepEqual(byMetric('Actual income'), { Section: 'Summary', Metric: 'Actual income', Baseline: null,
    Comparison: 1100, Delta: null, Status: 'Incomplete', sectionKey: 'summary', dimensionKey: '',
    drilldownEligible: false });
  assert.equal(byMetric('Actual expenses').Baseline, null);
  assert.equal(byMetric('Actual cash flow').Baseline, null);
  assert.deepEqual([byMetric('Food').Baseline, byMetric('Food').Comparison, byMetric('Food').Delta], [null, 0, null]);
  assert.deepEqual([byMetric('Fun').Baseline, byMetric('Fun').Comparison, byMetric('Fun').Delta], [0, 40, 40]);
  assert.deepEqual([byMetric('Home').Baseline, byMetric('Home').Comparison], [350, 0]);
  assert.equal(byMetric('Credit Card').Baseline, null);
  assert.equal(byMetric('Bank').Status, 'Complete');
  assert.ok(rows.filter(row => row.Section === 'Allocations').every(row => row.Status === 'Complete'));
});

test('invalid, incomplete, same, stale, and insufficient requests return detached status responses', () => {
  const { store } = loaded();
  const request = overrides => store.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned', ...overrides });
  assert.equal(request({ basis: 'combined' }).status, 'invalid-basis');
  assert.equal(request({ baselineMonth: '' }).status, 'incomplete');
  assert.equal(request({ comparisonMonth: '' }).status, 'incomplete');
  assert.equal(request({ comparisonMonth: '2026-01' }).status, 'same-month');
  assert.equal(request({ baselineMonth: '2026-1' }).status, 'missing-baseline');
  assert.equal(request({ baselineMonth: '2026-03' }).status, 'missing-baseline');
  assert.equal(request({ comparisonMonth: '2026-13' }).status, 'missing-comparison');
  const one = fixture(); one.months = { '2026-01': one.months['2026-01'] };
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(one) });
  const oneStore = createStore({ storage }); oneStore.load();
  assert.equal(oneStore.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' }).status,
    'insufficient-saved-months');
});

test('comparison is deterministic, detached, write-free, and schema-compatible across v3, v4, and v5', () => {
  let expected;
  for (const version of [3, 4, 5]) {
    const { store, storage, raw, status } = loaded(version);
    const first = store.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'actual' });
    const second = store.compareSavedMonths({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'actual' });
    assert.deepEqual(first, second);
    if (!expected) expected = first; else assert.deepEqual(first, expected);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(store.getStatus(), status);
    assert.deepEqual(storage.operations.filter(operation => operation.op !== 'getItem'), []);
    assert.throws(() => { first.rowModel.rows[0].Metric = 'changed'; }, TypeError);
  }
});

test('explanation validates exact current row identity and returns public expense contributors in saved order', () => {
  const { store, storage, raw, status } = loaded();
  const result = store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
    basis: 'planned', section: 'categories', dimensionKey: 'Home' });
  assert.equal(result.status, 'ready');
  assert.equal(result.rowLabel, 'Home');
  assert.deepEqual(result.counts, { totalCount: 2, returnedCount: 2, truncated: false });
  assert.deepEqual(result.baseline.records, [{
    kind: 'expense', recordId: 'jan-home', monthKey: '2026-01', name: 'jan-home', category: 'Home', date: '',
    plannedAmount: 400, actualAmount: 350, paymentMethod: 'bank', displayAmount: 400, displayStatus: 'Complete'
  }]);
  assert.deepEqual(result.comparison.records.map(record => record.recordId), ['feb-home']);
  assert.deepEqual(Object.keys(result.baseline.records[0]).sort(), [
    'actualAmount', 'category', 'date', 'displayAmount', 'displayStatus', 'kind', 'monthKey', 'name',
    'paymentMethod', 'plannedAmount', 'recordId'
  ]);
  assertFrozen(result);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getStatus(), status);
  assert.deepEqual(storage.operations.filter(operation => operation.op !== 'getItem'), []);
});

test('actual explanations preserve incomplete and entered-zero contributor semantics', () => {
  const { store } = loaded();
  const credit = store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
    basis: 'actual', section: 'payment_methods', dimensionKey: 'credit_card' });
  assert.deepEqual(credit.baseline.records.map(record => [record.recordId, record.displayAmount, record.displayStatus]),
    [['jan-food', null, 'Incomplete']]);
  assert.deepEqual(credit.comparison.records.map(record => [record.recordId, record.displayAmount, record.displayStatus]),
    [['feb-fun', 40, 'Complete']]);
  const bank = store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
    basis: 'actual', section: 'payment_methods', dimensionKey: 'bank' });
  assert.deepEqual(bank.comparison.records.map(record => [record.displayAmount, record.displayStatus]), [[0, 'Complete']]);
});

test('explanation rejects invalid requests and non-existent dimensional rows without scanning other months', () => {
  const { store } = loaded();
  const request = overrides => store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01',
    comparisonMonth: '2026-02', basis: 'planned', section: 'categories', dimensionKey: 'Home', ...overrides });
  assert.equal(request({ basis: 'combined' }).status, 'invalid-basis');
  assert.equal(request({ baselineMonth: '' }).status, 'missing-baseline');
  assert.equal(request({ baselineMonth: '2026-13' }).status, 'missing-baseline');
  assert.equal(request({ comparisonMonth: '' }).status, 'missing-comparison');
  assert.equal(request({ comparisonMonth: '2026-01' }).status, 'same-month');
  assert.equal(request({ section: 'summary' }).status, 'invalid-section');
  assert.equal(request({ section: 'categories', dimensionKey: 'Missing' }).status, 'row-not-found');
  assert.equal(request({ section: 'payment_methods', dimensionKey: 'cash' }).status, 'row-not-found');
});

function loadedWithContributorCounts(baselineCount, comparisonCount) {
  const data = fixture();
  data.months['2026-01'].expenses = Array.from({ length: baselineCount }, (_, index) =>
    expense(`baseline-${String(index).padStart(3, '0')}`, 'Home', index + 1, index, 'bank'));
  data.months['2026-02'].expenses = Array.from({ length: comparisonCount }, (_, index) =>
    expense(`comparison-${String(index).padStart(3, '0')}`, 'Home', index + 1, index, 'bank'));
  const raw = JSON.stringify(data);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: () => { throw new Error('explanation used clock'); },
    uuid: () => { throw new Error('explanation used uuid'); } });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw };
}

test('explanation applies the fair hard cap with truthful counts and canonical per-side order', () => {
  for (const [baselineCount, comparisonCount, baselineReturned, comparisonReturned] of [
    [150, 150, 100, 100], [10, 250, 10, 190], [250, 10, 190, 10], [0, 250, 0, 200]
  ]) {
    const { store, storage, raw } = loadedWithContributorCounts(baselineCount, comparisonCount);
    const result = store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
      basis: 'planned', section: 'categories', dimensionKey: 'Home' });
    assert.deepEqual([result.baseline.returnedCount, result.comparison.returnedCount],
      [baselineReturned, comparisonReturned]);
    assert.deepEqual(result.counts, { totalCount: baselineCount + comparisonCount,
      returnedCount: baselineReturned + comparisonReturned,
      truncated: baselineReturned + comparisonReturned < baselineCount + comparisonCount });
    assert.deepEqual(result.baseline.records.map(record => record.recordId),
      Array.from({ length: baselineReturned }, (_, index) => `baseline-${String(index).padStart(3, '0')}`));
    assert.deepEqual(result.comparison.records.map(record => record.recordId),
      Array.from({ length: comparisonReturned }, (_, index) => `comparison-${String(index).padStart(3, '0')}`));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.operations.filter(operation => operation.op !== 'getItem'), []);
  }
});

test('explanation is deterministic and schema-compatible across v3, v4, and v5', () => {
  let expected;
  for (const version of [3, 4, 5]) {
    const { store, storage, raw } = loaded(version);
    const request = { baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'actual',
      section: 'payment_methods', dimensionKey: 'credit_card' };
    const first = store.explainSavedMonthComparisonRow(request);
    const second = store.explainSavedMonthComparisonRow(request);
    assert.deepEqual(first, second);
    if (!expected) expected = first; else assert.deepEqual(first, expected);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(storage.operations.filter(operation => operation.op !== 'getItem'), []);
  }
});
