'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const {
  STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, SNAPSHOT_LIMIT, StoreError, createStore
} = require('../js/data.js');
const { makeV1Budget, makeV2Budget, makeV3Budget: makeBudget, MemoryStorage, makeClock } = require('./helpers.js');

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

function readyV3Store({ budget = Schema.migrateToV3(makeBudget()), storage, clock = makeClock(), uuid = ids('v3') } = {}) {
  storage ||= new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  const store = createStore({ storage, now: clock, uuid, schemaPolicy: Schema.V3_SCHEMA_POLICY });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, clock };
}

function incomeTemplate(overrides = {}) {
  return {
    name: 'Primary payday', earnerId: 'earner-example-1', plannedAmount: 1200,
    enabled: true, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 15 }, ...overrides
  };
}

function expenseTemplate(overrides = {}) {
  return {
    name: 'Rent', categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    plannedAmount: 700, paymentMethod: 'bank', enabled: true,
    startDate: '2026-01-01', endDate: null, recurrence: { cadence: 'monthly', day: 31 }, ...overrides
  };
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

function makeStructureBudget() {
  const budget = makeBudget();
  budget.categories.push({
    id: 'category-example-2', name: 'Travel', archived: false,
    items: [{ id: 'item-example-2', name: 'Fare', archived: false }]
  });
  budget.settings.earners.push({ id: 'earner-example-2', name: 'Example Two', archived: false });
  return budget;
}

function makeOrderedMonthBudget() {
  const budget = makeStructureBudget();
  const month = budget.months['2026-01'];
  month.paychecks.push(
    { id: 'paycheck-example-2', earnerId: 'earner-example-2', earner: 'Historical Two', plannedAmount: 800, actualAmount: 800, date: '2026-01-20', sourceTemplateId: null, occurrenceKey: null },
    { id: 'paycheck-example-3', earnerId: 'earner-example-1', earner: 'Historical One', plannedAmount: 600, actualAmount: 600, date: '', sourceTemplateId: null, occurrenceKey: null }
  );
  month.expenses.push(
    {
      id: 'expense-example-2', categoryId: 'category-example-2', category: 'Historical Travel',
      categoryItemId: 'item-example-2', name: 'Historical fare',
      date: '', paycheckAmounts: { 'paycheck-example-2': 300 }, plannedAmount: 300, actualAmount: 280,
      paymentMethod: 'credit_card', sourceTemplateId: null, occurrenceKey: null
    },
    {
      id: 'expense-example-3', categoryId: 'category-example-1', category: 'Historical Home',
      categoryItemId: null, name: 'Custom service',
      date: '', paycheckAmounts: { 'paycheck-example-1': 50, 'paycheck-example-3': 75 }, plannedAmount: 125,
      actualAmount: 120, paymentMethod: 'bank', sourceTemplateId: null, occurrenceKey: null
    }
  );
  return budget;
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
  assert.equal(store.getData().schemaVersion, 3);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem').length, 0);
});

test('valid v0, v1, v2, and v3 loads are write-free and do not prune snapshots', () => {
  const v1 = makeV1Budget();
  const v0 = structuredClone(v1); delete v0.schemaVersion;
  for (const budget of [v0, v1, makeV2Budget(), makeBudget()]) {
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
    assert.equal(store.getData().schemaVersion, 3);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
    assert.equal(snapshotKeys(storage).length, SNAPSHOT_LIMIT + 2);
  }
});

test('failed first persistence after v1 load preserves exact v1 bytes and canonical v3 memory', () => {
  const v1Raw = JSON.stringify(makeV1Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: v1Raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids('first-write') });
  store.load();
  const before = store.getData();
  assert.equal(before.schemaVersion, 3);
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 999 }));
  assert.equal(storage.getItem(STORAGE_KEY), v1Raw);
  assert.deepEqual(store.getData(), before);
});

test('v2 raw load stays byte-exact until the first successful mutation persists canonical v3', () => {
  const raw = JSON.stringify(makeV2Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids('v2-write') });
  assert.equal(store.load().state, 'ready');
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(store.getData().schemaVersion, 3);
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 777 });
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.months['2026-01'].expenses[0].actualAmount, 777);
  assert.equal(Object.hasOwn(persisted.months['2026-01'].expenses[0], 'actual'), false);
});

test('v0, v1, and v2 backup and snapshot envelopes migrate through active v3 Store paths without preview writes', () => {
  const v1 = makeV1Budget(); const v0 = structuredClone(v1); delete v0.schemaVersion;
  const legacy = [v0, v1, makeV2Budget()];
  const envelope = (format, data, index) => JSON.stringify(format === 'zerobudget-backup' ? {
    format, formatVersion: 1, exportedAt: `2026-01-${String(index + 10).padStart(2, '0')}T12:00:00.000Z`, data
  } : {
    format, formatVersion: 1, createdAt: `2026-01-${String(index + 10).padStart(2, '0')}T12:00:00.000Z`,
    localDate: `2026-01-${String(index + 10).padStart(2, '0')}`, reason: 'daily', data
  });
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeBudget()) });
  legacy.forEach((data, index) => storage.setItem(`${SNAPSHOT_PREFIX}legacy-${index}`,
    envelope('zerobudget-snapshot', data, index)));
  const store = createStore({ storage, now: makeClock(), uuid: ids('envelope-v2') });
  store.load(); storage.operations.length = 0;
  legacy.forEach((data, index) => {
    const preview = store.previewImport(envelope('zerobudget-backup', data, index));
    assert.equal(preview.data.schemaVersion, 3);
    assert.equal(preview.data.months['2026-01'].expenses[0].actualAmount, 1200);
  });
  assert.deepEqual(store.listSnapshots().map(record => record.data.schemaVersion), [3, 3, 3]);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('active v3 policy owns canonical defaults and exposes template APIs', () => {
  const active = readyStore();
  assert.deepEqual(active.store.getIncomeTemplates(), []);
  assert.equal(active.store.addIncomeTemplate(incomeTemplate()).name, 'Primary payday');

  const storage = new MemoryStorage();
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  assert.equal(store.load().state, 'empty');
  assert.deepEqual(store.getData().templates, { income: [], expenses: [] });
  assert.deepEqual(store.getMonth('2026-04').suppressedOccurrences, []);
});

