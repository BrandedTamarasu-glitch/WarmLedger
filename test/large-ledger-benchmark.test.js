'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Benchmark = require('../scripts/large-ledger-benchmark-lib.js');

test('benchmark CLI parsing supplies bounded defaults and accepts explicit configuration', () => {
  assert.deepEqual(Benchmark.parseArgs([]), {
    sizes: [{ months: 12, expensesPerMonth: 50 }, { months: 36, expensesPerMonth: 100 },
      { months: 60, expensesPerMonth: 200 }],
    iterations: 3, output: null
  });
  const parsed = Benchmark.parseArgs(['--sizes', '2x3,4x5', '--iterations', '2', '--output', 'report.json']);
  assert.deepEqual(parsed.sizes, [{ months: 2, expensesPerMonth: 3 }, { months: 4, expensesPerMonth: 5 }]);
  assert.equal(parsed.iterations, 2);
  assert.equal(parsed.output, path.resolve('report.json'));
  for (const args of [['--sizes', '1x5'], ['--sizes', '2:5'], ['--iterations', '0'],
    ['--iterations', '21'], ['--unknown']]) assert.throws(() => Benchmark.parseArgs(args));
});

test('synthetic fixture shape is deterministic, generic, and exercises null versus entered zero', () => {
  const first = Benchmark.buildSyntheticLedger({ months: 2, expensesPerMonth: 30 });
  const second = Benchmark.buildSyntheticLedger({ months: 2, expensesPerMonth: 30 });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.months), ['2020-01', '2020-02']);
  assert.equal(first.months['2020-01'].expenses.length, 30);
  assert.equal(first.months['2020-01'].paychecks.length, 2);
  assert.equal(first.months['2020-01'].expenses[0].actualAmount, null);
  assert.equal(first.months['2020-01'].expenses[17].actualAmount, null);
  assert.equal(first.months['2020-01'].expenses[29].actualAmount, 0);
  assert.match(first.months['2020-01'].expenses[0].name, /Searchable expense/);
  assert.doesNotMatch(JSON.stringify(first), /Private Person|Private Merchant|Private Account/i);
});

test('small benchmark covers every operation with a privacy-safe measurement-only schema', () => {
  const report = Benchmark.runBenchmark({ sizes: [{ months: 2, expensesPerMonth: 3 }], iterations: 1 });
  assert.equal(report.measurementOnly, true);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.operationCoverage, [...Benchmark.OPERATIONS]);
  assert.deepEqual(Object.keys(report.results[0].operations), [...Benchmark.OPERATIONS]);
  for (const operation of Object.values(report.results[0].operations)) {
    assert.equal(operation.duration.samples, 1);
    assert.equal(typeof operation.duration.medianMs, 'number');
  }
  const serialized = JSON.stringify(report);
  for (const forbidden of ['expense-000', 'Category 01', 'Searchable expense', 'Earner 1', 'recordId', 'monthKey']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.doesNotMatch(serialized, /threshold|passed|failed|hostname|username|cwd/i);
});

test('migrated ordinary edit writes one month shard and reuses every unaffected reference', () => {
  const months = 3;
  const report = Benchmark.runBenchmark({ sizes: [{ months, expensesPerMonth: 4 }], iterations: 1 });
  const legacy = report.results[0].operations.ordinary_edit_commit.observations;
  const sharded = report.results[0].operations.month_sharded_ordinary_edit_commit.observations;

  assert.equal(sharded.monthShardWriteCount, 1);
  assert.equal(sharded.activeLayoutWriteCount, 3);
  assert.ok(sharded.activeLayoutWrittenBytes > sharded.primaryWrittenBytes);
  assert.ok(sharded.activeLayoutWrittenBytes < sharded.writtenBytes);
  assert.equal(sharded.manifestWriteCount, 1);
  assert.equal(sharded.primaryWriteCount, 1);
  assert.equal(sharded.globalShardWriteCount, 0);
  assert.equal(sharded.reusedGlobalReferenceCount, 1);
  assert.equal(sharded.reusedMonthReferenceCount, months - 1);
  assert.equal(sharded.changedMonthReferenceCount, 1);
  assert.ok(sharded.writtenBytes < legacy.writtenBytes,
    `expected sharded writes (${sharded.writtenBytes}) below legacy writes (${legacy.writtenBytes})`);
});

test('small smoke report writes parseable JSON and produces a concise human summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-ledger-benchmark-'));
  const output = path.join(directory, 'result.json');
  const report = Benchmark.runBenchmark({ sizes: [{ months: 2, expensesPerMonth: 3 }], iterations: 1 });
  Benchmark.writeReport(output, report);
  const file = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(file, report);
  const summary = Benchmark.humanSummary(report);
  assert.match(summary, /measurement only; no pass\/fail thresholds/);
  assert.match(summary, /startup_load: median/);
  assert.match(summary, /month_sharded_ordinary_edit_commit: median .*mean writes \d+ bytes/);
});
