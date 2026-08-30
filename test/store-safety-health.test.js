'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, SNAPSHOT_PREFIX, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage, makeClock } = require('./helpers.js');

function ids(prefix = 'id') { let count = 0; return () => `${prefix}-${++count}`; }
function ready(budget = makeV3Budget(), storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) })) {
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  assert.equal(store.load().state, 'ready'); storage.operations.length = 0;
  return { store, storage };
}
function code(expected, fn) {
  assert.throws(fn, error => error instanceof StoreError && error.code === expected);
}
function backup(data) { return JSON.stringify(Schema.buildBackup(data, '2026-08-29T20:00:00.000Z')); }
function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseObjectKeys(value[key])]));
}

test('copy clears paycheck actuals for null, zero, and nonzero sources without mutating source', () => {
  const budget = makeV3Budget();
  budget.months['2026-01'].paychecks.push(
    { ...budget.months['2026-01'].paychecks[0], id: 'p-zero', actualAmount: 0 },
    { ...budget.months['2026-01'].paychecks[0], id: 'p-null', actualAmount: null }
  );
  const { store } = ready(budget); const sourceBefore = store.getMonth('2026-01');
  const copied = store.copyFromMonth('2026-02', '2026-01');
  assert.deepEqual(copied.paychecks.map(item => item.actualAmount), [null, null, null]);
  assert.deepEqual(store.getMonth('2026-01'), sourceBefore);
});

test('expense deletion receipt is opaque, exact, one-use, same-store, and generation-bound', () => {
  const { store } = ready();
  const receipt = store.deleteExpense('2026-01', 'expense-example-1');
  assert.equal(Object.isFrozen(receipt), true); assert.deepEqual(Reflect.ownKeys(receipt), []);
  assert.equal(Object.getPrototypeOf(receipt), null);
  const restored = store.undoDeleteExpense(receipt);
  assert.equal(restored.id, 'expense-example-1');
  assert.equal(store.getMonth('2026-01').expenses[0].id, 'expense-example-1');
  code('INVALID_DELETE_RECEIPT', () => store.undoDeleteExpense(receipt));
  code('INVALID_DELETE_RECEIPT', () => store.undoDeleteExpense(Object.freeze(Object.create(null))));

  const stale = store.deleteExpense('2026-01', 'expense-example-1');
  store.updateAllocation('2026-01', 'savings', 401);
  code('STALE_DELETE_RECEIPT', () => store.undoDeleteExpense(stale));
  code('INVALID_DELETE_RECEIPT', () => store.undoDeleteExpense(stale));

  const other = ready().store;
  const cross = other.deleteExpense('2026-01', 'expense-example-1');
  code('INVALID_DELETE_RECEIPT', () => store.undoDeleteExpense(cross));
});

test('generated expense undo removes only the tombstone created by its delete and restores order', () => {
  const budget = makeV3Budget(); budget.months = {};
  const { store } = ready(budget);
  store.addExpenseTemplate({ name: 'Synthetic', categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    plannedAmount: 100, paymentMethod: 'bank', enabled: true, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 } });
  store.applyRecurringPreview(store.previewRecurringMonth('2026-01'));
  store.addExpense('2026-01', { categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'ignored',
    date: '', paycheckAmounts: {}, plannedAmount: 20, actualAmount: null, paymentMethod: 'bank' });
  const generated = store.getMonth('2026-01').expenses[0];
  const receipt = store.deleteExpense('2026-01', generated.id);
  assert.equal(store.getMonth('2026-01').suppressedOccurrences.length, 1);
  store.undoDeleteExpense(receipt);
  const month = store.getMonth('2026-01');
  assert.deepEqual(month.expenses.map(item => item.id), [generated.id, month.expenses[1].id]);
  assert.equal(month.suppressedOccurrences.length, 0);
});