test('schema policy validation rejects missing and non-callable members before storage access', () => {
  const required = ['clone', 'migrateActive', 'validateActive', 'parseActive', 'buildBackup', 'parseBackup', 'buildSnapshot', 'parseSnapshot', 'DataError'];
  for (const name of required) {
    for (const replacement of [undefined, 42]) {
      let storageAccessed = false;
      const storage = new Proxy({}, { get() { storageAccessed = true; throw new Error('storage accessed'); } });
      const policy = { ...Schema.V3_SCHEMA_POLICY, [name]: replacement };
      expectStoreCode('INVALID_SCHEMA_POLICY', () => createStore({ storage, schemaPolicy: policy }));
      assert.equal(storageAccessed, false, name);
    }
  }
  for (const version of [1, 4, '3']) {
    expectStoreCode('INVALID_SCHEMA_POLICY', () => createStore({ storage: {}, schemaPolicy: { ...Schema.V3_SCHEMA_POLICY, SCHEMA_VERSION: version } }));
  }
});

test('schema policy validation accepts only official frozen identities and rejects clones and mixed policies before storage access', () => {
  const rejected = [
    { ...Schema.ACTIVE_SCHEMA_POLICY },
    { ...Schema.V3_SCHEMA_POLICY },
    { ...Schema.ACTIVE_SCHEMA_POLICY, SCHEMA_VERSION: 3 },
    { ...Schema.V3_SCHEMA_POLICY, SCHEMA_VERSION: 2 },
    { ...Schema.ACTIVE_SCHEMA_POLICY, parseActive: Schema.V3_SCHEMA_POLICY.parseActive },
    { ...Schema.V3_SCHEMA_POLICY, buildBackup: Schema.ACTIVE_SCHEMA_POLICY.buildBackup }
  ];
  for (const schemaPolicy of rejected) {
    let storageAccessed = false;
    const storage = new Proxy({}, { get() { storageAccessed = true; throw new Error('storage accessed'); } });
    expectStoreCode('INVALID_SCHEMA_POLICY', () => createStore({ storage, schemaPolicy }));
    assert.equal(storageAccessed, false);
  }
  assert.equal(Object.isFrozen(Schema.ACTIVE_SCHEMA_POLICY), true);
  assert.equal(Object.isFrozen(Schema.V3_SCHEMA_POLICY), true);
  assert.doesNotThrow(() => createStore({ storage: new MemoryStorage(), schemaPolicy: Schema.ACTIVE_SCHEMA_POLICY }));
  assert.doesNotThrow(() => createStore({ storage: new MemoryStorage(), schemaPolicy: Schema.V3_SCHEMA_POLICY }));
});

test('v3 template CRUD is detached, strict, ordered, and preserves history', () => {
  const { store, storage } = readyV3Store();
  const monthsBefore = store.getData().months;
  const first = store.addIncomeTemplate(incomeTemplate());
  const second = store.addIncomeTemplate(incomeTemplate({ name: 'Second payday', recurrence: { cadence: 'weekly', anchorDate: '2026-01-02' } }));
  const expense = store.addExpenseTemplate(expenseTemplate());
  assert.deepEqual(Object.keys(first), ['id', 'name', 'earnerId', 'plannedAmount', 'enabled', 'startDate', 'endDate', 'recurrence', 'archived']);
  store.updateIncomeTemplate(first.id, { plannedAmount: 1300, enabled: false });
  store.setIncomeTemplateArchived(first.id, true);
  store.reorderIncomeTemplates([second.id, first.id]);
  store.updateExpenseTemplate(expense.id, { paymentMethod: 'credit_card' });
  store.setExpenseTemplateArchived(expense.id, true);
  const read = store.getIncomeTemplate(first.id);
  assert.equal(Object.isFrozen(read), true);
  assert.equal(read.plannedAmount, 1300);
  assert.deepEqual(store.getIncomeTemplates().map(item => item.id), [second.id, first.id]);
  assert.deepEqual(store.getData().months, monthsBefore);
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  Schema.validateV3(raw);
  assert.equal(JSON.stringify(raw).includes('"amount"'), false);
  expectStoreCode('FORBIDDEN_FIELD', () => store.updateIncomeTemplate(first.id, { id: 'forged' }));
  expectStoreCode('INVALID_PERMUTATION', () => store.reorderExpenseTemplates([]));
});

