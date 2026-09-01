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
  if (overrides) overrides(data);
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

function loaded(raw, options = {}) {
  const storage = options.storage || new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(raw) });
  let sequence = 0;
  const store = createStore({
    storage,
    now: options.now || (() => new Date('2026-08-31T12:00:00.000Z')),
    uuid: options.uuid || (() => `cleared-${++sequence}`),
    schemaPolicy: options.schemaPolicy
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage };
}

function request(kind, recordId, cleared = true) {
  return { monthKey: '2026-01', kind, recordId, cleared };
}

function snapshotKeys(storage) {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter(key => key.startsWith(SNAPSHOT_PREFIX));
}

test('legacy v3 checklist is frozen, unavailable, write-free, and cannot take a direct v5 mutation', () => {
  const raw = makeV3Budget(); const { store, storage } = loaded(raw);
  const before = store.getStatus(); const primary = storage.getItem(STORAGE_KEY); storage.operations.length = 0;
  const checklist = store.getClearedChecklist('2026-01');
  assert.deepEqual(checklist, {
    monthKey: '2026-01', available: false, unavailableReason: 'exact-money-upgrade-required',
    items: { income: [], expenses: [] },
    counts: { paycheckCount: 0, expenseCount: 0, eligibleCount: 0, ineligibleCount: 0, clearedCount: 0, unclearedCount: 0 }
  });
  assert.equal(Object.isFrozen(checklist), true); assert.equal(Object.isFrozen(checklist.items), true);
  expectCode('CLEARED_CHECKLIST_UNAVAILABLE', () => store.setRecordCleared(request('income', 'paycheck-example-1')));
  assert.deepEqual(store.getStatus(), before); assert.equal(storage.getItem(STORAGE_KEY), primary);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
});

test('v4 checklist preserves null, entered zero, dates, hostile text, eligibility and canonical order without writes', () => {
  const persisted = v4Data(data => {
    const month = data.months['2026-01'];
    month.paychecks[0].earner = 'Hostile <earner> & "quoted"';
    month.paychecks[0].actualAmount = 0;
    month.expenses[0].name = 'Hostile <bill> & "quoted"';
    month.expenses[0].actualAmount = null;
    month.expenses[0].date = '';
  });
  const { store, storage } = loaded(persisted);
  const primary = storage.getItem(STORAGE_KEY); const before = store.getStatus(); storage.operations.length = 0;
  const first = store.getClearedChecklist('2026-01'); const second = store.getClearedChecklist('2026-01');
  assert.deepEqual(first, second); assert.notStrictEqual(first, second);
  assert.equal(first.available, true);
  assert.deepEqual(first.items.income.map(item => [item.recordId, item.actualAmount, item.cleared, item.eligible]),
    [['paycheck-example-1', 0, false, true]]);
  assert.deepEqual(first.items.expenses.map(item => [item.recordId, item.actualAmount, item.cleared, item.eligibilityReason]),
    [['expense-example-1', null, false, 'actual-and-date-needed']]);
  assert.equal(first.items.income[0].earner, 'Hostile <earner> & "quoted"');
  assert.equal(first.items.expenses[0].name, 'Hostile <bill> & "quoted"');
  assert.deepEqual(first.counts, { paycheckCount: 1, expenseCount: 1, eligibleCount: 1,
    ineligibleCount: 1, clearedCount: 0, unclearedCount: 2 });
  assert.equal(Object.isFrozen(first.items.income[0]), true);
  assert.deepEqual(store.getStatus(), before); assert.equal(storage.getItem(STORAGE_KEY), primary);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
});

