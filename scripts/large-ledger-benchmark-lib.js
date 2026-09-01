'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createStore, STORAGE_KEY, SNAPSHOT_PREFIX } = require('../js/data.js');

const DEFAULT_SIZES = Object.freeze([
  Object.freeze({ months: 12, expensesPerMonth: 50 }),
  Object.freeze({ months: 36, expensesPerMonth: 100 }),
  Object.freeze({ months: 60, expensesPerMonth: 200 })
]);
const DEFAULT_ITERATIONS = 3;
const LIMITS = Object.freeze({ sizes: 6, months: 120, expensesPerMonth: 1000, records: 50000, iterations: 20 });
const OPERATIONS = Object.freeze([
  'startup_load', 'ordinary_edit_commit', 'month_sharded_ordinary_edit_commit', 'prepare_dashboard_range',
  'saved_record_search', 'saved_month_comparison', 'explain_change'
]);

class InstrumentedStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
    this.operations = [];
  }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key) {
    key = String(key); this.operations.push({ type: 'read', key });
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    key = String(key); value = String(value);
    this.operations.push({ type: 'write', key, bytes: Buffer.byteLength(value) });
    this.values.set(key, value);
  }
  removeItem(key) { key = String(key); this.operations.push({ type: 'remove', key }); this.values.delete(key); }
  resetOperations() { this.operations.length = 0; }
}

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(value || '')) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseSizes(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('--sizes requires a value');
  const sizes = value.split(',').map(token => {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (!match) throw new Error('--sizes must use MONTHSxEXPENSES_PER_MONTH entries');
    return { months: parsePositiveInteger(match[1], '--sizes months'),
      expensesPerMonth: parsePositiveInteger(match[2], '--sizes expenses') };
  });
  validateSizes(sizes);
  return sizes;
}

function validateSizes(sizes) {
  if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > LIMITS.sizes) {
    throw new Error(`sizes must contain 1-${LIMITS.sizes} entries`);
  }
  for (const size of sizes) {
    if (!Number.isInteger(size.months) || size.months < 2 || size.months > LIMITS.months) {
      throw new Error(`months must be between 2 and ${LIMITS.months}`);
    }
    if (!Number.isInteger(size.expensesPerMonth) || size.expensesPerMonth < 1 ||
        size.expensesPerMonth > LIMITS.expensesPerMonth) {
      throw new Error(`expenses per month must be between 1 and ${LIMITS.expensesPerMonth}`);
    }
    if (size.months * (size.expensesPerMonth + 2) > LIMITS.records) {
      throw new Error(`each size must contain at most ${LIMITS.records} records`);
    }
  }
}

