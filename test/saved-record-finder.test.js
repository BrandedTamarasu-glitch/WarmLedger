'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, SNAPSHOT_PREFIX, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function expectCode(expected, action) {
  assert.throws(action, error => error instanceof StoreError && error.code === expected);
}

function month(paychecks, expenses) {
  return {
    paychecks, expenses,
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
    suppressedOccurrences: []
  };
}

function paycheck(id, earner, date, plannedAmount, actualAmount) {
  return {
    id, earnerId: 'earner-example-1', earner, plannedAmount, actualAmount, date,
    sourceTemplateId: null, occurrenceKey: null
  };
}

function expense(id, name, category, date, plannedAmount, actualAmount, paymentMethod = 'bank') {
  return {
    id, categoryId: 'category-example-1', category, categoryItemId: 'item-example-1', name, date,
    paycheckAmounts: {}, plannedAmount, actualAmount, paymentMethod,
    sourceTemplateId: null, occurrenceKey: null
  };
}

function finderV3() {
  const data = makeV3Budget();
  data.categories[0].name = 'Archived catalog only needle';
  data.categories[0].archived = true;
  data.templates.income.push({
    id: 'template-id-only-needle', name: 'Template only needle', earnerId: 'earner-example-1',
    plannedAmount: 1, enabled: true, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }
  });
  data.months = {
    '2026-03': month(
      [paycheck('income-march', 'ÄLPHA March', '2026-03-05', 70.07, 0)],
      [expense('expense-march', 'Other', 'Utilities', '2026-03-06', 80.08, null)]
    ),
    '2026-01': month([
      paycheck('income-route-id-only-needle', 'ALPHA .* [One]', '', 12.34, null),
      paycheck('income-january-two', 'Second alpha', '2026-01-15', 0, 0)
    ], [
      expense('expense-january-one', 'Alpha rent', 'Home alpha', '', 56.78, 0, 'credit_card'),
      expense('expense-january-two', 'Other', 'Alpha category', '2026-01-20', 90.12, null)
    ]),
    '2026-02': month(
      [paycheck('income-february', 'Beta alpha', '2026-02-01', 23.45, 23.45)],
      [expense('expense-february', 'Alpha food', 'Food', '2026-02-02', 34.56, 0)]
    )
  };
  Schema.validateV3(data);
  return data;
}

function versions() {
  const v3 = finderV3();
  const v4 = Schema.migrateV3ToV4ExactMoney(v3);
  const v5 = Schema.migrateV4ToV5(v4);
  Schema.validateV5(v5);
  return [v3, v4, v5];
}

function ready(data, extraStorage = {}) {
  const raw = JSON.stringify(data);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw, ...extraStorage });
  let clockCalls = 0;
  let uuidCalls = 0;
  const store = createStore({
    storage,
    now: () => { clockCalls += 1; throw new Error('finder used the clock'); },
    uuid: () => { uuidCalls += 1; throw new Error('finder generated an identifier'); }
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw, clockCalls: () => clockCalls, uuidCalls: () => uuidCalls };
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === 'object') Object.values(value).forEach(assertDeepFrozen);
}