test('undo primary fault changes neither memory nor primary and consumes the receipt', () => {
  const { store, storage } = ready();
  const receipt = store.deleteExpense('2026-01', 'expense-example-1');
  const before = store.getData(); const raw = storage.getItem(STORAGE_KEY);
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  code('PRIMARY_WRITE_FAILED', () => store.undoDeleteExpense(receipt));
  assert.deepEqual(store.getData(), before); assert.equal(storage.getItem(STORAGE_KEY), raw);
  code('INVALID_DELETE_RECEIPT', () => store.undoDeleteExpense(receipt));
});

test('actual resolution preview is frozen, explicit, one-use, stale-safe, and applies zero atomically', () => {
  const budget = makeV3Budget();
  budget.months['2026-01'].paychecks[0].actualAmount = null;
  budget.months['2026-01'].expenses[0].actualAmount = null;
  const { store, storage } = ready(budget);
  const beforeRaw = storage.getItem(STORAGE_KEY); storage.operations.length = 0;
  const preview = store.previewActualResolutions([
    { kind: 'income', monthKey: '2026-01', recordId: 'paycheck-example-1', actualAmount: 0 },
    { kind: 'expense', monthKey: '2026-01', recordId: 'expense-example-1', actualAmount: 75 }
  ]);
  assert.equal(Object.isFrozen(preview), true); assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.equal(storage.operations.some(op => op.op === 'setItem'), false);
  store.applyActualResolutions(preview);
  assert.equal(store.getMonth('2026-01').paychecks[0].actualAmount, 0);
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 75);
  code('INVALID_ACTUAL_RESOLUTION_PREVIEW', () => store.applyActualResolutions(preview));
  code('INVALID_ACTUAL_RESOLUTIONS', () => store.previewActualResolutions([]));
  code('ACTUAL_ALREADY_RESOLVED', () => store.previewActualResolutions([
    { kind: 'income', monthKey: '2026-01', recordId: 'paycheck-example-1', actualAmount: 1 }
  ]));
});

test('actual resolution stale and write faults are failure-safe and capabilities cannot be forged', () => {
  const budget = makeV3Budget(); budget.months['2026-01'].expenses[0].actualAmount = null;
  const first = ready(budget); const proposal = [{ kind: 'expense', monthKey: '2026-01', recordId: 'expense-example-1', actualAmount: 0 }];
  const stale = first.store.previewActualResolutions(proposal);
  first.store.updateAllocation('2026-01', 'savings', 401);
  code('STALE_ACTUAL_RESOLUTION_PREVIEW', () => first.store.applyActualResolutions(stale));
  code('INVALID_ACTUAL_RESOLUTION_PREVIEW', () => first.store.applyActualResolutions({ ...stale }));

  const second = ready(budget); const preview = second.store.previewActualResolutions(proposal);
  const before = second.store.getData(); const raw = second.storage.getItem(STORAGE_KEY);
  second.storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  code('PRIMARY_WRITE_FAILED', () => second.store.applyActualResolutions(preview));
  assert.deepEqual(second.store.getData(), before); assert.equal(second.storage.getItem(STORAGE_KEY), raw);
  code('INVALID_ACTUAL_RESOLUTION_PREVIEW', () => second.store.applyActualResolutions(preview));
});

test('blank-date repair is previewed, cancel-safe, atomic, and capability-bound', () => {
  const budget = makeV3Budget();
  budget.months['2026-01'].paychecks[0].date = '';
  const { store, storage } = ready(budget);
  const before = storage.getItem(STORAGE_KEY); const preview = store.previewDefaultDateResolutions();
  assert.equal(Object.isFrozen(preview), true);
  assert.deepEqual(preview.resolutions.map(item => [item.kind, item.date]), [['income', '2026-01-01'], ['expense', '2026-01-01']]);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  assert.equal(storage.operations.some(item => item.op === 'setItem'), false);
  store.applyDefaultDateResolutions(preview);
  assert.equal(store.getMonth('2026-01').paychecks[0].date, '2026-01-01');
  assert.equal(store.getMonth('2026-01').expenses[0].date, '2026-01-01');
  code('INVALID_DATE_RESOLUTION_PREVIEW', () => store.applyDefaultDateResolutions(preview));
  code('INVALID_DATE_RESOLUTION_PREVIEW', () => store.applyDefaultDateResolutions({ ...preview }));
});