test('same-value template updates, archive state, and exact reorder are zero-write no-ops', () => {
  const { store, storage } = readyV3Store();
  const first = store.addIncomeTemplate(incomeTemplate());
  const second = store.addIncomeTemplate(incomeTemplate({ name: 'Other income' }));
  storage.operations.length = 0;
  store.updateIncomeTemplate(first.id, { plannedAmount: first.plannedAmount });
  store.setIncomeTemplateArchived(first.id, false);
  store.reorderIncomeTemplates([first.id, second.id]);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('v3 records preserve explicit planned amounts and nullable actual calculations', () => {
  const budget = Schema.migrateToV3(makeBudget());
  budget.months = {};
  const { store } = readyV3Store({ budget });
  const paycheck = store.addPaycheck('2026-02', {
    earnerId: 'earner-example-1', plannedAmount: 1000, actualAmount: 0, date: '2026-02-01'
  });
  const expense = store.addExpense('2026-02', {
    categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'ignored', date: '',
    paycheckAmounts: { [paycheck.id]: 200 }, plannedAmount: 500, actualAmount: null, paymentMethod: 'bank'
  });
  assert.equal(expense.plannedAmount, 500);
  assert.equal(expense.actualAmount, null);
  assert.deepEqual(store.calcMonthSummary('2026-02'), {
    totalIncome: 0, totalProjected: 500, totalActual: 0, totalAllocated: 0,
    totalBudgeted: 500, remaining: -500,
    totalPlannedIncome: 1000, totalActualIncome: 0, unresolvedIncomeCount: 0,
    totalPlannedExpenses: 500, totalActualExpenses: 0, unresolvedExpenseCount: 1
  });
  store.updateExpensePaycheckAmount('2026-02', expense.id, paycheck.id, 300);
  assert.equal(store.getMonth('2026-02').expenses[0].plannedAmount, 500);
  store.updateExpense('2026-02', expense.id, { actualAmount: 0 });
  assert.equal(store.getMonth('2026-02').expenses[0].actualAmount, 0);
});

test('v3 calculation APIs distinguish planned, null actual, typed zero, and resolved actual values', () => {
  const budget = Schema.migrateToV3(makeBudget()); budget.months = {};
  const { store } = readyV3Store({ budget });
  for (const [plannedAmount, actualAmount, day] of [[100, null, '01'], [200, 0, '02'], [300, 80, '03']]) {
    store.addPaycheck('2026-03', { earnerId: 'earner-example-1', plannedAmount, actualAmount, date: `2026-03-${day}` });
  }
  for (const [plannedAmount, actualAmount, paymentMethod, day] of [
    [50, null, 'bank', '05'], [60, 0, 'credit_card', '06'], [90, 70, 'bank', '07']
  ]) {
    store.addExpense('2026-03', {
      categoryId: 'category-example-1', categoryItemId: 'item-example-1', name: 'ignored',
      date: `2026-03-${day}`, paycheckAmounts: {}, plannedAmount, actualAmount, paymentMethod
    });
  }
  assert.deepEqual(store.calcMonthSummary('2026-03'), {
    totalIncome: 80, totalProjected: 200, totalActual: 70, totalAllocated: 0,
    totalBudgeted: 200, remaining: -120,
    totalPlannedIncome: 600, totalActualIncome: 80, unresolvedIncomeCount: 1,
    totalPlannedExpenses: 200, totalActualExpenses: 70, unresolvedExpenseCount: 1
  });
  assert.deepEqual({ ...store.calcCategoryTotals('2026-03') }, {
    Home: { planned: 200, actual: 70, unresolvedCount: 1, projected: 200 }
  });
  assert.deepEqual(store.calcPaymentMethodTotals('2026-03', 'planned'), {
    bank: 140, credit_card: 60, savings: 0, investments: 0
  });
  assert.deepEqual(store.calcPaymentMethodTotals('2026-03', 'actual'), {
    bank: 70, credit_card: 0, savings: 0, investments: 0
  });
  expectStoreCode('INVALID_TOTAL_MODE', () => store.calcPaymentMethodTotals('2026-03'));
  expectStoreCode('INVALID_TOTAL_MODE', () => store.calcPaymentMethodTotals('2026-03', 'combined'));
});

test('recurring preview is frozen, zero-write, identity-bound, stale-safe, atomic, and idempotent', () => {
  const budget = Schema.migrateToV3(makeBudget());
  budget.months = {};
  const { store, storage } = readyV3Store({ budget });
  store.addIncomeTemplate(incomeTemplate({ recurrence: { cadence: 'twice-monthly', days: [30, 31] } }));
  store.addExpenseTemplate(expenseTemplate());
  storage.operations.length = 0;
  const preview = store.previewRecurringMonth('2026-02');
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.additions.income), true);
  assert.equal(preview.counts.additions, 3);
  assert.deepEqual(preview.additions.income.map(item => item.occurrenceKey), ['2026-02-28#0001', '2026-02-28#0002']);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem'), false);
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => store.applyRecurringPreview(structuredClone(preview)));
  const result = store.applyRecurringPreview(preview);
  assert.deepEqual(result, { addedIncome: 2, addedExpenses: 1 });
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => store.applyRecurringPreview(preview));
  const rerun = store.previewRecurringMonth('2026-02');
  assert.equal(rerun.counts.additions, 0);
  storage.operations.length = 0;
  assert.deepEqual(store.applyRecurringPreview(rerun), { addedIncome: 0, addedExpenses: 0 });
  assert.equal(storage.operations.some(entry => entry.op === 'setItem'), false);

  const stale = store.previewRecurringMonth('2026-03');
  store.updateIncomeTemplate(store.getIncomeTemplates()[0].id, { plannedAmount: 1400 });
  expectStoreCode('STALE_RECURRING_PREVIEW', () => store.applyRecurringPreview(stale));
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => store.applyRecurringPreview(stale));
});

test('recurring previews reject forged and foreign-store capabilities', () => {
  const budget = Schema.migrateToV3(makeBudget()); budget.months = {};
  const first = readyV3Store({ budget: structuredClone(budget) }).store;
  const second = readyV3Store({ budget: structuredClone(budget) }).store;
  first.addIncomeTemplate(incomeTemplate());
  second.addIncomeTemplate(incomeTemplate());
  const preview = first.previewRecurringMonth('2026-02');
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => first.applyRecurringPreview({ ...preview }));
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => second.applyRecurringPreview(preview));
  assert.deepEqual(first.applyRecurringPreview(preview), { addedIncome: 1, addedExpenses: 0 });
});

test('recurring classification follows archived, disabled, and out-of-range precedence', () => {
  const budget = Schema.migrateToV3(makeBudget()); budget.months = {};
  const { store } = readyV3Store({ budget });
  const archived = store.addIncomeTemplate(incomeTemplate({ name: 'Archived', enabled: false, startDate: '2027-01-01' }));
  store.setIncomeTemplateArchived(archived.id, true);
  store.addIncomeTemplate(incomeTemplate({ name: 'Disabled', enabled: false, startDate: '2027-01-01' }));
  store.addIncomeTemplate(incomeTemplate({ name: 'Future', startDate: '2027-01-01' }));
  const preview = store.previewRecurringMonth('2026-02');
  assert.deepEqual(preview.skips.map(item => [item.name, item.reason]), [
    ['Archived', 'archived'], ['Disabled', 'disabled'], ['Future', 'out-of-range']
  ]);
});

test('recurring apply rolls back fully on UUID and primary-write failures', () => {
  const budget = Schema.migrateToV3(makeBudget()); budget.months = {};
  let sequence = 0;
  let failIds = false;
  const uuid = () => {
    sequence += 1;
    if (failIds && sequence === 3) throw new Error('identifier unavailable');
    return `rollback-${sequence}`;
  };
  const first = readyV3Store({ budget: structuredClone(budget), uuid });
  first.store.addIncomeTemplate(incomeTemplate({ recurrence: { cadence: 'twice-monthly', days: [1, 15] } }));
  failIds = true;
  const preview = first.store.previewRecurringMonth('2026-02');
  const beforeData = first.store.getData();
  const beforeRaw = first.storage.getItem(STORAGE_KEY);
  expectStoreCode('IDENTIFIER_GENERATION_FAILED', () => first.store.applyRecurringPreview(preview));
  assert.deepEqual(first.store.getData(), beforeData);
  assert.equal(first.storage.getItem(STORAGE_KEY), beforeRaw);
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => first.store.applyRecurringPreview(preview));

  const second = readyV3Store({ budget: structuredClone(budget) });
  second.store.addIncomeTemplate(incomeTemplate());
  const secondPreview = second.store.previewRecurringMonth('2026-02');
  const secondBefore = second.store.getData();
  const secondRaw = second.storage.getItem(STORAGE_KEY);
  second.storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => second.store.applyRecurringPreview(secondPreview));
  assert.deepEqual(second.store.getData(), secondBefore);
  assert.equal(second.storage.getItem(STORAGE_KEY), secondRaw);
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => second.store.applyRecurringPreview(secondPreview));
});