test('request validation is recovery-first, rejects unknown keys, and applies only the frozen defaults', () => {
  const { store } = ready(finderV3());
  for (const invalid of [undefined, null, [], {}, { query: 'x', extra: true }]) {
    expectCode('INVALID_SAVED_RECORD_SEARCH', () => store.findSavedRecords(invalid));
  }
  const symbolRequest = { query: 'x' };
  symbolRequest[Symbol('private')] = true;
  expectCode('INVALID_SAVED_RECORD_SEARCH', () => store.findSavedRecords(symbolRequest));
  for (const query of [null, 1, '', '   ', 'x'.repeat(121)]) {
    expectCode('INVALID_SAVED_RECORD_QUERY', () => store.findSavedRecords({ query }));
  }
  for (const kind of [null, '', 'paycheck', 'expenses', 'ALL', 1]) {
    expectCode('INVALID_SAVED_RECORD_KIND', () => store.findSavedRecords({ query: 'x', kind }));
  }
  for (const request of [
    { query: 'x', fromMonth: undefined }, { query: 'x', toMonth: 202601 },
    { query: 'x', fromMonth: '2026-1' }, { query: 'x', toMonth: '2026-13' }
  ]) expectCode('INVALID_MONTH', () => store.findSavedRecords(request));
  expectCode('INVALID_MONTH_RANGE', () => store.findSavedRecords({
    query: 'x', fromMonth: '2026-03', toMonth: '2026-02'
  }));
  for (const limit of [null, 0, 201, 1.5, '2', NaN]) {
    expectCode('INVALID_SAVED_RECORD_LIMIT', () => store.findSavedRecords({ query: 'x', limit }));
  }

  const defaults = store.findSavedRecords({ query: ' alpha ' });
  assert.equal(defaults.query, 'alpha');
  assert.equal(defaults.normalizedQuery, 'alpha');
  assert.deepEqual(defaults.filters, { kind: 'all', fromMonth: null, toMonth: null });
  assert.equal(Object.hasOwn(defaults.filters, 'limit'), false);

  const recovery = createStore({ storage: new MemoryStorage({ [STORAGE_KEY]: '{damaged' }) });
  assert.equal(recovery.load().state, 'recovery-required');
  expectCode('RECOVERY_REQUIRED', () => recovery.findSavedRecords(null));
});

test('literal lower-case includes matching is hostile-text safe and reports fixed matched fields', () => {
  const { store } = ready(finderV3());
  const alpha = store.findSavedRecords({ query: '  AlPhA  ' });
  assert.equal(alpha.query, 'AlPhA');
  assert.equal(alpha.normalizedQuery, 'alpha');
  assert.equal(alpha.totalMatchCount, 6);
  assert.deepEqual(alpha.results.map(result => [result.kind, result.monthKey, result.recordId]), [
    ['income', '2026-01', 'income-route-id-only-needle'],
    ['income', '2026-01', 'income-january-two'],
    ['expense', '2026-01', 'expense-january-one'],
    ['expense', '2026-01', 'expense-january-two'],
    ['income', '2026-02', 'income-february'],
    ['expense', '2026-02', 'expense-february']
  ]);
  assert.deepEqual(alpha.results[2].matchedFields, ['name', 'category']);
  assert.deepEqual(alpha.results[3].matchedFields, ['category']);
  assert.deepEqual(store.findSavedRecords({ query: '.*' }).results.map(result => result.recordId),
    ['income-route-id-only-needle']);
  assert.deepEqual(store.findSavedRecords({ query: '[' }).results.map(result => result.recordId),
    ['income-route-id-only-needle']);
  assert.deepEqual(store.findSavedRecords({ query: 'älpha' }).results.map(result => result.recordId),
    ['income-march']);
});

test('kind and inclusive month filters preserve canonical month, kind, and saved-array ordering', () => {
  const { store } = ready(finderV3());
  const income = store.findSavedRecords({
    query: 'alpha', kind: 'income', fromMonth: '2026-01', toMonth: '2026-02'
  });
  assert.deepEqual(income.filters, { kind: 'income', fromMonth: '2026-01', toMonth: '2026-02' });
  assert.deepEqual(income.results.map(result => result.recordId), [
    'income-route-id-only-needle', 'income-january-two', 'income-february'
  ]);
  const expenses = store.findSavedRecords({ query: 'alpha', kind: 'expense', fromMonth: '2026-02' });
  assert.deepEqual(expenses.results.map(result => result.recordId), ['expense-february']);
  const upperBound = store.findSavedRecords({ query: 'alpha', toMonth: '2026-01' });
  assert.deepEqual(upperBound.results.map(result => result.recordId), [
    'income-route-id-only-needle', 'income-january-two', 'expense-january-one', 'expense-january-two'
  ]);
});

test('limit truncates only returned results while retaining the full match count', () => {
  const { store } = ready(finderV3());
  const result = store.findSavedRecords({ query: 'alpha', limit: 3 });
  assert.equal(result.totalMatchCount, 6);
  assert.equal(result.returnedCount, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results.map(item => item.recordId), [
    'income-route-id-only-needle', 'income-january-two', 'expense-january-one'
  ]);
  const full = store.findSavedRecords({ query: 'alpha', limit: 6 });
  assert.equal(full.returnedCount, 6);
  assert.equal(full.truncated, false);
});

