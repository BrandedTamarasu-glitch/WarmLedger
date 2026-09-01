'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, SNAPSHOT_PREFIX, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function expectCode(expected, action) {
  assert.throws(action, error => error instanceof StoreError && error.code === expected);
}

function savedMonth(monthKey, options = {}) {
  const paycheckId = `paycheck-${monthKey}`;
  const payDate = Object.hasOwn(options, 'payDate') ? options.payDate : `${monthKey}-05`;
  const expenseDate = Object.hasOwn(options, 'expenseDate') ? options.expenseDate : `${monthKey}-10`;
  const payActual = Object.hasOwn(options, 'payActual') ? options.payActual : 100;
  const expenseActual = Object.hasOwn(options, 'expenseActual') ? options.expenseActual : 40;
  const assigned = Object.hasOwn(options, 'assigned') ? options.assigned : 40;
  return {
    paychecks: [{
      id: paycheckId, earnerId: 'earner-example-1', earner: 'Example Earner',
      plannedAmount: 100, actualAmount: payActual, date: payDate,
      sourceTemplateId: null, occurrenceKey: null
    }],
    expenses: [{
      id: `expense-${monthKey}`, categoryId: 'category-example-1', category: 'Home',
      categoryItemId: 'item-example-1', name: 'Rent', date: expenseDate,
      paycheckAmounts: { [paycheckId]: assigned }, plannedAmount: 40,
      actualAmount: expenseActual, paymentMethod: 'bank', sourceTemplateId: null, occurrenceKey: null
    }],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
    suppressedOccurrences: []
  };
}

function emptyMonth() {
  return {
    paychecks: [], expenses: [],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
    suppressedOccurrences: []
  };
}

function navigationV3() {
  const data = makeV3Budget();
  data.templates.income.push({
    id: 'ignored-recurring-template', name: 'Ignored recurring work', earnerId: 'earner-example-1',
    plannedAmount: 1, enabled: true, archived: false, startDate: '2026-06-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }
  });
  data.months = {
    '2026-07': savedMonth('2026-07', { payActual: null, payDate: '', assigned: 0 }),
    '2026-06': savedMonth('2026-06', {
      payActual: null, payDate: '', expenseActual: 0, expenseDate: '', assigned: 0
    }),
    '2026-05': savedMonth('2026-05', { payActual: 0, expenseActual: 0 }),
    '2026-04': emptyMonth(),
    '2026-03': savedMonth('2026-03', { payActual: 0, expenseActual: 0, expenseDate: '' }),
    '2026-01': savedMonth('2026-01', { payActual: 0, expenseActual: 0, assigned: 39.98 }),
    '2025-06': savedMonth('2025-06', { payActual: null, payDate: '' })
  };
  Schema.validateV3(data);
  return data;
}

function versions() {
  const v3 = navigationV3();
  const v4 = Schema.migrateV3ToV4ExactMoney(v3);
  const v5 = Schema.migrateV4ToV5(v4);
  for (const [monthKey, month] of Object.entries(v5.months)) {
    const cleared = !['2026-06', '2025-06'].includes(monthKey);
    month.paychecks.forEach(record => { record.cleared = cleared; });
    month.expenses.forEach(record => { record.cleared = cleared; });
  }
  Schema.validateV5(v5);
  return { v3, v4, v5 };
}

function ready(data) {
  const raw = JSON.stringify(data);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  let clockCalls = 0;
  let uuidCalls = 0;
  const store = createStore({
    storage,
    now: () => { clockCalls += 1; throw new Error('review navigation used the clock'); },
    uuid: () => { uuidCalls += 1; throw new Error('review navigation generated an identifier'); }
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw, clockCalls: () => clockCalls, uuidCalls: () => uuidCalls };
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === 'object') Object.values(value).forEach(assertDeepFrozen);
}

