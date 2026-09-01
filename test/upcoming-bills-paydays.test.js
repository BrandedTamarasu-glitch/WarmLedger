'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function emptyMonth() {
  return { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] };
}

function paycheck(id, date, actualAmount, plannedAmount = 100, earner = `Earner <${id}>`) {
  return { id, earnerId: 'earner-example-1', earner, plannedAmount, actualAmount, date,
    sourceTemplateId: null, occurrenceKey: null };
}

function expense(id, date, paycheckAmounts = {}, overrides = {}) {
  return {
    id, categoryId: 'category-example-1', category: 'Home <&>', categoryItemId: 'item-example-1',
    name: `Bill <${id}> & ${'long'.repeat(20)}`, date, paycheckAmounts, plannedAmount: 100,
    actualAmount: null, paymentMethod: 'bank', sourceTemplateId: null, occurrenceKey: null, ...overrides
  };
}

function budgetFixture() {
  const budget = makeV3Budget();
  budget.months = { '2026-01': emptyMonth(), '2026-03': emptyMonth() };
  budget.months['2026-01'].paychecks = [
    paycheck('jan-before', '2026-01-10', 20),
    paycheck('jan-first', '2026-01-20', null),
    paycheck('jan-second', '2026-01-20', 0),
    paycheck('jan-undated', '', 12)
  ];
  budget.months['2026-01'].expenses = [
    expense('jan-full', '2026-01-20', { 'jan-first': 60, 'jan-second': 39.991 }, { actualAmount: 0 }),
    expense('jan-partial', '2026-01-20', { 'jan-first': 99.9909 }),
    expense('jan-unfunded', '2026-01-31'),
    expense('jan-undated-bill', '', { 'jan-first': 40 }, { actualAmount: 40 }),
    expense('jan-before-bill', '2026-01-05')
  ];
  budget.months['2026-03'].paychecks = [paycheck('mar-payday', '2026-03-20', 100)];
  budget.months['2026-03'].expenses = [expense('mar-bill', '2026-03-20', { 'mar-payday': 100 }, { actualAmount: 100 })];
  Schema.validateV3(budget);
  return budget;
}

function ready(budget = budgetFixture(), { raw, now, uuid } = {}) {
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw || JSON.stringify(budget) });
  const store = createStore({ storage,
    now: now || (() => { throw new Error('passive projection must not read clock'); }),
    uuid: uuid || (() => { throw new Error('passive projection must not request UUID'); }) });
  assert.equal(store.load().state, 'ready'); storage.operations.length = 0;
  return { store, storage };
}

function expectCode(expected, action) {
  assert.throws(action, error => error instanceof StoreError && error.code === expected);
}

test('projects exact civil windows across month, year, and leap boundaries', () => {
  const { store } = ready();
  assert.equal(store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 30 }).endDate, '2026-02-18');
  assert.equal(store.getUpcomingBillsAndPaydays({ anchorDate: '2026-12-15', dayCount: 30 }).endDate, '2027-01-13');
  assert.equal(store.getUpcomingBillsAndPaydays({ anchorDate: '2028-02-15', dayCount: 30 }).endDate, '2028-03-15');
  const sixty = store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  assert.equal(sixty.endDate, '2026-03-20');
  assert.equal(sixty.dateGroups.length, 60);
  assert.equal(sixty.dateGroups[0].date, '2026-01-20');
  assert.equal(sixty.dateGroups[59].date, '2026-03-20');
  assert.equal(store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 90 }).dateGroups.length, 90);
});

test('distinguishes missing and saved-empty coverage while retaining gap dates', () => {
  const budget = budgetFixture(); budget.months['2026-02'] = emptyMonth();
  const withEmpty = ready(budget).store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  assert.deepEqual(withEmpty.coverage, [
    { monthKey: '2026-01', state: 'saved-plan' },
    { monthKey: '2026-02', state: 'saved-plan' },
    { monthKey: '2026-03', state: 'saved-plan' }
  ]);
  assert.equal(withEmpty.dateGroups.find(group => group.date === '2026-02-10').paydays.length, 0);
  const missing = ready().store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  assert.equal(missing.coverage[1].state, 'no-saved-plan');
  assert.equal(missing.counts.savedPlanMonthCount, 2);
  assert.equal(missing.counts.noSavedPlanMonthCount, 1);
});

