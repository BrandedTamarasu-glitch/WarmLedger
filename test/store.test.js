'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const {
  STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, SNAPSHOT_LIMIT, StoreError, createStore
} = require('../js/data.js');
const { makeV1Budget, makeV2Budget: makeBudget, MemoryStorage, makeClock } = require('./helpers.js');

function ids(prefix = 'generated') {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function readyStore({ budget = makeBudget(), storage, clock = makeClock(), uuid = ids() } = {}) {
  storage ||= new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  const store = createStore({ storage, now: clock, uuid });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, clock };
}

function expectStoreCode(code, fn) {
  assert.throws(fn, error => error instanceof StoreError && error.code === code);
}

function snapshotKeys(storage) {
  return Array.from(storage._values.keys()).filter(key => key.startsWith(SNAPSHOT_PREFIX));
}

function backupText(data = makeBudget()) {
  return JSON.stringify(Schema.buildBackup(data, '2026-01-15T12:00:00.000Z'));
}

class AttemptStorage extends MemoryStorage {
  constructor(initial) {
    super(initial);
    this.attempts = [];
  }

  setItem(key, value) {
    this.attempts.push({ op: 'setItem', key: String(key) });
    return super.setItem(key, value);
  }

  getItem(key) {
    this.attempts.push({ op: 'getItem', key: String(key) });
    return super.getItem(key);
  }
}

test('empty load uses generic detached defaults without writing', () => {
  const storage = new MemoryStorage();
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  assert.deepEqual(store.load(), { state: 'empty', warnings: [], migrated: false });
  const first = store.getData();
  assert.deepEqual(first.settings.earners.map(earner => earner.name), ['Primary', 'Secondary']);
  first.settings.earners[0].name = 'Changed';
  assert.equal(store.getData().settings.earners[0].name, 'Primary');
  assert.equal(storage.operations.some(operation => operation.op === 'setItem'), false);
});

test('legacy load migrates only in memory and preserves primary bytes', () => {
  const legacy = makeV1Budget();
  delete legacy.schemaVersion;
  const raw = JSON.stringify(legacy);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  const result = store.load();
  assert.equal(result.state, 'ready');
  assert.equal(result.migrated, true);
  assert.equal(store.getData().schemaVersion, 2);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem').length, 0);
});

test('valid v0, v1, and v2 loads are write-free and do not prune snapshots', () => {
  const v1 = makeV1Budget();
  const v0 = structuredClone(v1); delete v0.schemaVersion;
  for (const budget of [v0, v1, makeBudget()]) {
    const raw = JSON.stringify(budget);
    const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
    for (let index = 0; index < SNAPSHOT_LIMIT + 2; index += 1) {
      const day = String(index + 1).padStart(2, '0');
      storage.setItem(`${SNAPSHOT_PREFIX}valid-${index}`, JSON.stringify(Schema.buildSnapshot(makeBudget(), {
        createdAt: `2026-01-${day}T00:00:00.000Z`, localDate: `2026-01-${day}`, reason: 'daily'
      })));
    }
    storage.operations.length = 0;
    const store = createStore({ storage, now: makeClock(), uuid: ids() });
    assert.equal(store.load().state, 'ready');
    assert.equal(store.getData().schemaVersion, 2);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
    assert.equal(snapshotKeys(storage).length, SNAPSHOT_LIMIT + 2);
  }
});

test('failed first persistence after v1 load preserves exact v1 bytes and canonical v2 memory', () => {
  const v1Raw = JSON.stringify(makeV1Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: v1Raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids('first-write') });
  store.load();
  const before = store.getData();
  assert.equal(before.schemaVersion, 2);
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.updateExpense('2026-01', 'expense-example-1', { actual: 999 }));
  assert.equal(storage.getItem(STORAGE_KEY), v1Raw);
  assert.deepEqual(store.getData(), before);
});

test('catalog projections are filtered, deeply frozen, detached, and write-free', () => {
  const budget = makeBudget();
  budget.categories.push({ id: 'category-archived', name: 'Former', archived: true, items: [
    { id: 'item-archived-category', name: 'Former item', archived: true }
  ] });
  budget.categories[0].items.push({ id: 'item-archived', name: 'Old rent', archived: true });
  budget.settings.earners.push({ id: 'earner-archived', name: 'Former Earner', archived: true });
  const { store, storage } = readyStore({ budget });
  assert.deepEqual(store.getCategories().map(category => category.id), ['category-example-1']);
  assert.equal(store.getCategories({ includeArchived: true }).length, 2);
  assert.deepEqual(store.getCategoryItems('category-example-1').map(item => item.id), ['item-example-1']);
  assert.equal(store.getCategoryItems('category-example-1', { includeArchived: true }).length, 2);
  assert.deepEqual(store.getEarners().map(earner => earner.id), ['earner-example-1']);
  assert.equal(store.getEarners({ includeArchived: true }).length, 2);
  const category = store.getCategory('category-example-1');
  const item = store.getCategoryItem('category-example-1', 'item-example-1');
  const earner = store.getEarner('earner-example-1');
  assert.equal(Object.isFrozen(category), true);
  assert.equal(Object.isFrozen(category.items), true);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(earner), true);
  assert.equal(store.getCategory('missing'), null);
  assert.deepEqual(store.getCategoryItems('missing'), []);
  assert.equal(store.getCategoryItem('missing', 'missing'), null);
  assert.equal(store.getEarner('missing'), null);
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
});

