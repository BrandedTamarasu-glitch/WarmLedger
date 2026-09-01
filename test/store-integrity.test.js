'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const StorageEngine = require('../js/storage-engine.js');
const { STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, WRITE_LOCK_KEY,
  StoreError, createStore } = require('../js/data.js');
const { MemoryStorage, makeClock, makeV3Budget } = require('./helpers.js');

function loaded({ storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) }),
  clock = makeClock(), prefix = 'id' } = {}) {
  let sequence = 0;
  const store = createStore({ storage, now: clock, uuid: () => `${prefix}-${++sequence}` });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage, clock };
}

function code(expected, callback) {
  assert.throws(callback, error => error instanceof StoreError && error.code === expected);
}

function makeV5Budget() {
  return Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3Budget()));
}

test('accounts migration is schema-5-only, preview-write-free, generation-bound, and reloadable', () => {
  const persisted = makeV5Budget();
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(persisted) });
  const { store } = loaded({ storage, prefix: 'accounts' });
  const before = storage.getItem(STORAGE_KEY); storage.operations.length = 0;
  const preview = store.previewAccountsMigration();
  assert.deepEqual(Object.keys(preview).sort(), ['expenseCount', 'generation', 'paycheckCount', 'state', 'templateCount']);
  assert.equal(preview.state, 'eligible'); assert.equal(Object.isFrozen(preview), true);
  assert.equal(storage.operations.some(item => item.op !== 'getItem' && item.op !== 'key'), false);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  code('INVALID_ACCOUNTS_MIGRATION_PREVIEW', () => store.commitAccountsMigration({ ...preview }));
  const result = store.commitAccountsMigration(preview);
  assert.equal(result.schemaVersion, 3); assert.deepEqual(result.settings.accounts, []);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schemaVersion, 6);
  const snapshotKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => key.startsWith(SNAPSHOT_PREFIX));
  assert.equal(snapshotKeys.length, 1);
  const snapshot = JSON.parse(storage.getItem(snapshotKeys[0]));
  assert.equal(snapshot.reason, 'pre-accounts'); assert.equal(snapshot.data.schemaVersion, 5);
  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'accounts-reload' });
  assert.equal(reloaded.load().state, 'ready'); assert.equal(reloaded.getStatus().residentSchemaVersion, 6);
  assert.deepEqual(reloaded.getData().settings.accounts, []);
  code('ACCOUNTS_ALREADY_MIGRATED', () => reloaded.previewAccountsMigration());
});

test('accounts migration blocks schemas 3 and 4 with exact copy and rejects stale previews without writes', () => {
  const v3 = loaded();
  assert.deepEqual(v3.store.getAccountsMigrationSummary(), { state: 'blocked', paycheckCount: 0, expenseCount: 0, templateCount: 0,
    message: 'Accounts require the current manual-clearing data format. Complete the earlier storage upgrades before adding accounts.' });
  code('ACCOUNTS_MIGRATION_REQUIRES_MANUAL_CLEARING', () => v3.store.previewAccountsMigration());
  const v4Storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(Schema.migrateV3ToV4ExactMoney(makeV3Budget())) });
  const v4 = loaded({ storage: v4Storage });
  code('ACCOUNTS_MIGRATION_REQUIRES_MANUAL_CLEARING', () => v4.store.previewAccountsMigration());

  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV5Budget()) });
  const migrated = loaded({ storage }); const preview = migrated.store.previewAccountsMigration();
  migrated.store.updateAllocation('2026-01', 'savings', 401); storage.operations.length = 0;
  code('STALE_ACCOUNTS_MIGRATION_PREVIEW', () => migrated.store.commitAccountsMigration(preview));
  assert.equal(storage.operations.some(item => item.op === 'setItem' && item.key === STORAGE_KEY), false);
  assert.equal(storage.operations.some(item => item.op === 'setItem' && item.key.startsWith(SNAPSHOT_PREFIX)), false);
});