test('preserves canonical same-date order, blank Date-needed groups, hostile text, and null-versus-zero actuals', () => {
  const projection = ready().store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  const first = projection.dateGroups[0];
  assert.deepEqual(first.paydays.map(item => item.paycheckId), ['jan-first', 'jan-second']);
  assert.deepEqual(first.paydays.map(item => [item.actualAmount, item.actualState]),
    [[null, 'not-entered'], [0, 'entered']]);
  assert.deepEqual(first.bills.map(item => item.expenseId), ['jan-full', 'jan-partial']);
  assert.equal(first.bills[0].name.includes('<jan-full>'), true);
  assert.deepEqual(projection.dateNeeded.map(group => group.monthKey), ['2026-01']);
  assert.deepEqual(projection.dateNeeded[0].paydays.map(item => item.paycheckId), ['jan-undated']);
  assert.deepEqual(projection.dateNeeded[0].bills.map(item => item.expenseId), ['jan-undated-bill']);
  assert.equal(projection.dateGroups.some(group => group.paydays.some(item => item.paycheckId === 'jan-undated')), false);
  assert.equal(projection.dateGroups.some(group => group.bills.some(item => item.expenseId === 'jan-before-bill')), false);
  assert.deepEqual(projection.counts, {
    savedPlanMonthCount: 2, noSavedPlanMonthCount: 1,
    paydayCount: 4, billCount: 5, datedPaydayCount: 3, datedBillCount: 4,
    dateNeededPaydayCount: 1, dateNeededBillCount: 1
  });
});

test('derives funding solely from saved positive assignments with shared tolerance and stable sources', () => {
  const bills = ready().store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 30 })
    .dateGroups[0].bills;
  const full = bills[0]; const partial = bills[1];
  assert.equal(full.fundedAcrossPaychecks, 99.991);
  assert.equal(full.remainingToFund, 0);
  assert.equal(full.fundingState, 'fully-funded');
  assert.equal(full.fundedPaycheckCount, 2);
  assert.equal(full.splitAcrossPaychecks, true);
  assert.deepEqual(full.fundingSources.map(source => [source.paycheckId, source.amount]),
    [['jan-first', 60], ['jan-second', 39.991]]);
  assert.equal(partial.fundedAcrossPaychecks, 99.9909);
  assert.equal(partial.fundingState, 'partially-funded');
  assert.equal(partial.remainingToFund > 0.009, true);
  const unfunded = ready().store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 30 })
    .dateGroups.find(group => group.date === '2026-01-31').bills[0];
  assert.equal(unfunded.fundingState, 'unfunded');
  assert.deepEqual(unfunded.fundingSources, []);
});

test('resident v3 and hydrated v4 runtime projections are identical', () => {
  const budget = budgetFixture();
  budget.months['2026-01'].expenses[0].paycheckAmounts['jan-second'] = 40;
  budget.months['2026-01'].expenses[1].paycheckAmounts['jan-first'] = 99.99;
  const v3 = ready(budget).store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  const persistedV4 = Schema.migrateV3ToV4ExactMoney(budget);
  const v4 = ready(budget, { raw: JSON.stringify(persistedV4) }).store
    .getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  assert.deepEqual(v4, v3);
});

test('projection is detached, deeply frozen, deterministic, and performs no writes or mutations', () => {
  const budget = budgetFixture();
  let nowCalls = 0; let uuidCalls = 0;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  const store = createStore({ storage, now: () => { nowCalls++; return new Date(); }, uuid: () => { uuidCalls++; return 'unused'; } });
  store.load(); const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
  const beforeStatus = store.getStatus(); storage.operations.length = 0;
  const first = store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  const second = store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 60 });
  assert.deepEqual(first, second); assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.dateGroups), true);
  assert.equal(Object.isFrozen(first.dateGroups[0].paydays), true);
  assert.equal(Object.isFrozen(first.counts), true);
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData); assert.deepEqual(store.getStatus(), beforeStatus);
  assert.equal(nowCalls, 0); assert.equal(uuidCalls, 0);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
});

test('invalid anchors and day counts fail stably without writes, and recovery remains gated', () => {
  const { store, storage } = ready(); const raw = storage.getItem(STORAGE_KEY); storage.operations.length = 0;
  for (const request of [undefined, null, 30, 'range', Symbol('range')]) {
    expectCode('INVALID_ANCHOR_DATE', () => store.getUpcomingBillsAndPaydays(request));
  }
  for (const anchorDate of [undefined, null, 20260101, {}, Symbol('date'), '', '2026-02-29', '2026-13-01', '2026-01-00']) {
    expectCode('INVALID_ANCHOR_DATE', () => store.getUpcomingBillsAndPaydays({ anchorDate, dayCount: 30 }));
  }
  for (const dayCount of [undefined, null, 0, 29, 31, 60.0 + 0.1, '30', 120, Symbol('count')]) {
    expectCode('INVALID_DAY_COUNT', () => store.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount }));
  }
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);

  const damaged = new MemoryStorage({ [STORAGE_KEY]: '{damaged private bytes' });
  const recovery = createStore({ storage: damaged, now: () => new Date(), uuid: () => 'unused' });
  recovery.load(); damaged.operations.length = 0;
  expectCode('RECOVERY_REQUIRED', () => recovery.getUpcomingBillsAndPaydays({ anchorDate: '2026-01-20', dayCount: 30 }));
  assert.equal(damaged.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
});
