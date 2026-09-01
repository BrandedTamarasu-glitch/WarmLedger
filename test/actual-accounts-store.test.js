'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { MemoryStorage, makeClock, makeV3Budget } = require('./helpers.js');

function v7Budget() {
  return Schema.migrateV6ToV7(Schema.migrateV5ToV6(
    Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3Budget()))));
}

function ready() {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(v7Budget()) });
  let sequence = 0;
  const store = createStore({ storage, now: makeClock(), uuid: () => `actual-account-${++sequence}` });
  assert.equal(store.load().state, 'ready');
  return { store, storage };
}

function code(expected, callback) {
  assert.throws(callback, error => error instanceof StoreError && error.code === expected);
}

test('saved records accept explicit compatible actual accounts and clear them with actual amounts', () => {
  const { store } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  const card = store.createAccount({ name: 'Card', kind: 'credit_card' });
  const paycheck = store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 100,
    actualAmount: 0, date: '2026-09-01', accountId: null, actualAccountId: bank.id });
  const expense = store.addExpense('2026-09', { categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    name: 'Rent', date: '2026-09-02', paycheckAmounts: {}, plannedAmount: 40, actualAmount: 35,
    paymentMethod: 'credit_card', accountId: null, actualAccountId: card.id });
  assert.equal(paycheck.actualAccountId, bank.id);
  assert.equal(expense.actualAccountId, card.id);
  assert.equal(store.updatePaycheck('2026-09', paycheck.id, { actualAmount: null }).actualAccountId, null);
  assert.equal(store.updateExpense('2026-09', expense.id, { actualAmount: null }).actualAccountId, null);
  store.updatePaycheck('2026-09', paycheck.id, { actualAmount: 1, actualAccountId: bank.id });
  const undatedPaycheck = store.updatePaycheck('2026-09', paycheck.id, { date: '' });
  assert.equal(undatedPaycheck.actualAccountId, null);
  assert.equal(undatedPaycheck.date, '');
  store.updateExpense('2026-09', expense.id, { actualAmount: 1, actualAccountId: card.id });
  const undatedExpense = store.updateExpense('2026-09', expense.id, { date: '' });
  assert.equal(undatedExpense.actualAccountId, null);
  assert.equal(undatedExpense.date, '');
  assert.deepEqual(store.getActualAccountSummary('2026-09').eligible, { paychecks: 0, expenses: 0 });
  store.updatePaycheck('2026-09', paycheck.id, { date: '2026-09-01' });
  store.updateExpense('2026-09', expense.id, { date: '2026-09-02' });
  code('ACCOUNT_INCOMPATIBLE', () => store.updatePaycheck('2026-09', paycheck.id,
    { actualAmount: 1, actualAccountId: card.id }));
  code('ACCOUNT_INCOMPATIBLE', () => store.updateExpense('2026-09', expense.id,
    { actualAmount: 1, actualAccountId: bank.id }));
});

test('payment method changes revalidate actual accounts and archived references may only be preserved', () => {
  const { store } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  const otherBank = store.createAccount({ name: 'Reserve', kind: 'bank' });
  const expense = store.addExpense('2026-09', { categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    name: 'Rent', date: '2026-09-02', paycheckAmounts: {}, plannedAmount: 40, actualAmount: 35,
    paymentMethod: 'bank', accountId: null, actualAccountId: bank.id });
  code('ACCOUNT_INCOMPATIBLE', () => store.updateExpense('2026-09', expense.id, { paymentMethod: 'credit_card' }));
  store.updateAccount(bank.id, { archived: true });
  assert.equal(store.updateExpense('2026-09', expense.id, { plannedAmount: 41 }).actualAccountId, bank.id);
  assert.equal(store.updateExpense('2026-09', expense.id, { actualAccountId: bank.id }).actualAccountId, bank.id);
  store.updateAccount(otherBank.id, { archived: true });
  code('ACCOUNT_ARCHIVED', () => store.updateExpense('2026-09', expense.id, { actualAccountId: otherBank.id }));
});