test('first true mutation migrates v4 to v5 only after a verified v4 snapshot and one primary write', () => {
  const persisted = v4Data(); const { store, storage } = loaded(persisted);
  store.setRecordCleared(request('income', 'paycheck-example-1'));
  const snapshotWrite = storage.operations.findIndex(operation => operation.op === 'setItem' && operation.key.startsWith(SNAPSHOT_PREFIX));
  const snapshotRead = storage.operations.findIndex(operation => operation.op === 'getItem' && operation.key.startsWith(SNAPSHOT_PREFIX));
  const primaryWrites = storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY);
  const primaryWrite = storage.operations.findIndex(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY);
  assert.ok(snapshotWrite >= 0 && snapshotRead > snapshotWrite && primaryWrite > snapshotRead);
  assert.equal(primaryWrites.length, 1);
  const snapshotRaw = storage.getItem(snapshotKeys(storage)[0]);
  assert.equal(JSON.parse(snapshotRaw).data.schemaVersion, 4);
  assert.doesNotThrow(() => Schema.parseV4Snapshot(snapshotRaw));
  const active = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(active.schemaVersion, 5); assert.equal(active.months['2026-01'].paychecks[0].cleared, true);
  assert.equal(active.months['2026-01'].expenses[0].cleared, false);
  assert.equal(store.getStatus().residentSchemaVersion, 5);
});

test('false v4 no-op and ineligible requests do not migrate or touch storage', () => {
  const persisted = v4Data(); const { store, storage } = loaded(persisted);
  const raw = storage.getItem(STORAGE_KEY); const before = store.getStatus(); storage.operations.length = 0;
  const unchanged = store.setRecordCleared(request('income', 'paycheck-example-1', false));
  assert.equal(unchanged.cleared, false);
  expectCode('CLEARED_RECORD_INELIGIBLE', () => store.setRecordCleared(request('expense', 'expense-example-1', true)));
  assert.equal(storage.getItem(STORAGE_KEY), raw); assert.deepEqual(store.getStatus(), before);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  assert.equal(snapshotKeys(storage).length, 0);
});

test('migration clock, UUID, snapshot write/read, and primary faults preserve v4 bytes, memory, resident version and generation', () => {
  const cases = [
    { code: 'CLOCK_FAILED', now: () => { throw new Error('clock'); }, uuid: () => 'unused' },
    { code: 'IDENTIFIER_GENERATION_FAILED', uuid: () => { throw new Error('uuid'); } },
    { code: 'SNAPSHOT_WRITE_FAILED', fault: storage => storage.fail({ op: 'setItem', prefix: SNAPSHOT_PREFIX, once: true }) },
    { code: 'SNAPSHOT_READ_FAILED', fault: storage => storage.fail({ op: 'getItem', prefix: SNAPSHOT_PREFIX, once: true }) },
    { code: 'PRIMARY_WRITE_FAILED', fault: storage => storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true }) }
  ];
  for (const item of cases) {
    const persisted = v4Data(); const raw = JSON.stringify(persisted);
    const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
    const { store } = loaded(persisted, { storage, now: item.now, uuid: item.uuid });
    const beforeData = store.getData(); const before = store.getStatus(); item.fault?.(storage); storage.operations.length = 0;
    expectCode(item.code, () => store.setRecordCleared(request('income', 'paycheck-example-1')));
    assert.equal(storage.getItem(STORAGE_KEY), raw, item.code);
    assert.deepEqual(store.getData(), beforeData, item.code); assert.deepEqual(store.getStatus(), before, item.code);
    assert.equal(store.getStatus().residentSchemaVersion, 4, item.code);
  }
});

test('v5 eligibility is narrow, set is atomic, same values are no-ops, and invalid requests fail closed', () => {
  const persisted = v5Data(); const { store, storage } = loaded(persisted);
  const raw = storage.getItem(STORAGE_KEY); const generation = store.getStatus().generation; storage.operations.length = 0;
  const same = store.setRecordCleared(request('income', 'paycheck-example-1', true));
  assert.equal(same.cleared, true); assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(store.getStatus().generation, generation);
  store.setRecordCleared(request('income', 'paycheck-example-1', false));
  assert.equal(store.getClearedChecklist('2026-01').items.income[0].cleared, false);
  for (const invalid of [null, {}, { ...request('income', 'paycheck-example-1'), extra: true },
    request('paycheck', 'paycheck-example-1'), request('income', '', true),
    { ...request('income', 'paycheck-example-1'), cleared: 1 }]) {
    expectCode('INVALID_CLEARED_REQUEST', () => store.setRecordCleared(invalid));
  }
  for (const monthKey of ['2026-1', '2026-13', 'bad']) expectCode('INVALID_MONTH', () => store.getClearedChecklist(monthKey));
  expectCode('MONTH_NOT_FOUND', () => store.setRecordCleared({ ...request('income', 'paycheck-example-1'), monthKey: '2026-02' }));
  expectCode('EXPENSE_NOT_FOUND', () => store.setRecordCleared(request('expense', 'missing')));
});

