'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, WRITE_LOCK_KEY,
  StoreError, createStore } = require('../js/data.js');
const { MemoryStorage, makeClock, makeV3Budget } = require('./helpers.js');

function loaded({ storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) }),
  clock = makeClock(), prefix = 'id' } = {}) {
  let sequence = 0;
  const store = createStore({ storage, now: clock, uuid: () => `${prefix}-${++sequence}` });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, clock };
}

function code(expected, callback) {
  assert.throws(callback, error => error instanceof StoreError && error.code === expected);
}

test('semantic no-ops and passive Store paths perform no writes and never acquire the lock', () => {
  const { store, storage } = loaded();
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1200 });
  store.compareSavedMonths({});
  store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
    basis: 'planned', section: 'categories', dimensionKey: 'Home' });
  store.prepareDashboardRange({ monthKeys: ['2026-01'], basis: 'planned' });
  store.previewLocalDataPurge();
  assert.equal(storage.operations.some(item => item.op !== 'getItem' && item.op !== 'key'), false);
  assert.equal(storage.operations.some(item => item.key === WRITE_LOCK_KEY && item.op !== 'getItem'), false);
});

test('an unexpired foreign lock rejects atomically while an expired lock can be claimed', () => {
  const first = loaded();
  const before = first.store.getData();
  first.storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ ownerId: 'other', expiresAt: first.clock().getTime() + 1000 }));
  first.storage.operations.length = 0;
  code('STORE_BUSY', () => first.store.updateAllocation('2026-01', 'savings', 401));
  assert.deepEqual(first.store.getData(), before);
  assert.equal(first.storage.operations.some(item => item.op === 'setItem' && item.key === STORAGE_KEY), false);

  first.storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ ownerId: 'other', expiresAt: first.clock().getTime() - 1 }));
  first.storage.operations.length = 0;
  first.store.updateAllocation('2026-01', 'savings', 401);
  assert.equal(first.store.getMonth('2026-01').allocations.savings, 401);
  assert.equal(first.storage.getItem(WRITE_LOCK_KEY), null);
  assert.equal(first.storage.operations.filter(item => item.op === 'setItem' && item.key === STORAGE_KEY).length, 1);
});

test('fresh-raw revalidation rejects stale writers with no primary or snapshot write', () => {
  const { store, storage } = loaded();
  const external = makeV3Budget();
  external.months['2026-01'].allocations.savings = 777;
  storage.setItem(STORAGE_KEY, JSON.stringify(external));
  storage.operations.length = 0;
  code('STALE_WRITE', () => store.updateAllocation('2026-01', 'savings', 401));
  assert.equal(store.getMonth('2026-01').allocations.savings, 400);
  assert.equal(storage.operations.some(item => item.op === 'setItem' &&
    (item.key === STORAGE_KEY || item.key.startsWith(SNAPSHOT_PREFIX))), false);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
});

test('reload is write-free, reports byte changes, and refreshes resident state', () => {
  const { store, storage } = loaded();
  assert.equal(store.reload().changed, false);
  const external = makeV3Budget();
  external.months['2026-01'].allocations.savings = 612;
  storage.setItem(STORAGE_KEY, JSON.stringify(external));
  storage.operations.length = 0;
  const status = store.reload();
  assert.equal(status.changed, true);
  assert.equal(store.getMonth('2026-01').allocations.savings, 612);
  assert.equal(storage.operations.some(item => item.op !== 'getItem' && item.op !== 'key'), false);
});

test('purge preview is frozen, detached, generation-bound, and successful purge leaves no local artifacts', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()), [CORRUPT_KEY]: 'evidence',
    [`${SNAPSHOT_PREFIX}one`]: 'snapshot', [`${SNAPSHOT_PREFIX}two`]: 'snapshot' });
  const { store } = loaded({ storage });
  const preview = store.previewLocalDataPurge();
  assert.deepEqual(preview, { activeDataPresent: true, corruptEvidencePresent: true,
    snapshotCount: 2, lockPresent: false, generation: 1 });
  assert.equal(Object.isFrozen(preview), true);
  store.commitLocalDataPurge(preview);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem(CORRUPT_KEY), null);
  assert.equal(storage.getItem(`${SNAPSHOT_PREFIX}one`), null);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  assert.equal(store.getStatus().state, 'empty');
  assert.equal(store.reload().changed, false);
  code('INVALID_PURGE_PREVIEW', () => store.commitLocalDataPurge(preview));
});

test('purge delete failure rolls removed bytes back and leaves resident data intact', () => {
  const raw = JSON.stringify(makeV3Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw, [CORRUPT_KEY]: 'evidence' });
  const { store } = loaded({ storage });
  const before = store.getData();
  const preview = store.previewLocalDataPurge();
  storage.fail({ op: 'removeItem', key: CORRUPT_KEY, once: true });
  code('PURGE_FAILED', () => store.commitLocalDataPurge(preview));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.getItem(CORRUPT_KEY), 'evidence');
  assert.deepEqual(store.getData(), before);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
});