test('accounts migration primary-write failure preserves active bytes and live schema-5 state', () => {
  const persisted = makeV5Budget(); const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(persisted) });
  const { store } = loaded({ storage }); const preview = store.previewAccountsMigration();
  const beforeRaw = storage.getItem(STORAGE_KEY); const beforeData = store.getData();
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key === STORAGE_KEY) throw new Error('blocked'); originalSet(key, value); };
  code('PRIMARY_WRITE_FAILED', () => store.commitAccountsMigration(preview));
  storage.setItem = originalSet;
  assert.equal(storage.getItem(STORAGE_KEY), beforeRaw); assert.deepEqual(store.getData(), beforeData);
  assert.equal(store.getStatus().residentSchemaVersion, 5);
});

test('accounts migration safely activates schema 6 in sharded layout and preserves backup/import/restore round trips', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV5Budget()) });
  const { store } = loaded({ storage, prefix: 'accounts-sharded' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  const rootBefore = storage.getItem(STORAGE_KEY);
  store.commitAccountsMigration(store.previewAccountsMigration());
  const root = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
  assert.notEqual(storage.getItem(STORAGE_KEY), rootBefore); assert.equal(root.residentSchemaVersion, 6);
  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'accounts-sharded-reload' });
  assert.equal(reloaded.load().state, 'ready'); assert.equal(reloaded.getStatus().residentSchemaVersion, 6);
  const backupText = reloaded.exportData(); assert.equal(JSON.parse(backupText).data.schemaVersion, 6);
  const importedStorage = new MemoryStorage({ [STORAGE_KEY]: storage.getItem(STORAGE_KEY) });
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index); if (key !== STORAGE_KEY) importedStorage.setItem(key, storage.getItem(key));
  }
  const imported = createStore({ storage: importedStorage, now: makeClock(), uuid: () => 'accounts-import' });
  imported.load(); imported.importData(backupText);
  assert.equal(imported.getStatus().residentSchemaVersion, 6);
  const preAccounts = imported.listSnapshotMetadata().find(item => item.reason === 'pre-accounts');
  assert.ok(preAccounts); imported.restoreSnapshot(preAccounts.id);
  assert.equal(imported.getStatus().residentSchemaVersion, 5);
});

test('semantic no-ops and passive Store paths perform no writes and never acquire the lock', () => {
  const { store, storage } = loaded();
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1200 });
  store.compareSavedMonths({});
  store.explainSavedMonthComparisonRow({ baselineMonth: '2026-01', comparisonMonth: '2026-02',
    basis: 'planned', section: 'categories', dimensionKey: 'Home' });
  store.prepareDashboardRange({ monthKeys: ['2026-01'], basis: 'planned' });
  store.previewLocalDataPurge();
  assert.equal(storage.operations.some(item => item.op !== 'getItem' && item.op !== 'key'), false);
  assert.equal(storage.operations.some(item => item.key === WRITE_LOCK_KEY && item.op !== 'getItem'), false);
});

test('an unexpired foreign lock rejects atomically while an expired lock can be claimed', () => {
  const first = loaded();
  const before = first.store.getData();
  first.storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ ownerId: 'other', expiresAt: first.clock().getTime() + 1000 }));
  first.storage.operations.length = 0;
  code('STORE_BUSY', () => first.store.updateAllocation('2026-01', 'savings', 401));
  assert.deepEqual(first.store.getData(), before);
  assert.equal(first.storage.operations.some(item => item.op === 'setItem' && item.key === STORAGE_KEY), false);

  first.storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ ownerId: 'other', expiresAt: first.clock().getTime() - 1 }));
  first.storage.operations.length = 0;
  first.store.updateAllocation('2026-01', 'savings', 401);
  assert.equal(first.store.getMonth('2026-01').allocations.savings, 401);
  assert.equal(first.storage.getItem(WRITE_LOCK_KEY), null);
  assert.equal(first.storage.operations.filter(item => item.op === 'setItem' && item.key === STORAGE_KEY).length, 1);
});

