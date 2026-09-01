'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, locateChromium, helpText, removeDisposableProfile } = require('../scripts/browser-evidence.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'browser-evidence.js'), 'utf8');

test('browser evidence options are deterministic and reject ambiguity', () => {
  assert.equal(parseArgs([]).output, path.join(require('node:os').tmpdir(), 'zerobudget-browser-evidence.json'));
  assert.equal(parseArgs(['--output', './evidence.json']).output, path.resolve('evidence.json'));
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--unknown']), /Unknown or incomplete option/);
  assert.equal(locateChromium({ CHROMIUM_BIN: '/definitely/missing/chromium' }), null);
});

test('browser evidence help describes its isolated optional execution', () => {
  assert.match(helpText(), /disposable Chromium profile/);
  assert.match(helpText(), /OS temp directory/);
});

test('browser evidence owns a disposable, collision-free CDP endpoint and cleans it up', () => {
  assert.match(source, /--remote-debugging-port=0/);
  assert.match(source, /DevToolsActivePort/);
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'zerobudget-browser-'\)\)/);
  assert.match(source, /await removeDisposableProfile\(profile\)/);
  assert.doesNotMatch(source, /9300 \+ Math\.floor/);
  assert.doesNotMatch(source, /--no-sandbox/);
  assert.match(source, /waitForExit\(child, 2000\)/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /!fs\.existsSync\(profile\)/);
  assert.match(source, /evidence\.profileCleanup = true/);
  assert.match(source, /const CDP_STARTUP_ATTEMPTS = 600/);
  assert.match(source, /const CDP_POLL_MS = 50/);
  assert.match(source, /width: 640, height: 450/);
  assert.doesNotMatch(source, /setPageScaleFactor/);
});

test('browser evidence exercises Data Health and reversible expense deletion behavior', () => {
  for (const marker of ['expenseDeleteCancelUndoStale', 'generatedTombstoneUndo', 'dataHealthPassiveRoutes',
    'actualZeroPreviewCancelApply', 'actualApplyFailureAlertFocus', 'compareOnlyNoWrite', 'hostileLabelsSafe', 'recoveryGating',
    'restoreInvalidatesUndo']) assert.match(source, new RegExp(marker));
  assert.match(source, /Store\.getMonth\(month\)\.suppressedOccurrences\.length === 1/);
  assert.match(source, /const primaryKey = Store\.STORAGE_KEY \|\| ZeroBudgetStore\.STORAGE_KEY/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === healthBefore/);
  assert.doesNotMatch(source, /zeroBudgetData/);
  assert.match(source, /Emulation\.setEmulatedMedia/);
  assert.match(source, /forced-colors/);
  assert.match(source, /focusOutline !== 'none'/);
  assert.match(source, /focusOutline !== 'hidden'/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /scenario\.expenseDeleteEscape = true/);
});