test('recurring apply is atomic when the canonical month cap rejects the candidate', () => {
  const budget = Schema.migrateToV3(makeBudget());
  budget.templates.income.push({
    id: 'cap-template', ...incomeTemplate(), archived: false
  });
  budget.months = {
    '2026-02': {
      paychecks: Array.from({ length: 500 }, (_, index) => ({
        id: `cap-paycheck-${index}`, earnerId: 'earner-example-1', earner: 'Example Earner',
        plannedAmount: 1, actualAmount: null, date: '', sourceTemplateId: null, occurrenceKey: null
      })),
      expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
      suppressedOccurrences: []
    }
  };
  Schema.validateV3(budget);
  const { store, storage } = readyV3Store({ budget });
  const preview = store.previewRecurringMonth('2026-02');
  const beforeData = store.getData();
  const beforeRaw = storage.getItem(STORAGE_KEY);
  assert.throws(() => store.applyRecurringPreview(preview), error => error instanceof Schema.DataError);
  assert.deepEqual(store.getData(), beforeData);
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  expectStoreCode('INVALID_RECURRING_PREVIEW', () => store.applyRecurringPreview(preview));
});

test('generated deletion, clearing, and target copy preserve suppression and prevent resurrection', () => {
  const budget = Schema.migrateToV3(makeBudget());
  budget.months = {};
  const { store } = readyV3Store({ budget });
  store.addIncomeTemplate(incomeTemplate());
  store.addExpenseTemplate(expenseTemplate());
  store.applyRecurringPreview(store.previewRecurringMonth('2026-01'));
  const generated = store.getMonth('2026-01');
  store.deletePaycheck('2026-01', generated.paychecks[0].id);
  assert.equal(store.previewRecurringMonth('2026-01').skips.some(item => item.reason === 'suppressed'), true);
  store.clearMonth('2026-01');
  assert.equal(store.getMonth('2026-01').suppressedOccurrences.length, 2);
  assert.equal(store.previewRecurringMonth('2026-01').counts.additions, 0);

  store.applyRecurringPreview(store.previewRecurringMonth('2026-02'));
  store.copyFromMonth('2026-02', '2026-01');
  const copied = store.getMonth('2026-02');
  assert.equal(copied.suppressedOccurrences.length, 2);
  assert.equal(copied.paychecks.every(item => item.sourceTemplateId === null), true);
  assert.equal(copied.expenses.every(item => item.sourceTemplateId === null), true);
  assert.equal(store.previewRecurringMonth('2026-02').counts.additions, 0);
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

test('structure usage counts every month by structural ID and is frozen, detached, and write-free', () => {
  const budget = makeStructureBudget();
  budget.months['2026-02'] = structuredClone(budget.months['2026-01']);
  budget.months['2026-02'].paychecks[0].id = 'paycheck-example-2';
  budget.months['2026-02'].paychecks[0].earnerId = 'earner-example-2';
  budget.months['2026-02'].paychecks[0].earner = 'Historical Earner Two';
  budget.months['2026-02'].paychecks[0].date = '';
  budget.months['2026-02'].expenses[0].id = 'expense-example-2';
  budget.months['2026-02'].expenses[0].categoryId = 'category-example-2';
  budget.months['2026-02'].expenses[0].category = 'Historical Travel';
  budget.months['2026-02'].expenses[0].categoryItemId = null;
  budget.months['2026-02'].expenses[0].paycheckAmounts = { 'paycheck-example-2': 1200 };
  budget.categories[0].archived = true;
  budget.categories[0].items[0].archived = true;
  budget.settings.earners[0].archived = true;
  const { store, storage } = readyStore({ budget });
  const usage = store.getStructureUsage();
  assert.deepEqual(usage, {
    categoryExpenses: { 'category-example-1': 1, 'category-example-2': 1 },
    itemExpenses: { 'item-example-1': 1, 'item-example-2': 0 },
    earnerPaychecks: { 'earner-example-1': 1, 'earner-example-2': 1 }
  });
  assert.equal(Object.isFrozen(usage), true);
  assert.equal(Object.isFrozen(usage.categoryExpenses), true);
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
});

test('catalog lifecycle and reorder operations commit once without rewriting history or totals', () => {
  const { store, storage } = readyStore({ budget: makeStructureBudget(), uuid: ids('structure') });
  const monthsBefore = store.getData().months;
  const summaryBefore = store.calcMonthSummary('2026-01');

  let beforeWrites = storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length;
  const category = store.addCategory({ name: 'Utilities' });
  assert.equal(category.id, 'structure-1');
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, beforeWrites + 1);
  store.renameCategory(category.id, 'Services');
  store.setCategoryArchived(category.id, true);
  store.setCategoryArchived(category.id, false);
  const itemA = store.addCategoryItem(category.id, { name: 'Power' });
  const itemB = store.addCategoryItem(category.id, { name: 'Power' });
  store.renameCategoryItem(category.id, itemA.id, 'Electricity');
  store.setCategoryItemArchived(category.id, itemA.id, true);
  store.setCategoryItemArchived(category.id, itemA.id, false);
  store.reorderCategoryItems(category.id, [itemB.id, itemA.id]);
  const earner = store.addEarner({ name: 'Example Three' });
  store.renameEarner(earner.id, 'Example Updated');
  store.setEarnerArchived(earner.id, true);
  store.setEarnerArchived(earner.id, false);
  store.reorderCategories(['category-example-2', category.id, 'category-example-1']);
  store.reorderEarners([earner.id, 'earner-example-2', 'earner-example-1']);

  const current = store.getData();
  assert.deepEqual(current.months, monthsBefore);
  assert.deepEqual(store.calcMonthSummary('2026-01'), summaryBefore);
  assert.deepEqual(current.categories.map(entry => entry.id), ['category-example-2', category.id, 'category-example-1']);
  assert.deepEqual(store.getCategoryItems(category.id, { includeArchived: true }).map(entry => entry.id), [itemB.id, itemA.id]);
  assert.deepEqual(current.settings.earners.map(entry => entry.id), [earner.id, 'earner-example-2', 'earner-example-1']);
  Schema.validateActive(JSON.parse(storage.getItem(STORAGE_KEY)));
});

test('duplicate, last-active, stale, invalid-name, and invalid-permutation failures are zero-write', () => {
  const { store, storage } = readyStore({ budget: makeStructureBudget() });
  const assertUnchanged = (code, operation) => {
    const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
    storage.operations.length = 0;
    if (code instanceof RegExp) assert.throws(operation, error => error instanceof Schema.DataError && code.test(error.code));
    else expectStoreCode(code, operation);
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  };
  assertUnchanged('DUPLICATE_CATEGORY_NAME', () => store.addCategory({ name: 'Home' }));
  assertUnchanged('DUPLICATE_CATEGORY_NAME', () => store.renameCategory('category-example-2', 'Home'));
  assertUnchanged('DUPLICATE_EARNER_NAME', () => store.addEarner({ name: 'Example Earner' }));
  assertUnchanged('DUPLICATE_EARNER_NAME', () => store.renameEarner('earner-example-2', 'Example Earner'));
  assertUnchanged('CATEGORY_NOT_FOUND', () => store.renameCategory('missing', 'Missing'));
  assertUnchanged('CATEGORY_ITEM_NOT_FOUND', () => store.renameCategoryItem('category-example-1', 'missing', 'Missing'));
  assertUnchanged('EARNER_NOT_FOUND', () => store.renameEarner('missing', 'Missing'));
  assertUnchanged(/INVALID_STRING|EXPECTED_STRING/, () => store.addCategory({ name: '' }));
  assertUnchanged('INVALID_PERMUTATION', () => store.reorderCategories(['category-example-1']));
  assertUnchanged('INVALID_PERMUTATION', () => store.reorderCategories(['category-example-1', 'category-example-1']));
  assertUnchanged('INVALID_PERMUTATION', () => store.reorderCategories(['category-example-1', 'foreign']));
  assertUnchanged('INVALID_PERMUTATION', () => store.reorderCategoryItems('category-example-1', []));
  assertUnchanged('INVALID_PERMUTATION', () => store.reorderEarners(['earner-example-1']));
  store.setCategoryArchived('category-example-2', true);
  assertUnchanged('LAST_ACTIVE_CATEGORY', () => store.setCategoryArchived('category-example-1', true));
  store.setEarnerArchived('earner-example-2', true);
  assertUnchanged('LAST_ACTIVE_EARNER', () => store.setEarnerArchived('earner-example-1', true));
});

test('every structure mutation rolls back memory and bytes on primary-write failure', () => {
  const operations = [
    store => store.addCategory({ name: 'Added' }),
    store => store.renameCategory('category-example-1', 'Renamed'),
    store => store.setCategoryArchived('category-example-1', true),
    store => store.reorderCategories(['category-example-2', 'category-example-1']),
    store => store.addCategoryItem('category-example-1', { name: 'Added item' }),
    store => store.renameCategoryItem('category-example-1', 'item-example-1', 'Renamed item'),
    store => store.setCategoryItemArchived('category-example-1', 'item-example-1', true),
    store => store.reorderCategoryItems('category-example-1', ['item-example-extra', 'item-example-1']),
    store => store.addEarner({ name: 'Added Earner' }),
    store => store.renameEarner('earner-example-1', 'Renamed Earner'),
    store => store.setEarnerArchived('earner-example-1', true),
    store => store.reorderEarners(['earner-example-2', 'earner-example-1'])
  ];
  for (const operation of operations) {
    const budget = makeStructureBudget();
    budget.categories[0].items.push({ id: 'item-example-extra', name: 'Extra', archived: false });
    const { store, storage } = readyStore({ budget, uuid: ids('fault') });
    const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
    storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
    expectStoreCode('PRIMARY_WRITE_FAILED', () => operation(store));
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
  }
});

test('structure additions redact UUID failures and preserve state', () => {
  for (const operation of [
    store => store.addCategory({ name: 'Added' }),
    store => store.addCategoryItem('category-example-1', { name: 'Added item' }),
    store => store.addEarner({ name: 'Added Earner' })
  ]) {
    const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeStructureBudget()) });
    const store = createStore({ storage, now: makeClock(), uuid: () => { throw new Error('private UUID detail'); } });
    store.load();
    const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
    storage.operations.length = 0;
    expectStoreCode('IDENTIFIER_GENERATION_FAILED', () => operation(store));
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  }
});