test('fresh-raw revalidation rejects stale writers with no primary or snapshot write', () => {
  const { store, storage } = loaded();
  const external = makeV3Budget();
  external.months['2026-01'].allocations.savings = 777;
  storage.setItem(STORAGE_KEY, JSON.stringify(external));
  storage.operations.length = 0;
  code('STALE_WRITE', () => store.updateAllocation('2026-01', 'savings', 401));
  assert.equal(store.getMonth('2026-01').allocations.savings, 400);
  assert.equal(storage.operations.some(item => item.op === 'setItem' &&
    (item.key === STORAGE_KEY || item.key.startsWith(SNAPSHOT_PREFIX))), false);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
});

test('reload is write-free, reports byte changes, and refreshes resident state', () => {
  const { store, storage } = loaded();
  assert.equal(store.reload().changed, false);
  const external = makeV3Budget();
  external.months['2026-01'].allocations.savings = 612;
  storage.setItem(STORAGE_KEY, JSON.stringify(external));
  storage.operations.length = 0;
  const status = store.reload();
  assert.equal(status.changed, true);
  assert.equal(store.getMonth('2026-01').allocations.savings, 612);
  assert.equal(storage.operations.some(item => item.op !== 'getItem' && item.op !== 'key'), false);
});

test('purge preview is frozen, detached, generation-bound, and successful purge leaves no local artifacts', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()), [CORRUPT_KEY]: 'evidence',
    [`${SNAPSHOT_PREFIX}one`]: 'snapshot', [`${SNAPSHOT_PREFIX}two`]: 'snapshot' });
  const { store } = loaded({ storage });
  const preview = store.previewLocalDataPurge();
  assert.deepEqual(preview, { activeDataPresent: true, corruptEvidencePresent: true,
    snapshotCount: 2, lockPresent: false, generation: 1 });
  assert.equal(Object.isFrozen(preview), true);
  store.commitLocalDataPurge(preview);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem(CORRUPT_KEY), null);
  assert.equal(storage.getItem(`${SNAPSHOT_PREFIX}one`), null);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  assert.equal(store.getStatus().state, 'empty');
  assert.equal(store.reload().changed, false);
  code('INVALID_PURGE_PREVIEW', () => store.commitLocalDataPurge(preview));
});

test('purge delete failure rolls removed bytes back and leaves resident data intact', () => {
  const raw = JSON.stringify(makeV3Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw, [CORRUPT_KEY]: 'evidence' });
  const { store } = loaded({ storage });
  const before = store.getData();
  const preview = store.previewLocalDataPurge();
  storage.fail({ op: 'removeItem', key: CORRUPT_KEY, once: true });
  code('PURGE_FAILED', () => store.commitLocalDataPurge(preview));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.getItem(CORRUPT_KEY), 'evidence');
  assert.deepEqual(store.getData(), before);
  assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
});

test('purge preview becomes stale after a commit and purge recovery failure fails closed', () => {
  const first = loaded();
  const stale = first.store.previewLocalDataPurge();
  first.store.updateAllocation('2026-01', 'savings', 405);
  first.storage.operations.length = 0;
  code('STALE_PURGE_PREVIEW', () => first.store.commitLocalDataPurge(stale));
  assert.equal(first.storage.operations.length, 0);

  const raw = JSON.stringify(makeV3Budget());
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw, [CORRUPT_KEY]: 'evidence' });
  const second = loaded({ storage });
  const preview = second.store.previewLocalDataPurge();
  storage.fail({ op: 'removeItem', key: CORRUPT_KEY, once: true });
  storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true });
  code('PURGE_RECOVERY_FAILED', () => second.store.commitLocalDataPurge(preview));
  assert.equal(second.store.getStatus().state, 'recovery-required');
  code('RECOVERY_REQUIRED', () => second.store.getData());
});

