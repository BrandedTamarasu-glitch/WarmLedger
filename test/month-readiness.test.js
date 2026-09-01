'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, SNAPSHOT_PREFIX, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function expectCode(expected, action) {
  assert.throws(action, error => error instanceof StoreError && error.code === expected);
}

function v4Data(overrides) {
  const data = makeV3Budget();
  overrides?.(data);
  return Schema.migrateV3ToV4ExactMoney(data);
}

function v5Data(overrides) {
  const persisted = Schema.migrateV4ToV5(v4Data(overrides));
  for (const month of Object.values(persisted.months)) {
    month.paychecks.forEach(record => { record.cleared = true; });
    month.expenses.forEach(record => { record.cleared = true; });
  }
  Schema.validateV5(persisted);
  return persisted;
}

function ready(data, adapters = {}) {
  const raw = JSON.stringify(data);
  const storage = adapters.storage || new MemoryStorage({ [STORAGE_KEY]: raw });
  let clockCalls = 0;
  let uuidCalls = 0;
  const store = createStore({
    storage,
    now: adapters.now || (() => { clockCalls += 1; throw new Error('readiness used the clock'); }),
    uuid: adapters.uuid || (() => { uuidCalls += 1; throw new Error('readiness generated an identifier'); })
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw, clockCalls: () => clockCalls, uuidCalls: () => uuidCalls };
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === 'object') Object.values(value).forEach(assertDeepFrozen);
}

function neutral(monthKey) {
  return {
    monthKey, exists: false, available: false,
    unavailableReason: 'manual-clearing-format-required',
    status: 'unavailable', stateLabel: 'Open for editing',
    counts: { recordCount: 0, actualsMissing: 0, datesMissing: 0, notManuallyCleared: 0 },
    checks: { actualsComplete: false, datesComplete: false,
      manualClearingComplete: false, checklistComplete: false }
  };
}

test('resident v3 and v4 return the same neutral unavailable projection without migration or writes', () => {
  for (const persisted of [makeV3Budget(), v4Data()]) {
    const { store, storage, raw, clockCalls, uuidCalls } = ready(persisted);
    const statusBefore = store.getStatus();
    const memoryBefore = store.getData();
    const result = store.getMonthReadiness('2026-01');
    assert.deepEqual(result, neutral('2026-01'));
    assertDeepFrozen(result);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.deepEqual(store.getData(), memoryBefore);
    assert.deepEqual(store.getStatus(), statusBefore);
    assert.equal(clockCalls(), 0);
    assert.equal(uuidCalls(), 0);
    assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    assert.equal(keys.some(key => key.startsWith(SNAPSHOT_PREFIX)), false);
  }
});

test('v5 distinguishes an absent month from a saved empty month and neither is complete', () => {
  const persisted = v5Data(data => {
    data.months['2026-02'] = {
      paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
      suppressedOccurrences: []
    };
  });
  const { store } = ready(persisted);
  assert.deepEqual(store.getMonthReadiness('2026-03'), {
    monthKey: '2026-03', exists: false, available: true, unavailableReason: null,
    status: 'no-saved-month', stateLabel: 'Open for editing',
    counts: { recordCount: 0, actualsMissing: 0, datesMissing: 0, notManuallyCleared: 0 },
    checks: { actualsComplete: false, datesComplete: false,
      manualClearingComplete: false, checklistComplete: false }
  });
  assert.deepEqual(store.getMonthReadiness('2026-02'), {
    monthKey: '2026-02', exists: true, available: true, unavailableReason: null,
    status: 'empty-month', stateLabel: 'Open for editing',
    counts: { recordCount: 0, actualsMissing: 0, datesMissing: 0, notManuallyCleared: 0 },
    checks: { actualsComplete: false, datesComplete: false,
      manualClearingComplete: false, checklistComplete: false }
  });
});

test('v5 counts every overlapping actual, date, and cleared requirement across exhaustive record combinations', () => {
  const persisted = v5Data(data => {
    const month = data.months['2026-01'];
    month.paychecks = [];
    month.expenses = [];
    for (let combination = 0; combination < 8; combination += 1) {
      const actualAmount = combination & 1 ? 0 : null;
      const date = combination & 2 ? '2026-01-15' : '';
      month.paychecks.push({
        id: `paycheck-combination-${combination}`, earnerId: 'earner-example-1', earner: 'Example Earner',
        plannedAmount: 1, actualAmount, date, sourceTemplateId: null, occurrenceKey: null
      });
      month.expenses.push({
        id: `expense-combination-${combination}`, categoryId: 'category-example-1', category: 'Home',
        categoryItemId: 'item-example-1', name: `Expense ${combination}`, date, paycheckAmounts: {},
        plannedAmount: 1, actualAmount, paymentMethod: 'bank', sourceTemplateId: null, occurrenceKey: null
      });
    }
  });
  persisted.months['2026-01'].paychecks.forEach((record, index) => { record.cleared = Boolean(index & 4); });
  persisted.months['2026-01'].expenses.forEach((record, index) => { record.cleared = Boolean(index & 4); });
  Schema.validateV5(persisted);
  const { store } = ready(persisted);
  const result = store.getMonthReadiness('2026-01');
  assert.deepEqual(result.counts, {
    recordCount: 16, actualsMissing: 8, datesMissing: 8, notManuallyCleared: 8
  });
  assert.deepEqual(result.checks, {
    actualsComplete: false, datesComplete: false,
    manualClearingComplete: false, checklistComplete: false
  });
  assert.equal(result.status, 'needs-attention');
  const checklist = store.getClearedChecklist('2026-01');
  assert.equal(checklist.counts.unclearedCount, result.counts.notManuallyCleared);
  assert.equal(checklist.counts.eligibleCount, 4);
});