test('catalog reorder round-trips exactly through backup import and reload', () => {
  const { store } = readyStore({ budget: makeStructureBudget() });
  store.reorderCategories(['category-example-2', 'category-example-1']);
  store.reorderEarners(['earner-example-2', 'earner-example-1']);
  const exported = store.exportData();
  const storage = new MemoryStorage();
  const restored = createStore({ storage, now: makeClock(), uuid: ids() });
  restored.load();
  restored.importData(exported);
  const raw = storage.getItem(STORAGE_KEY);
  const reloaded = createStore({ storage, now: makeClock(), uuid: ids() });
  reloaded.load();
  assert.deepEqual(reloaded.getCategories({ includeArchived: true }).map(entry => entry.id),
    ['category-example-2', 'category-example-1']);
  assert.deepEqual(reloaded.getEarners({ includeArchived: true }).map(entry => entry.id),
    ['earner-example-2', 'earner-example-1']);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('getters, calculations, and missing-month reads are detached and write-free', () => {
  const { store, storage } = readyStore();
  const data = store.getData();
  const month = store.getMonth('2026-01');
  const absent = store.peekMonth('2029-01');
  data.months['2026-01'].paychecks[0].plannedAmount = 1;
  month.expenses.length = 0;
  absent.allocations.savings = 99;
  assert.equal(store.getData().months['2026-01'].paychecks[0].plannedAmount, 2500);
  assert.equal(store.getMonth('2026-01').expenses.length, 1);
  assert.equal(store.getAllMonthKeys().includes('2029-01'), false);
  assert.deepEqual(store.calcMonthSummary('2029-01'), {
    totalIncome: 0, totalProjected: 0, totalActual: 0,
    totalAllocated: 0, totalBudgeted: 0, remaining: 0,
    totalPlannedIncome: 0, totalActualIncome: 0, unresolvedIncomeCount: 0,
    totalPlannedExpenses: 0, totalActualExpenses: 0, unresolvedExpenseCount: 0
  });
  assert.equal(store.calcPaycheckRemaining('2026-01', 'paycheck-example-1'), 1300);
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
});

test('ensureMonth and every CRUD family commit detached canonical state', () => {
  const storage = new MemoryStorage();
  const store = createStore({ storage, now: makeClock(), uuid: ids('id') });
  store.load();
  store.ensureMonth('2026-02');
  const paycheck = store.addPaycheck('2026-02', { earnerId: 'default-earner-0001', plannedAmount: 3000, actualAmount: null, date: '' });
  assert.equal(paycheck.id, 'id-1');
  store.updatePaycheck('2026-02', paycheck.id, { plannedAmount: 3200 });
  const expense = store.addExpense('2026-02', {
    categoryId: 'default-category-0001', categoryItemId: null,
    name: 'Example bill', date: '', paycheckAmounts: {}, plannedAmount: 900, actualAmount: 0, paymentMethod: 'bank'
  });
  store.updateExpensePaycheckAmount('2026-02', expense.id, paycheck.id, 900);
  store.updateExpense('2026-02', expense.id, { actualAmount: 875 });
  store.updateAllocation('2026-02', 'savings', 100);
  store.updateAllocations('2026-02', { savings: 200, credit_card_debt: 0, investments: 0 });
  const current = store.getMonth('2026-02');
  assert.equal(current.paychecks[0].plannedAmount, 3200);
  assert.equal(current.expenses[0].paycheckAmounts[paycheck.id], 900);
  assert.equal(current.expenses[0].actualAmount, 875);
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

  const paycheck = store.addPaycheck('2026-02', { earnerId: 'earner-other', plannedAmount: 100, actualAmount: null, date: '' });
  assert.equal(paycheck.earner, 'Other Earner');
  expectStoreCode('FORBIDDEN_FIELD', () => store.addPaycheck('2026-02', {
    earnerId: 'earner-other', earner: 'Spoofed', plannedAmount: 100, actualAmount: null, date: ''
  }));
  expectStoreCode('EARNER_ARCHIVED', () => store.reassignPaycheckEarner('2026-02', paycheck.id, 'earner-archived'));
  store.reassignPaycheckEarner('2026-02', paycheck.id, 'earner-example-1');
  assert.equal(store.getMonth('2026-02').paychecks[0].earner, 'Example Earner');

  const preset = store.addExpense('2026-02', {
    categoryId: 'category-other', categoryItemId: 'item-other', name: 'Spoofed preset', date: '', paycheckAmounts: {},
    plannedAmount: 100, actualAmount: null, paymentMethod: 'bank'
  });
  assert.equal(preset.category, 'Other');
  assert.equal(preset.name, 'Other preset');
  expectStoreCode('CATEGORY_ARCHIVED', () => store.addExpense('2026-02', {
    categoryId: 'category-archived', categoryItemId: null, name: 'Custom', date: '', paycheckAmounts: {},
    plannedAmount: 100, actualAmount: null, paymentMethod: 'bank'
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
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1210 });
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
    earnerId: 'earner-other', plannedAmount: 2600, actualAmount: 2500, date: '2026-01-20'
  });
  storage.operations.length = 0;
  store.editExpense('2026-01', 'expense-example-1', {
    categoryId: 'category-other', categoryItemId: null, name: 'Custom item', plannedAmount: 1200,
    actualAmount: 1100, paymentMethod: 'credit_card'
  });
  const expense = store.getMonth('2026-01').expenses[0];
  assert.deepEqual({ categoryId: expense.categoryId, category: expense.category, categoryItemId: expense.categoryItemId,
    name: expense.name, actualAmount: expense.actualAmount, paymentMethod: expense.paymentMethod }, {
    categoryId: 'category-other', category: 'Other', categoryItemId: null,
    name: 'Custom item', actualAmount: 1100, paymentMethod: 'credit_card'
  });
  assert.equal(storage.operations.filter(operation => operation.op === 'setItem' && operation.key === STORAGE_KEY).length, 1);
  const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.editExpense('2026-01', 'expense-example-1', {
    categoryId: 'category-example-1', categoryItemId: 'item-example-1', actualAmount: 999
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
  assert.equal(copied.expenses[0].actualAmount, null);
  assert.equal(copied.paychecks[0].earnerId, 'earner-example-1');
  assert.equal(copied.paychecks[0].earner, 'Example Earner');
  assert.equal(copied.expenses[0].categoryId, 'category-example-1');
  assert.equal(copied.expenses[0].categoryItemId, 'item-example-1');
  assert.equal(copied.expenses[0].category, 'Home');
  assert.equal(copied.expenses[0].name, 'Rent');
  store.clearMonth('2026-02');
  assert.deepEqual(store.peekMonth('2026-02'), {
    paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: []
  });
});

test('monthly record reorder uses exact permutations and preserves every record value and total', () => {
  const { store, storage } = readyStore({ budget: makeOrderedMonthBudget() });
  const before = store.getMonth('2026-01');
  const summary = store.calcMonthSummary('2026-01');
  const categories = store.getCategories({ includeArchived: true });
  const earners = store.getEarners({ includeArchived: true });
  const paycheckById = new Map(before.paychecks.map(record => [record.id, record]));
  const expenseById = new Map(before.expenses.map(record => [record.id, record]));

  storage.operations.length = 0;
  store.reorderPaychecks('2026-01', ['paycheck-example-3', 'paycheck-example-1', 'paycheck-example-2']);
  assert.equal(storage.operations.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);
  storage.operations.length = 0;
  store.reorderExpenses('2026-01', ['expense-example-2', 'expense-example-3', 'expense-example-1']);
  assert.equal(storage.operations.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);

  const after = store.getMonth('2026-01');
  assert.deepEqual(after.paychecks.map(record => record.id), ['paycheck-example-3', 'paycheck-example-1', 'paycheck-example-2']);
  assert.deepEqual(after.expenses.map(record => record.id), ['expense-example-2', 'expense-example-3', 'expense-example-1']);
  for (const record of after.paychecks) assert.deepEqual(record, paycheckById.get(record.id));
  for (const record of after.expenses) assert.deepEqual(record, expenseById.get(record.id));
  assert.deepEqual(store.calcMonthSummary('2026-01'), summary);
  assert.deepEqual(store.getCategories({ includeArchived: true }), categories);
  assert.deepEqual(store.getEarners({ includeArchived: true }), earners);
});

test('monthly reorder rejects missing months and every non-exact permutation without writes', () => {
  const { store, storage } = readyStore({ budget: makeOrderedMonthBudget() });
  const validPaychecks = ['paycheck-example-1', 'paycheck-example-2', 'paycheck-example-3'];
  const validExpenses = ['expense-example-1', 'expense-example-2', 'expense-example-3'];
  const cases = [
    ['MONTH_NOT_FOUND', () => store.reorderPaychecks('2099-01', [])],
    ['MONTH_NOT_FOUND', () => store.reorderExpenses('2099-01', [])],
    ['INVALID_PERMUTATION', () => store.reorderPaychecks('2026-01', validPaychecks.slice(0, 2))],
    ['INVALID_PERMUTATION', () => store.reorderPaychecks('2026-01', [validPaychecks[0], validPaychecks[0], validPaychecks[2]])],
    ['INVALID_PERMUTATION', () => store.reorderPaychecks('2026-01', [validPaychecks[0], validPaychecks[1], 'foreign'])],
    ['INVALID_PERMUTATION', () => store.reorderPaychecks('2026-01', null)],
    ['INVALID_PERMUTATION', () => store.reorderExpenses('2026-01', validExpenses.slice(0, 2))],
    ['INVALID_PERMUTATION', () => store.reorderExpenses('2026-01', [validExpenses[0], validExpenses[0], validExpenses[2]])],
    ['INVALID_PERMUTATION', () => store.reorderExpenses('2026-01', [validExpenses[0], validExpenses[1], '__proto__'])],
    ['INVALID_PERMUTATION', () => store.reorderExpenses('2026-01', { 0: validExpenses[0] })]
  ];
  for (const [code, operation] of cases) {
    const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
    storage.operations.length = 0;
    expectStoreCode(code, operation);
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
    assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
  }
  const sparse = new Array(3); sparse[0] = validPaychecks[0]; sparse[2] = validPaychecks[2];
  const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
  storage.operations.length = 0;
  assert.throws(() => store.reorderPaychecks('2026-01', sparse),
    error => error instanceof Schema.DataError && error.code === 'SPARSE_ARRAY');
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData);
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('monthly reorder rolls back on primary failure and no-op order does not write', () => {
  for (const [method, ids] of [
    ['reorderPaychecks', ['paycheck-example-3', 'paycheck-example-2', 'paycheck-example-1']],
    ['reorderExpenses', ['expense-example-3', 'expense-example-2', 'expense-example-1']]
  ]) {
    const { store, storage } = readyStore({ budget: makeOrderedMonthBudget() });
    const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
    storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError', once: true });
    expectStoreCode('PRIMARY_WRITE_FAILED', () => store[method]('2026-01', ids));
    assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
    assert.deepEqual(store.getData(), beforeData);
  }
  const { store, storage } = readyStore({ budget: makeOrderedMonthBudget() });
  storage.operations.length = 0;
  store.reorderPaychecks('2026-01', store.getMonth('2026-01').paychecks.map(record => record.id));
  store.reorderExpenses('2026-01', store.getMonth('2026-01').expenses.map(record => record.id));
  assert.equal(storage.operations.some(entry => entry.op === 'setItem' || entry.op === 'removeItem'), false);
});

test('monthly record order round-trips through reload, export/import, and copy', () => {
  const { store, storage } = readyStore({ budget: makeOrderedMonthBudget(), uuid: ids('order') });
  store.reorderPaychecks('2026-01', ['paycheck-example-3', 'paycheck-example-1', 'paycheck-example-2']);
  store.reorderExpenses('2026-01', ['expense-example-2', 'expense-example-3', 'expense-example-1']);
  const expectedPaycheckLabels = ['Historical One', 'Example Earner', 'Historical Two'];
  const expectedExpenseLabels = ['Historical fare', 'Custom service', 'Rent'];
  const reloaded = createStore({ storage, now: makeClock(), uuid: ids() });
  reloaded.load();
  assert.deepEqual(reloaded.getMonth('2026-01').paychecks.map(record => record.earner), expectedPaycheckLabels);
  assert.deepEqual(reloaded.getMonth('2026-01').expenses.map(record => record.name), expectedExpenseLabels);

  const importedStorage = new MemoryStorage();
  const imported = createStore({ storage: importedStorage, now: makeClock(), uuid: ids('import-order') });
  imported.load(); imported.importData(store.exportData());
  assert.deepEqual(imported.getMonth('2026-01').paychecks.map(record => record.earner), expectedPaycheckLabels);
  assert.deepEqual(imported.getMonth('2026-01').expenses.map(record => record.name), expectedExpenseLabels);

  const copied = store.copyFromMonth('2026-02', '2026-01');
  assert.deepEqual(copied.paychecks.map(record => record.earner), expectedPaycheckLabels);
  assert.deepEqual(copied.expenses.map(record => record.name), expectedExpenseLabels);
  assert.deepEqual(Object.keys(copied.expenses[0].paycheckAmounts), [copied.paychecks[2].id]);
  assert.deepEqual(Object.keys(copied.expenses[1].paycheckAmounts), [copied.paychecks[1].id, copied.paychecks[0].id]);
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
    () => store.updatePaycheck('2026-01', 'missing', { plannedAmount: 1 }),
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
    ['PAYCHECK_NOT_FOUND', () => store.updatePaycheck('2026-01', 'missing', { plannedAmount: 1 })],
    ['PAYCHECK_NOT_FOUND', () => store.deletePaycheck('2026-01', 'missing')],
    ['EXPENSE_NOT_FOUND', () => store.updateExpense('2026-01', 'missing', { actualAmount: 1 })],
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
  assert.throws(() => store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1_000_000_000_001 }),
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
  assert.throws(() => store.addPaycheck('2026-02', { earnerId: 'default-earner-0001', plannedAmount: 100, actualAmount: null, date: '' }),
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
  assert.deepEqual(totals.__proto__, { planned: 1200, projected: 1200, actual: 1200, unresolvedCount: 0 });
});

test('failed primary write preserves exact primary bytes and memory', () => {
  const { store, storage } = readyStore();
  const raw = storage.getItem(STORAGE_KEY);
  const before = store.getData();
  storage.operations.length = 0;
  storage.fail({ op: 'setItem', key: STORAGE_KEY, name: 'QuotaExceededError' });
  expectStoreCode('PRIMARY_WRITE_FAILED', () => store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 999 }));
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
    store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 101 }));
  const snapshotKey = snapshotKeys(storage)[0];
  const relevant = storage.attempts.filter(entry => entry.key === snapshotKey || entry.key === STORAGE_KEY);
  assert.deepEqual(relevant, [
    { op: 'setItem', key: snapshotKey },
    { op: 'getItem', key: snapshotKey },
    { op: 'setItem', key: STORAGE_KEY }
  ]);
  assert.equal(storage.attempts.filter(entry => entry.op === 'setItem' && entry.key === STORAGE_KEY).length, 1);
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 1200);
});