test('purge preview becomes stale after a commit and purge recovery failure fails closed', () => {
  const first = loaded();
  const stale = first.store.previewLocalDataPurge();
  first.store.updateAllocation('2026-01', 'savings', 405);
  first.storage.operations.length = 0;
  code('STALE_PURGE_PREVIEW', () => first.store.commitLocalDataPurge(stale));
  assert.equal(first.storage.operations.length, 0);

  const raw = JSON.stringify(makeV3Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw, [CORRUPT_KEY]: 'evidence' });
  const second = loaded({ storage });
  const preview = second.store.previewLocalDataPurge();
  storage.fail({ op: 'removeItem', key: CORRUPT_KEY, once: true });
  storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true });
  code('PURGE_RECOVERY_FAILED', () => second.store.commitLocalDataPurge(preview));
  assert.equal(second.store.getStatus().state, 'recovery-required');
  code('RECOVERY_REQUIRED', () => second.store.getData());
});

test('prepared dashboard range is ordered, deeply frozen, detached, and preserves incomplete methods', () => {
  const { store, storage } = loaded();
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: null });
  storage.operations.length = 0;
  const prepared = store.prepareDashboardRange({ monthKeys: ['2026-02', '2026-01'], basis: 'actual' });
  assert.deepEqual(prepared.monthKeys, ['2026-02', '2026-01']);
  assert.deepEqual({
    exists: prepared.months['2026-02'].exists,
    paycheckCount: prepared.months['2026-02'].paycheckCount,
    expenseCount: prepared.months['2026-02'].expenseCount,
    suppressedOccurrenceCount: prepared.months['2026-02'].suppressedOccurrenceCount
  }, { exists: false, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 });
  assert.deepEqual({
    exists: prepared.months['2026-01'].exists,
    paycheckCount: prepared.months['2026-01'].paycheckCount,
    expenseCount: prepared.months['2026-01'].expenseCount,
    suppressedOccurrenceCount: prepared.months['2026-01'].suppressedOccurrenceCount
  }, { exists: true, paycheckCount: 1, expenseCount: 1, suppressedOccurrenceCount: 0 });
  assert.equal(prepared.months['2026-01'].summary.unresolvedExpenseCount, 1);
  assert.deepEqual(prepared.months['2026-01'].incompletePaymentMethods, ['bank']);
  assert.equal(prepared.months['2026-01'].paymentMethodTotals.bank, 0);
  assert.equal(Object.isFrozen(prepared.months['2026-01'].summary), true);
  assert.equal(Object.isFrozen(prepared.months['2026-01']), true);
  assert.equal(storage.operations.length, 0);
  assert.throws(() => { prepared.months['2026-01'].summary.totalIncome = -1; }, TypeError);
  assert.equal(store.calcMonthSummary('2026-01').totalIncome, 2500);
});

test('prepared counts distinguish missing, saved-empty, and tombstone-only months without exposing records', () => {
  const budget = makeV3Budget();
  budget.templates.income.push({
    id: 'template-example-1', name: 'Example payday', earnerId: 'earner-example-1',
    plannedAmount: 100, enabled: true, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }
  });
  budget.months['2026-02'] = { paychecks: [], expenses: [], allocations: {
    savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] };
  budget.months['2026-03'] = { paychecks: [], expenses: [], allocations: {
    savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [
    { sourceTemplateId: 'template-example-1', occurrenceKey: '2026-03-01#0001' }
  ] };
  const { store } = loaded({ storage: new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) }) });
  const prepared = store.prepareDashboardRange({
    monthKeys: ['2026-04', '2026-02', '2026-03'], basis: 'planned'
  });
  assert.deepEqual(prepared.monthKeys.map(key => ({
    exists: prepared.months[key].exists,
    paycheckCount: prepared.months[key].paycheckCount,
    expenseCount: prepared.months[key].expenseCount,
    suppressedOccurrenceCount: prepared.months[key].suppressedOccurrenceCount
  })), [
    { exists: false, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 },
    { exists: true, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 },
    { exists: true, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 1 }
  ]);
  assert.equal('paychecks' in prepared.months['2026-03'], false);
  assert.equal('expenses' in prepared.months['2026-03'], false);
});

test('shared comparison validator exposes all locked statuses consistently', () => {
  const oneMonth = loaded();
  const compare = request => oneMonth.store.compareSavedMonths(request).status;
  const explain = request => oneMonth.store.explainSavedMonthComparisonRow(request).status;
  const base = { baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' };
  assert.equal(compare({ ...base, basis: 'bad' }), 'invalid-basis');
  assert.equal(explain({ ...base, basis: 'bad', section: 'categories' }), 'invalid-basis');
  assert.equal(compare(base), 'insufficient-saved-months');
  assert.equal(explain({ ...base, section: 'categories' }), 'insufficient-saved-months');
});