test('actual, date, expense name and payment-method changes reset cleared while identical edits do not', () => {
  const resetCases = [
    ['paycheck actual', store => store.updatePaycheck('2026-01', 'paycheck-example-1', { actualAmount: 2499 })],
    ['paycheck date', store => store.editPaycheck('2026-01', 'paycheck-example-1', { date: '2026-01-16' })],
    ['expense actual', store => store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1199 })],
    ['expense date', store => store.editExpense('2026-01', 'expense-example-1', { date: '2026-01-16' })],
    ['expense name', store => store.updateExpense('2026-01', 'expense-example-1', { name: 'Changed' })],
    ['expense method', store => store.editExpense('2026-01', 'expense-example-1', { paymentMethod: 'credit_card' })]
  ];
  for (const [label, mutate] of resetCases) {
    const persisted = v5Data(data => { data.months['2026-01'].expenses[0].date = '2026-01-15'; });
    const { store } = loaded(persisted); mutate(store);
    const data = store.getData(); const record = label.startsWith('paycheck')
      ? data.months['2026-01'].paychecks[0] : data.months['2026-01'].expenses[0];
    assert.equal(record.cleared, false, label);
  }

  const persisted = v5Data(data => { data.months['2026-01'].expenses[0].date = '2026-01-15'; });
  const { store, storage } = loaded(persisted); const raw = storage.getItem(STORAGE_KEY); const generation = store.getStatus().generation;
  storage.operations.length = 0;
  store.editPaycheck('2026-01', 'paycheck-example-1', { actualAmount: 2500, date: '2026-01-15' });
  store.editExpense('2026-01', 'expense-example-1', { name: 'Rent', actualAmount: 1200,
    date: '2026-01-15', paymentMethod: 'bank' });
  assert.equal(storage.getItem(STORAGE_KEY), raw); assert.equal(store.getStatus().generation, generation);
  assert.equal(store.getData().months['2026-01'].paychecks[0].cleared, true);
  assert.equal(store.getData().months['2026-01'].expenses[0].cleared, true);
});

test('planned, funding, structure, reorder, catalog, template, and earner changes preserve cleared', () => {
  const persisted = v5Data(data => {
    data.settings.earners.push({ id: 'earner-two', name: 'Second', archived: false });
    data.categories.push({ id: 'category-two', name: 'Second category', archived: false,
      items: [{ id: 'item-two', name: 'Rent', archived: false }] });
    data.months['2026-01'].expenses[0].date = '2026-01-15';
  });
  const { store } = loaded(persisted);
  store.updatePaycheck('2026-01', 'paycheck-example-1', { plannedAmount: 2600 });
  store.reassignPaycheckEarner('2026-01', 'paycheck-example-1', 'earner-two');
  store.updateExpense('2026-01', 'expense-example-1', { plannedAmount: 1250 });
  store.updateExpensePaycheckAmount('2026-01', 'expense-example-1', 'paycheck-example-1', 1100);
  store.reassignExpenseStructure('2026-01', 'expense-example-1', {
    categoryId: 'category-two', categoryItemId: 'item-two', name: 'ignored'
  });
  store.reorderPaychecks('2026-01', ['paycheck-example-1']); store.reorderExpenses('2026-01', ['expense-example-1']);
  store.renameEarner('earner-two', 'Second renamed'); store.renameCategory('category-two', 'Category renamed');
  assert.equal(store.getData().months['2026-01'].paychecks[0].cleared, true);
  assert.equal(store.getData().months['2026-01'].expenses[0].cleared, true);
});