test('actual account summary is selected-month-only, ordered, frozen, explicit, and counts usage', () => {
  const { store } = ready();
  const first = store.createAccount({ name: 'Checking', kind: 'bank' });
  const second = store.createAccount({ name: 'Cash', kind: 'cash' });
  const card = store.createAccount({ name: 'Card', kind: 'credit_card' });
  store.reorderAccounts([second.id, card.id, first.id]);
  store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 100, actualAmount: 0,
    date: '2026-09-01', accountId: first.id, actualAccountId: first.id });
  store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 50, actualAmount: 50,
    date: '2026-09-02', accountId: null, actualAccountId: second.id });
  store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 25, actualAmount: 25,
    date: '2026-09-03', accountId: null, actualAccountId: null });
  store.addExpense('2026-09', { categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'Rent',
    date: '2026-09-04', paycheckAmounts: {}, plannedAmount: 20, actualAmount: 20,
    paymentMethod: 'credit_card', accountId: null, actualAccountId: card.id });
  store.updateAccount(first.id, { archived: true });
  const summary = store.getActualAccountSummary('2026-09');
  assert.deepEqual(summary.eligible, { paychecks: 3, expenses: 1 });
  assert.deepEqual(summary.entered, { paychecks: 2, expenses: 1 });
  assert.deepEqual(summary.missing, { paychecks: 1, expenses: 0 });
  assert.deepEqual(summary.incomeAccounts.map(row => row.accountId), [second.id, first.id]);
  assert.deepEqual(summary.incomeAccounts.map(row => row.totalActualAmount), [50, 0]);
  assert.equal(summary.incomeAccounts[1].archived, true);
  assert.equal(summary.expenseAccounts[0].accountId, card.id);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.incomeAccounts[0]), true);
  assert.equal(store.getAccountUsage()[first.id], 2);
  assert.equal(store.getAccountUsage()[second.id], 1);
  assert.equal(store.getAccountUsage()[card.id], 1);
  assert.deepEqual(store.getActualAccountSummary('2026-10'), { monthKey: '2026-10', exists: false,
    eligible: { paychecks: 0, expenses: 0 }, entered: { paychecks: 0, expenses: 0 },
    missing: { paychecks: 0, expenses: 0 }, incomeAccounts: [], expenseAccounts: [] });
});

test('copy and recurring generation always reset actual account references', () => {
  const { store } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 100, actualAmount: 100,
    date: '2026-09-01', accountId: null, actualAccountId: bank.id });
  store.copyFromMonth('2026-10', '2026-09');
  assert.equal(store.getMonth('2026-10').paychecks[0].actualAccountId, null);
  store.addIncomeTemplate({ name: 'Payday', earnerId: 'earner-example-1', plannedAmount: 100, enabled: true,
    startDate: '2026-11-01', endDate: null, recurrence: { cadence: 'monthly', day: 1 }, accountId: bank.id });
  store.applyRecurringPreview(store.previewRecurringMonth('2026-11'));
  assert.equal(store.getMonth('2026-11').paychecks[0].actualAccountId, null);
});

test('schema 7 Data Health analysis ignores actual account fields without removing persisted labels', () => {
  const { store, storage } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  const paycheck = store.addPaycheck('2026-09', { earnerId: 'earner-example-1', plannedAmount: 100,
    actualAmount: 100, date: '2026-09-01', accountId: null, actualAccountId: bank.id });

  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'unused' });
  assert.equal(reloaded.load().state, 'ready');
  assert.doesNotThrow(() => reloaded.getDataHealth());
  assert.doesNotThrow(() => reloaded.getExactMoneyAudit());
  assert.equal(reloaded.getMonth('2026-09').paychecks.find(record => record.id === paycheck.id).actualAccountId, bank.id);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-09'].paychecks
    .find(record => record.id === paycheck.id).actualAccountId, bank.id);
});