test('prepared dashboard range is ordered, deeply frozen, detached, and preserves incomplete methods', () => {
  const { store, storage } = loaded();
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: null });
  storage.operations.length = 0;
  const prepared = store.prepareDashboardRange({ monthKeys: ['2026-02', '2026-01'], basis: 'actual' });
  assert.deepEqual(prepared.monthKeys, ['2026-02', '2026-01']);
  assert.deepEqual({
    exists: prepared.months['2026-02'].exists,
    paycheckCount: prepared.months['2026-02'].paycheckCount,
    expenseCount: prepared.months['2026-02'].expenseCount,
    suppressedOccurrenceCount: prepared.months['2026-02'].suppressedOccurrenceCount
  }, { exists: false, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 });
  assert.deepEqual({
    exists: prepared.months['2026-01'].exists,
    paycheckCount: prepared.months['2026-01'].paycheckCount,
    expenseCount: prepared.months['2026-01'].expenseCount,
    suppressedOccurrenceCount: prepared.months['2026-01'].suppressedOccurrenceCount
  }, { exists: true, paycheckCount: 1, expenseCount: 1, suppressedOccurrenceCount: 0 });
  assert.equal(prepared.months['2026-01'].summary.unresolvedExpenseCount, 1);
  assert.deepEqual(prepared.months['2026-01'].incompletePaymentMethods, ['bank']);
  assert.equal(prepared.months['2026-01'].paymentMethodTotals.bank, 0);
  assert.equal(Object.isFrozen(prepared.months['2026-01'].summary), true);
  assert.equal(Object.isFrozen(prepared.months['2026-01']), true);
  assert.equal(storage.operations.length, 0);
  assert.throws(() => { prepared.months['2026-01'].summary.totalIncome = -1; }, TypeError);
  assert.equal(store.calcMonthSummary('2026-01').totalIncome, 2500);
});

test('prepared counts distinguish missing, saved-empty, and tombstone-only months without exposing records', () => {
  const budget = makeV3Budget();
  budget.templates.income.push({
    id: 'template-example-1', name: 'Example payday', earnerId: 'earner-example-1',
    plannedAmount: 100, enabled: true, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }
  });
  budget.months['2026-02'] = { paychecks: [], expenses: [], allocations: {
    savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] };
  budget.months['2026-03'] = { paychecks: [], expenses: [], allocations: {
    savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [
    { sourceTemplateId: 'template-example-1', occurrenceKey: '2026-03-01#0001' }
  ] };
  const { store } = loaded({ storage: new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) }) });
  const prepared = store.prepareDashboardRange({
    monthKeys: ['2026-04', '2026-02', '2026-03'], basis: 'planned'
  });
  assert.deepEqual(prepared.monthKeys.map(key => ({
    exists: prepared.months[key].exists,
    paycheckCount: prepared.months[key].paycheckCount,
    expenseCount: prepared.months[key].expenseCount,
    suppressedOccurrenceCount: prepared.months[key].suppressedOccurrenceCount
  })), [
    { exists: false, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 },
    { exists: true, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 0 },
    { exists: true, paycheckCount: 0, expenseCount: 0, suppressedOccurrenceCount: 1 }
  ]);
  assert.equal('paychecks' in prepared.months['2026-03'], false);
  assert.equal('expenses' in prepared.months['2026-03'], false);
});