test('optional daily snapshot identifier failure warns but does not block a normal commit', () => {
  const { store, storage } = readyStore({ uuid: () => { throw new Error('unavailable'); } });
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 111 });
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 111);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-01'].expenses[0].actualAmount, 111);
  assert.ok(store.getStatus().warnings.includes('IDENTIFIER_GENERATION_FAILED'));
});

test('optional daily snapshot set and readback faults warn, clean up, and still commit', () => {
  for (const fault of [
    { op: 'setItem', prefix: SNAPSHOT_PREFIX, name: 'QuotaExceededError', once: true },
    { op: 'getItem', prefix: SNAPSHOT_PREFIX, name: 'SecurityError', once: true }
  ]) {
    const { store, storage } = readyStore({ uuid: ids(`optional-${fault.op}`) });
    storage.fail(fault);
    store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 112 });
    assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 112);
    assert.equal(snapshotKeys(storage).length, 0);
    assert.ok(store.getStatus().warnings.some(code => code.startsWith('SNAPSHOT_')));
  }
});

test('daily snapshots happen once per local date and retention keeps newest seven valid records', () => {
  const { store, storage, clock } = readyStore({ uuid: ids('snapshot') });
  for (let day = 15; day <= 23; day += 1) {
    clock.set(`2026-01-${day}T12:00:00.000Z`);
    store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1200 + day });
    store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1300 + day });
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
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 201 });
  assert.equal(snapshotKeys(storage).length, 8);
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 202 });
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
  replacement.months['2026-01'].expenses[0].actualAmount = 777;
  const backup = JSON.stringify(Schema.buildBackup(replacement, '2026-01-15T12:00:00.000Z'));
  const preview = store.previewImport(backup);
  assert.equal(preview.monthCount, 1);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem'), false);

  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 600 });
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
  invalid.data.months['2026-01'].expenses[0].actualAmount = -1;
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
    replacement.months['2026-01'].expenses[0].actualAmount = 888;
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
  changed.months['2026-01'].expenses[0].actualAmount = 919;
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
  replacement.months['2026-01'].expenses[0].actualAmount = 444;
  const text = JSON.stringify(Schema.buildBackup(replacement, '2026-01-15T12:00:00.000Z'));
  store.commitImport(store.previewImport(text));
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 444);
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
    () => store.addExpense('2026-01', { categoryId: 'category-example-1', categoryItemId: null, name: 'x', date: '', paycheckAmounts: {}, plannedAmount: 0, actualAmount: 0, paymentMethod: 'bank' }),
    () => store.updateExpense('2026-01', 'x', { actualAmount: 1 }),
    () => store.updateExpensePaycheckAmount('2026-01', 'x', 'y', 1),
    () => store.deleteExpense('2026-01', 'x'),
    () => store.reorderPaychecks('2026-01', ['paycheck-example-1']),
    () => store.reorderExpenses('2026-01', ['expense-example-1']),
    () => store.updateAllocations('2026-01', { savings: 0, credit_card_debt: 0, investments: 0 }),
    () => store.updateAllocation('2026-01', 'savings', 1),
    () => store.addCategory({ name: 'New' }),
    () => store.renameCategory('category-example-1', 'New'),
    () => store.setCategoryArchived('category-example-1', true),
    () => store.reorderCategories(['category-example-1']),
    () => store.addCategoryItem('category-example-1', { name: 'New' }),
    () => store.renameCategoryItem('category-example-1', 'item-example-1', 'New'),
    () => store.setCategoryItemArchived('category-example-1', 'item-example-1', true),
    () => store.reorderCategoryItems('category-example-1', ['item-example-1']),
    () => store.addEarner({ name: 'New' }),
    () => store.renameEarner('earner-example-1', 'New'),
    () => store.setEarnerArchived('earner-example-1', true),
    () => store.reorderEarners(['earner-example-1']),
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
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 333 });
  const daily = store.listSnapshots()[0];
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 555 });
  expectStoreCode('SNAPSHOT_NOT_FOUND', () => store.restoreSnapshot('missing'));
  store.restoreSnapshot(daily.id);
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 1200);
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
  const active = makeBudget(); active.months['2026-01'].expenses[0].actualAmount = 999;
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
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 1200);
  const selectedReads = storage.attempts.filter(entry => entry.op === 'getItem' && entry.key === selectedKey);
  const unrelatedReads = storage.attempts.filter(entry => entry.op === 'getItem' && entry.key === unrelatedKey);
  assert.ok(selectedReads.length >= 1);
  assert.ok(unrelatedReads.length >= 1, 'best-effort cleanup may inspect unrelated snapshots after commit');
  assert.ok(store.getStatus().warnings.includes('SNAPSHOT_READ_FAILED'));
});

test('changed restore at the snapshot cap prunes valid physical keys back to seven', () => {
  const active = makeBudget(); active.months['2026-01'].expenses[0].actualAmount = 999;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(active) });
  for (let day = 1; day <= SNAPSHOT_LIMIT; day += 1) {
    const date = String(day).padStart(2, '0');
    const data = makeBudget(); data.months['2026-01'].expenses[0].actualAmount = 100 + day;
    const envelope = Schema.buildSnapshot(data, {
      createdAt: `2026-01-${date}T00:00:00.000Z`, localDate: `2026-01-${date}`, reason: 'daily'
    });
    storage.setItem(`${SNAPSHOT_PREFIX}capped-${day}`, JSON.stringify(envelope));
  }
  const store = createStore({ storage, now: makeClock(), uuid: ids('restore-cap') });
  store.load();
  store.restoreSnapshot('capped-7');
  assert.equal(store.getMonth('2026-01').expenses[0].actualAmount, 107);
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
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 222 });
  assert.equal(store.getData().months['2026-01'].expenses[0].actualAmount, 222);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-01'].expenses[0].actualAmount, 222);
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
  try { store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 321 }); }
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
