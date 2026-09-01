#!/usr/bin/env node
'use strict';

const Benchmark = require('./large-ledger-benchmark-lib.js');

const HELP = `Usage: npm run benchmark:ledger -- [options]

Options:
  --sizes MONTHSxEXPENSES,...  Synthetic sizes (default: 12x50,36x100,60x200)
  --iterations NUMBER          Measurements per operation (default: 3, maximum: 20)
  --output PATH                Also write the machine-readable JSON report to PATH
  --help                       Show this help
`;

function main(argv = process.argv.slice(2)) {
  try {
    const options = Benchmark.parseArgs(argv);
    if (options.help) { process.stdout.write(HELP); return 0; }
    const report = Benchmark.runBenchmark(options);
    if (options.output) Benchmark.writeReport(options.output, report);
    process.stderr.write(`${Benchmark.humanSummary(report)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Benchmark configuration error: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, HELP };