test('each null-or-zero, blank-or-saved-date, and cleared combination derives independent checks for both record kinds', () => {
  for (const kind of ['income', 'expense']) {
    for (let combination = 0; combination < 8; combination += 1) {
      const actualEntered = Boolean(combination & 1);
      const dateEntered = Boolean(combination & 2);
      const manuallyCleared = Boolean(combination & 4);
      const persisted = v5Data(data => {
        const month = data.months['2026-01'];
        if (kind === 'income') month.expenses = [];
        else {
          month.paychecks = [];
          month.expenses[0].paycheckAmounts = {};
        }
      });
      const month = persisted.months['2026-01'];
      const record = kind === 'income' ? month.paychecks[0] : month.expenses[0];
      record.actualAmount = actualEntered ? 0 : null;
      record.date = dateEntered ? '2026-01-15' : '';
      record.cleared = manuallyCleared;
      Schema.validateV5(persisted);
      const result = ready(persisted).store.getMonthReadiness('2026-01');
      assert.deepEqual(result.counts, {
        recordCount: 1,
        actualsMissing: actualEntered ? 0 : 1,
        datesMissing: dateEntered ? 0 : 1,
        notManuallyCleared: manuallyCleared ? 0 : 1
      }, `${kind} combination ${combination}`);
      assert.deepEqual(result.checks, {
        actualsComplete: actualEntered,
        datesComplete: dateEntered,
        manualClearingComplete: manuallyCleared,
        checklistComplete: actualEntered && dateEntered && manuallyCleared
      }, `${kind} combination ${combination}`);
      assert.equal(result.status,
        actualEntered && dateEntered && manuallyCleared ? 'checklist-complete' : 'needs-attention');
    }
  }
});

test('entered zero is complete and unrelated funding, planning, allocations, and templates do not affect readiness', () => {
  const persisted = v5Data(data => {
    const month = data.months['2026-01'];
    month.paychecks[0].actualAmount = 0;
    month.paychecks[0].plannedAmount = 999999;
    month.expenses[0].actualAmount = 0;
    month.expenses[0].date = '2026-01-31';
    month.expenses[0].plannedAmount = 1;
    month.expenses[0].paycheckAmounts = {};
    month.allocations = { savings: 123, credit_card_debt: 456, investments: 789 };
    data.templates.income.push({
      id: 'irrelevant-template', name: 'Irrelevant', earnerId: 'earner-example-1', plannedAmount: 1,
      enabled: true, archived: false, startDate: '2026-01-01', endDate: null,
      recurrence: { cadence: 'monthly', day: 1 }
    });
  });
  const { store } = ready(persisted);
  const result = store.getMonthReadiness('2026-01');
  assert.deepEqual(result.counts, {
    recordCount: 2, actualsMissing: 0, datesMissing: 0, notManuallyCleared: 0
  });
  assert.deepEqual(result.checks, {
    actualsComplete: true, datesComplete: true,
    manualClearingComplete: true, checklistComplete: true
  });
  assert.equal(result.status, 'checklist-complete');
});

test('readiness reads are deterministic, detached, recursively frozen, and instrumentably side-effect free', () => {
  const persisted = v5Data(data => { data.months['2026-01'].expenses[0].date = '2026-01-31'; });
  const { store, storage, raw, clockCalls, uuidCalls } = ready(persisted);
  const statusBefore = store.getStatus();
  const memoryBefore = store.getData();
  const first = store.getMonthReadiness('2026-01');
  const second = store.getMonthReadiness('2026-01');
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.counts, first.counts);
  assert.notStrictEqual(second.checks, first.checks);
  assertDeepFrozen(first);
  assert.throws(() => { first.counts.recordCount = 99; }, TypeError);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getData(), memoryBefore);
  assert.deepEqual(store.getStatus(), statusBefore);
  assert.equal(clockCalls(), 0);
  assert.equal(uuidCalls(), 0);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(keys.some(key => key.startsWith(SNAPSHOT_PREFIX)), false);
});

test('invalid months and recovery gating retain the Store contracts', () => {
  const { store } = ready(v5Data());
  for (const invalid of [null, '', '2026-1', '2026-00', '2026-13', '10000-01', 'not-a-month']) {
    expectCode('INVALID_MONTH', () => store.getMonthReadiness(invalid));
  }

  const recovery = createStore({ storage: new MemoryStorage({ [STORAGE_KEY]: '{damaged' }) });
  assert.equal(recovery.load().state, 'recovery-required');
  expectCode('RECOVERY_REQUIRED', () => recovery.getMonthReadiness('2026-01'));
  expectCode('RECOVERY_REQUIRED', () => recovery.getMonthReadiness('bad'));
});