function parseArgs(argv) {
  const options = { sizes: DEFAULT_SIZES.map(size => ({ ...size })), iterations: DEFAULT_ITERATIONS, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--sizes') options.sizes = parseSizes(argv[++index]);
    else if (flag === '--iterations') {
      options.iterations = parsePositiveInteger(argv[++index], '--iterations');
      if (options.iterations > LIMITS.iterations) throw new Error(`--iterations must be at most ${LIMITS.iterations}`);
    } else if (flag === '--output') {
      const output = argv[++index];
      if (!output || output.startsWith('-') || output.includes('\0')) throw new Error('--output requires a file path');
      options.output = path.resolve(output);
    } else if (flag === '--help') options.help = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  validateSizes(options.sizes);
  return options;
}

function monthKeyAt(index) {
  const year = 2020 + Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function buildSyntheticLedger({ months, expensesPerMonth }) {
  validateSizes([{ months, expensesPerMonth }]);
  const categories = Array.from({ length: 8 }, (_, index) => ({
    id: `category-${String(index + 1).padStart(2, '0')}`,
    name: `Category ${String(index + 1).padStart(2, '0')}`,
    archived: false,
    items: []
  }));
  const earners = [1, 2].map(number => ({ id: `earner-${number}`, name: `Earner ${number}`, archived: false }));
  const savedMonths = {};
  for (let monthIndex = 0; monthIndex < months; monthIndex += 1) {
    const monthKey = monthKeyAt(monthIndex);
    const paychecks = earners.map((earner, index) => ({
      id: `income-${String(monthIndex).padStart(3, '0')}-${index + 1}`,
      earnerId: earner.id, earner: earner.name, plannedAmount: 3000 + index * 500,
      actualAmount: (monthIndex + index) % 9 === 0 ? null : 3000 + index * 500,
      date: `${monthKey}-${index === 0 ? '05' : '20'}`, sourceTemplateId: null, occurrenceKey: null
    }));
    const expenses = Array.from({ length: expensesPerMonth }, (_, expenseIndex) => {
      const category = categories[expenseIndex % categories.length];
      const amount = 20 + (expenseIndex % 200) / 10;
      return {
        id: `expense-${String(monthIndex).padStart(3, '0')}-${String(expenseIndex).padStart(4, '0')}`,
        categoryId: category.id, category: category.name, categoryItemId: null,
        name: `${expenseIndex % 10 === 0 ? 'Searchable' : 'Routine'} expense ${String(expenseIndex).padStart(4, '0')}`,
        date: `${monthKey}-${String((expenseIndex % 28) + 1).padStart(2, '0')}`,
        paycheckAmounts: {}, plannedAmount: amount,
        actualAmount: (monthIndex + expenseIndex) % 17 === 0 ? null
          : (monthIndex + expenseIndex) % 29 === 0 ? 0 : amount,
        paymentMethod: ['bank', 'credit_card', 'savings', 'investments'][expenseIndex % 4],
        sourceTemplateId: null, occurrenceKey: null
      };
    });
    savedMonths[monthKey] = { paychecks, expenses,
      allocations: { savings: 300, credit_card_debt: 100, investments: 200 }, suppressedOccurrences: [] };
  }
  return { schemaVersion: 3, categories, settings: { earners }, templates: { income: [], expenses: [] }, months: savedMonths };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  const rounded = value => Number(value.toFixed(3));
  return Object.freeze({
    samples: sorted.length,
    minMs: rounded(sorted[0]), medianMs: rounded(quantile(0.5)), p95Ms: rounded(quantile(0.95)),
    maxMs: rounded(sorted[sorted.length - 1]),
    meanMs: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  });
}

function timed(callback) {
  const start = performance.now();
  const observation = callback();
  return { duration: performance.now() - start, observation };
}

function makeStore(raw, initial = null, uuidOffset = 0) {
  const storage = new InstrumentedStorage(initial || { [STORAGE_KEY]: raw });
  let sequence = uuidOffset;
  const store = createStore({ storage, now: () => new Date('2026-09-01T12:00:00.000Z'),
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  return { store, storage };
}

function activeManifest(storage) {
  const root = JSON.parse(storage.values.get(STORAGE_KEY));
  return { root, manifest: JSON.parse(storage.values.get(root.manifestKey)) };
}

function writeObservation(operations) {
  const writes = operations.filter(operation => operation.type === 'write');
  const primary = writes.filter(operation => operation.key === STORAGE_KEY);
  const snapshots = writes.filter(operation => operation.key.startsWith(SNAPSHOT_PREFIX));
  return { writeCount: writes.length, writtenBytes: writes.reduce((sum, item) => sum + item.bytes, 0),
    primaryWriteCount: primary.length, primaryWrittenBytes: primary.reduce((sum, item) => sum + item.bytes, 0),
    snapshotWriteCount: snapshots.length, snapshotWrittenBytes: snapshots.reduce((sum, item) => sum + item.bytes, 0) };
}

function shardedWriteObservation(storage, operations, before) {
  const observation = writeObservation(operations);
  const writes = operations.filter(operation => operation.type === 'write');
  const activeLayoutWrites = writes.filter(item => item.key === STORAGE_KEY ||
    item.key.startsWith('zeroBudget_manifest:') || item.key.startsWith('zeroBudget_global:') ||
    item.key.startsWith('zeroBudget_month:'));
  const after = activeManifest(storage);
  const unchangedMonths = before.manifest.monthOrder.filter(monthKey =>
    before.manifest.months[monthKey].key === after.manifest.months[monthKey].key);
  const changedMonths = before.manifest.monthOrder.filter(monthKey =>
    before.manifest.months[monthKey].key !== after.manifest.months[monthKey].key);
  return {
    ...observation,
    activeLayoutWriteCount: activeLayoutWrites.length,
    activeLayoutWrittenBytes: activeLayoutWrites.reduce((sum, item) => sum + item.bytes, 0),
    journalWriteCount: writes.filter(item => item.key === 'zeroBudget_journal').length,
    manifestWriteCount: writes.filter(item => item.key.startsWith('zeroBudget_manifest:')).length,
    globalShardWriteCount: writes.filter(item => item.key.startsWith('zeroBudget_global:')).length,
    monthShardWriteCount: writes.filter(item => item.key.startsWith('zeroBudget_month:')).length,
    reusedGlobalReferenceCount: before.manifest.global.key === after.manifest.global.key ? 1 : 0,
    reusedMonthReferenceCount: unchangedMonths.length,
    changedMonthReferenceCount: changedMonths.length
  };
}

function aggregateObservations(items) {
  const keys = Object.keys(items[0] || {});
  return Object.fromEntries(keys.map(key => [key, items.reduce((sum, item) => sum + item[key], 0) / items.length]));
}

function measureOperation(iterations, callback) {
  const durations = []; const observations = [];
  for (let index = 0; index < iterations; index += 1) {
    const result = timed(() => callback(index));
    durations.push(result.duration);
    if (result.observation) observations.push(result.observation);
  }
  return { duration: summarize(durations), observations: observations.length ? aggregateObservations(observations) : {} };
}

function benchmarkSize(size, iterations) {
  const ledger = buildSyntheticLedger(size);
  const raw = JSON.stringify(ledger);
  const monthKeys = Object.keys(ledger.months).sort();
  const baselineMonth = monthKeys[0]; const comparisonMonth = monthKeys[monthKeys.length - 1];
  const operations = {};

  operations.startup_load = measureOperation(iterations, () => {
    const { store, storage } = makeStore(raw);
    const state = store.load().state;
    return { stateReady: state === 'ready' ? 1 : 0,
      storageReadCount: storage.operations.filter(item => item.type === 'read').length };
  });
  const legacyEditStores = Array.from({ length: iterations }, () => {
    const subject = makeStore(raw);
    subject.store.load();
    subject.storage.resetOperations();
    return subject;
  });
  operations.ordinary_edit_commit = measureOperation(iterations, index => {
    const { store, storage } = legacyEditStores[index];
    store.updateExpense(baselineMonth, ledger.months[baselineMonth].expenses[0].id,
      { actualAmount: 21 + index / 100 });
    return writeObservation(storage.operations);
  });
  const migratedSeed = makeStore(raw);
  migratedSeed.store.load();
  migratedSeed.store.commitShardedPersistenceMigration(
    migratedSeed.store.previewShardedPersistenceMigration());
  const migratedInitial = Object.fromEntries(migratedSeed.storage.values);
  const shardedEditStores = Array.from({ length: iterations }, (_, index) => {
    const subject = makeStore(raw, migratedInitial, 1000 + index * 10);
    subject.store.load();
    const before = activeManifest(subject.storage);
    subject.storage.resetOperations();
    return { ...subject, before };
  });
  operations.month_sharded_ordinary_edit_commit = measureOperation(iterations, index => {
    const { store, storage, before } = shardedEditStores[index];
    store.updateExpense(baselineMonth, ledger.months[baselineMonth].expenses[0].id,
      { actualAmount: 21 + index / 100 });
    return shardedWriteObservation(storage, storage.operations, before);
  });
  const loaded = makeStore(raw); loaded.store.load(); loaded.storage.resetOperations();
  operations.prepare_dashboard_range = measureOperation(iterations, () => {
    const result = loaded.store.prepareDashboardRange({ monthKeys, basis: 'actual' });
    return { returnedMonthCount: result.monthKeys.length };
  });
  operations.saved_record_search = measureOperation(iterations, () => {
    const result = loaded.store.findSavedRecords({ query: 'searchable', kind: 'expense', limit: 200 });
    return { totalMatchCount: result.totalMatchCount, returnedCount: result.returnedCount };
  });
  operations.saved_month_comparison = measureOperation(iterations, () => {
    const result = loaded.store.compareSavedMonths({ baselineMonth, comparisonMonth, basis: 'actual' });
    return { readyCount: result.status === 'ready' ? 1 : 0, rowCount: result.rowModel.rows.length };
  });
  operations.explain_change = measureOperation(iterations, () => {
    const result = loaded.store.explainSavedMonthComparisonRow({ baselineMonth, comparisonMonth,
      basis: 'actual', section: 'categories', dimensionKey: 'Category 01' });
    return { readyCount: result.status === 'ready' ? 1 : 0,
      totalContributorCount: result.counts.totalCount, returnedContributorCount: result.counts.returnedCount };
  });
  return {
    fixture: { months: size.months, expensesPerMonth: size.expensesPerMonth,
      paycheckCount: size.months * 2, expenseCount: size.months * size.expensesPerMonth,
      serializedBytes: Buffer.byteLength(raw) },
    operations
  };
}

function runBenchmark(options) {
  validateSizes(options.sizes);
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > LIMITS.iterations) {
    throw new Error(`iterations must be between 1 and ${LIMITS.iterations}`);
  }
  return {
    schemaVersion: 2,
    benchmark: 'warm-ledger-large-ledger',
    measurementOnly: true,
    units: { duration: 'milliseconds', storage: 'UTF-8 bytes' },
    configuration: { iterations: options.iterations, sizes: options.sizes.map(size => ({ ...size })) },
    operationCoverage: [...OPERATIONS],
    results: options.sizes.map(size => benchmarkSize(size, options.iterations))
  };
}

function humanSummary(report) {
  const lines = ['Warm Ledger large-ledger benchmark (measurement only; no pass/fail thresholds)'];
  for (const result of report.results) {
    const fixture = result.fixture;
    lines.push(`${fixture.months} months x ${fixture.expensesPerMonth} expenses/month ` +
      `(${fixture.serializedBytes} bytes)`);
    for (const name of OPERATIONS) {
      const duration = result.operations[name].duration;
      const observation = result.operations[name].observations;
      const writeSuffix = typeof observation.writtenBytes === 'number'
        ? `, mean writes ${Math.round(observation.writtenBytes)} bytes` : '';
      lines.push(`  ${name}: median ${duration.medianMs} ms, p95 ${duration.p95Ms} ms${writeSuffix}`);
    }
  }
  return lines.join('\n');
}

function writeReport(output, report) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
}

module.exports = { DEFAULT_SIZES, DEFAULT_ITERATIONS, LIMITS, OPERATIONS, InstrumentedStorage,
  parseArgs, parseSizes, buildSyntheticLedger, runBenchmark, humanSummary, writeReport };
