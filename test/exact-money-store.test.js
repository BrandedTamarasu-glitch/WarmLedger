'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Schema = require('../js/data-schema.js');
const Recurrence = require('../js/recurrence.js');
const DataHealth = require('../js/data-health.js');
const ExactMoney = require('../js/exact-money.js');
const StoreModule = require('../js/data.js');
const { STORAGE_KEY, SNAPSHOT_PREFIX, StoreError, createStore } = StoreModule;
const { makeV3Budget, MemoryStorage } = require('./helpers.js');

function expectCode(expected, fn) {
  assert.throws(fn, error => error && error.code === expected);
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === 'object') Object.values(value).forEach(assertDeepFrozen);
}

function readyStore(data, adapters = {}) {
  const raw = JSON.stringify(data);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({
    storage,
    now: adapters.now || (() => { throw new Error('audit used the clock'); }),
    uuid: adapters.uuid || (() => { throw new Error('audit generated an identifier'); })
  });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, raw };
}

function loadStoreWithoutExactMoney() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
  const context = vm.createContext({
    ZeroBudgetSchema: Schema,
    ZeroBudgetRecurrence: Recurrence,
    ZeroBudgetDataHealth: DataHealth,
    module: { exports: {} }
  });
  vm.runInContext(source, context, { filename: 'data.js' });
  return context.module.exports;
}

test('Store exposes the frozen Exact Money audit through the classic/CommonJS dependency', () => {
  assert.equal(typeof StoreModule.createStore, 'function');
  const data = makeV3Budget();
  const { store } = readyStore(data);
  assert.equal(typeof store.getExactMoneyAudit, 'function');
  const first = store.getExactMoneyAudit();
  const second = store.getExactMoneyAudit();
  assert.deepEqual(first, ExactMoney.audit(data));
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.groups, first.groups);
  assertDeepFrozen(first);
  assert.throws(() => { first.groups.allocations.subCentValueCount = 99; }, TypeError);
});

test('audit is byte-exact and does not write, snapshot, advance generation, use clock or UUID, or mutate memory', () => {
  const data = makeV3Budget();
  data.templates.income.push({
    id: 'template-income', name: 'Income', earnerId: 'earner-example-1', plannedAmount: 100.001, enabled: true, archived: false,
    startDate: '2026-01-01', endDate: null, recurrence: { cadence: 'monthly', day: 1 }
  });
  data.months['2026-01'].expenses[0].paycheckAmounts['paycheck-example-1'] = 1199.001;
  const sourceBefore = Schema.clone(data);
  let clockCalls = 0; let uuidCalls = 0;
  const { store, storage, raw } = readyStore(data, {
    now: () => { clockCalls += 1; throw new Error('clock unavailable'); },
    uuid: () => { uuidCalls += 1; throw new Error('uuid unavailable'); }
  });
  const statusBefore = store.getStatus();
  const memoryBefore = store.getData();
  storage.operations.length = 0;

  const audit = store.getExactMoneyAudit();

  assert.equal(audit.subCentValueCount, 2);
  assert.equal(audit.affectedMonthCount, 1);
  assert.equal(audit.affectedTemplateCount, 1);
  assert.deepEqual(data, sourceBefore);
  assert.deepEqual(store.getData(), memoryBefore);
  assert.equal(store.getStatus().state, 'ready');
  assert.equal(store.getStatus().generation, statusBefore.generation);
  assert.equal(clockCalls, 0);
  assert.equal(uuidCalls, 0);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(keys.some(key => key.startsWith(SNAPSHOT_PREFIX)), false);
});

test('sub-cent values are migration-blocking findings but keep the valid v3 Store ready and exportable', () => {
  const data = makeV3Budget();
  data.months['2026-01'].paychecks[0].actualAmount = 2500.0001;
  let clockCalls = 0;
  const { store, storage, raw } = readyStore(data, {
    now: () => { clockCalls += 1; return new Date('2026-08-30T12:00:00.000Z'); }
  });
  const generation = store.getStatus().generation;

  const audit = store.getExactMoneyAudit();

  assert.equal(audit.subCentValueCount, 1);
  assert.equal(clockCalls, 0);
  assert.equal(store.getStatus().state, 'ready');
  assert.equal(store.getStatus().generation, generation);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(JSON.parse(store.exportData()).data, data);
  assert.equal(clockCalls, 1);
});

test('recovery-required takes precedence and remains read-only', () => {
  let clockCalls = 0; let uuidCalls = 0;
  const storage = new MemoryStorage({ [STORAGE_KEY]: '{damaged' });
  const store = createStore({
    storage,
    now: () => { clockCalls += 1; throw new Error('clock unavailable'); },
    uuid: () => { uuidCalls += 1; throw new Error('uuid unavailable'); }
  });
  assert.equal(store.load().state, 'recovery-required');
  const before = store.getStatus(); storage.operations.length = 0;

  expectCode('RECOVERY_REQUIRED', () => store.getExactMoneyAudit());

  assert.deepEqual(store.getStatus(), before);
  assert.equal(storage.operations.length, 0);
  assert.equal(clockCalls, 0);
  assert.equal(uuidCalls, 0);
});

test('missing Exact Money dependency fails closed after readiness without changing Store state', () => {
  const isolated = loadStoreWithoutExactMoney();
  const data = makeV3Budget(); const raw = JSON.stringify(data);
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = isolated.createStore({
    storage,
    now: () => { throw new Error('clock unavailable'); },
    uuid: () => { throw new Error('uuid unavailable'); }
  });
  assert.equal(store.load().state, 'ready');
  const generation = store.getStatus().generation; storage.operations.length = 0;

  expectCode('EXACT_MONEY_UNAVAILABLE', () => store.getExactMoneyAudit());

  assert.equal(store.getStatus().state, 'ready');
  assert.equal(store.getStatus().generation, generation);
  assert.equal(storage.operations.length, 0);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('existing module exports and Store read APIs remain available', () => {
  for (const name of ['STORAGE_KEY', 'CORRUPT_KEY', 'SNAPSHOT_PREFIX', 'SNAPSHOT_LIMIT',
    'ALLOCATION_TYPES', 'StoreError', 'createStore']) assert.ok(Object.hasOwn(StoreModule, name), name);
  const { store } = readyStore(makeV3Budget());
  for (const name of ['getData', 'getDataHealth', 'getTemplateReadiness', 'getMonthReview',
    'getPayPeriodPlan', 'buildExport', 'exportData']) assert.equal(typeof store[name], 'function', name);
  assert.ok(new StoreError('EXAMPLE') instanceof Error);
});