test('v5 next steps expose overlapping saved facts in the fixed symbolic route order', () => {
  const { store } = ready(versions().v5);
  assert.deepEqual(store.getNextReviewSteps('2026-06'), {
    monthKey: '2026-06', exists: true, empty: false,
    availability: { manualClearing: true }, status: 'attention',
    steps: [
      { kind: 'recurring', count: 1, label: 'Preview recurring items', routeTarget: 'recurring-preview' },
      { kind: 'dates', count: 2, label: 'Add record dates', routeTarget: 'budget-dates' },
      { kind: 'actuals', count: 1, label: 'Enter actual amounts', routeTarget: 'budget-actuals' },
      { kind: 'funding', count: 1, label: 'Review paycheck funding', routeTarget: 'budget-funding' },
      { kind: 'manual-clearing', count: 2, label: 'Review manual cleared marks', routeTarget: 'manual-cleared-checklist' }
    ],
    limitation: 'Local saved-data review aid only—not payment confirmation, bank verification, reconciliation, or month close.'
  });
});

test('next steps distinguish absent, saved-empty, attention, and no-current-attention states', () => {
  const { store } = ready(versions().v5);
  assert.deepEqual(store.getNextReviewSteps('2026-02'), {
    monthKey: '2026-02', exists: false, empty: false,
    availability: { manualClearing: true }, status: 'no-saved-month', steps: [],
    limitation: 'Local saved-data review aid only—not payment confirmation, bank verification, reconciliation, or month close.'
  });
  assert.equal(store.getNextReviewSteps('2026-04').status, 'empty-month');
  assert.equal(store.getNextReviewSteps('2026-04').empty, true);
  assert.equal(store.getNextReviewSteps('2026-05').status, 'no-current-attention');
  assert.deepEqual(store.getNextReviewSteps('2026-05').steps, []);
  assert.deepEqual(store.getNextReviewSteps('2026-03').steps.map(step => step.kind), ['dates']);
  assert.deepEqual(store.getNextReviewSteps('2026-01').steps.map(step => step.kind), ['funding']);
});

test('v3 and v4 keep manual clearing unavailable and otherwise preserve exact step facts', () => {
  const { v3, v4 } = versions();
  const projections = [v3, v4].map(data => ready(data).store.getNextReviewSteps('2026-06'));
  assert.deepEqual(projections[1], projections[0]);
  assert.equal(projections[0].availability.manualClearing, false);
  assert.deepEqual(projections[0].steps.map(step => [step.kind, step.count]), [
    ['recurring', 1], ['dates', 2], ['actuals', 1], ['funding', 1]
  ]);
  assert.equal(projections[0].steps.some(step => step.kind === 'manual-clearing'), false);
});

test('queue scans only saved months in the inclusive descending calendar window', () => {
  const { store } = ready(versions().v5);
  const six = store.getMonthReviewQueue({ anchorMonth: '2026-06', lookbackMonths: 6 });
  assert.deepEqual(six.coverage, {
    savedMonthCount: 5, emptyMonthCount: 1, monthsWithAttentionCount: 3, savedMonthsClearCount: 1
  });
  assert.deepEqual(six.items.map(item => item.monthKey), ['2026-06', '2026-03', '2026-01']);
  assert.deepEqual(six.emptyMonths, ['2026-04']);
  assert.equal(six.items.some(item => item.attentionKinds.includes('recurring')), false);
  assert.equal(six.items.some(item => item.monthKey === '2026-07'), false);
  assert.deepEqual(six.items[0], {
    monthKey: '2026-06', exists: true, empty: false,
    counts: { actualsMissing: 1, datesMissing: 2, fundingIssues: 1, notManuallyCleared: 2 },
    availability: { manualClearing: true },
    attentionKinds: ['actuals', 'dates', 'funding', 'manual-clearing'],
    allApplicableFactsClear: false
  });

  const defaults = store.getMonthReviewQueue({ anchorMonth: '2026-06' });
  assert.equal(defaults.lookbackMonths, 12);
  assert.equal(defaults.coverage.savedMonthCount, 5);
  const twentyFour = store.getMonthReviewQueue({ anchorMonth: '2026-06', lookbackMonths: 24 });
  assert.deepEqual(twentyFour.items.map(item => item.monthKey), [
    '2026-06', '2026-03', '2026-01', '2025-06'
  ]);
  assert.deepEqual(twentyFour.coverage, {
    savedMonthCount: 6, emptyMonthCount: 1, monthsWithAttentionCount: 4, savedMonthsClearCount: 1
  });
});