test('new and copied records start false and expense undo restores the exact flag', () => {
  const persisted = v5Data(data => { data.months['2026-01'].expenses[0].date = '2026-01-15'; });
  const { store } = loaded(persisted, { uuid: (() => { let i = 0; return () => `new-${++i}`; })() });
  const addedPaycheck = store.addPaycheck('2026-01', {
    earnerId: 'earner-example-1', plannedAmount: 10, actualAmount: 0, date: '2026-01-20'
  });
  const addedExpense = store.addExpense('2026-01', {
    categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'ignored', date: '2026-01-20',
    paycheckAmounts: {}, plannedAmount: 10, actualAmount: 0, paymentMethod: 'bank'
  });
  assert.equal(addedPaycheck.cleared, false); assert.equal(addedExpense.cleared, false);
  const copied = store.copyFromMonth('2026-02', '2026-01');
  assert.equal(copied.paychecks.every(record => record.cleared === false), true);
  assert.equal(copied.expenses.every(record => record.cleared === false), true);
  const receipt = store.deleteExpense('2026-01', 'expense-example-1');
  const restored = store.undoDeleteExpense(receipt); assert.equal(restored.cleared, true);
});

test('recurring-generated income and expenses start uncleared in a v5 resident store', () => {
  const persisted = v5Data(data => {
    data.templates.income.push({
      id: 'income-template', name: 'Generated income', earnerId: 'earner-example-1',
      plannedAmount: 50, enabled: true, archived: false, startDate: '2026-02-01', endDate: null,
      recurrence: { cadence: 'monthly', day: 1 }
    });
    data.templates.expenses.push({
      id: 'expense-template', name: 'Generated expense', categoryId: 'category-example-1',
      categoryItemId: 'item-example-1', plannedAmount: 25, paymentMethod: 'bank',
      enabled: true, archived: false, startDate: '2026-02-01', endDate: null,
      recurrence: { cadence: 'monthly', day: 1 }
    });
  });
  const { store } = loaded(persisted);
  const preview = store.previewRecurringMonth('2026-02');
  assert.deepEqual(store.applyRecurringPreview(preview), { addedIncome: 1, addedExpenses: 1 });
  const month = store.getData().months['2026-02'];
  assert.equal(month.paychecks[0].cleared, false);
  assert.equal(month.expenses[0].cleared, false);
});

test('v5 backup import and snapshot restore retain explicit dispatch and flags', () => {
  const persisted = v5Data(data => { data.months['2026-01'].expenses[0].date = '2026-01-15'; });
  const runtime = Schema.hydrateV5ExactMoney(persisted);
  const backup = Schema.buildV5Backup(runtime, '2026-08-31T12:00:00.000Z');
  const target = loaded(v4Data()).store;
  target.commitImport(target.previewImport(JSON.stringify(backup)));
  assert.equal(target.getStatus().residentSchemaVersion, 5);
  assert.equal(target.getData().months['2026-01'].paychecks[0].cleared, true);

  const snapshot = Schema.buildV5Snapshot(runtime, {
    createdAt: '2026-08-31T12:00:00.000Z', localDate: '2026-08-31', reason: 'daily'
  });
  const key = `${SNAPSHOT_PREFIX}known-v5`;
  const storage = new MemoryStorage({ [STORAGE_KEY]: '{damaged', [key]: JSON.stringify(snapshot) });
  const recovery = createStore({ storage }); assert.equal(recovery.load().state, 'recovery-required');
  recovery.restoreSnapshot('known-v5');
  assert.equal(recovery.getStatus().residentSchemaVersion, 5);
  assert.equal(recovery.getData().months['2026-01'].expenses[0].cleared, true);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schemaVersion, 5);
});