test('getters, calculations, and missing-month reads are detached and write-free', () => {
  const { store, storage } = readyStore();
  const data = store.getData();
  const month = store.getMonth('2026-01');
  const absent = store.peekMonth('2029-01');
  data.months['2026-01'].paychecks[0].amount = 1;
  month.expenses.length = 0;
  absent.allocations.savings = 99;
  assert.equal(store.getData().months['2026-01'].paychecks[0].amount, 2500);
  assert.equal(store.getMonth('2026-01').expenses.length, 1);
  assert.equal(store.getAllMonthKeys().includes('2029-01'), false);
  assert.deepEqual(store.calcMonthSummary('2029-01'), {
    totalIncome: 0, totalProjected: 0, totalActual: 0,
    totalAllocated: 0, totalBudgeted: 0, remaining: 0
  });
  assert.equal(store.calcPaycheckRemaining('2026-01', 'paycheck-example-1'), 1300);
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
});

test('ensureMonth and every CRUD family commit detached canonical state', () => {
  const storage = new MemoryStorage();
  const store = createStore({ storage, now: makeClock(), uuid: ids('id') });
  store.load();
  store.ensureMonth('2026-02');
  const paycheck = store.addPaycheck('2026-02', { earnerId: 'default-earner-0001', amount: 3000, date: '' });
  assert.equal(paycheck.id, 'id-1');
  store.updatePaycheck('2026-02', paycheck.id, { amount: 3200 });
  const expense = store.addExpense('2026-02', {
    categoryId: 'default-category-0001', categoryItemId: null,
    name: 'Example bill', actual: 0, paymentMethod: 'bank'
  });
  store.updateExpensePaycheckAmount('2026-02', expense.id, paycheck.id, 900);
  store.updateExpense('2026-02', expense.id, { actual: 875 });
  store.updateAllocation('2026-02', 'savings', 100);
  store.updateAllocations('2026-02', { savings: 200, credit_card_debt: 0, investments: 0 });
  const current = store.getMonth('2026-02');
  assert.equal(current.paychecks[0].amount, 3200);
  assert.equal(current.expenses[0].paycheckAmounts[paycheck.id], 900);
  assert.equal(current.expenses[0].actual, 875);
  assert.equal(current.allocations.savings, 200);
  store.deleteExpense('2026-02', expense.id);
  store.deletePaycheck('2026-02', paycheck.id);
  assert.deepEqual(store.getMonth('2026-02').expenses, []);
  assert.deepEqual(store.getMonth('2026-02').paychecks, []);
  Schema.validateActive(JSON.parse(storage.getItem(STORAGE_KEY)));
});

test('structural create and reassignment snapshot labels and reject spoofing or archived targets', () => {
  const budget = makeBudget();
  budget.categories.push({ id: 'category-other', name: 'Other', archived: false, items: [
    { id: 'item-other', name: 'Other preset', archived: false },
    { id: 'item-other-archived', name: 'Old preset', archived: true }
  ] });
  budget.categories.push({ id: 'category-archived', name: 'Archived category', archived: true, items: [] });
  budget.settings.earners.push({ id: 'earner-other', name: 'Other Earner', archived: false });
  budget.settings.earners.push({ id: 'earner-archived', name: 'Archived Earner', archived: true });
  const { store, storage } = readyStore({ budget, uuid: ids('structural') });

  const paycheck = store.addPaycheck('2026-02', { earnerId: 'earner-other', amount: 100, date: '' });
  assert.equal(paycheck.earner, 'Other Earner');
  expectStoreCode('FORBIDDEN_FIELD', () => store.addPaycheck('2026-02', {
    earnerId: 'earner-other', earner: 'Spoofed', amount: 100, date: ''
  }));
  expectStoreCode('EARNER_ARCHIVED', () => store.reassignPaycheckEarner('2026-02', paycheck.id, 'earner-archived'));
  store.reassignPaycheckEarner('2026-02', paycheck.id, 'earner-example-1');
  assert.equal(store.getMonth('2026-02').paychecks[0].earner, 'Example Earner');

  const preset = store.addExpense('2026-02', {
    categoryId: 'category-other', categoryItemId: 'item-other', name: 'Spoofed preset', paymentMethod: 'bank'
  });
  assert.equal(preset.category, 'Other');
  assert.equal(preset.name, 'Other preset');
  expectStoreCode('CATEGORY_ARCHIVED', () => store.addExpense('2026-02', {
    categoryId: 'category-archived', categoryItemId: null, name: 'Custom', paymentMethod: 'bank'
  }));
  expectStoreCode('CATEGORY_ITEM_ARCHIVED', () => store.reassignExpenseStructure('2026-02', preset.id, {
    categoryId: 'category-other', categoryItemId: 'item-other-archived'
  }));
  expectStoreCode('CATEGORY_ITEM_NOT_FOUND', () => store.reassignExpenseStructure('2026-02', preset.id, {
    categoryId: 'category-example-1', categoryItemId: 'item-other'
  }));
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, 3);
});

