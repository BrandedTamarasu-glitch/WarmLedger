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

test('resident v3 and v4 ordinary edits preserve their persisted schema representation', () => {
  const v3 = makeV3Budget();
  const first = readyStore(v3, { now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'daily-v3' });
  first.store.updateAllocation('2026-01', 'savings', 401);
  assert.equal(JSON.parse(first.storage.getItem(STORAGE_KEY)).schemaVersion, 3);

  const v4 = Schema.migrateV3ToV4ExactMoney(v3);
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(v4) });
  const store = createStore({ storage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'daily-v4' });
  assert.equal(store.load().state, 'ready');
  assert.equal(store.getStatus().residentSchemaVersion, 4);
  store.updateAllocation('2026-01', 'savings', 401);
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(persisted.months['2026-01'].allocations.savings, 40100);
  assert.equal(store.getData().months['2026-01'].allocations.savings, 401);
});

test('canonical resident v3 load is not reported as migrated', () => {
  const budget = makeV3Budget();
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  const store = createStore({ storage });
  assert.equal(store.load().migrated, false);
  assert.equal(store.getStatus().residentSchemaVersion, 3);
});

test('migration summary and preview are aggregate-only, frozen, identity-bound, and write-free', () => {
  const { store, storage, raw } = readyStore(makeV3Budget());
  const generation = store.getStatus().generation;
  const summary = store.getExactMoneyMigrationSummary();
  const preview = store.previewExactMoneyMigration();
  assert.deepEqual(summary, { state: 'eligible', subCentValueCount: 0, affectedMonthCount: 0, affectedTemplateCount: 0 });
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.hasOwn(preview, 'data'), false);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(store.getStatus().generation, generation);
  assert.equal(storage.operations.some(item => item.op === 'setItem' || item.op === 'removeItem'), false);
  expectCode('INVALID_EXACT_MONEY_MIGRATION_PREVIEW', () => store.commitExactMoneyMigration({ ...preview }));
});

test('sub-cent ledgers are blocked while null and entered zero remain migration eligible', () => {
  const blockedData = makeV3Budget();
  blockedData.months['2026-01'].expenses[0].plannedAmount = 1200.001;
  const blocked = readyStore(blockedData);
  assert.equal(blocked.store.getExactMoneyMigrationSummary().state, 'blocked');
  expectCode('EXACT_MONEY_MIGRATION_BLOCKED', () => blocked.store.previewExactMoneyMigration());

  const exact = makeV3Budget();
  exact.months['2026-01'].paychecks[0].actualAmount = null;
  exact.months['2026-01'].expenses[0].actualAmount = 0;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(exact) });
  const store = createStore({ storage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'migration-snapshot' });
  store.load();
  store.commitExactMoneyMigration(store.previewExactMoneyMigration());
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(persisted.months['2026-01'].paychecks[0].actualAmount, null);
  assert.equal(persisted.months['2026-01'].expenses[0].actualAmount, 0);
  assert.equal(store.getExactMoneyMigrationSummary().state, 'already-migrated');
});

test('migration rejects stale previews and snapshot or primary failures preserve active bytes and memory', () => {
  const clock = () => new Date('2026-08-30T12:00:00Z');
  let id = 0;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const store = createStore({ storage, now: clock, uuid: () => `migration-${++id}` });
  store.load();
  const stale = store.previewExactMoneyMigration();
  store.updateAllocation('2026-01', 'savings', 401);
  expectCode('STALE_EXACT_MONEY_MIGRATION_PREVIEW', () => store.commitExactMoneyMigration(stale));

  const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData(); const beforeStatus = store.getStatus();
  storage.fail({ op: 'setItem', prefix: SNAPSHOT_PREFIX, once: true });
  expectCode('SNAPSHOT_WRITE_FAILED', () => store.commitExactMoneyMigration(store.previewExactMoneyMigration()));
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData); assert.deepEqual(store.getStatus(), beforeStatus);

  storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true });
  expectCode('PRIMARY_WRITE_FAILED', () => store.commitExactMoneyMigration(store.previewExactMoneyMigration()));
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw);
  assert.deepEqual(store.getData(), beforeData); assert.deepEqual(store.getStatus(), beforeStatus);

  store.commitExactMoneyMigration(store.previewExactMoneyMigration());
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schemaVersion, 4);
});

test('v4 backup export/import and snapshot recovery retain envelope v1 and integer cents', () => {
  const v4 = Schema.migrateV3ToV4ExactMoney(makeV3Budget());
  const sourceStorage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(v4) });
  const source = createStore({ storage: sourceStorage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'unused' });
  source.load();
  const backup = JSON.parse(source.exportData());
  assert.equal(backup.formatVersion, 1); assert.equal(backup.data.schemaVersion, 4);
  assert.equal(backup.data.months['2026-01'].paychecks[0].plannedAmount, 250000);

  const targetStorage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const target = createStore({ storage: targetStorage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'pre-import-v3' });
  target.load(); target.importData(JSON.stringify(backup));
  assert.equal(target.getStatus().residentSchemaVersion, 4);
  assert.equal(JSON.parse(targetStorage.getItem(STORAGE_KEY)).schemaVersion, 4);
});

