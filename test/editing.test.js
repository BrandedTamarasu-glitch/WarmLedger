'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget: makeBudget, MemoryStorage, makeClock, makeUuid } = require('./helpers.js');

function readyStore() {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeBudget()) });
  const store = createStore({
    storage,
    now: makeClock(),
    uuid: makeUuid('editing-snapshot-1', 'editing-snapshot-2', 'editing-record-1', 'editing-record-2')
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage };
}

test('record edits transact once and preserve fields outside the edit form', () => {
  const { store, storage } = readyStore();

  const paycheckBefore = store.getMonth('2026-01').paychecks[0];
  store.editPaycheck('2026-01', paycheckBefore.id, {
    earnerId: 'earner-example-1', plannedAmount: 2600, actualAmount: null, date: '2026-01-20'
  });
  const paycheckAfter = store.getMonth('2026-01').paychecks[0];
  assert.deepEqual(paycheckAfter, {
    id: paycheckBefore.id,
    earnerId: 'earner-example-1',
    earner: 'Example Earner',
    plannedAmount: 2600, actualAmount: null, date: '2026-01-20',
    sourceTemplateId: null, occurrenceKey: null
  });

  storage.operations.length = 0;
  const expenseBefore = store.getMonth('2026-01').expenses[0];
  store.editExpense('2026-01', expenseBefore.id, {
    categoryId: 'category-example-1', categoryItemId: null,
    name: 'Updated rent', date: '2026-01-22',
    plannedAmount: 1250, actualAmount: 0, paymentMethod: 'credit_card'
  });
  const expenseAfter = store.getMonth('2026-01').expenses[0];
  assert.deepEqual(expenseAfter, {
    ...expenseBefore,
    categoryId: 'category-example-1',
    category: 'Home', categoryItemId: null,
    name: 'Updated rent', date: '2026-01-22',
    plannedAmount: 1250, actualAmount: 0,
    paymentMethod: 'credit_card'
  });
  assert.deepEqual(expenseAfter.paycheckAmounts, expenseBefore.paycheckAmounts);
  assert.equal(expenseAfter.sourceTemplateId, expenseBefore.sourceTemplateId);
  assert.equal(expenseAfter.occurrenceKey, expenseBefore.occurrenceKey);
  assert.equal(storage.operations.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);
  Schema.validateActive(JSON.parse(storage.getItem(STORAGE_KEY)));
});

test('failed and missing-ID record edits preserve memory and primary bytes', () => {
  const { store, storage } = readyStore();
  const beforeData = store.getData();
  const beforeRaw = storage.getItem(STORAGE_KEY);

  storage.operations.length = 0;
  assert.throws(
    () => store.updateExpense('2026-01', 'missing-expense', { name: 'No change' }),
    error => error instanceof StoreError && error.code === 'EXPENSE_NOT_FOUND'
  );
  assert.deepEqual(store.getData(), beforeData);
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem'), false);

  storage.operations.length = 0;
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  assert.throws(
    () => store.updatePaycheck('2026-01', 'paycheck-example-1', { plannedAmount: 2700 }),
    error => error instanceof StoreError && error.code === 'PRIMARY_WRITE_FAILED'
  );
  assert.deepEqual(store.getData(), beforeData);
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.equal(storage.operations.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 0);
});

test('blank dates default to the first day of the selected month at the Store boundary', () => {
  const { store } = readyStore();
  store.updatePaycheck('2026-01', 'paycheck-example-1', { date: '' });
  store.updateExpense('2026-01', 'expense-example-1', { date: '' });
  assert.equal(store.getMonth('2026-01').paychecks[0].date, '2026-01-01');
  assert.equal(store.getMonth('2026-01').expenses[0].date, '2026-01-01');

  const paycheck = store.addPaycheck('2026-02', {
    earnerId: 'earner-example-1', plannedAmount: 100, actualAmount: null, date: ''
  });
  const expense = store.addExpense('2026-02', {
    categoryId: 'category-example-1', categoryItemId: null, name: 'Phone', date: '', paycheckAmounts: {},
    plannedAmount: 50, actualAmount: null, paymentMethod: 'bank'
  });
  assert.equal(paycheck.date, '2026-02-01');
  assert.equal(expense.date, '2026-02-01');
});
