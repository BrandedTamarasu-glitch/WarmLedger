'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { MemoryStorage, makeClock, makeV3Budget } = require('./helpers.js');

function v6Budget() {
  return Schema.migrateV5ToV6(Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3Budget())));
}

function ready({ sharded = false } = {}) {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(v6Budget()) });
  let sequence = 0;
  const store = createStore({ storage, now: makeClock(), uuid: () => `account-test-${++sequence}` });
  assert.equal(store.load().state, 'ready');
  if (sharded) store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  storage.operations.length = 0;
  return { store, storage };
}

function code(expected, callback) {
  assert.throws(callback, error => error instanceof StoreError && error.code === expected);
}

test('account catalog CRUD, ordering, archived filtering, usage, and detached reads', () => {
  const { store } = ready();
  const checking = store.createAccount({ name: 'House Checking', kind: 'bank' });
  const card = store.createAccount({ name: 'House Card', kind: 'credit_card' });
  assert.equal(Object.isFrozen(checking), true);
  store.addPaycheck('2026-01', { earnerId: 'earner-example-1', plannedAmount: 50, actualAmount: null,
    date: '2026-01-20', accountId: checking.id });
  store.addExpense('2026-01', { categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    name: 'Rent', date: '2026-01-20', paycheckAmounts: {}, plannedAmount: 20, actualAmount: null,
    paymentMethod: 'credit_card', accountId: card.id });
  assert.equal(store.getAccountUsage()[checking.id], 1);
  assert.equal(store.getAccountUsage()[card.id], 1);
  const archived = store.updateAccount(checking.id, { archived: true });
  assert.equal(Object.isFrozen(archived), true);
  assert.deepEqual(store.getAccounts().map(item => item.id), [card.id]);
  const all = store.getAccounts({ includeArchived: true });
  assert.equal(Object.isFrozen(all), true); assert.equal(Object.isFrozen(all[0]), true);
  code('DUPLICATE_ACCOUNT_NAME', () => store.updateAccount(card.id, { name: 'House Checking' }));
  store.updateAccount(checking.id, { archived: false, name: 'Daily Checking' });
  const reordered = store.reorderAccounts([card.id, checking.id]);
  assert.equal(Object.isFrozen(reordered), true); assert.equal(Object.isFrozen(reordered[0]), true);
  assert.deepEqual(reordered.map(item => item.id), [card.id, checking.id]);
  code('INVALID_PERMUTATION', () => store.reorderAccounts([checking.id]));
});