test('queue v3/v4 parity uses null rather than synthesized manual-clearing counts', () => {
  const { v3, v4 } = versions();
  const queues = [v3, v4].map(data => ready(data).store.getMonthReviewQueue({
    anchorMonth: '2026-06', lookbackMonths: 6
  }));
  assert.deepEqual(queues[1], queues[0]);
  for (const item of queues[0].items) {
    assert.equal(item.counts.notManuallyCleared, null);
    assert.equal(item.availability.manualClearing, false);
    assert.equal(item.attentionKinds.includes('manual-clearing'), false);
  }
  assert.deepEqual(queues[0].items[0].attentionKinds, ['actuals', 'dates', 'funding']);
});

test('queue validation is strict and recovery gates malformed requests first', () => {
  const { store } = ready(versions().v5);
  for (const request of [undefined, null, [], {}, { anchorMonth: '2026-06', extra: true }, new Date()]) {
    expectCode('INVALID_MONTH_REVIEW_QUEUE', () => store.getMonthReviewQueue(request));
  }
  const symbolRequest = { anchorMonth: '2026-06' };
  symbolRequest[Symbol('private')] = true;
  expectCode('INVALID_MONTH_REVIEW_QUEUE', () => store.getMonthReviewQueue(symbolRequest));
  for (const anchorMonth of [null, '2026-6', '2026-00', '2026-13', 'bad']) {
    expectCode('INVALID_MONTH', () => store.getMonthReviewQueue({ anchorMonth }));
    expectCode('INVALID_MONTH', () => store.getNextReviewSteps(anchorMonth));
  }
  for (const lookbackMonths of [undefined, null, 0, 5, 18, '12']) {
    expectCode('INVALID_MONTH_REVIEW_LOOKBACK', () => store.getMonthReviewQueue({
      anchorMonth: '2026-06', lookbackMonths
    }));
  }
  const nullPrototype = Object.assign(Object.create(null), { anchorMonth: '2026-06', lookbackMonths: 6 });
  assert.equal(store.getMonthReviewQueue(nullPrototype).lookbackMonths, 6);

  const recovery = createStore({ storage: new MemoryStorage({ [STORAGE_KEY]: '{damaged' }) });
  assert.equal(recovery.load().state, 'recovery-required');
  expectCode('RECOVERY_REQUIRED', () => recovery.getMonthReviewQueue(null));
  expectCode('RECOVERY_REQUIRED', () => recovery.getNextReviewSteps('bad'));
});

test('funding uses the existing tolerance and null versus entered zero remains exact', () => {
  const data = navigationV3();
  data.months['2026-03'].expenses[0].date = '2026-03-10';
  data.months['2026-03'].expenses[0].paycheckAmounts = { 'paycheck-2026-03': 39.995 };
  Schema.validateV3(data);
  const { store } = ready(data);
  assert.equal(store.getNextReviewSteps('2026-03').status, 'no-current-attention');
  assert.equal(store.getNextReviewSteps('2026-03').steps.length, 0);
  const june = store.getNextReviewSteps('2026-06');
  assert.equal(june.steps.find(step => step.kind === 'actuals').count, 1);
  assert.equal(june.steps.find(step => step.kind === 'dates').count, 2);
});

test('queue and steps are deterministic, detached, deeply frozen, and instrumentably no-write', () => {
  const { store, storage, raw, clockCalls, uuidCalls } = ready(versions().v5);
  const statusBefore = store.getStatus();
  const memoryBefore = store.getData();
  const first = store.getMonthReviewQueue({ anchorMonth: '2026-06', lookbackMonths: 6 });
  const second = store.getMonthReviewQueue({ anchorMonth: '2026-06', lookbackMonths: 6 });
  const steps = store.getNextReviewSteps('2026-06');
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.items, first.items);
  assertDeepFrozen(first);
  assertDeepFrozen(steps);
  assert.throws(() => { first.coverage.savedMonthCount = 99; }, TypeError);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getData(), memoryBefore);
  assert.deepEqual(store.getStatus(), statusBefore);
  assert.equal(clockCalls(), 0);
  assert.equal(uuidCalls(), 0);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(keys.some(key => key.startsWith(SNAPSHOT_PREFIX)), false);
});