test('browser evidence proves exact-money migration states and v4 recovery paths', () => {
  for (const marker of ['exactMoneyEligiblePreviewCancelConfirm', 'exactMoneyV4BackupImportSnapshotRoundTrip',
    'exactMoneyBlockedSubCentWriteFreeUsable']) assert.match(source, new RegExp(marker));
  assert.match(source, /localStorage\.getItem\(primaryKey\) === eligibleV3Bytes/);
  assert.match(source, /migratedPersisted\.schemaVersion === 4/);
  assert.match(source, /Number\.isInteger\(migratedPersisted\.months\[month\]\.paychecks\[0\]\.plannedAmount\)/);
  assert.match(source, /Store\.commitImport\(Store\.previewImport\(v4Backup\)\)/);
  assert.match(source, /Store\.restoreSnapshot\(v4SnapshotKey\.slice/);
  assert.match(source, /blocked\.state === 'blocked'/);
  assert.match(source, /blocked\.actionAbsent/);
  assert.match(source, /blocked\.byteExact/);
  assert.match(source, /blocked\.plannedAmount === 321\.001/);
  assert.match(source, /reload\.schemaVersion === 5/);
});

test('browser evidence proves Saved-Record Finder is transient, routable, and stale-safe', () => {
  assert.match(source, /savedRecordFinderTransientRouteStaleSafe/);
  assert.match(source, /dashboard-record-finder-form/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === finderBytes/);
  assert.match(source, /document\.activeElement\.dataset\.editType === 'expense'/);
  assert.match(source, /Store\.updateExpense\(month, unfunded\.id/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleFinderBytes/);
});

test('browser evidence proves Review Navigation is passive, revalidating, responsive, and privacy-minimal', () => {
  assert.match(source, /reviewNavigationClosedPassiveLookbacksRoutesStaleSafe/);
  assert.match(source, /assert\(!reviewQueue\.open/);
  assert.match(source, /for \(const lookback of \[6, 12, 24\]\)/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === reviewQueueBytes/);
  assert.match(source, /document\.activeElement === expectedClearedTarget/);
  assert.match(source, /const refreshedStaleTarget =/);
  assert.match(source, /reviewQueue\.querySelector\('summary'\)/);
  assert.match(source, /document\.activeElement === refreshedStaleTarget/);
  assert.match(source, /reviewNavigationBudgetOriginStaleFocusByteExact/);
  assert.match(source, /data-review-step-kind="actuals"/);
  assert.match(source, /document\.getElementById\('view-budget'\)\.classList\.contains\('active'\)/);
  assert.match(source, /document\.activeElement\.id === 'monthly-review-next-steps-heading'/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleBudgetBytes/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleReviewBytes/);
  assert.match(source, /document\.activeElement === reviewQueue\.querySelector\('summary'\)/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleEmptyBytes/);
  assert.match(source, /reviewNavigationNarrowTargetsForcedColorsPrint/);
  assert.match(source, /Review Navigation 320px evidence failed/);
  assert.match(source, /targetsAtLeast44/);
  assert.match(source, /Review Navigation forced-colors evidence failed/);
  assert.match(source, /Review Navigation print evidence failed/);
  assert.match(source, /const publicScenario = Object\.fromEntries/);
  assert.match(source, /filter\(\(\[, value\]\) => typeof value === 'boolean'\)/);
  assert.doesNotMatch(source, /evidence = \{ passed: true, browser/);
});

test('browser evidence proves Saved Month Comparison defaults, validation, exact output, and stale safety', () => {
  for (const marker of ['savedMonthComparisonDefaultsValidationRowsPassiveStaleSafe',
    'savedMonthComparisonActualIncompleteCsvPrintByteExact',
    'savedMonthComparisonDraftRequiresExplicitCompare',
    'savedMonthComparisonNarrowForcedColorsPrint']) assert.match(source, new RegExp(marker));
  assert.match(source, /assert\(!comparisonDisclosure\.open/);
  assert.match(source, /savedComparisonMonths\.slice\(-2\)/);
  assert.match(source, /savedComparisonMonths\.includes\(month\)/);
  assert.match(source, /different saved months/);
  assert.match(source, /DashboardView\.render\(\); await settle\(\)/);
  assert.match(source, /csvCapture === null && printCount === 0/);
  assert.match(source, /DashboardView\.savedMonthComparisonRequest\.baselineMonth === expectedComparisonMonths\[1\]/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === draftComparisonBytes/);
  assert.match(source, /actualComparison\.rowModel\.rows\.some\(row => row\.Status === 'Incomplete'\)/);
  assert.match(source, /csvCapture\.content === DashboardView\.savedMonthComparisonCsv\(actualComparison\)/);
  assert.match(source, /delete replacementPreview\.data\.months\[expectedComparisonMonths\[1\]\]/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleComparisonBytes/);
  assert.match(source, /Saved Month Comparison explanation 320px evidence failed/);
  assert.match(source, /Saved Month Comparison explanation forced-colors evidence failed/);
  assert.match(source, /Saved Month Comparison explanation print evidence failed/);
});

test('browser evidence covers prepared dashboards, multi-tab recovery, and local-data purge safety', () => {
  for (const marker of ['preparedDashboardPassiveByteExact', 'multiTabStaleBusyReloadRecovery',
    'purgeCancelConfirmFocusExactRemoval', 'cspSafeNodeModal']) {
    assert.match(source, new RegExp(marker));
  }
  assert.match(source, /Store\.prepareDashboardRange\(/);
  assert.match(source, /Store\.reload\(\)/);
  assert.match(source, /review-local-data-purge/);
  assert.match(source, /zeroBudget_write_lock/);
  assert.match(source, /modal-body/);
  assert.match(source, /current-month-label/);
  assert.match(source, /recovery-title/);
  assert.match(source, /snapshotCountBefore/);
  assert.match(source, /snapshotCount === snapshotCountBefore \+ snapshotKeys\.length/);
});

test('browser evidence covers month-sharded preview, migration, reload, corruption recovery, and complete purge', () => {
  for (const marker of ['shardedMigrationPreviewNoWriteCancelConfirm',
    'shardedReloadCorruptionEvidenceSnapshotRecovery', 'zerobudget-corrupt-evidence']) {
    assert.match(source, new RegExp(marker));
  }
  assert.match(source, /beforePreview === allBytes\(\)/);
  assert.match(source, /primaryKey === 'zeroBudget_data'/);
  assert.match(source, /rootPointer\?\.format === 'zerobudget-active-layout'/);
  assert.match(source, /manifest\.monthOrder\.every\(monthKey => localStorage\.getItem\(manifest\.months\[monthKey\]\.key\)\)/);
  assert.match(source, /ZeroBudgetStorageEngine\.validateGlobalReference/);
  assert.match(source, /ZeroBudgetStorageEngine\.validateMonthReference/);
  assert.match(source, /Store\.getShardedPersistenceSummary\(\)\.state === 'already-sharded'/);
  assert.match(source, /allBytes\(\) === sessionStorage\.getItem\('browser-evidence-sharded-bytes'\)/);
  assert.match(source, /sessionStorage\.getItem\('browser-evidence-sharded-semantic'\)/);
  assert.match(source, /Store\.restoreSnapshot\(safety\.id\)/);
  assert.match(source, /const evidenceRaw = Store\.getCorruptEvidence\(\)/);
  assert.doesNotMatch(source, /Store\.getCorruptEvidence\(\) \|\|/);
  assert.match(source, /localStorage\.getItem\(corruptKey\) === null/);
  assert.match(source, /evidence\.failingKey === monthShardKey/);
  for (const namespace of ['zeroBudget_manifest:', 'zeroBudget_global:', 'zeroBudget_month:', 'zeroBudget_journal']) {
    assert.match(source, new RegExp(namespace));
  }
  assert.match(source, /orphanedShardingKeys\.every\(key => localStorage\.getItem\(key\) === null\)/);
});

test('browser evidence proves Explain change is lazy, transient, routable, and export-neutral', () => {
  for (const marker of ['savedMonthComparisonExplainLazyReplaceCloseTransitions',
    'savedMonthComparisonExplainNullZeroStaleSuccessCsvByteExact']) assert.match(source, new RegExp(marker));
  assert.match(source, /!document\.getElementById\('dashboard-comparison-explanation'\)/);
  assert.match(source, /dataset\.comparisonSection === 'categories'/);
  assert.match(source, /dataset\.comparisonSection === 'payment_methods'/);
  assert.match(source, /Actual: Not entered/);
  assert.match(source, /Actual: \$0\.00 · Complete/);
  assert.match(source, /Store\.updateExpense\(forecastMonth, comparisonZeroExpense\.id/);
  assert.match(source, /changed or is no longer a contributor/);
  assert.match(source, /localStorage\.getItem\(primaryKey\) === staleContributorBytes/);
  assert.match(source, /document\.activeElement\.dataset\.recordId === comparisonZeroExpense\.id/);
  assert.match(source, /csvCapture\?\.content === comparisonCsvBeforeExplain/);
  assert.match(source, /!csvCapture\.content\.includes\('recordId'\)/);
  assert.match(source, /Saved Month Comparison explanation 320px evidence failed/);
  assert.match(source, /Saved Month Comparison explanation forced-colors evidence failed/);
  assert.match(source, /Saved Month Comparison explanation print evidence failed/);
});

test('browser evidence toggles and reloads one eligible entered-zero Manual Cleared record', () => {
  assert.match(source, /manualClearedZeroToggleFocusReload/);
  assert.match(source, /Passive Manual Cleared render changed storage bytes/);
  assert.match(source, /clearedCheckbox\?\.type === 'checkbox'/);
  assert.match(source, /clearedPersisted\.schemaVersion === 5/);
  assert.match(source, /document\.activeElement === clearedAfter/);
  assert.match(source, /reload\.cleared && reload\.nativeChecked/);
});

test('browser evidence dynamically covers Pay periods semantics, routes, safety, and reflow', () => {
  for (const marker of ['payPeriodsPassiveByteExact', 'payPeriodsCanonicalActualsFundingStates',
    'payPeriodsAllocationsReconcileHostileSafe', 'payPeriodsExactCanonicalCollapsedRoutes',
    'payPeriodsFourDigitFunding', 'payPeriodsStaleAndZeroPaycheckRoutes', 'payPeriodsNarrowReflowForcedColors']) {
    assert.match(source, new RegExp(marker));
  }
  assert.match(source, /localStorage\.getItem\(primaryKey\) === payPeriodBytes/);
  assert.match(source, /Store\.getPayPeriodPlan\(month\)/);
  assert.match(source, /split across 2 paychecks/);
  assert.match(source, /pay-period-bill-pill/);
  assert.match(source, /plan\.summary\.reconciliationDifference === 0/);
  assert.match(source, /BudgetView\.collapsedCategories\.set/);
  assert.match(source, /dataset\.fundingExpenseId === currentGenerated\.id/);
  assert.match(source, /dataset\.fundingPaycheckId === income\.id/);
  assert.match(source, /fourDigitFunding\.value = '1076'/);
  assert.match(source, /document\.activeElement\.id === 'btn-add-paycheck'/);
  assert.match(source, /document\.activeElement\.id === 'expenses-heading'/);
  assert.match(source, /Pay periods overflows at 320px/);
  assert.match(source, /Forced-colors Pay periods evidence failed/);
  assert.match(source, /payPeriodNarrow\.overflowing\.length === 0/);
  assert.match(source, /payPeriodForcedColors\.focusOutline !== 'none'/);
});

test('browser evidence covers the compact Monthly Review dashboard and removed exceptions UI', () => {
  assert.match(source, /monthlyReviewCompactNarrowForcedColors/);
  assert.match(source, /monthlyPaymentGuidance/);
  assert.match(source, /Monthly payment guidance did not match assigned funding/);
  assert.match(source, /\.monthly-review-metric/);
  assert.match(source, /exceptionsVisible/);
  assert.match(source, /Forced-colors Monthly Review evidence failed/);
  assert.match(source, /monthlyReviewNarrow\.overflowing\.length === 0/);
});

test('profile cleanup retries transient failures with bounded backoff and eventually succeeds', async () => {
  const calls = []; const waits = [];
  const failures = ['ENOTEMPTY', 'EBUSY'].map(code => Object.assign(new Error(code), { code }));
  const fileSystem = {
    rmSync(profile, options) {
      calls.push({ profile, options });
      const error = failures.shift(); if (error) throw error;
    },
    existsSync() { return false; }
  };
  await removeDisposableProfile('/tmp/exact-profile', {
    fileSystem, attempts: 4, initialDelayMs: 5, wait: delay => { waits.push(delay); }
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.profile === '/tmp/exact-profile'));
  assert.ok(calls.every(call => call.options.recursive === true && call.options.force === true));
  assert.deepEqual(waits, [5, 10]);
});

test('profile cleanup retries a still-present directory and proves eventual absence', async () => {
  let removals = 0; let existenceChecks = 0;
  await removeDisposableProfile('/tmp/exact-profile', {
    attempts: 3, initialDelayMs: 1, wait() {},
    fileSystem: {
      rmSync() { removals += 1; },
      existsSync() { existenceChecks += 1; return existenceChecks === 1; }
    }
  });
  assert.equal(removals, 2);
  assert.equal(existenceChecks, 2);
});

test('profile cleanup preserves terminal failures and never silently swallows them', async () => {
  const terminal = Object.assign(new Error('still busy'), { code: 'EPERM' });
  let removals = 0; const waits = [];
  await assert.rejects(removeDisposableProfile('/tmp/exact-profile', {
    attempts: 3, initialDelayMs: 2, wait: delay => { waits.push(delay); },
    fileSystem: { rmSync() { removals += 1; throw terminal; }, existsSync() { return true; } }
  }), error => error === terminal);
  assert.equal(removals, 3); assert.deepEqual(waits, [2, 4]);

  const nonTransient = Object.assign(new Error('denied'), { code: 'EACCES' });
  removals = 0;
  await assert.rejects(removeDisposableProfile('/tmp/exact-profile', {
    attempts: 6, wait() {},
    fileSystem: { rmSync() { removals += 1; throw nonTransient; }, existsSync() { return true; } }
  }), error => error === nonTransient);
  assert.equal(removals, 1);
});