test('narrow scalar APIs reject arbitrary fields and apply exact provenance semantics', () => {
  const { store, storage } = readyStore();
  const before = store.getData();
  for (const operation of [
    () => store.updatePaycheck('2026-01', 'paycheck-example-1', { earnerId: 'earner-example-1' }),
    () => store.updatePaycheck('2026-01', 'paycheck-example-1', {}),
    () => store.updateExpense('2026-01', 'expense-example-1', { categoryId: 'category-example-1' }),
    () => store.updateExpense('2026-01', 'expense-example-1', {})
  ]) assert.throws(operation, error => error instanceof StoreError && ['FORBIDDEN_FIELD', 'EMPTY_PATCH'].includes(error.code));
  assert.deepEqual(store.getData(), before);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem'), false);

  store.updateExpense('2026-01', 'expense-example-1', { name: 'Rent' });
  assert.equal(store.getMonth('2026-01').expenses[0].categoryItemId, 'item-example-1');
  store.updateExpense('2026-01', 'expense-example-1', { actual: 1210 });
  assert.equal(store.getMonth('2026-01').expenses[0].categoryItemId, 'item-example-1');
  store.updateExpense('2026-01', 'expense-example-1', { name: 'Custom rent' });
  assert.equal(store.getMonth('2026-01').expenses[0].categoryItemId, null);
  store.reassignExpenseStructure('2026-01', 'expense-example-1', {
    categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'Ignored spoof'
  });
  assert.equal(store.getMonth('2026-01').expenses[0].name, 'Rent');
});

test('composite record edits commit once and cannot half-save', () => {
  const budget = makeBudget();
  budget.categories.push({ id: 'category-other', name: 'Other', archived: false, items: [] });
  budget.settings.earners.push({ id: 'earner-other', name: 'Other Earner', archived: false });
  const { store, storage } = readyStore({ budget });
  store.editPaycheck('2026-01', 'paycheck-example-1', {
    earnerId: 'earner-other', amount: 2600, date: '2026-01-20'
  });
  storage.operations.length = 0;
  store.editExpense('2026-01', 'expense-example-1', {
    categoryId: 'category-other', categoryItemId: null, name: 'Custom item', actual: 1100, paymentMethod: 'credit_card'
  });
  const expense = store.getMonth('2026-01').expenses[0];
  assert.deepEqual({ categoryId: expense.categoryId, category: expense.category, categoryItemId: expense.categoryItemId,
    name: expense.name, actual: expense.actual, paymentMethod: expense.paymentMethod }, {
    categoryId: 'category-other', category: 'Other', categoryItemId: null,
    name: 'Custom item', actual: 1100, paymentMethod: 'credit_card'
  });
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, 1);
  const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.editExpense('2026-01', 'expense-example-1', {
    categoryId: 'category-example-1', categoryItemId: 'item-example-1', actual: 999
  }));
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData);
});

test('copy and clear use transactions and remap paycheck references', () => {
  const { store } = readyStore({ uuid: ids('copy') });
  const copied = store.copyFromMonth('2026-02', '2026-01');
  assert.equal(copied.paychecks[0].id, 'copy-1');
  assert.equal(copied.expenses[0].id, 'copy-2');
  assert.deepEqual(copied.expenses[0].paycheckAmounts, { 'copy-1': 1200 });
  assert.equal(copied.expenses[0].actual, 0);
  assert.equal(copied.paychecks[0].earnerId, 'earner-example-1');
  assert.equal(copied.paychecks[0].earner, 'Example Earner');
  assert.equal(copied.expenses[0].categoryId, 'category-example-1');
  assert.equal(copied.expenses[0].categoryItemId, 'item-example-1');
  assert.equal(copied.expenses[0].category, 'Home');
  assert.equal(copied.expenses[0].name, 'Rent');
  store.clearMonth('2026-02');
  assert.deepEqual(store.peekMonth('2026-02'), {
    paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
  });
});