test('actual resolution preview rejects individual and aggregate schema limits without writes', () => {
  const budget = makeV3Budget();
  budget.months['2026-01'].paychecks[0].actualAmount = null;
  budget.months['2026-01'].paychecks.push({
    ...budget.months['2026-01'].paychecks[0], id: 'paycheck-example-2', actualAmount: null
  });
  const { store, storage } = ready(budget);
  const before = store.getData(); const raw = storage.getItem(STORAGE_KEY);
  const attempts = [
    [{ kind: 'income', monthKey: '2026-01', recordId: 'paycheck-example-1', actualAmount: 1_000_000_000_001 }],
    [
      { kind: 'income', monthKey: '2026-01', recordId: 'paycheck-example-1', actualAmount: 600_000_000_000 },
      { kind: 'income', monthKey: '2026-01', recordId: 'paycheck-example-2', actualAmount: 600_000_000_000 }
    ]
  ];
  for (const proposals of attempts) {
    storage.operations.length = 0;
    code('INVALID_ACTUAL_RESOLUTIONS', () => store.previewActualResolutions(proposals));
    assert.deepEqual(store.getData(), before);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.operations.some(op => op.op === 'setItem' || op.op === 'removeItem'), false);
  }
});

test('health and additive comparison are frozen, detached, parser-backed, classified, and write-free', () => {
  const { store, storage } = ready(); const raw = storage.getItem(STORAGE_KEY); storage.operations.length = 0;
  const health = store.getDataHealth(); assert.equal(Object.isFrozen(health), true);
  const candidate = store.getData();
  candidate.months['2026-02'] = Schema.clone(candidate.months['2026-01']);
  candidate.months['2026-02'].paychecks = []; candidate.months['2026-02'].expenses = [];
  const comparison = store.compareAdditiveBackup(backup(candidate));
  assert.deepEqual(comparison.months.identical, ['2026-01']);
  assert.deepEqual(comparison.months.addable, ['2026-02']);
  assert.deepEqual(comparison.months.conflicting, []);
  assert.deepEqual(comparison.structure, { categories: 'identical', earners: 'identical', templates: 'identical' });
  assert.equal(Object.isFrozen(comparison.months), true);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.some(op => op.op === 'setItem' || op.op === 'removeItem'), false);
  code('INVALID_COMPARISON_BACKUP', () => store.compareAdditiveBackup('{bad'));

  const conflict = store.getData(); conflict.months['2026-01'].expenses[0].actualAmount = 0;
  conflict.categories[0].name = 'Changed';
  const classified = store.compareAdditiveBackup(backup(conflict));
  assert.deepEqual(classified.months.conflicting, ['2026-01']);
  assert.equal(classified.structure.categories, 'conflicting');

  const additiveStructure = store.getData();
  additiveStructure.settings.earners.push({ id: 'earner-added', name: 'Added', archived: false });
  const structural = store.compareAdditiveBackup(backup(additiveStructure));
  assert.equal(structural.structure.earners, 'addable');
});

test('additive comparison ignores object key order recursively while preserving array order', () => {
  const budget = makeV3Budget();
  budget.months['2026-01'].paychecks.push({ ...budget.months['2026-01'].paychecks[0], id: 'paycheck-example-2' });
  budget.months['2026-01'].expenses[0].paycheckAmounts['paycheck-example-2'] = 0;
  const { store, storage } = ready(budget); const raw = storage.getItem(STORAGE_KEY);
  const reordered = reverseObjectKeys(store.getData());
  const comparison = store.compareAdditiveBackup(backup(reordered));
  assert.deepEqual(comparison.months.identical, ['2026-01']);
  assert.deepEqual(comparison.structure, { categories: 'identical', earners: 'identical', templates: 'identical' });
  assert.equal(storage.getItem(STORAGE_KEY), raw);

  const reversedArray = store.getData();
  reversedArray.months['2026-01'].paychecks.reverse();
  const conflict = store.compareAdditiveBackup(backup(reversedArray));
  assert.deepEqual(conflict.months.conflicting, ['2026-01']);
});