test('account compatibility is enforced for records and templates while archived references remain valid', () => {
  const { store } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  const card = store.createAccount({ name: 'Card', kind: 'credit_card' });
  code('ACCOUNT_INCOMPATIBLE', () => store.addPaycheck('2026-02', { earnerId: 'earner-example-1',
    plannedAmount: 10, actualAmount: null, date: '2026-02-01', accountId: card.id }));
  code('ACCOUNT_INCOMPATIBLE', () => store.addExpense('2026-02', { categoryId: 'category-example-1',
    categoryItemId: 'item-example-1', name: 'Rent', date: '2026-02-01', paycheckAmounts: {},
    plannedAmount: 10, actualAmount: null, paymentMethod: 'credit_card', accountId: bank.id }));
  const paycheck = store.addPaycheck('2026-02', { earnerId: 'earner-example-1', plannedAmount: 10,
    actualAmount: null, date: '2026-02-01', accountId: bank.id });
  const expense = store.addExpense('2026-02', { categoryId: 'category-example-1',
    categoryItemId: 'item-example-1', name: 'Rent', date: '2026-02-01', paycheckAmounts: {},
    plannedAmount: 10, actualAmount: null, paymentMethod: 'credit_card', accountId: card.id });
  const incomeTemplate = store.addIncomeTemplate({ name: 'Payday', earnerId: 'earner-example-1', plannedAmount: 100,
    enabled: true, startDate: '2026-02-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }, accountId: bank.id });
  const expenseTemplate = store.addExpenseTemplate({ name: 'Card bill', categoryId: 'category-example-1',
    categoryItemId: 'item-example-1', plannedAmount: 20, paymentMethod: 'credit_card', enabled: true,
    startDate: '2026-02-01', endDate: null, recurrence: { cadence: 'monthly', day: 2 }, accountId: card.id });
  const unassignedIncome = store.addIncomeTemplate({ name: 'Other pay', earnerId: 'earner-example-1', plannedAmount: 25,
    enabled: false, startDate: '2026-02-01', endDate: null, recurrence: { cadence: 'monthly', day: 3 } });
  const unassignedExpense = store.addExpenseTemplate({ name: 'Other bill', categoryId: 'category-example-1',
    categoryItemId: 'item-example-1', plannedAmount: 5, paymentMethod: 'credit_card', enabled: false,
    startDate: '2026-02-01', endDate: null, recurrence: { cadence: 'monthly', day: 4 } });
  store.updateAccount(bank.id, { archived: true });
  store.updateAccount(card.id, { archived: true });
  store.updatePaycheck('2026-02', paycheck.id, { plannedAmount: 11, accountId: bank.id });
  store.updateExpense('2026-02', expense.id, { plannedAmount: 11, accountId: card.id });
  store.updateIncomeTemplate(incomeTemplate.id, { plannedAmount: 101, accountId: bank.id });
  store.updateExpenseTemplate(expenseTemplate.id, { plannedAmount: 21, accountId: card.id });
  assert.equal(store.getMonth('2026-02').paychecks[0].accountId, bank.id);
  code('ACCOUNT_ARCHIVED', () => store.addPaycheck('2026-02', { earnerId: 'earner-example-1',
    plannedAmount: 12, actualAmount: null, date: '2026-02-02', accountId: bank.id }));
  code('ACCOUNT_ARCHIVED', () => store.updatePaycheck('2026-01', 'paycheck-example-1', { accountId: bank.id }));
  code('ACCOUNT_ARCHIVED', () => store.updateExpense('2026-01', 'expense-example-1', { accountId: card.id }));
  code('ACCOUNT_ARCHIVED', () => store.updateIncomeTemplate(unassignedIncome.id, { accountId: bank.id }));
  code('ACCOUNT_ARCHIVED', () => store.updateExpenseTemplate(unassignedExpense.id, { accountId: card.id }));
  code('ACCOUNT_INCOMPATIBLE', () => store.updateAccount(bank.id, { kind: 'credit_card' }));
});

test('templates, recurring generation, and copy preserve optional account references', () => {
  const { store } = ready();
  const bank = store.createAccount({ name: 'Checking', kind: 'bank' });
  const template = store.addIncomeTemplate({ name: 'Payday', earnerId: 'earner-example-1', plannedAmount: 100,
    enabled: true, startDate: '2026-02-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }, accountId: bank.id });
  store.applyRecurringPreview(store.previewRecurringMonth('2026-02'));
  const generated = store.getMonth('2026-02').paychecks.find(item => item.sourceTemplateId === template.id);
  assert.equal(generated.accountId, bank.id);
  store.copyFromMonth('2026-03', '2026-02');
  assert.equal(store.getMonth('2026-03').paychecks[0].accountId, bank.id);
  assert.equal(store.getAccountUsage()[bank.id], 3);
});

test('account APIs are unavailable before schema 6 and sharded account writes avoid month shards', () => {
  const legacyStorage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const legacy = createStore({ storage: legacyStorage, now: makeClock(), uuid: () => 'legacy-account' });
  legacy.load();
  code('ACCOUNTS_UNAVAILABLE', () => legacy.getAccounts());
  code('ACCOUNTS_UNAVAILABLE', () => legacy.createAccount({ name: 'Checking', kind: 'bank' }));

  const { store, storage } = ready({ sharded: true });
  store.createAccount({ name: 'Checking', kind: 'bank' });
  const writes = storage.operations.filter(item => item.op === 'setItem').map(item => item.key);
  assert.equal(writes.some(key => key.startsWith('zeroBudget_month:')), false);
  assert.equal(writes.some(key => key.startsWith('zeroBudget_global:')), true);
});