test('copy overwrite aborts when its required protective snapshot cannot be written', () => {
  const { store, storage } = readyStore({ uuid: ids('copy-fail') });
  const before = storage.getItem(STORAGE_KEY);
  storage.fail({ op: 'setItem', prefix: SNAPSHOT_PREFIX, name: 'QuotaExceededError' });
  expectStoreCode('SNAPSHOT_WRITE_FAILED', () => store.copyFromMonth('2026-02', '2026-01'));
  assert.equal(storage.getItem(STORAGE_KEY), before);
  assert.equal(store.getAllMonthKeys().includes('2026-02'), false);
});

test('missing records and invalid allocation keys cause zero writes', () => {
  const { store, storage } = readyStore();
  const before = JSON.stringify(store.getData());
  const cases = [
    () => store.updatePaycheck('2026-01', 'missing', { amount: 1 }),
    () => store.deleteExpense('2026-01', 'missing'),
    () => store.updateExpensePaycheckAmount('2026-01', 'expense-example-1', 'missing', 1),
    () => store.updateAllocation('2026-01', 'constructor', 1)
  ];
  const codes = ['PAYCHECK_NOT_FOUND', 'EXPENSE_NOT_FOUND', 'PAYCHECK_NOT_FOUND', 'INVALID_ALLOCATION_KEY'];
  cases.forEach((operation, index) => expectStoreCode(codes[index], operation));
  assert.equal(JSON.stringify(store.getData()), before);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem'), false);
});

test('all missing-ID mutators fail before any write', () => {
  const { store, storage } = readyStore();
  const matrix = [
    ['PAYCHECK_NOT_FOUND', () => store.updatePaycheck('2026-01', 'missing', { amount: 1 })],
    ['PAYCHECK_NOT_FOUND', () => store.deletePaycheck('2026-01', 'missing')],
    ['EXPENSE_NOT_FOUND', () => store.updateExpense('2026-01', 'missing', { actual: 1 })],
    ['EXPENSE_NOT_FOUND', () => store.deleteExpense('2026-01', 'missing')],
    ['EXPENSE_NOT_FOUND', () => store.updateExpensePaycheckAmount('2026-01', 'missing', 'paycheck-example-1', 1)],
    ['PAYCHECK_NOT_FOUND', () => store.updateExpensePaycheckAmount('2026-01', 'expense-example-1', 'missing', 1)]
  ];
  for (const [code, operation] of matrix) {
    storage.operations.length = 0;
    expectStoreCode(code, operation);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  }
});