test('shared comparison validator exposes all locked statuses consistently', () => {
  const oneMonth = loaded();
  const compare = request => oneMonth.store.compareSavedMonths(request).status;
  const explain = request => oneMonth.store.explainSavedMonthComparisonRow(request).status;
  const base = { baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' };
  assert.equal(compare({ ...base, basis: 'bad' }), 'invalid-basis');
  assert.equal(explain({ ...base, basis: 'bad', section: 'categories' }), 'invalid-basis');
  assert.equal(compare(base), 'insufficient-saved-months');
  assert.equal(explain({ ...base, section: 'categories' }), 'insufficient-saved-months');
});

test('month-shard migration is explicit, preview-write-free, identity-bound, and reloadable', () => {
  const { store, storage } = loaded({ prefix: 'shard' });
  const summary = store.getShardedPersistenceSummary();
  assert.equal(summary.state, 'available');
  assert.equal(summary.firstMonth, '2026-01');
  assert.equal(summary.lastMonth, '2026-01');
  const before = storage.getItem(STORAGE_KEY);
  storage.operations.length = 0;
  const preview = store.previewShardedPersistenceMigration();
  assert.equal(preview.layout, 'month-sharded');
  assert.equal(preview.monthCount, 1);
  assert.equal(preview.firstMonth, '2026-01');
  assert.equal(preview.lastMonth, '2026-01');
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  code('INVALID_MONTH_SHARD_MIGRATION_PREVIEW', () => store.commitMonthShardMigration({ ...preview }));
  const result = store.commitShardedPersistenceMigration(preview);
  assert.equal(result.layout, 'sharded');
  const writes = storage.operations.filter(operation => operation.op === 'setItem').map(operation => operation.key);
  assert.ok(writes.indexOf(StorageEngine.JOURNAL_KEY) < writes.findIndex(key =>
    key.startsWith(StorageEngine.GLOBAL_PREFIX) || key.startsWith(StorageEngine.MONTH_PREFIX) || key.startsWith(StorageEngine.MANIFEST_PREFIX)));
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).layout, 'month-sharded');
  assert.ok(store.listSnapshots().some(snapshot => snapshot.reason === 'pre-sharding'));

  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
  assert.equal(reloaded.load().layout, 'sharded');
  assert.equal(reloaded.getShardedPersistenceSummary().state, 'already-sharded');
  assert.deepEqual(reloaded.getData(), store.getData());
  code('MONTH_SHARD_ALREADY_MIGRATED', () => reloaded.previewMonthShardMigration());
});

test('sharded semantic no-op performs zero writes against the canonical resident state', () => {
  const { store, storage } = loaded({ prefix: 'noop-shard' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  storage.operations.length = 0;
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 1200 });
  assert.equal(storage.operations.some(operation => operation.op !== 'getItem'), false);
});

test('sharded month-only commits reuse global references and untouched month references', () => {
  const budget = makeV3Budget();
  budget.months['2026-02'] = structuredClone(budget.months['2026-01']);
  budget.months['2026-02'].paychecks[0].id = 'paycheck-february';
  budget.months['2026-02'].paychecks[0].date = '2026-02-15';
  budget.months['2026-02'].expenses[0].id = 'expense-february';
  budget.months['2026-02'].expenses[0].paycheckAmounts = { 'paycheck-february': 1200 };
  const { store, storage } = loaded({ storage: new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) }), prefix: 'cow' });
  store.commitMonthShardMigration(store.previewMonthShardMigration());
  const firstRoot = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
  const firstManifest = StorageEngine.parseManifest(storage.getItem(firstRoot.manifestKey));
  storage.operations.length = 0;
  store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 999 });
  const secondRoot = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
  const secondManifest = StorageEngine.parseManifest(storage.getItem(secondRoot.manifestKey));
  assert.deepEqual(secondManifest.global, firstManifest.global);
  assert.deepEqual(secondManifest.months['2026-02'], firstManifest.months['2026-02']);
  assert.notDeepEqual(secondManifest.months['2026-01'], firstManifest.months['2026-01']);
  const shardWrites = storage.operations.filter(operation => operation.op === 'setItem' &&
    (operation.key.startsWith(StorageEngine.GLOBAL_PREFIX) || operation.key.startsWith(StorageEngine.MONTH_PREFIX)));
  assert.deepEqual(shardWrites.map(operation => operation.key), [secondManifest.months['2026-01'].key]);
});

test('failed sharded root activation rolls staged generation back and preserves the prior readable generation', () => {
  const { store, storage } = loaded({ prefix: 'rollback' });
  store.commitMonthShardMigration(store.previewMonthShardMigration());
  const priorRoot = storage.getItem(STORAGE_KEY);
  const priorData = store.getData();
  storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true });
  code('PRIMARY_WRITE_FAILED', () => store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 777 }));
  assert.equal(storage.getItem(STORAGE_KEY), priorRoot);
  assert.deepEqual(store.getData(), priorData);
  assert.equal(Array.from(storage._values.keys()).some(key => key === StorageEngine.JOURNAL_KEY), false);
  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
  assert.equal(reloaded.load().state, 'ready');
  assert.deepEqual(reloaded.getData(), priorData);
});