test('results expose only frozen presentation fields and preserve null, entered zero, and decimal-facing values', () => {
  const { store } = ready(finderV3());
  const result = store.findSavedRecords({ query: 'alpha', limit: 1 });
  assertDeepFrozen(result);
  assert.deepEqual(Object.keys(result).sort(), [
    'filters', 'normalizedQuery', 'query', 'results', 'returnedCount', 'totalMatchCount', 'truncated'
  ]);
  assert.deepEqual(Object.keys(result.results[0]).sort(), [
    'actualAmount', 'date', 'kind', 'matchedFields', 'monthKey', 'plannedAmount',
    'primaryLabel', 'recordId', 'secondaryLabel'
  ]);
  assert.deepEqual(result.results[0], {
    kind: 'income', monthKey: '2026-01', recordId: 'income-route-id-only-needle',
    primaryLabel: 'ALPHA .* [One]', secondaryLabel: 'Paycheck', date: '',
    plannedAmount: 12.34, actualAmount: null, matchedFields: ['earner']
  });
  const enteredZero = store.findSavedRecords({ query: 'second alpha' }).results[0];
  assert.equal(enteredZero.plannedAmount, 0);
  assert.equal(enteredZero.actualAmount, 0);
  const expenseResult = store.findSavedRecords({ query: 'alpha rent' }).results[0];
  assert.deepEqual(Object.keys(expenseResult).sort(), [
    'actualAmount', 'date', 'kind', 'matchedFields', 'monthKey', 'paymentMethod',
    'plannedAmount', 'primaryLabel', 'recordId', 'secondaryLabel'
  ]);
  assert.equal(expenseResult.paymentMethod, 'credit_card');
  assert.throws(() => { result.results[0].primaryLabel = 'changed'; }, TypeError);
});

test('IDs, amounts, dates, methods, templates, catalog text, funding, snapshots, and cleared state stay unsearchable', () => {
  const snapshotKey = `${SNAPSHOT_PREFIX}search-source-leak`;
  const { store } = ready(finderV3(), { [snapshotKey]: JSON.stringify({ note: 'snapshot only needle' }) });
  for (const excluded of [
    'route-id-only-needle', '12.34', '2026-01-15', 'credit_card', 'template only needle',
    'template-id-only-needle', 'archived catalog only needle', 'snapshot only needle', 'false', 'true'
  ]) {
    assert.equal(store.findSavedRecords({ query: excluded }).totalMatchCount, 0, excluded);
  }
});

test('resident v3, v4, and v5 return byte-equivalent decimal-facing results without cents or clearing leakage', () => {
  const projections = versions().map(data => ready(data).store.findSavedRecords({ query: 'alpha' }));
  assert.deepEqual(projections[1], projections[0]);
  assert.deepEqual(projections[2], projections[0]);
  assert.equal(projections[2].results.some(result => Object.hasOwn(result, 'cleared')), false);
  assert.equal(projections[2].results[0].plannedAmount, 12.34);
  assert.notEqual(projections[2].results[0].plannedAmount, 1234);
});

test('search is deterministic, detached, and instrumentably free of writes, snapshots, clocks, UUIDs, generation, and memory mutation', () => {
  const { store, storage, raw, clockCalls, uuidCalls } = ready(versions()[2]);
  const statusBefore = store.getStatus();
  const memoryBefore = store.getData();
  const first = store.findSavedRecords({ query: 'alpha', limit: 5 });
  const second = store.findSavedRecords({ query: 'alpha', limit: 5 });
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.results, first.results);
  assert.notStrictEqual(second.results[0], first.results[0]);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getData(), memoryBefore);
  assert.deepEqual(store.getStatus(), statusBefore);
  assert.equal(clockCalls(), 0);
  assert.equal(uuidCalls(), 0);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(keys.some(key => key.startsWith(SNAPSHOT_PREFIX)), false);
});