test('schema-rejected over-limit mutations perform zero writes and preserve memory', () => {
  const { store, storage } = readyStore();
  const before = store.getData();
  assert.throws(() => store.updateExpense('2026-01', 'expense-example-1', { actual: 1_000_000_000_001 }),
    error => error instanceof Schema.DataError && error.code === 'AMOUNT_OUT_OF_RANGE');
  assert.deepEqual(store.getData(), before);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('unsafe generated identifiers cannot silently commit or lose an amount', () => {
  const storage = new MemoryStorage();
  const store = createStore({ storage, now: makeClock(), uuid: () => '__proto__' });
  store.load();
  store.ensureMonth('2026-02');
  const beforeRaw = storage.getItem(STORAGE_KEY);
  const beforeData = store.getData();
  storage.operations.length = 0;
  assert.throws(() => store.addPaycheck('2026-02', { earnerId: 'default-earner-0001', amount: 100, date: '' }),
    error => error instanceof Schema.DataError && error.code === 'UNSAFE_IDENTIFIER');
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('hostile category key spellings remain safe calculation labels', () => {
  const budget = makeBudget();
  budget.categories[0].name = '__proto__';
  budget.months['2026-01'].expenses[0].category = '__proto__';
  const { store } = readyStore({ budget });
  const totals = store.calcCategoryTotals('2026-01');
  assert.equal(Object.getPrototypeOf(totals), null);
  assert.deepEqual(totals.__proto__, { projected: 1200, actual: 1200 });
});

test('failed primary write preserves exact primary bytes and memory', () => {
  const { store, storage } = readyStore();
  const raw = storage.getItem(STORAGE_KEY);
  const before = store.getData();
  storage.operations.length = 0;
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError' });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.updateExpense('2026-01', 'expense-example-1', { actual: 999 }));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getData(), before);
  assert.equal(snapshotKeys(storage).length, 1, 'a valid pre-change daily snapshot may remain');
});

test('failed primary is attempted exactly once after daily snapshot set and readback', () => {
  const storage = new AttemptStorage({ [STORAGE_KEY]: JSON.stringify(makeBudget()) });
  const store = createStore({ storage, now: makeClock(), uuid: ids('order') });
  store.load();
  storage.operations.length = 0;
  storage.attempts.length = 0;
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError' });
  expectStoreCode('PRIMARY_WRITE_FAILED', () =>
    store.updateExpense('2026-01', 'expense-example-1', { actual: 101 }));
  const snapshotKey = snapshotKeys(storage)[0];
  const relevant = storage.attempts.filter(entry => entry.key === snapshotKey || entry.key === STORAGE_KEY);
  assert.deepEqual(relevant, [
    { op: 'setItem', key: snapshotKey },
    { op: 'getItem', key: snapshotKey },
    { op: 'setItem', key: STORAGE_KEY }
  ]);
  assert.equal(storage.attempts.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 1200);
});

test('optional daily snapshot identifier failure warns but does not block a normal commit', () => {
  const { store, storage } = readyStore({ uuid: () => { throw new Error('unavailable'); } });
  store.updateExpense('2026-01', 'expense-example-1', { actual: 111 });
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 111);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-01'].expenses[0].actual, 111);
  assert.ok(store.getStatus().warnings.includes('IDENTIFIER_GENERATION_FAILED'));
});

test('optional daily snapshot set and readback faults warn, clean up, and still commit', () => {
  for (const fault of [
    { op: 'setItem', prefix: SNAPSHOT_PREFIX, name: 'QuotaExceededError', once: true },
    { op: 'getItem', prefix: SNAPSHOT_PREFIX, name: 'SecurityError', once: true }
  ]) {
    const { store, storage } = readyStore({ uuid: ids(`optional-${fault.op}`) });
    storage.fail(fault);
    store.updateExpense('2026-01', 'expense-example-1', { actual: 112 });
    assert.equal(store.getMonth('2026-01').expenses[0].actual, 112);
    assert.equal(snapshotKeys(storage).length, 0);
    assert.ok(store.getStatus().warnings.some(code => code.startsWith('SNAPSHOT_')));
  }
});

test('daily snapshots happen once per local date and retention keeps newest seven valid records', () => {
  const { store, storage, clock } = readyStore({ uuid: ids('snapshot') });
  for (let day = 15; day <= 23; day += 1) {
    clock.set(`2026-01-${day}T12:00:00.000Z`);
    store.updateExpense('2026-01', 'expense-example-1', { actual: 1200 + day });
    store.updateExpense('2026-01', 'expense-example-1', { actual: 1300 + day });
  }
  assert.equal(store.listSnapshots().length, SNAPSHOT_LIMIT);
  assert.equal(snapshotKeys(storage).length, SNAPSHOT_LIMIT);
  assert.deepEqual(store.listSnapshots().map(record => record.localDate),
    ['2026-01-23', '2026-01-22', '2026-01-21', '2026-01-20', '2026-01-19', '2026-01-18', '2026-01-17']);
});

test('a prune failure is retried by the next commit and returns physical valid keys to seven', () => {
  const { store, storage, clock } = readyStore({ uuid: ids('retry') });
  for (let day = 1; day <= 7; day += 1) {
    const date = String(day).padStart(2, '0');
    const envelope = Schema.buildSnapshot(makeBudget(), {
      createdAt: `2026-01-${date}T00:00:00.000Z`, localDate: `2026-01-${date}`, reason: 'daily'
    });
    storage.setItem(`${SNAPSHOT_PREFIX}old-${day}`, JSON.stringify(envelope));
  }
  clock.set('2026-01-15T12:00:00.000Z');
  storage.fail({ op: 'removeItem', prefix: SNAPSHOT_PREFIX, name: 'SecurityError', once: true });
  store.updateExpense('2026-01', 'expense-example-1', { actual: 201 });
  assert.equal(snapshotKeys(storage).length, 8);
  store.updateExpense('2026-01', 'expense-example-1', { actual: 202 });
  assert.equal(snapshotKeys(storage).length, 7);
  snapshotKeys(storage).forEach(key => Schema.parseSnapshot(storage.getItem(key)));
});

test('equal snapshot timestamps sort deterministically by key ID descending', () => {
  const first = Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-10T00:00:00.000Z', localDate: '2026-01-10', reason: 'daily'
  });
  const storage = new MemoryStorage({
    [STORAGE_KEY]: JSON.stringify(makeBudget()),
    [`${SNAPSHOT_PREFIX}alpha`]: JSON.stringify(first),
    [`${SNAPSHOT_PREFIX}omega`]: JSON.stringify(first)
  });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  store.load();
  assert.deepEqual(store.listSnapshots().map(item => item.id), ['omega', 'alpha']);
});

test('invalid snapshots are skipped without exposing their values', () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: JSON.stringify(makeBudget()),
    [`${SNAPSHOT_PREFIX}bad`]: '{not json'
  });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  store.load();
  assert.deepEqual(store.listSnapshots(), []);
  assert.ok(store.getStatus().warnings.includes('INVALID_SNAPSHOT_SKIPPED'));
});