test('v4 backups participate in additive comparison through their embedded schema', () => {
  const data = makeV3Budget();
  const { store } = readyStore(data);
  const backup = Schema.buildV4Backup(data, '2026-08-30T12:00:00.000Z');
  const comparison = store.compareAdditiveBackup(JSON.stringify(backup));
  assert.equal(comparison.months.identical.length, 1);
  assert.equal(comparison.months.conflicting.length, 0);
  assert.equal(comparison.structure.categories, 'identical');
});

test('v4 snapshots list and restore in ready and recovery-required stores with decimal runtime data', () => {
  const data = makeV3Budget();
  const v4Snapshot = Schema.buildV4Snapshot(data, {
    createdAt: '2026-08-30T12:00:00.000Z', localDate: '2026-08-30', reason: 'daily'
  });
  const snapshotKey = `${SNAPSHOT_PREFIX}v4-known`;
  const current = makeV3Budget(); current.months['2026-01'].allocations.savings = 999;
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(current), [snapshotKey]: JSON.stringify(v4Snapshot) });
  const store = createStore({ storage, now: () => new Date('2026-08-31T12:00:00Z'), uuid: () => 'protect-current' });
  store.load();
  assert.equal(store.listSnapshots()[0].data.months['2026-01'].allocations.savings, 400);
  store.restoreSnapshot('v4-known');
  assert.equal(store.getStatus().residentSchemaVersion, 4);
  assert.equal(store.getData().months['2026-01'].allocations.savings, 400);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).months['2026-01'].allocations.savings, 40000);

  const recoveryStorage = new MemoryStorage({ [STORAGE_KEY]: '{damaged', [snapshotKey]: JSON.stringify(v4Snapshot) });
  const recovery = createStore({ storage: recoveryStorage });
  assert.equal(recovery.load().state, 'recovery-required');
  recovery.restoreSnapshot('v4-known');
  assert.equal(recovery.getStatus().state, 'ready');
  assert.equal(recovery.getStatus().residentSchemaVersion, 4);
  assert.equal(recovery.getData().months['2026-01'].allocations.savings, 400);
  assert.equal(JSON.parse(recoveryStorage.getItem(STORAGE_KEY)).schemaVersion, 4);
});

test('migration clock, UUID, snapshot verification, and serialization failures preserve active bytes and memory', () => {
  const cases = [
    { code: 'CLOCK_FAILED', adapters: { now: () => { throw new Error('clock'); }, uuid: () => 'unused' } },
    { code: 'IDENTIFIER_GENERATION_FAILED', adapters: { now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => { throw new Error('uuid'); } } },
    { code: 'SNAPSHOT_READ_FAILED', adapters: { now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'verify-fail' },
      fault: storage => storage.fail({ op: 'getItem', prefix: SNAPSHOT_PREFIX, once: true }) }
  ];
  for (const item of cases) {
    const raw = JSON.stringify(makeV3Budget()); const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
    const store = createStore({ storage, ...item.adapters }); store.load(); storage.operations.length = 0;
    const beforeData = store.getData(); const beforeStatus = store.getStatus(); item.fault?.(storage);
    expectCode(item.code, () => store.commitExactMoneyMigration(store.previewExactMoneyMigration()));
    assert.equal(storage.getItem(STORAGE_KEY), raw, item.code);
    assert.deepEqual(store.getData(), beforeData, item.code); assert.deepEqual(store.getStatus(), beforeStatus, item.code);
    assert.equal(storage.operations.some(op => op.op === 'setItem' && op.key === STORAGE_KEY), false, item.code);
  }

  const raw = JSON.stringify(makeV3Budget()); const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'serialize-snapshot' });
  store.load(); const beforeData = store.getData(); const beforeStatus = store.getStatus(); storage.operations.length = 0;
  const originalStringify = JSON.stringify;
  JSON.stringify = value => {
    if (value && value.schemaVersion === 4) throw new TypeError('injected serialization failure');
    return originalStringify(value);
  };
  try { assert.throws(() => store.commitExactMoneyMigration(store.previewExactMoneyMigration()), TypeError); }
  finally { JSON.stringify = originalStringify; }
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(store.getData(), beforeData); assert.deepEqual(store.getStatus(), beforeStatus);
  assert.equal(storage.operations.some(op => op.op === 'setItem' && op.key === STORAGE_KEY), false);
});

test('successful migration verifies its safety snapshot before exactly one active write', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const store = createStore({ storage, now: () => new Date('2026-08-30T12:00:00Z'), uuid: () => 'ordered-snapshot' });
  store.load(); storage.operations.length = 0;
  store.commitExactMoneyMigration(store.previewExactMoneyMigration());
  const writes = storage.operations.filter(op => op.op === 'setItem');
  const snapshotWrite = storage.operations.findIndex(op => op.op === 'setItem' && op.key.startsWith(SNAPSHOT_PREFIX));
  const snapshotRead = storage.operations.findIndex(op => op.op === 'getItem' && op.key.startsWith(SNAPSHOT_PREFIX));
  const activeWrites = writes.filter(op => op.key === STORAGE_KEY);
  const activeWrite = storage.operations.findIndex(op => op.op === 'setItem' && op.key === STORAGE_KEY);
  assert.equal(activeWrites.length, 1);
  assert.ok(snapshotWrite >= 0 && snapshotRead > snapshotWrite && activeWrite > snapshotRead);
});
