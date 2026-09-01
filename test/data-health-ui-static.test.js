'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const budget = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');
const health = fs.readFileSync(path.join(root, 'js', 'data-health.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'js', 'data-health-view.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Data Health scripts and sixth view load in dependency order', () => {
  assert.ok(html.indexOf('js/data-health.js') < html.indexOf('js/data.js'));
  assert.ok(html.indexOf('js/data-health-view.js') < html.indexOf('js/app.js'));
  assert.match(html, /data-view="data-health"/);
  assert.match(html, /id="view-data-health"/);
  assert.match(app, /DataHealthView\.init\(\)/);
});

test('health workflows use frozen Store APIs without unsafe persisted-content sinks', () => {
  for (const api of ['getDataHealth', 'getExactMoneyMigrationSummary', 'previewExactMoneyMigration', 'commitExactMoneyMigration', 'previewActualResolutions', 'applyActualResolutions', 'previewDefaultDateResolutions', 'applyDefaultDateResolutions', 'compareAdditiveBackup']) {
    assert.match(view, new RegExp(`Store\\.${api}\\(`));
  }
  assert.doesNotMatch(view, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
  assert.match(view, /file\.size\s*>\s*App\.MAX_IMPORT_BYTES/);
  assert.match(view, /Nothing was imported/);
  assert.match(view, /type\s*=\s*'checkbox'/);
  assert.match(view, /dialog\.returnValue\s*!==\s*'confirm'/);
  assert.match(view, /More checks and tools/);
  assert.match(view, /review-default-dates/);
  assert.match(view, /Review template suggestion/);
  assert.match(view, /Schedule unknown — choose a schedule before saving/);
  assert.match(view, /openPatternTemplate\(pattern, trigger\)/);
  assert.match(view, /Store\.getDataHealth\(\)\.repeatedManualPatterns\.find/);
  assert.match(view, /TemplatesView\.showTemplateModal/);
});

test('exact-money migration is preview-first, Cancel-first, and offers a durable backup', () => {
  const cancel = html.indexOf('id="exact-money-migration-cancel"');
  const confirm = html.indexOf('id="exact-money-migration-confirm"');
  assert.ok(cancel >= 0 && cancel < confirm);
  assert.match(html, /exact-money-migration-dialog[^>]*aria-labelledby="exact-money-migration-title"[^>]*aria-describedby="exact-money-migration-description"/);
  assert.match(view, /App\.downloadBackup\(\)/);
  assert.match(view, /Store\.previewExactMoneyMigration\(\)/);
  assert.match(view, /Store\.commitExactMoneyMigration\(preview\)/);
  assert.match(view, /dialog\.returnValue\s*!==\s*'confirm'/);
  assert.match(css, /\.exact-money-actions \.btn\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.exact-money-migration/s);
});

test('month-sharded migration stays preview-first, backup-first, and DOM-only', () => {
  assert.match(view, /Store\.getShardedPersistenceSummary\(\)/);
  assert.match(view, /ZeroBudgetDataHealth\.buildShardedPersistenceMigration\(shardedSummary\)/);
  assert.match(view, /monthShardedMigrationSection\(summary, migration\)/);
  assert.match(view, /summary\.firstMonth/);
  assert.match(view, /summary\.lastMonth/);
  assert.match(view, /First month/);
  assert.match(view, /Last month/);
  assert.match(view, /Download a JSON backup first\. Warm Ledger also creates a local safety snapshot before changing storage\./);
  assert.match(view, /review-month-sharded-storage/);
  assert.match(view, /month-sharded-storage-heading/);
  assert.match(view, /monthShardedSummaryList\(preview\)/);
  assert.match(view, /App\.showModal\(\{\s*title:\s*'Move this ledger to month-sharded storage\?'/s);
  assert.match(view, /initialFocus:\s*\(\)\s*=>\s*document\.getElementById\('modal-cancel'\)/);
  assert.match(view, /onClose:\s*reason\s*=>\s*\{\s*if \(reason !== 'confirm'\) this\.monthShardedPreview = null;\s*\}/s);
  assert.match(view, /Store\.previewShardedPersistenceMigration\(\)/);
  assert.match(view, /Store\.commitShardedPersistenceMigration\(preview\)/);
  assert.match(view, /Warm Ledger now stores this ledger in month-sharded local storage\. Budget values did not change\./);
  assert.match(view, /Store\.getStatus\(\)\.state === 'recovery-required'/);
  assert.match(view, /App\.showRecovery\(Store\.reload\(\)\)/);
  assert.match(app, /INVALID_MONTH_SHARD_MIGRATION_PREVIEW/);
  assert.match(app, /STALE_MONTH_SHARD_MIGRATION_PREVIEW/);
  assert.match(app, /MONTH_SHARD_ALREADY_MIGRATED/);
  assert.match(app, /MONTH_SHARD_MIGRATION_EMPTY/);
  assert.match(app, /'pre-sharding': 'Before converting to month-sharded storage'/);
  assert.match(health, /Month-sharded local storage is ready/);
  assert.match(health, /Month-sharded local storage is active/);
  assert.match(health, /Month-sharded local storage is unavailable/);
  assert.match(html, /dialog id="exact-money-migration-dialog"/);
  assert.doesNotMatch(html, /month-sharded-storage-dialog/);
});

test('accounts upgrade is explicit, preview-first, local-label-only, and uses stable evidence hooks', () => {
  assert.match(view, /Store\.getAccountsMigrationSummary\(\)/);
  assert.match(view, /ZeroBudgetDataHealth\.buildAccountsMigration\(accountsSummary\)/);
  assert.match(view, /review-accounts-migration/);
  assert.match(view, /accounts-migration-heading/);
  assert.match(view, /Store\.previewAccountsMigration\(\)/);
  assert.match(view, /Store\.commitAccountsMigration\(preview\)/);
  assert.match(view, /initialFocus:\s*\(\)\s*=>\s*document\.getElementById\('modal-cancel'\)/);
  assert.match(view, /if \(reason !== 'confirm'\) this\.accountsPreview = null/);
  assert.match(view, /Accounts are local planning labels only\. They do not connect to a bank, prove payment, or reconcile activity\./);
  assert.match(view, /Saved paychecks/);
  assert.match(view, /Saved expenses/);
  assert.match(view, /Saved templates/);
  assert.doesNotMatch(view.slice(view.indexOf('accountsSummaryList'), view.indexOf('previewMonthShardedMigration')), /monthKey|account\.name|accountName/);
  assert.match(view, /Store\.getStatus\(\)\.state === 'recovery-required'/);
  assert.match(view, /App\.showRecovery\(Store\.reload\(\)\)/);
  assert.doesNotMatch(view, /actual transfer|bank transfer|balance confirmed/i);
});

test('expense deletion is Cancel-first and offers receipt-based session Undo', () => {
  const cancel = html.indexOf('id="expense-delete-cancel"');
  const confirm = html.indexOf('id="expense-delete-confirm"');
  assert.ok(cancel >= 0 && cancel < confirm);
  assert.match(budget, /App\.confirmExpenseDelete\(/);
  assert.match(app, /Store\.deleteExpense\([^)]*\)/);
  assert.match(app, /Store\.undoDeleteExpense\(context\.receipt\)/);
  assert.match(app, /expenseUndo:\s*null/);
  for (const mutation of ['Store.restoreSnapshot(id)', 'Store.startFresh()', 'Store.commitImport(preview)']) {
    const start = app.indexOf(mutation); assert.ok(start >= 0, `${mutation} path is missing`);
    assert.match(app.slice(start, start + 180), /clearExpenseUndo\(\)/, `${mutation} must invalidate Undo`);
  }
});

test('actual-resolution failures leave the application alert in control of focus', () => {
  const apply = view.slice(view.indexOf('Store.applyActualResolutions'));
  const failure = apply.slice(apply.indexOf('onFailure:'), apply.indexOf('onFailure:') + 140);
  assert.doesNotMatch(failure, /\.focus\s*\(/);
  assert.match(failure, /this\.render\(\)/);
});

test('new surfaces reflow with reachable controls and system accessibility modes', () => {
  assert.match(css, /\.actual-resolution-row\s*\{/);
  assert.match(css, /\.undo-notice\s*\{/);
  assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*\.undo-actions[\s\S]*min-height:\s*44px/);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.data-health-section[\s\S]*\.undo-notice/);
  assert.match(css, /\.nav-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
});