test('import preview is write-free, stale-safe, and required snapshot failure aborts replacement', () => {
  const { store, storage } = readyStore({ uuid: ids('import') });
  const replacement = makeBudget();
  replacement.months['2026-01'].expenses[0].actual = 777;
  const backup = JSON.stringify(Schema.buildBackup(replacement, '2026-01-15T12:00:00.000Z'));
  const preview = store.previewImport(backup);
  assert.equal(preview.monthCount, 1);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem'), false);

  store.updateExpense('2026-01', 'expense-example-1', { actual: 600 });
  expectStoreCode('STALE_IMPORT_PREVIEW', () => store.commitImport(preview));

  const fresh = store.previewImport(backup);
  const beforeRaw = storage.getItem(STORAGE_KEY);
  const beforeData = store.getData();
  storage.fail({ op: 'setItem', prefix: SNAPSHOT_PREFIX, name: 'QuotaExceededError' });
  expectStoreCode('SNAPSHOT_WRITE_FAILED', () => store.commitImport(fresh));
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData);
});

test('malformed JSON, malformed envelope, and invalid nested schema imports are zero-write', () => {
  const { store, storage } = readyStore();
  const before = store.getData();
  const malformedEnvelope = JSON.stringify({ format: 'other', formatVersion: 1, exportedAt: '2026-01-15T12:00:00.000Z', data: makeBudget() });
  const invalid = Schema.buildBackup(makeBudget(), '2026-01-15T12:00:00.000Z');
  invalid.data.months['2026-01'].expenses[0].actual = -1;
  for (const text of ['{bad json', malformedEnvelope, JSON.stringify(invalid)]) {
    storage.operations.length = 0;
    expectStoreCode('INVALID_IMPORT', () => store.previewImport(text));
    assert.deepEqual(store.getData(), before);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  }
});

test('required import snapshot set and readback faults abort before primary with unchanged state', () => {
  for (const fault of [
    { op: 'setItem', prefix: SNAPSHOT_PREFIX, name: 'QuotaExceededError', once: true },
    { op: 'getItem', prefix: SNAPSHOT_PREFIX, name: 'SecurityError', once: true }
  ]) {
    const { store, storage } = readyStore({ uuid: ids(`required-${fault.op}`) });
    const replacement = makeBudget();
    replacement.months['2026-01'].expenses[0].actual = 888;
    const preview = store.previewImport(backupText(replacement));
    const beforeRaw = storage.getItem(STORAGE_KEY);
    const beforeData = store.getData();
    storage.operations.length = 0;
    storage.fail(fault);
    expectStoreCode(fault.op === 'setItem' ? 'SNAPSHOT_WRITE_FAILED' : 'SNAPSHOT_READ_FAILED',
      () => store.commitImport(preview));
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY), false);
  }
});

test('required snapshot set and readback precede exactly one changed import primary write', () => {
  const storage = new AttemptStorage({ [STORAGE_KEY]: JSON.stringify(makeBudget()) });
  const store = createStore({ storage, now: makeClock(), uuid: ids('required-order') });
  store.load();
  const changed = makeBudget();
  changed.months['2026-01'].expenses[0].actual = 919;
  const preview = store.previewImport(backupText(changed));
  storage.attempts.length = 0;
  store.commitImport(preview);
  const snapshotKey = snapshotKeys(storage)[0];
  const relevant = storage.attempts.filter(entry => entry.key === snapshotKey || entry.key === STORAGE_KEY);
  assert.deepEqual(relevant.slice(0, 3), [
    { op: 'setItem', key: snapshotKey },
    { op: 'getItem', key: snapshotKey },
    { op: 'setItem', key: STORAGE_KEY }
  ]);
  assert.equal(relevant.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);
});

test('no-op import performs no snapshot, cleanup, or primary write', () => {
  const { store, storage } = readyStore();
  const preview = store.previewImport(backupText(store.getData()));
  storage.operations.length = 0;
  store.commitImport(preview);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('valid import snapshots prior state, commits once, and round-trips export', () => {
  const { store, storage } = readyStore({ uuid: ids('import') });
  const replacement = makeBudget();
  replacement.months['2026-01'].expenses[0].actual = 444;
  const text = JSON.stringify(Schema.buildBackup(replacement, '2026-01-15T12:00:00.000Z'));
  store.commitImport(store.previewImport(text));
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 444);
  assert.equal(store.listSnapshots()[0].reason, 'pre-import');
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, 1);
  const exported = Schema.parseBackup(store.exportData());
  assert.deepEqual(exported.data, store.getData());
});