test('global-only and copy commits preserve every untouched shard reference and copy reads its source without writing it', () => {
  const budget = makeV3Budget();
  budget.months['2026-02'] = structuredClone(budget.months['2026-01']);
  budget.months['2026-02'].paychecks[0].id = 'paycheck-february';
  budget.months['2026-02'].paychecks[0].date = '2026-02-15';
  budget.months['2026-02'].expenses[0].id = 'expense-february';
  budget.months['2026-02'].expenses[0].paycheckAmounts = { 'paycheck-february': 1200 };
  const { store, storage } = loaded({ storage: new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) }), prefix: 'scope' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  const manifest = () => { const root = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
    return StorageEngine.parseManifest(storage.getItem(root.manifestKey)); };
  const initial = manifest();
  storage.operations.length = 0;
  store.renameCategory('category-example-1', 'Home costs');
  const globalCommit = manifest();
  assert.notDeepEqual(globalCommit.global, initial.global);
  assert.deepEqual(globalCommit.months, initial.months);
  assert.equal(storage.operations.some(op => op.op === 'setItem' && op.key.startsWith(StorageEngine.MONTH_PREFIX)), false);
  storage.operations.length = 0;
  store.copyFromMonth('2026-02', '2026-01');
  const copyCommit = manifest();
  assert.deepEqual(copyCommit.months['2026-01'], globalCommit.months['2026-01']);
  assert.notDeepEqual(copyCommit.months['2026-02'], globalCommit.months['2026-02']);
  assert.deepEqual(storage.operations.filter(op => op.op === 'setItem' && op.key.startsWith(StorageEngine.MONTH_PREFIX))
    .map(op => op.key), [copyCommit.months['2026-02'].key]);
  assert.equal(storage.operations.some(op => op.op === 'getItem' && op.key === globalCommit.months['2026-01'].key), false);
});