test('corrupt primary remains untouched with evidence fallback and blocks ordinary mutations', () => {
  const raw = '{damaged private bytes';
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  storage.fail({ op: 'setItem', key: CORRUPT_KEY, name: 'QuotaExceededError' });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  const result = store.load();
  assert.equal(result.state, 'recovery-required');
  assert.equal(result.hasEvidence, true);
  assert.ok(result.warnings.includes('EVIDENCE_WRITE_FAILED'));
  assert.equal(store.getCorruptEvidence(), raw);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  expectStoreCode('RECOVERY_REQUIRED', () => store.ensureMonth('2026-02'));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('recovery-required blocks every ordinary mutation and import commit entry point', () => {
  const raw = '{damaged';
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  store.load();
  const fakePreview = { generation: store.getStatus().generation, data: makeBudget() };
  const operations = [
    () => store.ensureMonth('2026-02'),
    () => store.addPaycheck('2026-01', { earnerId: 'earner-example-1', amount: 1, date: '' }),
    () => store.updatePaycheck('2026-01', 'x', { amount: 1 }),
    () => store.deletePaycheck('2026-01', 'x'),
    () => store.addExpense('2026-01', { categoryId: 'category-example-1', categoryItemId: null, name: 'x', actual: 0, paymentMethod: 'bank' }),
    () => store.updateExpense('2026-01', 'x', { actual: 1 }),
    () => store.updateExpensePaycheckAmount('2026-01', 'x', 'y', 1),
    () => store.deleteExpense('2026-01', 'x'),
    () => store.updateAllocations('2026-01', { savings: 0, credit_card_debt: 0, investments: 0 }),
    () => store.updateAllocation('2026-01', 'savings', 1),
    () => store.copyFromMonth('2026-02', '2026-01'),
    () => store.clearMonth('2026-01'),
    () => store.previewImport(backupText()),
    () => store.commitImport(fakePreview),
    () => store.importData(backupText())
  ];
  for (const operation of operations) {
    storage.operations.length = 0;
    expectStoreCode('RECOVERY_REQUIRED', operation);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  }
});

test('start fresh from recovery writes generic canonical data only after explicit action', () => {
  const raw = '{damaged';
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  store.load();
  const fresh = store.startFresh();
  Schema.validateActive(fresh);
  assert.deepEqual(fresh.settings.earners.map(earner => earner.name), ['Primary', 'Secondary']);
  assert.notEqual(storage.getItem(STORAGE_KEY), raw);
  assert.equal(store.getStatus().state, 'ready');
});

test('validated snapshot restore protects the current state and rejects unknown IDs', () => {
  const { store } = readyStore({ uuid: ids('restore') });
  store.updateExpense('2026-01', 'expense-example-1', { actual: 333 });
  const daily = store.listSnapshots()[0];
  store.updateExpense('2026-01', 'expense-example-1', { actual: 555 });
  expectStoreCode('SNAPSHOT_NOT_FOUND', () => store.restoreSnapshot('missing'));
  store.restoreSnapshot(daily.id);
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 1200);
  assert.ok(store.listSnapshots().some(snapshot => snapshot.reason === 'pre-import'));
});

test('recovery can restore an independently validated snapshot without overwriting first', () => {
  const snapshot = Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-14T12:00:00.000Z', localDate: '2026-01-14', reason: 'daily'
  });
  const storage = new MemoryStorage({
    [STORAGE_KEY]: '{damaged',
    [`${SNAPSHOT_PREFIX}known`]: JSON.stringify(snapshot)
  });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  assert.equal(store.load().state, 'recovery-required');
  storage.operations.length = 0;
  store.restoreSnapshot('known');
  assert.deepEqual(store.getData(), Schema.migrateActive(makeBudget()));
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, 1);
});

test('invalid, unknown, and unreadable snapshot restores leave primary and memory unchanged', () => {
  const invalidKey = `${SNAPSHOT_PREFIX}invalid`;
  const storage = new MemoryStorage({
    [STORAGE_KEY]: JSON.stringify(makeBudget()),
    [invalidKey]: '{bad'
  });
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  store.load();
  const beforeRaw = storage.getItem(STORAGE_KEY);
  const beforeData = store.getData();
  expectStoreCode('SNAPSHOT_NOT_FOUND', () => store.restoreSnapshot('invalid'));
  expectStoreCode('SNAPSHOT_NOT_FOUND', () => store.restoreSnapshot('unknown'));
  storage.fail({ op: 'getItem', key: invalidKey, name: 'SecurityError', once: true });
  expectStoreCode('SNAPSHOT_READ_FAILED', () => store.restoreSnapshot('invalid'));
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData);
});

test('selected valid snapshot restore is not blocked by an unrelated unreadable snapshot', () => {
  const selected = Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-14T12:00:00.000Z', localDate: '2026-01-14', reason: 'daily'
  });
  const selectedKey = `${SNAPSHOT_PREFIX}selected`;
  const unrelatedKey = `${SNAPSHOT_PREFIX}unrelated`;
  const active = makeBudget(); active.months['2026-01'].expenses[0].actual = 999;
  const storage = new AttemptStorage({
    [STORAGE_KEY]: JSON.stringify(active),
    [selectedKey]: JSON.stringify(selected),
    [unrelatedKey]: JSON.stringify(selected)
  });
  const store = createStore({ storage, now: makeClock(), uuid: ids('isolated-restore') });
  store.load();
  storage.attempts.length = 0;
  storage.fail({ op: 'getItem', key: unrelatedKey, name: 'SecurityError' });
  store.restoreSnapshot('selected');
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 1200);
  const selectedReads = storage.attempts.filter(entry => entry.op === 'getItem' && entry.key === selectedKey);
  const unrelatedReads = storage.attempts.filter(entry => entry.op === 'getItem' && entry.key === unrelatedKey);
  assert.ok(selectedReads.length >= 1);
  assert.ok(unrelatedReads.length >= 1, 'best-effort cleanup may inspect unrelated snapshots after commit');
  assert.ok(store.getStatus().warnings.includes('SNAPSHOT_READ_FAILED'));
});

test('changed restore at the snapshot cap prunes valid physical keys back to seven', () => {
  const active = makeBudget(); active.months['2026-01'].expenses[0].actual = 999;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(active) });
  for (let day = 1; day <= SNAPSHOT_LIMIT; day += 1) {
    const date = String(day).padStart(2, '0');
    const data = makeBudget(); data.months['2026-01'].expenses[0].actual = 100 + day;
    const envelope = Schema.buildSnapshot(data, {
      createdAt: `2026-01-${date}T00:00:00.000Z`, localDate: `2026-01-${date}`, reason: 'daily'
    });
    storage.setItem(`${SNAPSHOT_PREFIX}capped-${day}`, JSON.stringify(envelope));
  }
  const store = createStore({ storage, now: makeClock(), uuid: ids('restore-cap') });
  store.load();
  store.restoreSnapshot('capped-7');
  assert.equal(store.getMonth('2026-01').expenses[0].actual, 107);
  assert.equal(snapshotKeys(storage).length, SNAPSHOT_LIMIT);
  snapshotKeys(storage).forEach(key => Schema.parseSnapshot(storage.getItem(key)));
});

test('cleanup failure after the primary commit is a warning and memory follows committed bytes', () => {
  const initial = makeBudget();
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(initial) });
  const clock = makeClock();
  const store = createStore({ storage, now: clock, uuid: ids('cleanup') });
  store.load();
  for (let index = 0; index < SNAPSHOT_LIMIT; index += 1) {
    const day = String(1 + index).padStart(2, '0');
    const snapshot = Schema.buildSnapshot(initial, {
      createdAt: `2026-01-${day}T00:00:00.000Z`, localDate: `2026-01-${day}`, reason: 'daily'
    });
    storage.setItem(`${SNAPSHOT_PREFIX}old-${index}`, JSON.stringify(snapshot));
  }
  storage.fail({ op: 'removeItem', prefix: SNAPSHOT_PREFIX, name: 'SecurityError' });
  store.updateExpense('2026-01', 'expense-example-1', { actual: 222 });
  assert.equal(store.getData().months['2026-01'].expenses[0].actual, 222);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-01'].expenses[0].actual, 222);
  assert.ok(store.getStatus().warnings.includes('SNAPSHOT_CLEANUP_FAILED'));
  assert.ok(snapshotKeys(storage).length > SNAPSHOT_LIMIT);
});

test('invalid clocks are redacted for exports and do not write', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeBudget()) });
  const store = createStore({ storage, now: () => { throw new Error('private clock detail'); }, uuid: ids() });
  store.load();
  expectStoreCode('CLOCK_FAILED', () => store.exportData());
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem').length, 0);
});

test('store errors remain redacted and never include adapter messages or values', () => {
  const { store, storage } = readyStore();
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'SecurityError' });
  let caught;
  try { store.updateExpense('2026-01', 'expense-example-1', { actual: 321 }); }
  catch (error) { caught = error; }
  assert.equal(caught.code, 'PRIMARY_WRITE_FAILED');
  assert.equal(caught.message, 'Budget storage error (PRIMARY_WRITE_FAILED)');
  assert.doesNotMatch(caught.message, /Injected|321|expense-example/);
  assert.equal(Object.hasOwn(caught, 'cause'), false);
});

test('invalid import errors do not retain JSON parser or schema causes', () => {
  const { store } = readyStore();
  let caught;
  try { store.previewImport('{private malformed bytes'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'INVALID_IMPORT');
  assert.equal(Object.hasOwn(caught, 'cause'), false);
  assert.doesNotMatch(caught.message, /private|JSON|position/i);
});