test('sharded corruption evidence captures detection time and exact failing month bytes', () => {
  const clock = makeClock('2026-03-04T05:06:07.890Z');
  const { store, storage } = loaded({ clock, prefix: 'evidence' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  const root = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
  const manifest = StorageEngine.parseManifest(storage.getItem(root.manifestKey));
  const failingKey = manifest.months['2026-01'].key;
  storage.setItem(failingKey, '{"broken":true}');
  clock.set('2026-04-05T06:07:08.901Z');
  const damaged = createStore({ storage, now: clock, uuid: () => 'damaged' });
  assert.equal(damaged.load().state, 'recovery-required');
  const evidence = JSON.parse(damaged.getCorruptEvidence());
  assert.deepEqual({ format: evidence.format, formatVersion: evidence.formatVersion, layout: evidence.layout,
    capturedAt: evidence.capturedAt, failingKey: evidence.failingKey, failingRaw: evidence.failingRaw }, {
    format: 'zerobudget-corrupt-evidence', formatVersion: 1, layout: 'month-sharded',
    capturedAt: '2026-04-05T06:07:08.901Z', failingKey, failingRaw: '{"broken":true}'
  });
  assert.equal(evidence.manifestKey, root.manifestKey);
  assert.equal(evidence.manifestRaw, storage.getItem(root.manifestKey));
});

test('expired and malformed journals are removed on load and cannot retain unreachable generation keys', () => {
  const { store, storage } = loaded({ prefix: 'journal-gc' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  const orphanGeneration = '20260101T000000000Z-00000000-0000-4000-8000-000000000001';
  const orphanKey = StorageEngine.globalKey(orphanGeneration);
  storage.setItem(orphanKey, '{}');
  storage.setItem(StorageEngine.JOURNAL_KEY, '{bad');
  const reloaded = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
  assert.equal(reloaded.load().state, 'ready');
  assert.equal(storage.getItem(StorageEngine.JOURNAL_KEY), null);
  assert.equal(storage.getItem(orphanKey), null);
});

test('journal, shard, manifest, and root activation failures retain exact legacy root bytes and clean every staged key', () => {
  const cases = [
    { key: StorageEngine.JOURNAL_KEY },
    { prefix: StorageEngine.GLOBAL_PREFIX },
    { prefix: StorageEngine.MONTH_PREFIX },
    { prefix: StorageEngine.MANIFEST_PREFIX },
    { key: STORAGE_KEY }
  ];
  for (const [index, fault] of cases.entries()) {
    const raw = JSON.stringify(makeV3Budget());
    const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
    const { store } = loaded({ storage, prefix: `stage-${index}` });
    const preview = store.previewShardedPersistenceMigration();
    storage.fail({ op: 'setItem', ...fault, once: true });
    assert.throws(() => store.commitShardedPersistenceMigration(preview), StoreError);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.getItem(StorageEngine.JOURNAL_KEY), null);
    assert.equal(Array.from(storage._values.keys()).some(key => key.startsWith(StorageEngine.GLOBAL_PREFIX) ||
      key.startsWith(StorageEngine.MONTH_PREFIX) || key.startsWith(StorageEngine.MANIFEST_PREFIX)), false);
  }
});

test('expired valid journal cleanup removes staged orphans and retains every active reference', () => {
  const { store, storage } = loaded({ prefix: 'expired' });
  store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
  const rootRaw = storage.getItem(STORAGE_KEY), root = StorageEngine.parseRootPointer(rootRaw);
  const manifest = StorageEngine.parseManifest(storage.getItem(root.manifestKey));
  const generation = '20260101T000000000Z-00000000-0000-4000-8000-000000000002';
  const orphan = StorageEngine.globalKey(generation);
  storage.setItem(orphan, '{}');
  storage.setItem(StorageEngine.JOURNAL_KEY, JSON.stringify(StorageEngine.buildJournal({ txId: generation,
    baseMode: 'sharded', baseGeneration: root.generation, nextGeneration: generation,
    residentSchemaVersion: 3, stagedKeys: [orphan], startedAt: '2026-01-01T00:00:00.000Z', expiresAt: 1 })));
  const reload = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
  assert.equal(reload.load().state, 'ready');
  assert.equal(storage.getItem(StorageEngine.JOURNAL_KEY), null); assert.equal(storage.getItem(orphan), null);
  assert.notEqual(storage.getItem(root.manifestKey), null); assert.notEqual(storage.getItem(manifest.global.key), null);
  manifest.monthOrder.forEach(month => assert.notEqual(storage.getItem(manifest.months[month].key), null));
});

test('a competing valid root immediately before activation aborts stale and preserves the newer root without residue', () => {
  const newerRaw = JSON.stringify(makeV3Budget({ months: {} }));
  class RacingStorage extends MemoryStorage {
    getItem(key) {
      if (key === STORAGE_KEY && this._values.has(StorageEngine.JOURNAL_KEY) && !this.raced) {
        this.raced = true; this._values.set(STORAGE_KEY, newerRaw);
      }
      return super.getItem(key);
    }
  }
  const original = JSON.stringify(makeV3Budget());
  const storage = new RacingStorage({ [STORAGE_KEY]: original });
  const { store } = loaded({ storage, prefix: 'race' }); const before = store.getData();
  assert.throws(() => store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration()),
    error => error instanceof StoreError && error.code === 'STALE_WRITE');
  assert.equal(storage.getItem(STORAGE_KEY), newerRaw); assert.deepEqual(store.getData(), before);
  assert.equal(storage.getItem(StorageEngine.JOURNAL_KEY), null);
  assert.equal(Array.from(storage._values.keys()).some(key => key.startsWith(StorageEngine.MANIFEST_PREFIX) ||
    key.startsWith(StorageEngine.GLOBAL_PREFIX) || key.startsWith(StorageEngine.MONTH_PREFIX)), false);
});

test('corrupt sharded recovery via startFresh and snapshot restore permits ordinary edits and reload', () => {
  for (const action of ['fresh', 'restore']) {
    const { store, storage } = loaded({ prefix: `recover-${action}` });
    store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
    const snapshot = store.listSnapshots()[0];
    const root = StorageEngine.parseRootPointer(storage.getItem(STORAGE_KEY));
    const manifest = StorageEngine.parseManifest(storage.getItem(root.manifestKey));
    storage.setItem(manifest.months['2026-01'].key, '{bad');
    const damaged = createStore({ storage, now: makeClock(), uuid: (() => { let n = 0; return () => `repair-${action}-${++n}`; })() });
    assert.equal(damaged.load().state, 'recovery-required');
    if (action === 'fresh') damaged.startFresh(); else damaged.restoreSnapshot(snapshot.id);
    damaged.ensureMonth('2026-02');
    const reload = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
    assert.equal(reload.load().state, 'ready'); assert.ok(reload.getAllMonthKeys().includes('2026-02'));
  }
});

test('sharded import, ready restore, and startFresh each activate a fresh reloadable sharded generation', () => {
  for (const action of ['import', 'restore', 'fresh']) {
    const { store, storage } = loaded({ prefix: `replace-${action}` });
    store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
    const prior = store.getStatus().activeGeneration; const snapshot = store.listSnapshots()[0];
    if (action === 'import') {
      const backup = JSON.parse(store.exportData());
      backup.data.months['2026-01'].expenses[0].actualAmount = 321;
      store.importData(JSON.stringify(backup));
    }
    else if (action === 'restore') { store.updateExpense('2026-01', 'expense-example-1', { actualAmount: 111 }); store.restoreSnapshot(snapshot.id); }
    else store.startFresh();
    assert.notEqual(store.getStatus().activeGeneration, prior); assert.equal(store.getStatus().layout, 'sharded');
    const reload = createStore({ storage, now: makeClock(), uuid: () => 'reload' });
    assert.equal(reload.load().state, 'ready'); assert.equal(reload.getStatus().residentSchemaVersion, 3);
  }
});

test('sharded purge removes every artifact and a deletion fault restores the complete byte-exact key map', () => {
  for (const fail of [false, true]) {
    const { store, storage } = loaded({ prefix: `purge-shard-${fail}` });
    store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration());
    storage.setItem('zeroBudget_global:orphan', 'orphan'); storage.setItem(CORRUPT_KEY, 'evidence');
    const before = new Map(storage._values); const preview = store.previewLocalDataPurge();
    if (fail) storage.fail({ op: 'removeItem', prefix: StorageEngine.MONTH_PREFIX, once: true });
    if (fail) { assert.throws(() => store.commitLocalDataPurge(preview), StoreError); assert.deepEqual(storage._values, before); }
    else { store.commitLocalDataPurge(preview); assert.equal(storage._values.size, 0); }
  }
});

test('lost sharded lock ownership during staging aborts before root activation', () => {
  class TakeoverStorage extends MemoryStorage {
    setItem(key, value) {
      super.setItem(key, value);
      if (key.startsWith(StorageEngine.MONTH_PREFIX) && !this.taken) {
        this.taken = true; this._values.set(WRITE_LOCK_KEY, JSON.stringify({ ownerId: 'other', revision: 'legacy',
          heartbeatAt: Date.parse('2026-01-15T12:00:00.000Z'), expiresAt: Date.parse('2026-01-15T12:01:00.000Z') }));
      }
    }
  }
  let instant = Date.parse('2026-01-15T12:00:00.000Z');
  const clock = () => { const value = new Date(instant); instant += 3000; return value; };
  const base = new TakeoverStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const { store } = loaded({ storage: base, clock, prefix: 'takeover' }); const raw = base.getItem(STORAGE_KEY);
  assert.throws(() => store.commitShardedPersistenceMigration(store.previewShardedPersistenceMigration()), StoreError);
  assert.equal(base.getItem(STORAGE_KEY), raw);
});
