#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const CDP_STARTUP_ATTEMPTS = 600;
const CDP_POLL_MS = 50;
const PROFILE_CLEANUP_ATTEMPTS = 6;
const PROFILE_CLEANUP_DELAY_MS = 25;
const TRANSIENT_CLEANUP_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

function parseArgs(argv) {
  const options = { output: path.join(os.tmpdir(), 'zerobudget-browser-evidence.json') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') options.help = true;
    else if (argv[index] === '--output' && argv[index + 1]) options.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete option: ${argv[index]}`);
  }
  return options;
}

function locateChromium(env = process.env) {
  const candidates = env.CHROMIUM_BIN ? [env.CHROMIUM_BIN] : ['chromium', 'chromium-browser', 'google-chrome'];
  return candidates.find(candidate => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForPage(port, child) {
  for (let attempt = 0; attempt < CDP_STARTUP_ATTEMPTS; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chromium exited before CDP was ready (status ${child.exitCode}).`);
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(entry => entry.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) { /* CDP is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, CDP_POLL_MS));
  }
  throw new Error('Chromium CDP endpoint did not become ready.');
}

async function waitForDevToolsPort(profile, child) {
  const marker = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < CDP_STARTUP_ATTEMPTS; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chromium exited before CDP was ready (status ${child.exitCode}).`);
    try {
      const port = Number(fs.readFileSync(marker, 'utf8').split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch (_) { /* Chromium has not published its isolated endpoint yet. */ }
    await new Promise(resolve => setTimeout(resolve, CDP_POLL_MS));
  }
  throw new Error('Chromium did not publish its disposable CDP endpoint.');
}

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.events = []; }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else this.events.push(message);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopBrowser(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2000)) return;
  child.kill('SIGKILL');
  if (!await waitForExit(child, 2000)) throw new Error('Chromium did not stop after SIGKILL.');
}

async function removeDisposableProfile(profile, {
  fileSystem = fs,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  attempts = PROFILE_CLEANUP_ATTEMPTS,
  initialDelayMs = PROFILE_CLEANUP_DELAY_MS
} = {}) {
  let finalError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fileSystem.rmSync(profile, { recursive: true, force: true });
      if (!fileSystem.existsSync(profile)) return;
      finalError = Object.assign(new Error('Disposable Chromium profile still exists after removal.'), { code: 'ENOTEMPTY' });
    } catch (error) {
      if (!TRANSIENT_CLEANUP_CODES.has(error?.code)) throw error;
      finalError = error;
    }
    if (attempt + 1 < attempts) await wait(initialDelayMs * (2 ** attempt));
  }
  throw finalError || new Error('Disposable Chromium profile cleanup failed.');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

const SCENARIO = `(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  localStorage.clear(); Store.startFresh(); App.enterApplication('', 'ready');
  const primaryKey = Store.STORAGE_KEY || ZeroBudgetStore.STORAGE_KEY;
  assert(typeof primaryKey === 'string' && primaryKey.length > 0, 'Primary storage key is unavailable.');
  const month = BudgetView.currentMonth;
  const day = Number(month.slice(5, 7)) === new Date().getMonth() + 1 ? new Date().getDate() : 1;
  const date = month + '-' + String(day).padStart(2, '0');
  const earnerId = Store.getEarners()[0].id;
  const category = Store.getCategories()[0];
  Store.addIncomeTemplate({ name: 'Synthetic browser pay', earnerId, plannedAmount: 321,
    enabled: true, startDate: date, endDate: null, recurrence: { cadence: 'monthly', day } });
  Store.addExpenseTemplate({ name: 'Synthetic browser bill', categoryId: category.id,
    categoryItemId: null, plannedAmount: 123, paymentMethod: 'bank', enabled: true,
    startDate: date, endDate: null, recurrence: { cadence: 'monthly', day } });
  assert(localStorage.getItem(primaryKey) !== null, 'Synthetic setup did not establish active primary storage bytes.');
  App.refreshAllViews();

  const previewTrigger = document.getElementById('btn-preview-recurring');
  const passiveBefore = localStorage.getItem(primaryKey); previewTrigger.click(); await settle();
  const previewDialog = document.getElementById('recurring-preview-dialog');
  assert(previewDialog.open, 'Recurring preview did not open.');
  assert(document.activeElement.id === 'recurring-preview-cancel', 'Recurring preview did not focus Cancel.');
  assert(localStorage.getItem(primaryKey) === passiveBefore, 'Opening recurring preview changed storage bytes.');
  previewDialog.close('cancel'); await settle();
  assert(document.activeElement === previewTrigger, 'Cancel did not restore preview-trigger focus.');
  assert(localStorage.getItem(primaryKey) === passiveBefore, 'Cancel changed storage bytes.');

  previewTrigger.click(); await settle(); previewDialog.close('confirm'); await settle();
  const generated = Store.getMonth(month); assert(generated.paychecks.length && generated.expenses.length, 'Apply did not create recurring records.');
  const income = generated.paychecks[0]; assert(income.actualAmount === null, 'Generated income actual must begin unresolved.');
  const reviewEdit = [...document.querySelectorAll('[data-review-kind="income"]')]
    .find(button => button.dataset.recordId === income.id);
  assert(reviewEdit, 'Monthly Review income edit control is missing.'); reviewEdit.click(); await settle();
  assert(document.activeElement.id === 'field-earner', 'Monthly Review editor initial focus is incorrect.');
  document.getElementById('field-actual-amount').value = '0'; document.getElementById('modal-save').click(); await settle();
  assert(Store.getMonth(month).paychecks[0].actualAmount === 0, 'Monthly Review did not preserve typed zero.');
  assert(document.activeElement.id === 'monthly-review-income-heading' ||
    document.activeElement.dataset.reviewKind === 'income',
    'Monthly Review edit did not restore contextual focus or its heading fallback.');

  const generatedExpense = generated.expenses[0];
  const deleteControl = () => [...document.querySelectorAll('.expense-table [aria-label^="Delete "]')]
    .find(button => button.closest('tr')?.dataset.id === generatedExpense.id);
  const deleteDialog = document.getElementById('expense-delete-dialog');
  const beforeDelete = localStorage.getItem(primaryKey); deleteControl().click(); await settle();
  assert(deleteDialog.open && document.activeElement.id === 'expense-delete-cancel', 'Expense delete did not open on Cancel.');
  assert(localStorage.getItem(primaryKey) === beforeDelete, 'Opening expense delete changed bytes.');
  document.getElementById('expense-delete-cancel').click(); await settle();
  assert(Store.getMonth(month).expenses.some(item => item.id === generatedExpense.id), 'Delete Cancel removed the expense.');
  assert(document.activeElement === deleteControl(), 'Delete Cancel did not restore trigger focus.');
  assert(localStorage.getItem(primaryKey) === beforeDelete, 'Delete Cancel changed bytes.');

  deleteControl().click(); await settle(); document.getElementById('expense-delete-confirm').click(); await settle();
  assert(!Store.getMonth(month).expenses.some(item => item.id === generatedExpense.id), 'Confirmed expense delete did not remove it.');
  assert(Store.getMonth(month).suppressedOccurrences.length === 1, 'Generated deletion did not create its tombstone.');
  assert(document.activeElement.id === 'expense-undo', 'Confirmed deletion did not focus Undo.');
  document.getElementById('expense-undo').click(); await settle();
  assert(Store.getMonth(month).expenses[0].id === generatedExpense.id, 'Undo did not restore the exact expense position.');
  assert(Store.getMonth(month).suppressedOccurrences.length === 0, 'Undo did not remove the exact generated tombstone.');
  assert(document.activeElement.dataset.recordId === generatedExpense.id, 'Undo did not restore expense edit focus.');

  deleteControl().click(); await settle(); document.getElementById('expense-delete-confirm').click(); await settle();
  Store.addExpense(month, { categoryId: category.id, categoryItemId: null,
    name: '<img src=x onerror="globalThis.__hostileRan=true"> Hostile ledger label', date: '', paycheckAmounts: {},
    plannedAmount: 7, actualAmount: null, paymentMethod: 'bank' });
  document.getElementById('expense-undo').click(); await settle();
  assert(document.getElementById('expense-undo-notice').hidden, 'Stale Undo notice was not cleared.');
  assert(!document.getElementById('app-error').hidden && document.activeElement.id === 'app-error', 'Stale Undo did not preserve alert focus.');
  assert(!globalThis.__hostileRan, 'A hostile record label executed markup.');
  App.announceStatus('Continuing browser evidence.'); BudgetView.render(); await settle();

  const secondIncome = Store.addPaycheck(month, { earnerId, plannedAmount: 200, actualAmount: null, date: '' });
  const hostile = Store.getMonth(month).expenses.find(item => item.name.includes('Hostile ledger label'));
  const currentGenerated = hostile;
  Store.updateExpensePaycheckAmount(month, currentGenerated.id, income.id, 4);
  Store.updateExpensePaycheckAmount(month, hostile.id, secondIncome.id, 3);
  const partial = Store.addExpense(month, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic partially funded bill', date: '', paycheckAmounts: {}, plannedAmount: 10,
    actualAmount: null, paymentMethod: 'credit_card' });
  Store.updateExpensePaycheckAmount(month, partial.id, secondIncome.id, 2);
  const unfunded = Store.addExpense(month, { categoryId: category.id, categoryItemId: null,
    name: '<img src=x onerror="globalThis.__payHostileRan=true"> ' + 'Synthetic long unfunded bill '.repeat(2).trim(),
    date: '', paycheckAmounts: {}, plannedAmount: 11, actualAmount: null, paymentMethod: 'savings' });
  Store.updateAllocation(month, 'savings', 9);
  const payPeriodBytes = localStorage.getItem(primaryKey);
  const payPeriodTab = [...document.querySelectorAll('.nav-tab')].find(tab => tab.dataset.view === 'transfers');
  payPeriodTab.focus(); payPeriodTab.click(); await settle();
  const payPeriodContent = document.getElementById('transfers-content');
  const cards = [...payPeriodContent.querySelectorAll('.pay-period-card')];
  const plan = Store.getPayPeriodPlan(month);
  assert(document.getElementById('view-transfers').classList.contains('active'), 'Pay periods route did not activate.');
  assert(document.activeElement === payPeriodTab, 'Pay periods navigation did not retain trigger focus.');
  assert(localStorage.getItem(primaryKey) === payPeriodBytes, 'Passive Pay periods navigation changed active bytes.');
  assert(cards.length === 2 && plan.periods.map(item => item.paycheckId).join('|') === [income.id, secondIncome.id].join('|'),
    'Pay periods did not preserve canonical paycheck order.');
  assert(cards[0].textContent.includes('$0.00') && cards[1].textContent.includes('Not entered'),
    'Pay periods did not distinguish entered-zero and missing actual income.');
  assert(payPeriodContent.textContent.includes('Partially funded') && payPeriodContent.textContent.includes('Unfunded'),
    'Pay periods funding-state text is incomplete.');
  assert(payPeriodContent.querySelector('.pay-period-allocations')?.textContent.includes('$9.00') &&
    payPeriodContent.querySelector('.pay-period-monthly-summary'), 'Pay periods allocations or monthly summary are missing.');
  assert(plan.summary.reconciliationDifference === 0 &&
    payPeriodContent.querySelector('.pay-period-monthly-summary').textContent.includes('Funding reconciliation difference'),
    'Pay periods summary did not reconcile.');
  assert(payPeriodContent.textContent.includes('Synthetic long unfunded bill') &&
    !payPeriodContent.querySelector('img') && !globalThis.__payHostileRan, 'Hostile Pay periods content was not inert text.');

  const reviewFunding = [...cards[1].querySelectorAll('.pay-period-bill-pill')]
    .find(button => button.dataset.expenseId === currentGenerated.id);
  assert(reviewFunding.textContent === currentGenerated.name && reviewFunding.getAttribute('aria-label').includes('split across 2 paychecks'),
    'Funded bill pill did not preserve compact text with accessible funding context.');
  Store.updateExpense(month, currentGenerated.id, { plannedAmount: 1076 });
  BudgetView.collapsedCategories.set(currentGenerated.category, true);
  reviewFunding.click(); await settle();
  assert(!BudgetView.collapsedCategories.get(currentGenerated.category), 'Funding route did not expand a collapsed category.');
  assert(document.activeElement.dataset.fundingExpenseId === currentGenerated.id &&
    document.activeElement.dataset.fundingPaycheckId === secondIncome.id,
    'Review funding did not focus the exact paycheck allocation.');
  const firstFunding = [...document.querySelectorAll('input[data-funding-expense-id][data-funding-paycheck-id]')]
    .find(input => input.dataset.fundingExpenseId === currentGenerated.id && input.dataset.fundingPaycheckId === income.id);
  firstFunding.value = '0'; firstFunding.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  const fourDigitFunding = document.activeElement;
  fourDigitFunding.value = '1076'; fourDigitFunding.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === currentGenerated.id)
    .paycheckAmounts[secondIncome.id] === 1076,
  'A valid four-digit paycheck funding amount was rejected.');

  App.switchView('transfers'); await settle();
  const fundUnfunded = [...document.querySelectorAll('.pay-period-needs .pay-period-funding-action')]
    .find(button => button.dataset.expenseId === unfunded.id);
  fundUnfunded.click(); await settle();
  assert(document.activeElement.dataset.fundingExpenseId === unfunded.id &&
    document.activeElement.dataset.fundingPaycheckId === income.id,
    'Fund this bill did not focus the first canonical paycheck allocation.');

  const staleExpense = Store.addExpense(month, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic stale funding bill', date: '', paycheckAmounts: {}, plannedAmount: 2,
    actualAmount: null, paymentMethod: 'bank' });
  App.switchView('transfers'); await settle();
  const staleFunding = [...document.querySelectorAll('.pay-period-needs .pay-period-funding-action')]
    .find(button => button.dataset.expenseId === staleExpense.id);
  Store.deleteExpense(month, staleExpense.id); staleFunding.click(); await settle();
  assert(document.activeElement.id === 'expenses-heading' && document.getElementById('app-status').textContent.includes('no longer available'),
    'Stale funding route did not use its heading fallback.');

  const zeroMonth = month.slice(0, 5) + (month.endsWith('-12') ? '11' : '12');
  Store.addExpense(zeroMonth, { categoryId: category.id, categoryItemId: null, name: 'Synthetic zero-paycheck bill',
    date: '', paycheckAmounts: {}, plannedAmount: 5, actualAmount: null, paymentMethod: 'credit_card' });
  BudgetView.currentMonth = zeroMonth; App.switchView('transfers'); await settle();
  assert(Store.getPayPeriodPlan(zeroMonth).paycheckCount === 0 &&
    document.querySelector('.pay-period-needs')?.textContent.includes('Synthetic zero-paycheck bill'),
    'Zero-paycheck Pay periods state hid bills needing funding.');
  const zeroFunding = document.querySelector('.pay-period-needs .pay-period-funding-action');
  zeroFunding.click(); await settle();
  assert(document.activeElement.id === 'btn-add-paycheck' && document.getElementById('app-status').textContent.includes('Add a paycheck'),
    'Zero-paycheck funding route did not focus Add Paycheck.');
  BudgetView.currentMonth = month; BudgetView.render(); TransfersView.currentMonth = month;

  const healthBefore = localStorage.getItem(primaryKey); const healthTab = document.getElementById('nav-data-health');
  healthTab.focus(); healthTab.click(); await settle();
  assert(document.getElementById('view-data-health').classList.contains('active'), 'Data Health route did not activate.');
  assert(document.activeElement.id === 'nav-data-health', 'Data Health navigation did not retain trigger focus.');
  assert(localStorage.getItem(primaryKey) === healthBefore, 'Passive Data Health render changed bytes.');
  assert(document.getElementById('data-health-content').textContent.includes('Hostile ledger label'), 'Hostile label was not rendered as text.');
  assert(!document.querySelector('#data-health-content img'), 'Hostile Data Health label created markup.');
  const eligibleV3Bytes = localStorage.getItem(primaryKey);
  const blockedLedger = JSON.parse(eligibleV3Bytes);
  blockedLedger.months[month].paychecks[0].plannedAmount = 321.001;
  const blockedV3Bytes = JSON.stringify(blockedLedger);
  const migrationTrigger = document.getElementById('review-exact-money-migration');
  assert(Store.getExactMoneyMigrationSummary().state === 'eligible' && migrationTrigger,
    'Cent-exact v3 ledger did not expose the migration action.');
  migrationTrigger.click(); await settle();
  const migrationDialog = document.getElementById('exact-money-migration-dialog');
  assert(migrationDialog.open && document.activeElement.id === 'exact-money-migration-cancel',
    'Exact-money preview did not open on Cancel.');
  assert(localStorage.getItem(primaryKey) === eligibleV3Bytes, 'Exact-money preview changed v3 bytes.');
  document.getElementById('exact-money-migration-cancel').click(); await settle();
  assert(localStorage.getItem(primaryKey) === eligibleV3Bytes && document.activeElement === migrationTrigger,
    'Exact-money Cancel did not preserve byte-exact v3 storage and restore focus.');
  migrationTrigger.click(); await settle(); document.getElementById('exact-money-migration-confirm').click(); await settle();
  const migratedBytes = localStorage.getItem(primaryKey); const migratedPersisted = JSON.parse(migratedBytes);
  assert(migratedPersisted.schemaVersion === 4 && Number.isInteger(migratedPersisted.months[month].paychecks[0].plannedAmount) &&
    migratedPersisted.months[month].paychecks[0].plannedAmount === 32100,
  'Confirmed exact-money migration did not persist integer cents.');
  assert(Store.getExactMoneyMigrationSummary().state === 'already-migrated' &&
    !document.getElementById('review-exact-money-migration'), 'Migrated ledger did not render the already-active state.');

  const v4Backup = Store.exportData(); const v4Envelope = JSON.parse(v4Backup);
  assert(v4Envelope.data.schemaVersion === 4 && Number.isInteger(v4Envelope.data.months[month].paychecks[0].plannedAmount),
    'v4 backup did not preserve integer-cent persistence.');
  const v4RoundTrip = Store.addPaycheck(month, { earnerId, plannedAmount: 19.99, actualAmount: null, date: '' });
  const snapshotKeysBeforeV4Import = new Set(Object.keys(localStorage).filter(key => key.startsWith('zeroBudget_snapshot:')));
  Store.commitImport(Store.previewImport(v4Backup));
  assert(!Store.getMonth(month).paychecks.some(item => item.id === v4RoundTrip.id) &&
    JSON.parse(localStorage.getItem(primaryKey)).schemaVersion === 4, 'v4 backup import did not restore its exact ledger.');
  const v4SnapshotKey = Object.keys(localStorage).find(key => key.startsWith('zeroBudget_snapshot:') &&
    !snapshotKeysBeforeV4Import.has(key));
  const v4SnapshotEnvelope = v4SnapshotKey ? JSON.parse(localStorage.getItem(v4SnapshotKey)) : null;
  assert(v4SnapshotEnvelope?.data.schemaVersion === 4 &&
    v4SnapshotEnvelope.data.months[month].paychecks.some(record => record.id === v4RoundTrip.id),
  'v4 backup replacement did not create a restorable integer-cent v4 safety snapshot.');
  Store.restoreSnapshot(v4SnapshotKey.slice('zeroBudget_snapshot:'.length));
  assert(Store.getMonth(month).paychecks.some(item => item.id === v4RoundTrip.id) &&
    JSON.parse(localStorage.getItem(primaryKey)).schemaVersion === 4, 'v4 snapshot did not round-trip through active storage.');
  Store.commitImport(Store.previewImport(v4Backup)); DataHealthView.render(); await settle();
  const resolutionBefore = localStorage.getItem(primaryKey);
  const healthCheck = [...document.querySelectorAll('.actual-resolution-row input[type="checkbox"]')]
    .find(input => input.dataset.recordId === hostile.id);
  assert(healthCheck && !healthCheck.checked, 'Missing-actual choice was not default-unselected.');
  healthCheck.click(); const amount = document.getElementById(healthCheck.id.replace('resolve-actual-', 'resolve-amount-'));
  amount.value = '0'; const resolutionForm = healthCheck.closest('form'); resolutionForm.requestSubmit(); await settle();
  const resolutionDialog = document.getElementById('actual-resolution-dialog');
  assert(resolutionDialog.open && document.activeElement.id === 'actual-resolution-cancel', 'Actual preview did not focus Cancel.');
  assert(localStorage.getItem(primaryKey) === resolutionBefore, 'Actual preview changed bytes.');
  document.getElementById('actual-resolution-cancel').click(); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === hostile.id).actualAmount === null, 'Actual preview Cancel applied a value.');
  assert(localStorage.getItem(primaryKey) === resolutionBefore, 'Actual preview Cancel changed bytes.');
  resolutionForm.requestSubmit(); await settle(); document.getElementById('actual-resolution-confirm').click(); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === hostile.id).actualAmount === 0, 'Selected actual zero was not applied.');

  App.switchView('budget'); BudgetView.render(); await settle();
  const clearedPassiveBytes = localStorage.getItem(primaryKey);
  const clearedDetails = document.getElementById('monthly-review-cleared');
  const clearedCheckbox = [...document.querySelectorAll('[data-cleared-kind="income"][data-record-id]')]
    .find(input => input.dataset.recordId === income.id);
  assert(clearedDetails && !clearedDetails.open && clearedCheckbox?.type === 'checkbox' && !clearedCheckbox.checked,
    'Eligible entered-zero paycheck did not render as one initially unchecked native cleared control.');
  assert(localStorage.getItem(primaryKey) === clearedPassiveBytes, 'Passive Manual Cleared render changed storage bytes.');
  clearedDetails.open = true; clearedCheckbox.click(); await settle();
  const clearedPersisted = JSON.parse(localStorage.getItem(primaryKey));
  const clearedAfter = [...document.querySelectorAll('[data-cleared-kind="income"][data-record-id]')]
    .find(input => input.dataset.recordId === income.id);
  assert(Store.getStatus().residentSchemaVersion === 5 &&
    clearedPersisted.schemaVersion === 5 &&
    clearedPersisted.months[month].paychecks.find(item => item.id === income.id)?.cleared === true,
  'Manual Cleared toggle did not atomically persist the entered-zero paycheck in schema v5.');
  assert(clearedAfter?.checked && document.activeElement === clearedAfter &&
    document.getElementById('monthly-review-cleared')?.open,
  'Manual Cleared toggle did not restore the exact checkbox focus and open checklist state.');

  const staleActual = Store.addExpense(month, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic stale actual', date, paycheckAmounts: {}, plannedAmount: 4, actualAmount: null, paymentMethod: 'bank' });
  DataHealthView.render(); const staleCheck = [...document.querySelectorAll('.actual-resolution-row input[type="checkbox"]')]
    .find(input => input.dataset.recordId === staleActual.id); staleCheck.click();
  const staleAmount = document.getElementById(staleCheck.id.replace('resolve-actual-', 'resolve-amount-')); staleAmount.value = '2';
  staleCheck.closest('form').requestSubmit(); await settle();
  Store.addExpense(month, { categoryId: category.id, categoryItemId: null, name: 'Synthetic generation change',
    date, paycheckAmounts: {}, plannedAmount: 1, actualAmount: 1, paymentMethod: 'bank' });
  document.getElementById('actual-resolution-confirm').click(); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === staleActual.id).actualAmount === null,
    'Stale actual preview partially applied.');
  assert(!document.getElementById('app-error').hidden && document.activeElement.id === 'app-error',
    'Actual apply failure did not preserve application-alert focus.');
  App.announceStatus('Continuing browser evidence.'); DataHealthView.render();

  const compareBefore = localStorage.getItem(primaryKey); const compareInput = document.getElementById('health-compare-file');
  const transfer = new DataTransfer(); transfer.items.add(new File([Store.exportData()], 'synthetic-backup.json', { type: 'application/json' }));
  compareInput.files = transfer.files; compareInput.dispatchEvent(new Event('change', { bubbles: true })); await pause(80); await settle();
  const compareText = document.getElementById('health-compare-result').textContent;
  assert(compareText.includes('Nothing was imported') && !compareText.includes('Apply'), 'Comparison did not remain clearly report-only.');
  assert(localStorage.getItem(primaryKey) === compareBefore, 'Backup comparison changed bytes.');

  App.showRecovery({ hasEvidence: false, snapshots: [], warnings: [] }); await settle();
  assert(!document.getElementById('recovery-panel').hidden && document.getElementById('application-shell').hidden &&
    document.getElementById('application-shell').inert, 'Recovery did not gate the application shell.');
  App.enterApplication('Recovery gate evidence complete.', 'ready'); App.switchView('data-health'); await settle();

  App.switchView('budget'); BudgetView.currentMonth = month; BudgetView.render(); await settle();
  const hostileDelete = [...document.querySelectorAll('.expense-table [aria-label^="Delete "]')]
    .find(button => button.closest('tr')?.dataset.id === hostile.id);
  hostileDelete.click(); await settle(); document.getElementById('expense-delete-confirm').click(); await settle();
  assert(!document.getElementById('expense-undo-notice').hidden, 'Restore invalidation setup did not create an outstanding Undo.');
  const backup = Store.exportData(); const importBytes = localStorage.getItem(primaryKey);
  const importPreview = Store.previewImport(backup);
  assert(localStorage.getItem(primaryKey) === importBytes, 'Backup preview changed storage bytes.');
  App.restorePreview = importPreview; App.restoreTrigger = document.getElementById('btn-import');
  document.getElementById('restore-dialog').returnValue = 'confirm'; App.onRestoreDialogClose(); await settle();
  assert(document.getElementById('expense-undo-notice').hidden && App.expenseUndo === null,
    'Successful Restore did not invalidate outstanding expense Undo.');
  assert(localStorage.getItem(primaryKey) === importBytes, 'No-op backup restore changed bytes.');
  const rerun = Store.previewRecurringMonth(month); assert(rerun.counts.additions === 0, 'Recurring apply was not idempotent.');

  const forecastMonth = DashboardView.getForecastMonths()[0];
  Store.addPaycheck(forecastMonth, { earnerId, plannedAmount: 88, actualAmount: null, date: '' });
  const comparisonZeroExpense = Store.addExpense(forecastMonth, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic comparison entered zero', date: '', paycheckAmounts: {}, plannedAmount: 5,
    actualAmount: 0, paymentMethod: 'bank' });
  Store.addExpense(forecastMonth, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic comparison incomplete', date: '', paycheckAmounts: {}, plannedAmount: 6,
    actualAmount: null, paymentMethod: 'credit_card' });
  Store.updateAllocation(forecastMonth, 'savings', 8);
  const dashboardBytes = localStorage.getItem(primaryKey); let csvCapture = null; const originalDownload = App.download;
  App.download = (content, filename, type) => { csvCapture = { content, filename, type }; };
  App.switchView('dashboard'); document.getElementById('dash-from').value = month;
  document.getElementById('dash-to').value = month; DashboardView.render(); await settle();
  document.querySelector('[data-dashboard-basis="actual"]').click(); await settle();
  assert(DashboardView.basis === 'actual', 'Dashboard Actual basis did not activate.');
  assert(document.querySelector('[data-dashboard-basis="actual"]').getAttribute('aria-pressed') === 'true',
    'Dashboard Actual basis did not expose pressed state.');
  document.getElementById('btn-dashboard-csv').click(); await settle();
  assert(csvCapture?.filename === 'warm-ledger-dashboard-' + month + '-to-' + month + '-actual.csv',
    'Dashboard CSV filename is incorrect.');
  assert(csvCapture?.type === 'text/csv;charset=utf-8' && csvCapture.content.startsWith('\uFEFF'),
    'Dashboard CSV encoding or media type is incorrect.');
  assert(csvCapture.content.includes('"Incomplete"'), 'Dashboard CSV did not preserve incomplete actuals.');
  const forecastRows = [...document.querySelectorAll('#table-dashboard-forecast tbody tr')];
  assert(forecastRows[0]?.textContent.includes('Saved month plan') && forecastRows[0].textContent.includes('$88'),
    'Dashboard forecast did not render the saved future month.');
  assert(forecastRows[1]?.textContent.includes('No saved plan'), 'Dashboard forecast estimated an absent future month.');
  document.querySelector('[data-dashboard-forecast-horizon="6"]').click(); await settle();
  assert(DashboardView.forecastHorizon === 6 &&
    document.querySelector('[data-dashboard-forecast-horizon="6"]').getAttribute('aria-pressed') === 'true',
    'Dashboard forecast horizon did not update accessibly.');
  csvCapture = null; document.getElementById('btn-dashboard-forecast-csv').click(); await settle();
  assert(csvCapture?.filename.startsWith('warm-ledger-forecast-') && csvCapture.content.includes('"Saved month plan"') &&
    csvCapture.content.includes('"No saved plan"'), 'Dashboard forecast CSV did not preserve saved-only sources.');
  App.download = originalDownload;
  const originalPrint = globalThis.print; let printCount = 0; globalThis.print = () => { printCount++; };
  document.getElementById('btn-dashboard-print').click(); await settle(); globalThis.print = originalPrint;
  assert(printCount === 1, 'Dashboard print action did not invoke browser print exactly once.');
  assert(document.getElementById('dashboard-print-context').textContent.includes(month) &&
    document.getElementById('dashboard-print-context').textContent.includes('Actual'),
    'Dashboard print context did not preserve range and basis.');
  assert(localStorage.getItem(primaryKey) === dashboardBytes, 'Dashboard basis, CSV, or print changed storage bytes.');

  const comparisonDisclosure = document.getElementById('dashboard-saved-month-comparison');
  assert(!comparisonDisclosure.open, 'Saved month comparison must be initially closed.');
  const savedComparisonMonths = Store.getAllMonthKeys().slice().sort();
  const expectedComparisonMonths = savedComparisonMonths.slice(-2);
  const baselineSelect = document.getElementById('dashboard-comparison-baseline');
  const comparisonSelect = document.getElementById('dashboard-comparison-month');
  assert(expectedComparisonMonths.length === 2 && baselineSelect.value === expectedComparisonMonths[0] &&
    comparisonSelect.value === expectedComparisonMonths[1],
    'Saved month comparison did not default to the two most recent distinct saved months.');
  assert([...baselineSelect.options].some(option => option.value === month) === savedComparisonMonths.includes(month),
    'Current month availability did not exactly match saved-month membership.');
  comparisonDisclosure.open = true;
  baselineSelect.value = expectedComparisonMonths[1];
  baselineSelect.dispatchEvent(new Event('change', { bubbles: true }));
  comparisonSelect.value = expectedComparisonMonths[0];
  comparisonSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const draftComparisonBytes = localStorage.getItem(primaryKey);
  document.getElementById('dash-from').value = month;
  document.getElementById('dash-to').value = month;
  DashboardView.render(); await settle();
  document.querySelector('[data-dashboard-basis="planned"]').click(); await settle();
  assert(document.getElementById('dashboard-comparison-output').hidden &&
    document.getElementById('dashboard-comparison-status').textContent.includes('Choose Compare') &&
    baselineSelect.value === expectedComparisonMonths[1] && comparisonSelect.value === expectedComparisonMonths[0],
    'An unrelated Dashboard range/render/basis update ran or discarded the unconfirmed picker draft.');
  csvCapture = null; App.download = (content, filename, type) => { csvCapture = { content, filename, type }; };
  printCount = 0; globalThis.print = () => { printCount++; };
  document.getElementById('btn-dashboard-comparison-csv').click(); await settle();
  document.getElementById('btn-dashboard-comparison-print').click(); await settle();
  App.download = originalDownload; globalThis.print = originalPrint;
  assert(csvCapture === null && printCount === 0 &&
    document.getElementById('dashboard-comparison-output').hidden &&
    document.getElementById('dashboard-comparison-status').textContent.includes('Choose Compare') &&
    localStorage.getItem(primaryKey) === draftComparisonBytes,
    'CSV or print ran an unconfirmed comparison draft or changed storage bytes.');
  const comparisonBytes = localStorage.getItem(primaryKey);
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  assert(DashboardView.savedMonthComparisonRequest.baselineMonth === expectedComparisonMonths[1] &&
    DashboardView.savedMonthComparisonRequest.comparisonMonth === expectedComparisonMonths[0] &&
    DashboardView.savedMonthComparisonRequest.basis === 'planned' &&
    !document.getElementById('dashboard-comparison-output').hidden,
    'Compare did not commit and render the exact picker draft.');
  const plannedComparison = Store.compareSavedMonths({ baselineMonth: baselineSelect.value,
    comparisonMonth: comparisonSelect.value, basis: 'planned' });
  const comparisonRows = [...document.querySelectorAll('.dashboard-comparison-table tbody tr')];
  const firstPlannedRow = plannedComparison.rowModel.rows[0];
  assert(plannedComparison.status === 'ready' && comparisonRows.length === plannedComparison.rowModel.rows.length &&
    comparisonRows[0]?.cells[1]?.textContent === firstPlannedRow.Metric &&
    comparisonRows[0]?.cells[4]?.textContent === BudgetView.fmt(firstPlannedRow.Delta) &&
    document.querySelector('.dashboard-comparison-context')?.textContent.includes('comparison minus baseline'),
    'Planned saved-month comparison did not render its canonical rows and deltas.');
  assert(localStorage.getItem(primaryKey) === comparisonBytes, 'Compare or planned comparison render changed storage bytes.');

  document.querySelector('[data-dashboard-basis="actual"]').click(); await settle();
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  const actualComparison = Store.compareSavedMonths({ baselineMonth: baselineSelect.value,
    comparisonMonth: comparisonSelect.value, basis: 'actual' });
  assert(actualComparison.status === 'ready' && actualComparison.rowModel.rows.some(row => row.Status === 'Incomplete') &&
    document.querySelector('.dashboard-comparison-table')?.textContent.includes('— Incomplete'),
    'Actual saved-month comparison did not preserve incomplete values in the UI.');
  csvCapture = null; App.download = (content, filename, type) => { csvCapture = { content, filename, type }; };
  document.getElementById('btn-dashboard-comparison-csv').click(); await settle();
  assert(csvCapture?.filename.endsWith('-actual.csv') && csvCapture.type === 'text/csv;charset=utf-8' &&
    csvCapture.content === DashboardView.savedMonthComparisonCsv(actualComparison) &&
    csvCapture.content.includes('"Incomplete"'),
    'Actual saved-month comparison CSV did not exactly preserve canonical incomplete rows.');
  App.download = originalDownload;
  printCount = 0; globalThis.print = () => { printCount++; };
  document.getElementById('btn-dashboard-comparison-print').click(); await settle(); globalThis.print = originalPrint;
  assert(printCount === 1 && !document.body.classList.contains('printing-saved-month-comparison'),
    'Saved month comparison print did not invoke print exactly once and clean up its print scope.');
  assert(localStorage.getItem(primaryKey) === comparisonBytes,
    'Saved month comparison render, CSV, or print changed storage bytes.');

  const comparisonCsvBeforeExplain = csvCapture.content;
  const explainButtons = () => [...document.querySelectorAll('.dashboard-comparison-explain-action')];
  const categoryExplain = () => explainButtons().find(button => button.dataset.comparisonSection === 'categories');
  const paymentExplain = () => explainButtons().find(button => button.dataset.comparisonSection === 'payment_methods');
  assert(!document.getElementById('dashboard-comparison-explanation'),
    'Saved month comparison rendered contributor details before Explain change was requested.');
  categoryExplain().click(); await settle();
  let explanation = document.getElementById('dashboard-comparison-explanation');
  assert(explanation && categoryExplain().getAttribute('aria-expanded') === 'true' &&
    explanation.textContent.includes('Actual: Not entered') && explanation.textContent.includes('Actual: $0.00') &&
    explanation.textContent.includes('Actual: Incomplete') && explanation.textContent.includes('Actual: $0.00 · Complete'),
    'Lazy category explanation did not preserve incomplete and entered-zero contributor presentation.');
  paymentExplain().click(); await settle();
  explanation = document.getElementById('dashboard-comparison-explanation');
  assert(explanation && paymentExplain().getAttribute('aria-expanded') === 'true' &&
    categoryExplain().getAttribute('aria-expanded') === 'false' &&
    DashboardView.savedMonthComparisonExplainRequest.section === 'payment_methods',
    'Payment-method explanation did not replace the open category explanation.');
  paymentExplain().click(); await settle();
  assert(!document.getElementById('dashboard-comparison-explanation') &&
    paymentExplain().getAttribute('aria-expanded') === 'false',
    'Selecting the same Explain change row did not close its contributor detail.');

  categoryExplain().click(); await settle();
  baselineSelect.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  assert(!document.getElementById('dashboard-comparison-explanation'),
    'Changing a saved-month picker did not close contributor detail.');
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  categoryExplain().click(); await settle();
  document.querySelector('[data-dashboard-basis="planned"]').click(); await settle();
  assert(!document.getElementById('dashboard-comparison-explanation'),
    'Changing the Dashboard basis did not close contributor detail.');
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  categoryExplain().click(); await settle();
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  assert(!document.getElementById('dashboard-comparison-explanation'),
    'Choosing Compare did not close contributor detail before rerendering.');

  document.querySelector('[data-dashboard-basis="actual"]').click(); await settle();
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  categoryExplain().click(); await settle();
  const staleContributorButton = [...document.querySelectorAll('.dashboard-comparison-contributor-edit')]
    .find(button => button.textContent.includes('Synthetic comparison entered zero'));
  assert(staleContributorButton, 'A contributor could not be prepared for stale-route evidence.');
  Store.updateExpense(forecastMonth, comparisonZeroExpense.id, { plannedAmount: 5.5 });
  const staleContributorBytes = localStorage.getItem(primaryKey); staleContributorButton.click(); await settle();
  assert(document.getElementById('view-dashboard').classList.contains('active') &&
    document.getElementById('app-status').textContent.includes('changed or is no longer a contributor') &&
    document.getElementById('dashboard-comparison-explanation') &&
    (document.activeElement.classList.contains('dashboard-comparison-explain-action') ||
      document.activeElement === comparisonDisclosure.querySelector('summary')) &&
    localStorage.getItem(primaryKey) === staleContributorBytes,
    'A stale contributor Edit did not refresh, announce, restore safe focus, and remain byte-exact on Dashboard.');

  const freshContributorButton = [...document.querySelectorAll('.dashboard-comparison-contributor-edit')]
    .find(button => button.textContent.includes('Synthetic comparison entered zero'));
  assert(freshContributorButton, 'The refreshed contributor detail did not retain the updated expense.');
  freshContributorButton.click(); await settle();
  assert(document.getElementById('view-budget').classList.contains('active') &&
    document.activeElement.dataset.editType === 'expense' &&
    document.activeElement.dataset.recordId === comparisonZeroExpense.id,
    'A valid contributor Edit did not focus the exact existing Budget expense control.');
  App.switchView('dashboard'); comparisonDisclosure.open = true; DashboardView.render(); await settle();
  document.querySelector('[data-dashboard-basis="actual"]').click(); await settle();
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  categoryExplain().click(); await settle();
  csvCapture = null; App.download = (content, filename, type) => { csvCapture = { content, filename, type }; };
  document.getElementById('btn-dashboard-comparison-csv').click(); await settle(); App.download = originalDownload;
  assert(csvCapture?.content === comparisonCsvBeforeExplain &&
    !csvCapture.content.includes('Synthetic comparison entered zero') &&
    !csvCapture.content.includes('recordId') && !csvCapture.content.includes('contributors'),
    'Explain change altered the canonical comparison CSV or leaked contributor-only fields.');

  baselineSelect.value = comparisonSelect.value;
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  assert(document.getElementById('dashboard-comparison-output').hidden &&
    document.getElementById('dashboard-comparison-status').textContent.includes('different saved months'),
    'Same-month comparison validation did not clear output and explain the error.');
  baselineSelect.value = expectedComparisonMonths[0]; comparisonSelect.value = expectedComparisonMonths[1];
  document.getElementById('dashboard-saved-month-comparison-form').requestSubmit(); await settle();
  const replacementPreview = Store.previewImport(Store.exportData());
  delete replacementPreview.data.months[expectedComparisonMonths[1]];
  Store.commitImport(replacementPreview);
  const staleComparisonBytes = localStorage.getItem(primaryKey);
  DashboardView.compareSavedMonths({ announce: true }); await settle();
  assert(document.getElementById('dashboard-comparison-output').hidden &&
    document.getElementById('dashboard-comparison-status').textContent.includes('no longer available') &&
    baselineSelect.value === expectedComparisonMonths[0] && comparisonSelect.value === '' &&
    localStorage.getItem(primaryKey) === staleComparisonBytes,
    'A removed selected month did not clear comparison output and status without fallback or write.');

  const finder = document.getElementById('dashboard-record-finder'); finder.open = true;
  const finderQuery = document.getElementById('dashboard-record-query');
  const finderBytes = localStorage.getItem(primaryKey); finderQuery.value = 'Synthetic long unfunded bill';
  document.getElementById('dashboard-record-finder-form').requestSubmit(); await settle();
  let finderAction = document.querySelector('.dashboard-record-result-action');
  assert(finderAction && document.getElementById('dashboard-record-results').textContent.includes('1 of 1 matching saved record shown.'),
    'Saved-record finder did not render the expected bounded result.');
  assert(localStorage.getItem(primaryKey) === finderBytes, 'Saved-record search changed storage bytes.');
  document.getElementById('dashboard-record-clear').click(); await settle();
  assert(document.activeElement === finderQuery && !document.querySelector('.dashboard-record-result-action') &&
    localStorage.getItem(primaryKey) === finderBytes, 'Clearing saved-record search changed bytes or lost query focus.');

  finderQuery.value = 'Synthetic long unfunded bill';
  document.getElementById('dashboard-record-finder-form').requestSubmit(); await settle();
  finderAction = document.querySelector('.dashboard-record-result-action'); finderAction.click(); await settle();
  assert(document.getElementById('view-budget').classList.contains('active') &&
    document.activeElement.dataset.editType === 'expense' && document.activeElement.dataset.recordId === unfunded.id,
  'Saved-record result did not route focus to the existing expense Edit control.');

  App.switchView('dashboard'); finder.open = true; DashboardView.rerunSavedRecordSearch(); await settle();
  const staleFinderAction = document.querySelector('.dashboard-record-result-action');
  Store.updateExpense(month, unfunded.id, { plannedAmount: 12 });
  const staleFinderBytes = localStorage.getItem(primaryKey); staleFinderAction.click(); await settle();
  assert(document.getElementById('view-dashboard').classList.contains('active') &&
    document.getElementById('app-status').textContent.includes('changed or is no longer') &&
    document.activeElement.classList.contains('dashboard-record-result-action') &&
    localStorage.getItem(primaryKey) === staleFinderBytes,
  'Stale saved-record result did not refresh safely and restore result focus without writing.');

  App.switchView('dashboard'); await settle();
  const reviewQueue = document.getElementById('dashboard-review-queue');
  assert(!reviewQueue.open, 'Months needing attention must be initially closed.');
  const reviewAnchorMonth = DashboardView.localCivilMonth();
  Store.addExpense(reviewAnchorMonth, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic review navigation bill', date: '', paycheckAmounts: {}, plannedAmount: 1,
    actualAmount: null, paymentMethod: 'bank' });
  for (const paycheck of Store.getMonth(reviewAnchorMonth).paychecks) {
    Store.updatePaycheck(reviewAnchorMonth, paycheck.id, { date, actualAmount: paycheck.plannedAmount });
  }
  for (const expense of Store.getMonth(reviewAnchorMonth).expenses) {
    Store.updateExpense(reviewAnchorMonth, expense.id, { date, actualAmount: expense.plannedAmount });
  }
  const reviewQueueBytes = localStorage.getItem(primaryKey); reviewQueue.open = true;
  DashboardView.renderMonthReviewQueue(); await settle();
  assert(localStorage.getItem(primaryKey) === reviewQueueBytes,
    'Opening or rendering Months needing attention changed storage bytes.');
  for (const lookback of [6, 12, 24]) {
    const control = document.querySelector('[name="dashboard-review-months"][value="' + lookback + '"]');
    assert(control, 'A required saved-month lookback control is missing.');
    control.click(); await settle();
    assert(DashboardView.reviewQueueLookback === lookback && control.checked,
      'A saved-month lookback control did not select its exact bounded window.');
    assert(localStorage.getItem(primaryKey) === reviewQueueBytes,
      'Changing a saved-month lookback changed storage bytes.');
  }

  document.querySelector('[name="dashboard-review-months"][value="12"]').click(); await settle();
  const validReviewAction = [...document.querySelectorAll('[data-review-kind][data-month-key]')]
    .find(button => button.dataset.reviewKind === 'manual-clearing');
  assert(validReviewAction, 'A valid saved-month review action is missing.');
  const reviewRouteMonth = validReviewAction.dataset.monthKey;
  const validReviewBytes = localStorage.getItem(primaryKey); validReviewAction.click(); await settle(); await pause(50);
  const expectedClearedTarget = document.querySelector('#monthly-review-cleared [data-cleared-kind][data-record-id]');
  assert(document.getElementById('view-budget').classList.contains('active') &&
    document.activeElement === expectedClearedTarget && localStorage.getItem(primaryKey) === validReviewBytes,
  'A valid review action did not revalidate and focus the exact existing target without writing.');

  App.switchView('dashboard'); reviewQueue.open = true; DashboardView.renderMonthReviewQueue(); await settle();
  const staleReviewAction = [...document.querySelectorAll('[data-review-kind][data-month-key]')]
    .find(button => button.dataset.reviewKind === 'manual-clearing' && button.dataset.monthKey === reviewRouteMonth);
  assert(staleReviewAction, 'A stale-route review action could not be prepared.');
  const clearedItems = Store.getClearedChecklist(reviewRouteMonth).items;
  for (const [kind, items] of [['income', clearedItems.income], ['expense', clearedItems.expenses]]) {
    for (const item of items) Store.setRecordCleared({ monthKey: reviewRouteMonth, kind,
      recordId: item.recordId, cleared: true });
  }
  const staleReviewBytes = localStorage.getItem(primaryKey); staleReviewAction.click(); await settle(); await pause(50);
  const refreshedStaleTarget = [...reviewQueue.querySelectorAll('[data-review-kind][data-month-key]')]
    .find(control => control.dataset.reviewKind === 'manual-clearing' && control.dataset.monthKey === reviewRouteMonth) ||
    reviewQueue.querySelector('summary');
  assert(document.getElementById('view-dashboard').classList.contains('active') &&
    refreshedStaleTarget?.getClientRects().length && document.activeElement === refreshedStaleTarget &&
    document.getElementById('app-status').textContent.includes('changed') &&
    localStorage.getItem(primaryKey) === staleReviewBytes,
  'A stale review action did not refresh and restore safe focus without click-time writes.');

  const budgetStaleExpense = Store.addExpense(reviewRouteMonth, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic stale Budget review bill', date, paycheckAmounts: {}, plannedAmount: 2,
    actualAmount: null, paymentMethod: 'bank' });
  BudgetView.currentMonth = reviewRouteMonth; App.switchView('budget'); BudgetView.render(); await settle();
  const staleBudgetAction = document.querySelector(
    '[data-review-step-kind="actuals"][data-review-route-target="budget-actuals"]');
  assert(staleBudgetAction, 'A Budget-origin stale review action could not be prepared.');
  Store.updateExpense(reviewRouteMonth, budgetStaleExpense.id, { actualAmount: budgetStaleExpense.plannedAmount });
  const staleBudgetBytes = localStorage.getItem(primaryKey); staleBudgetAction.click(); await settle(); await pause(50);
  assert(document.getElementById('view-budget').classList.contains('active') &&
    document.activeElement.id === 'monthly-review-next-steps-heading' &&
    document.getElementById('app-status').textContent.includes('changed') &&
    localStorage.getItem(primaryKey) === staleBudgetBytes,
  'A Budget-origin stale review action did not retain Budget, focus its safe heading, and remain write-free.');

  const emptyMonthIndex = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 2;
  const emptyMonth = String(Math.floor(emptyMonthIndex / 12)).padStart(4, '0') + '-' +
    String(emptyMonthIndex % 12 + 1).padStart(2, '0');
  Store.updateAllocation(emptyMonth, 'savings', 0);
  App.switchView('dashboard'); reviewQueue.open = true; DashboardView.renderMonthReviewQueue(); await settle();
  const staleEmptyAction = document.querySelector('[data-empty-month-key="' + emptyMonth + '"]');
  assert(staleEmptyAction, 'A saved empty-month action could not be prepared.');
  Store.addExpense(emptyMonth, { categoryId: category.id, categoryItemId: null,
    name: 'Synthetic changed empty month', date: '', paycheckAmounts: {}, plannedAmount: 1,
    actualAmount: null, paymentMethod: 'bank' });
  const staleEmptyBytes = localStorage.getItem(primaryKey); staleEmptyAction.click(); await settle(); await pause(50);
  assert(document.getElementById('view-dashboard').classList.contains('active') &&
    document.activeElement === reviewQueue.querySelector('summary') &&
    document.getElementById('app-status').textContent.includes('changed') &&
    localStorage.getItem(primaryKey) === staleEmptyBytes,
  'A stale empty-month route did not refresh and restore safe focus without click-time writes.');
  App.switchView('data-health'); await settle();
  return { month, passiveActionsByteExact: true, monthlyReviewEdit: true, expenseDeleteCancelUndoStale: true,
    generatedTombstoneUndo: true, dataHealthPassiveRoutes: true, actualZeroPreviewCancelApply: true, actualApplyFailureAlertFocus: true,
    compareOnlyNoWrite: true, hostileLabelsSafe: true, recoveryGating: true, restoreInvalidatesUndo: true,
    payPeriodsPassiveByteExact: true, payPeriodsCanonicalActualsFundingStates: true,
    payPeriodsAllocationsReconcileHostileSafe: true, payPeriodsExactCanonicalCollapsedRoutes: true,
    payPeriodsFourDigitFunding: true, payPeriodsStaleAndZeroPaycheckRoutes: true,
    previewCancelApply: true, backupRoundTrip: true, dashboardBasisCsvPrintPassive: true,
    dashboardSavedMonthForecastPassive: true, savedRecordFinderTransientRouteStaleSafe: true,
    savedMonthComparisonDefaultsValidationRowsPassiveStaleSafe: true,
    savedMonthComparisonActualIncompleteCsvPrintByteExact: true,
    savedMonthComparisonDraftRequiresExplicitCompare: true,
    savedMonthComparisonExplainLazyReplaceCloseTransitions: true,
    savedMonthComparisonExplainNullZeroStaleSuccessCsvByteExact: true,
    reviewNavigationClosedPassiveLookbacksRoutesStaleSafe: true,
    reviewNavigationBudgetOriginStaleFocusByteExact: true,
    exactMoneyEligiblePreviewCancelConfirm: true,
    exactMoneyV4BackupImportSnapshotRoundTrip: true, manualClearedZeroToggleFocusReload: true,
    clearedRecordId: income.id, blockedV3Bytes,
    generatedIncome: Store.getMonth(month).paychecks.length,
    generatedExpenses: Store.getMonth(month).expenses.length };
})()`;

async function run(options) {
  const browser = locateChromium();
  if (!browser) throw new Error('Chromium was not found. Install Chromium or set CHROMIUM_BIN to run optional browser evidence.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zerobudget-browser-'));
  const child = spawn(browser, ['--headless', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let cdp; let evidence;
  try {
    const port = await waitForDevToolsPort(profile, child);
    cdp = new Cdp(await waitForPage(port, child)); await cdp.open();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const appUrl = new URL('../index.html', `file://${__filename}`).href;
    await cdp.send('Page.navigate', { url: appUrl });
    await new Promise(resolve => setTimeout(resolve, 800));
    const scenario = await evaluate(cdp, SCENARIO);
    const preparedDashboard = await evaluate(cdp, `(() => {
      const primaryKey = Store.STORAGE_KEY || ZeroBudgetStore.STORAGE_KEY;
      const before = localStorage.getItem(primaryKey);
      const prepared = Store.prepareDashboardRange({
        monthKeys: [document.getElementById('dash-from').value, document.getElementById('dash-to').value],
        basis: DashboardView.basis
      });
      DashboardView.render();
      const after = localStorage.getItem(primaryKey);
      const monthKey = prepared.monthKeys[0];
      return { byteExact: before === after,
        monthKeysExact: prepared.monthKeys.length === 2,
        preparedFrozen: Object.isFrozen(prepared) && Object.isFrozen(prepared.months[monthKey]) &&
          Object.isFrozen(prepared.months[monthKey].summary) };
    })()`);
    assertEvidence(preparedDashboard.byteExact && preparedDashboard.monthKeysExact && preparedDashboard.preparedFrozen,
      'Prepared dashboard snapshot changed bytes or was not frozen: ' + JSON.stringify(preparedDashboard));
    scenario.preparedDashboardPassiveByteExact = true;
    const escapeSetup = await evaluate(cdp, `(async () => {
      App.switchView('budget'); BudgetView.render();
      const button = document.querySelector('.expense-table [aria-label^="Delete "]');
      if (!button) return { ready: false };
      globalThis.__escapeExpenseId = button.closest('tr').dataset.id;
      globalThis.__escapeBytes = localStorage.getItem(Store.STORAGE_KEY);
      button.focus(); button.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ready: document.getElementById('expense-delete-dialog').open,
        cancelFocused: document.activeElement.id === 'expense-delete-cancel' };
    })()`);
    assertEvidence(escapeSetup.ready && escapeSetup.cancelFocused, 'Expense delete Escape setup failed.');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const escapeDelete = await evaluate(cdp, `(() => {
      const id = globalThis.__escapeExpenseId; const bytes = globalThis.__escapeBytes;
      const result = { closed: !document.getElementById('expense-delete-dialog').open,
        preserved: Store.getMonth(BudgetView.currentMonth).expenses.some(item => item.id === id),
        byteExact: localStorage.getItem(Store.STORAGE_KEY) === bytes,
        focusReturned: document.activeElement.closest('tr')?.dataset.id === id && document.activeElement.getAttribute('aria-label')?.startsWith('Delete ') };
      delete globalThis.__escapeExpenseId; delete globalThis.__escapeBytes; return result;
    })()`);
    assertEvidence(escapeDelete.closed && escapeDelete.preserved && escapeDelete.byteExact && escapeDelete.focusReturned,
      `Expense delete Escape failed: ${JSON.stringify(escapeDelete)}`);
    scenario.expenseDeleteEscape = true;
    const comparisonResponsiveSetup = await evaluate(cdp, `(async () => {
      App.switchView('dashboard'); DashboardView.render();
      const disclosure = document.getElementById('dashboard-saved-month-comparison'); disclosure.open = true;
      const months = Store.getAllMonthKeys().slice().sort();
      const baseline = document.getElementById('dashboard-comparison-baseline');
      const comparison = document.getElementById('dashboard-comparison-month');
      if (months.length < 2) return { ready: false };
      baseline.value = months[0]; comparison.value = months[1];
      document.getElementById('dashboard-saved-month-comparison-form').requestSubmit();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const explain = [...document.querySelectorAll('.dashboard-comparison-explain-action')]
        .find(button => button.dataset.comparisonSection === 'categories');
      explain?.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ready: !document.getElementById('dashboard-comparison-output').hidden &&
        Boolean(document.getElementById('dashboard-comparison-explanation')) };
    })()`);
    assertEvidence(comparisonResponsiveSetup.ready, 'Saved Month Comparison responsive setup failed.');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    const comparisonNarrow = await evaluate(cdp, `(() => {
      const disclosure = document.getElementById('dashboard-saved-month-comparison');
      const tableRegion = disclosure.querySelector('.dashboard-comparison-table');
      const explanation = document.getElementById('dashboard-comparison-explanation');
      const explanationSides = explanation?.querySelector('.dashboard-comparison-explanation-sides');
      const viewport = document.documentElement.clientWidth;
      const targets = [...disclosure.querySelectorAll('summary, select, button')]
        .filter(element => element.getClientRects().length);
      const regionRect = tableRegion?.getBoundingClientRect();
      const overflowing = [...disclosure.querySelectorAll('*')].filter(element => {
        if (!element.getClientRects().length) return false; const rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > viewport + 0.5;
      }).map(element => ({ tag: element.tagName, className: String(element.className || ''),
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })).slice(0, 12);
      return { visible: Boolean(disclosure.getClientRects().length),
        noPageOverflow: document.documentElement.scrollWidth <= viewport,
        disclosureContained: disclosure.getBoundingClientRect().left >= -0.5 &&
          disclosure.getBoundingClientRect().right <= viewport + 0.5,
        explanationContained: explanation.getBoundingClientRect().left >= -0.5 &&
          explanation.getBoundingClientRect().right <= viewport + 0.5,
        tableContained: Boolean(regionRect && regionRect.left >= -0.5 && regionRect.right <= viewport + 0.5 &&
          tableRegion.scrollWidth >= tableRegion.clientWidth),
        explanationVisible: Boolean(explanation?.getClientRects().length),
        explanationStacked: getComputedStyle(explanationSides).gridTemplateColumns.split(' ').length === 1,
        contributorTargetsAtLeast44: [...explanation.querySelectorAll('.dashboard-comparison-contributor-edit')]
          .every(element => element.getBoundingClientRect().height >= 44),
        targetsAtLeast44: targets.length >= 6 && targets.every(element => element.getBoundingClientRect().height >= 44), overflowing };
    })()`);
    assertEvidence(comparisonNarrow.visible && comparisonNarrow.disclosureContained && comparisonNarrow.tableContained &&
      comparisonNarrow.explanationContained &&
      comparisonNarrow.explanationVisible && comparisonNarrow.explanationStacked &&
      comparisonNarrow.contributorTargetsAtLeast44 && comparisonNarrow.targetsAtLeast44,
      `Saved Month Comparison explanation 320px evidence failed: ${JSON.stringify(comparisonNarrow)}`);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'forced-colors', value: 'active' }] });
    const comparisonForcedColors = await evaluate(cdp, `(() => {
      const disclosure = document.getElementById('dashboard-saved-month-comparison');
      const table = disclosure.querySelector('.dashboard-comparison-table');
      const explanation = document.getElementById('dashboard-comparison-explanation');
      const contributor = explanation.querySelector('.dashboard-comparison-contributor');
      const focus = explanation.querySelector('.dashboard-comparison-contributor-edit'); focus.focus();
      return { active: matchMedia('(forced-colors: active)').matches,
        disclosureBoundary: getComputedStyle(disclosure).borderColor !== 'rgba(0, 0, 0, 0)',
        tableBoundary: getComputedStyle(table).borderColor !== 'rgba(0, 0, 0, 0)',
        explanationBoundary: getComputedStyle(explanation).borderColor !== 'rgba(0, 0, 0, 0)',
        contributorBoundary: getComputedStyle(contributor).borderColor !== 'rgba(0, 0, 0, 0)',
        focusVisible: !['none', 'hidden'].includes(getComputedStyle(focus).outlineStyle) };
    })()`);
    assertEvidence(comparisonForcedColors.active && comparisonForcedColors.disclosureBoundary &&
      comparisonForcedColors.tableBoundary && comparisonForcedColors.explanationBoundary &&
      comparisonForcedColors.contributorBoundary && comparisonForcedColors.focusVisible,
      `Saved Month Comparison explanation forced-colors evidence failed: ${JSON.stringify(comparisonForcedColors)}`);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print', features: [] });
    const comparisonPrint = await evaluate(cdp, `(() => {
      document.body.classList.add('printing-saved-month-comparison');
      const disclosure = document.getElementById('dashboard-saved-month-comparison');
      const result = { printMedia: matchMedia('print').matches,
        disclosureVisible: getComputedStyle(disclosure).display !== 'none',
        controlsHidden: getComputedStyle(document.getElementById('dashboard-saved-month-comparison-form')).display === 'none',
        contextVisible: getComputedStyle(disclosure.querySelector('.dashboard-comparison-context')).display !== 'none',
        tableVisible: getComputedStyle(disclosure.querySelector('.dashboard-comparison-table')).display !== 'none',
        explanationHidden: getComputedStyle(document.getElementById('dashboard-comparison-explanation')).display === 'none' };
      document.body.classList.remove('printing-saved-month-comparison'); return result;
    })()`);
    assertEvidence(comparisonPrint.printMedia && comparisonPrint.disclosureVisible && comparisonPrint.controlsHidden &&
      comparisonPrint.contextVisible && comparisonPrint.tableVisible && comparisonPrint.explanationHidden,
      `Saved Month Comparison explanation print evidence failed: ${JSON.stringify(comparisonPrint)}`);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'forced-colors', value: 'none' }] });
    scenario.savedMonthComparisonNarrowForcedColorsPrint = true;
    await evaluate(cdp, `(async () => {
      App.switchView('dashboard'); const queue = document.getElementById('dashboard-review-queue'); queue.open = true;
      DashboardView.renderMonthReviewQueue();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    const reviewNavigationNarrow = await evaluate(cdp, `(() => {
      const queue = document.getElementById('dashboard-review-queue'); const viewport = document.documentElement.clientWidth;
      const visibleTargets = [...queue.querySelectorAll('summary, button')]
        .filter(element => element.getClientRects().length);
      const overflowing = [...queue.querySelectorAll('*')].filter(element => {
        if (!element.getClientRects().length) return false; const rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > viewport + 0.5;
      });
      return { visible: Boolean(queue.getClientRects().length), noPageOverflow: document.documentElement.scrollWidth <= viewport,
        noQueueOverflow: overflowing.length === 0,
        targetsAtLeast44: visibleTargets.length > 0 && visibleTargets.every(element => element.getBoundingClientRect().height >= 44) };
    })()`);
    assertEvidence(reviewNavigationNarrow.visible && reviewNavigationNarrow.noPageOverflow &&
      reviewNavigationNarrow.noQueueOverflow && reviewNavigationNarrow.targetsAtLeast44,
      `Review Navigation 320px evidence failed: ${JSON.stringify(reviewNavigationNarrow)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const reviewNavigationForcedColors = await evaluate(cdp, `(() => {
      const queue = document.getElementById('dashboard-review-queue'); const card = queue.querySelector('.dashboard-review-item');
      const focus = queue.querySelector('[data-review-kind]') || queue.querySelector('summary'); focus.focus();
      return { active: matchMedia('(forced-colors: active)').matches,
        queueBoundary: getComputedStyle(queue).borderColor !== 'rgba(0, 0, 0, 0)',
        cardBoundary: !card || getComputedStyle(card).borderColor !== 'rgba(0, 0, 0, 0)',
        focusVisible: !['none', 'hidden'].includes(getComputedStyle(focus).outlineStyle) };
    })()`);
    assertEvidence(reviewNavigationForcedColors.active && reviewNavigationForcedColors.queueBoundary &&
      reviewNavigationForcedColors.cardBoundary && reviewNavigationForcedColors.focusVisible,
      `Review Navigation forced-colors evidence failed: ${JSON.stringify(reviewNavigationForcedColors)}`);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print', features: [] });
    const reviewNavigationPrint = await evaluate(cdp, `(() => {
      const queue = document.getElementById('dashboard-review-queue');
      return { printMedia: matchMedia('print').matches, hidden: getComputedStyle(queue).display === 'none' };
    })()`);
    assertEvidence(reviewNavigationPrint.printMedia && reviewNavigationPrint.hidden,
      `Review Navigation print evidence failed: ${JSON.stringify(reviewNavigationPrint)}`);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'forced-colors', value: 'none' }] });
    scenario.reviewNavigationNarrowTargetsForcedColorsPrint = true;
    await evaluate(cdp, `App.switchView('budget')`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    const monthlyReviewNarrow = await evaluate(cdp, `(() => {
      const review = document.getElementById('monthly-review-container'); const viewport = document.documentElement.clientWidth;
      const overflowing = [...review.querySelectorAll('*')].filter(el => {
        if (!el.getClientRects().length) return false; const rect = el.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > viewport + 0.5;
      }).map(el => ({ tag: el.tagName, id: el.id, className: String(el.className || '') })).slice(0, 20);
      const expenseNamesClean = [...document.querySelectorAll('.expense-table .col-name')].every(cell =>
        !cell.querySelector('.record-marker, .expense-date') && !cell.textContent.includes('Needs allocation'));
      return { visible: Boolean(review.getClientRects().length), cards: review.querySelectorAll('.monthly-review-group').length,
        metrics: review.querySelectorAll('.monthly-review-metric').length, drilldowns: review.querySelectorAll('details').length,
        fundingPrompt: review.querySelector('.monthly-review-funding-alert')?.textContent || '',
        removedTiles: !review.querySelector('#monthly-review-recurring-heading, #monthly-review-funding-heading'), expenseNamesClean,
        exceptionsVisible: review.textContent.includes('Recurring exceptions') || Boolean(review.querySelector('[data-exception-action]')),
        overflowing, pageWidth: document.documentElement.scrollWidth, viewport };
    })()`);
    assertEvidence(monthlyReviewNarrow.visible && monthlyReviewNarrow.cards >= 4 && monthlyReviewNarrow.metrics >= 7 &&
      monthlyReviewNarrow.drilldowns >= 1 && monthlyReviewNarrow.fundingPrompt === '!' && monthlyReviewNarrow.removedTiles && monthlyReviewNarrow.expenseNamesClean && !monthlyReviewNarrow.exceptionsVisible &&
      monthlyReviewNarrow.overflowing.length === 0 && monthlyReviewNarrow.pageWidth <= monthlyReviewNarrow.viewport,
      `Compact Monthly Review evidence failed: ${JSON.stringify(monthlyReviewNarrow)}`);
    const monthlyPaymentGuidance = await evaluate(cdp, `(() => {
      const plan = Store.getPayPeriodPlan(BudgetView.currentMonth); const guidance = document.querySelector('.monthly-review-tile-destinations');
      const fmt = value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const totals = plan.summary.methodFundingTotals; const text = guidance?.textContent || '';
      return { visible: Boolean(guidance?.getClientRects().length), bank: text.includes(fmt(totals.bank)),
        creditCard: text.includes(fmt(totals.credit_card)), savings: text.includes(fmt(totals.savings)),
        investments: text.includes(fmt(totals.investments)), scope: text.includes('No payment or transfer is performed.') };
    })()`);
    assertEvidence(monthlyPaymentGuidance.visible && monthlyPaymentGuidance.bank && monthlyPaymentGuidance.creditCard &&
      monthlyPaymentGuidance.savings && monthlyPaymentGuidance.investments && monthlyPaymentGuidance.scope,
      `Monthly payment guidance did not match assigned funding: ${JSON.stringify(monthlyPaymentGuidance)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const monthlyReviewForcedColors = await evaluate(cdp, `(() => {
      const card = document.querySelector('.monthly-review-group'); const status = document.querySelector('.monthly-review-status');
      const focus = document.querySelector('.monthly-review-drilldown summary') || document.getElementById('monthly-review-heading'); focus?.focus();
      return { active: matchMedia('(forced-colors: active)').matches, cardVisible: Boolean(card?.getClientRects().length),
        cardBorder: card ? getComputedStyle(card).borderColor : '', statusText: status?.textContent || '',
        statusColor: status ? getComputedStyle(status).color : '', focusOutline: focus ? getComputedStyle(focus).outlineStyle : '' };
    })()`);
    assertEvidence(monthlyReviewForcedColors.active && monthlyReviewForcedColors.cardVisible && monthlyReviewForcedColors.cardBorder &&
      monthlyReviewForcedColors.statusText && monthlyReviewForcedColors.statusColor &&
      monthlyReviewForcedColors.focusOutline !== 'none' && monthlyReviewForcedColors.focusOutline !== 'hidden',
      `Forced-colors Monthly Review evidence failed: ${JSON.stringify(monthlyReviewForcedColors)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
    scenario.monthlyReviewCompactNarrowForcedColors = true; scenario.monthlyPaymentGuidance = true;
    await evaluate(cdp, `App.switchView('transfers')`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    const payPeriodNarrow = await evaluate(cdp, `(() => {
      const viewport = document.documentElement.clientWidth; const view = document.getElementById('view-transfers');
      const overflowing = [...document.querySelectorAll('body *')].filter(el => {
        if (!el.getClientRects().length) return false; const rect = el.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > viewport + 0.5;
      }).map(el => ({ tag: el.tagName, id: el.id, className: String(el.className || ''),
        left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })).slice(0, 20);
      const controls = [...view.querySelectorAll('button:not([hidden]), input:not([hidden]), select')];
      return { active: view.classList.contains('active'), width: document.documentElement.scrollWidth, viewport, overflowing,
        controlsFit: controls.every(el => el.getBoundingClientRect().width <= viewport), cards: view.querySelectorAll('.pay-period-card').length };
    })()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 1, mobile: false });
    const payPeriodReflow200Percent = await evaluate(cdp, `({ width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth, active: document.getElementById('view-transfers').classList.contains('active') })`);
    assertEvidence(payPeriodNarrow.active && payPeriodNarrow.cards >= 2 && payPeriodNarrow.width <= payPeriodNarrow.viewport &&
      payPeriodNarrow.overflowing.length === 0 && payPeriodNarrow.controlsFit,
      `Pay periods overflows at 320px: ${JSON.stringify(payPeriodNarrow)}`);
    assertEvidence(payPeriodReflow200Percent.active && payPeriodReflow200Percent.width <= payPeriodReflow200Percent.viewport,
      `Pay periods overflows at the 200% browser-zoom-equivalent viewport: ${JSON.stringify(payPeriodReflow200Percent)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const payPeriodForcedColors = await evaluate(cdp, `(() => {
      const card = document.querySelector('.pay-period-card'); const state = card?.querySelector('.pay-period-state');
      const focus = card?.querySelector('.pay-period-bill-pill'); focus?.focus();
      return { active: matchMedia('(forced-colors: active)').matches, cardVisible: Boolean(card?.getClientRects().length),
        cardBorder: card ? getComputedStyle(card).borderColor : '', stateVisible: Boolean(state?.getClientRects().length),
        stateColor: state ? getComputedStyle(state).color : '', focusOutline: focus ? getComputedStyle(focus).outlineStyle : '' };
    })()`);
    assertEvidence(payPeriodForcedColors.active && payPeriodForcedColors.cardVisible && payPeriodForcedColors.stateVisible &&
      payPeriodForcedColors.cardBorder !== 'rgba(0, 0, 0, 0)' && payPeriodForcedColors.stateColor &&
      payPeriodForcedColors.focusOutline !== 'none' && payPeriodForcedColors.focusOutline !== 'hidden',
      `Forced-colors Pay periods evidence failed: ${JSON.stringify(payPeriodForcedColors)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
    scenario.payPeriodsNarrowReflowForcedColors = true;
    await evaluate(cdp, `App.switchView('data-health')`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    const narrow = await evaluate(cdp, `(() => {
      const viewport = document.documentElement.clientWidth;
      const overflowing = [...document.querySelectorAll('body *')].map(el => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName, id: el.id, className: String(el.className || ''), left: rect.left, right: rect.right, width: rect.width };
      }).filter(item => item.left < -0.5 || item.right > viewport + 0.5).slice(0, 20);
      const roots = [...document.body.children].map(el => ({ tag: el.tagName, id: el.id,
        className: String(el.className || ''), left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
      const shellChildren = [...document.getElementById('application-shell').children].map(el => ({ tag: el.tagName, id: el.id,
        className: String(el.className || ''), left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
      const viewChildren = [...document.querySelector('.view.active').children].map(el => ({ tag: el.tagName, id: el.id,
        className: String(el.className || ''), left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
      return { width: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewport, roots, shellChildren, viewChildren, overflowing,
        controls: [...document.querySelectorAll('button:not([hidden]), input:not([hidden]), select')].every(el => el.getBoundingClientRect().width <= viewport) };
    })()`);
    // Halving the original 1280 CSS-pixel viewport exercises the same layout
    // width available at 200% browser zoom without relying on pinch/page scale.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 1, mobile: false });
    const reflow200Percent = await evaluate(cdp, `({ width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth })`);
    assertEvidence(narrow.width <= narrow.viewport, `Page overflows at 320px: ${JSON.stringify(narrow)}`);
    assertEvidence(narrow.controls, `A visible form control is wider than the 320px viewport: ${JSON.stringify(narrow)}`);
    assertEvidence(reflow200Percent.width <= reflow200Percent.viewport, 'Page overflows at the 200% browser-zoom-equivalent viewport.');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const forcedColors = await evaluate(cdp, `(() => {
      const section = document.querySelector('.data-health-section'); const focus = document.getElementById('nav-data-health'); focus.focus();
      return { active: matchMedia('(forced-colors: active)').matches, sectionVisible: Boolean(section?.getClientRects().length),
        sectionBorder: section ? getComputedStyle(section).borderColor : '', focusOutline: getComputedStyle(focus).outlineStyle };
    })()`);
    assertEvidence(forcedColors.active && forcedColors.sectionVisible && forcedColors.sectionBorder !== 'rgba(0, 0, 0, 0)' &&
      forcedColors.focusOutline !== 'none' && forcedColors.focusOutline !== 'hidden',
      `Forced-colors Data Health evidence failed: ${JSON.stringify(forcedColors)}`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
    await cdp.send('Page.reload', { ignoreCache: true }); await new Promise(resolve => setTimeout(resolve, 700));
    const reload = await evaluate(cdp, `(() => {
      App.switchView('budget'); BudgetView.render();
      const checkbox = [...document.querySelectorAll('[data-cleared-kind="income"][data-record-id]')]
        .find(input => input.dataset.recordId === ${JSON.stringify(scenario.clearedRecordId)});
      return { schemaVersion: Store.getStatus().residentSchemaVersion,
        additions: Store.previewRecurringMonth(BudgetView.currentMonth).counts.additions,
        cleared: Store.getClearedChecklist(BudgetView.currentMonth).items.income
          .find(item => item.recordId === ${JSON.stringify(scenario.clearedRecordId)})?.cleared,
        nativeChecked: checkbox?.type === 'checkbox' && checkbox.checked };
    })()`);
    assertEvidence(reload.schemaVersion === 5 && reload.additions === 0 && reload.cleared && reload.nativeChecked,
      `Reload did not preserve v5 Manual Cleared state: ${JSON.stringify(reload)}`);
    await evaluate(cdp, `localStorage.setItem(ZeroBudgetStore.STORAGE_KEY, ${JSON.stringify(scenario.blockedV3Bytes)})`);
    await cdp.send('Page.reload', { ignoreCache: true }); await new Promise(resolve => setTimeout(resolve, 700));
    const blocked = await evaluate(cdp, `(() => {
      App.switchView('data-health'); const before = localStorage.getItem(ZeroBudgetStore.STORAGE_KEY); DataHealthView.render();
      const section = document.querySelector('.exact-money-migration');
      const result = { state: Store.getExactMoneyMigrationSummary().state,
        residentSchemaVersion: Store.getStatus().residentSchemaVersion,
        actionAbsent: !document.getElementById('review-exact-money-migration'),
        usable: document.getElementById('application-shell').hidden === false && section?.textContent.includes('remains usable'),
        byteExact: localStorage.getItem(ZeroBudgetStore.STORAGE_KEY) === before,
        plannedAmount: Store.getMonth(${JSON.stringify(scenario.month)}).paychecks[0].plannedAmount };
      Store.getDataHealth(); result.byteExact = result.byteExact && localStorage.getItem(ZeroBudgetStore.STORAGE_KEY) === before; return result;
    })()`);
    assertEvidence(blocked.state === 'blocked' && blocked.residentSchemaVersion === 3 && blocked.actionAbsent &&
      blocked.usable && blocked.byteExact && blocked.plannedAmount === 321.001,
      `Blocked sub-cent v3 evidence failed: ${JSON.stringify(blocked)}`);
    scenario.exactMoneyBlockedSubCentWriteFreeUsable = true;
    const multiTab = await evaluate(cdp, `(() => {
      const primaryKey = ZeroBudgetStore.STORAGE_KEY || Store.STORAGE_KEY;
      const lockKey = ZeroBudgetStore.WRITE_LOCK_KEY || Store.WRITE_LOCK_KEY || 'zeroBudget_write_lock';
      const monthKey = BudgetView.currentMonth;
      const before = localStorage.getItem(primaryKey);
      localStorage.setItem(lockKey, JSON.stringify({ ownerId: 'other-tab', expiresAt: Date.now() + 60000 }));
      let busy = false;
      try {
        Store.updateAllocation(monthKey, 'savings', (Store.getMonth(monthKey).allocations.savings || 0) + 1);
      } catch (error) { busy = error?.code === 'STORE_BUSY'; }
      localStorage.removeItem(lockKey);
      const external = JSON.parse(before);
      external.months[monthKey].allocations.savings += 2;
      localStorage.setItem(primaryKey, JSON.stringify(external));
      let stale = false;
      try {
        Store.updateAllocation(monthKey, 'savings', external.months[monthKey].allocations.savings + 1);
      } catch (error) { stale = error?.code === 'STALE_WRITE'; }
      const reload = Store.reload();
      return { busy, stale, reloadChanged: reload.changed,
        byteExact: localStorage.getItem(primaryKey) === JSON.stringify(external),
        recovered: Store.getMonth(monthKey).allocations.savings === external.months[monthKey].allocations.savings };
    })()`);
    assertEvidence(multiTab.busy && multiTab.stale && multiTab.reloadChanged && multiTab.byteExact && multiTab.recovered,
      `Multi-tab stale or busy write did not fail closed and recover by reload: ${JSON.stringify(multiTab)}`);
    scenario.multiTabStaleBusyReloadRecovery = true;
    const shardedMigration = await evaluate(cdp, `(async () => {
      App.switchView('data-health'); DataHealthView.render();
      const primaryKey = ZeroBudgetStore.STORAGE_KEY || Store.STORAGE_KEY;
      const allBytes = () => JSON.stringify(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
      const beforePreview = allBytes();
      const trigger = document.getElementById('review-month-sharded-storage');
      if (!trigger) return { available: false };
      trigger.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const previewWriteFree = beforePreview === allBytes();
      const cancel = document.getElementById('modal-cancel');
      const cancelFocused = document.activeElement === cancel;
      cancel.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const cancelWriteFree = beforePreview === allBytes() && document.activeElement === trigger;
      trigger.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getElementById('modal-save').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rootRaw = localStorage.getItem(primaryKey);
      const rootPointer = rootRaw ? JSON.parse(rootRaw) : null;
      const manifestRaw = rootPointer ? localStorage.getItem(rootPointer.manifestKey) : null;
      const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
      const referencesResolve = Boolean(manifest && localStorage.getItem(manifest.global.key) &&
        manifest.monthOrder.every(monthKey => localStorage.getItem(manifest.months[monthKey].key)));
      const referencesValidate = Boolean(referencesResolve &&
        ZeroBudgetStorageEngine.validateGlobalReference(manifest.global, localStorage.getItem(manifest.global.key)) &&
        manifest.monthOrder.every(monthKey => ZeroBudgetStorageEngine.validateMonthReference(
          manifest.months[monthKey], localStorage.getItem(manifest.months[monthKey].key))));
      sessionStorage.setItem('browser-evidence-sharded-bytes', allBytes());
      sessionStorage.setItem('browser-evidence-sharded-semantic', JSON.stringify(Store.getData()));
      return { available: true, previewWriteFree, cancelFocused, cancelWriteFree,
        rootKeyFrozen: primaryKey === 'zeroBudget_data',
        rootPresent: rootPointer !== null,
        migrated: rootPointer?.format === 'zerobudget-active-layout' && rootPointer.layout === 'month-sharded' &&
          rootPointer.manifestKey === 'zeroBudget_manifest:' + rootPointer.generation,
        referencesResolve, referencesValidate,
        summaryActive: Store.getStatus().state === 'ready' &&
          Store.getShardedPersistenceSummary().state === 'already-sharded' };
    })()`);
    assertEvidence(shardedMigration.available && shardedMigration.previewWriteFree && shardedMigration.cancelFocused &&
      shardedMigration.cancelWriteFree && shardedMigration.rootKeyFrozen && shardedMigration.rootPresent &&
      shardedMigration.migrated && shardedMigration.referencesResolve && shardedMigration.referencesValidate &&
      shardedMigration.summaryActive, `Month-sharded migration evidence failed: ${JSON.stringify(shardedMigration)}`);
    scenario.shardedMigrationPreviewNoWriteCancelConfirm = true;
    await cdp.send('Page.reload', { ignoreCache: true }); await new Promise(resolve => setTimeout(resolve, 700));
    const shardedReloadRecovery = await evaluate(cdp, `(() => {
      const primaryKey = ZeroBudgetStore.STORAGE_KEY || Store.STORAGE_KEY;
      const corruptKey = ZeroBudgetStore.CORRUPT_KEY || Store.CORRUPT_KEY || 'zeroBudget_corrupt';
      const rootPointer = JSON.parse(localStorage.getItem(primaryKey));
      const manifest = JSON.parse(localStorage.getItem(rootPointer.manifestKey));
      const monthShardKey = manifest.months[manifest.monthOrder[0]].key;
      const snapshots = Store.listSnapshots();
      const safety = snapshots.find(snapshot => snapshot.reason === 'pre-sharding');
      const reloadActive = Store.getShardedPersistenceSummary().state === 'already-sharded';
      const allBytes = () => JSON.stringify(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
      const reloadByteExact = allBytes() === sessionStorage.getItem('browser-evidence-sharded-bytes');
      const reloadSemanticExact = JSON.stringify(Store.getData()) ===
        sessionStorage.getItem('browser-evidence-sharded-semantic');
      localStorage.setItem(monthShardKey, '{corrupt-browser-evidence');
      const damaged = Store.reload();
      const evidenceRaw = Store.getCorruptEvidence();
      const evidence = evidenceRaw ? JSON.parse(evidenceRaw) : null;
      const recoveryRequired = damaged.state === 'recovery-required' &&
        evidence?.format === 'zerobudget-corrupt-evidence' && evidence.layout === 'month-sharded' &&
        evidence.rootRaw === localStorage.getItem(primaryKey) && evidence.manifestKey === rootPointer.manifestKey &&
        evidence.failingKey === monthShardKey && evidence.failingRaw === '{corrupt-browser-evidence' &&
        localStorage.getItem(corruptKey) === null;
      Store.restoreSnapshot(safety.id);
      const restored = Store.getStatus().state === 'ready' && Store.getShardedPersistenceSummary().state === 'available';
      const preview = Store.previewShardedPersistenceMigration(); Store.commitShardedPersistenceMigration(preview);
      return { reloadActive, reloadByteExact, reloadSemanticExact, recoveryRequired, restored,
        remigrated: Store.getShardedPersistenceSummary().state === 'already-sharded' };
    })()`);
    assertEvidence(shardedReloadRecovery.reloadActive && shardedReloadRecovery.reloadByteExact &&
      shardedReloadRecovery.reloadSemanticExact && shardedReloadRecovery.recoveryRequired &&
      shardedReloadRecovery.restored && shardedReloadRecovery.remigrated,
      `Sharded reload or recovery evidence failed: ${JSON.stringify(shardedReloadRecovery)}`);
    scenario.shardedReloadCorruptionEvidenceSnapshotRecovery = true;
    const purge = await evaluate(cdp, `(async () => {
      App.switchView('data-health'); DataHealthView.render();
      const primaryKey = ZeroBudgetStore.STORAGE_KEY || Store.STORAGE_KEY;
      const corruptKey = ZeroBudgetStore.CORRUPT_KEY || Store.CORRUPT_KEY || 'zeroBudget_corrupt';
      const lockKey = ZeroBudgetStore.WRITE_LOCK_KEY || Store.WRITE_LOCK_KEY || 'zeroBudget_write_lock';
      const snapshotKeys = ['zeroBudget_snapshot:browser-evidence-a', 'zeroBudget_snapshot:browser-evidence-b'];
      const orphanedShardingKeys = ['zeroBudget_manifest:orphan-browser-evidence',
        'zeroBudget_global:orphan-browser-evidence',
        'zeroBudget_month:orphan-browser-evidence:1999-01', 'zeroBudget_journal'];
      const trigger = document.getElementById('review-local-data-purge');
      const before = localStorage.getItem(primaryKey);
      const snapshotCountBefore = Object.keys(localStorage).filter(key => key.startsWith('zeroBudget_snapshot:')).length;
      localStorage.setItem(corruptKey, 'browser-evidence');
      snapshotKeys.forEach(key => localStorage.setItem(key, before));
      orphanedShardingKeys.forEach(key => localStorage.setItem(key, 'orphan-browser-evidence'));
      localStorage.setItem(lockKey, JSON.stringify({ ownerId: 'purge-evidence', expiresAt: Date.now() - 1000 }));
      const preview = Store.previewLocalDataPurge();
      trigger.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dialog = document.getElementById('modal-overlay');
      const body = document.getElementById('modal-body');
      const cancel = document.getElementById('modal-cancel');
      const save = document.getElementById('modal-save');
      const cancelFocused = document.activeElement === cancel;
      const modalOpen = !dialog.hidden && body.children.length > 0 && !body.querySelector('img') &&
        body.textContent.includes('Purge removes the active budget');
      cancel.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const cancelRestored = document.activeElement === trigger && localStorage.getItem(primaryKey) === before;
      App.switchView('budget'); BudgetView.render();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      trigger.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      save.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 50));
      const purgeRemoved = localStorage.getItem(primaryKey) === null && localStorage.getItem(corruptKey) === null &&
        snapshotKeys.every(key => localStorage.getItem(key) === null) &&
        orphanedShardingKeys.every(key => localStorage.getItem(key) === null) &&
        !Object.keys(localStorage).some(key => key.startsWith('zeroBudget_manifest:') ||
          key.startsWith('zeroBudget_global:') || key.startsWith('zeroBudget_month:')) &&
        localStorage.getItem(lockKey) === null;
      const focusRestored = document.activeElement.id === 'current-month-label' || document.activeElement.id === 'recovery-title';
      return { previewed: preview.activeDataPresent && preview.corruptEvidencePresent &&
        preview.snapshotCount === snapshotCountBefore + snapshotKeys.length &&
        preview.lockPresent, cancelFocused, modalOpen, cancelRestored, purgeRemoved, focusRestored };
    })()`);
    assertEvidence(purge.previewed && purge.cancelFocused && purge.modalOpen && purge.cancelRestored &&
      purge.purgeRemoved && purge.focusRestored,
      `Local-data purge did not preserve focus or remove exact keys: ${JSON.stringify(purge)}`);
    scenario.cspSafeNodeModal = true;
    scenario.purgeCancelConfirmFocusExactRemoval = true;
    delete scenario.blockedV3Bytes; delete scenario.clearedRecordId;
    const errors = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'));
    assertEvidence(errors.length === 0, 'Console or page exceptions were captured.');
    const publicScenario = Object.fromEntries(Object.entries(scenario)
      .filter(([, value]) => typeof value === 'boolean'));
    evidence = { passed: true, disposableProfile: true, scenario: publicScenario,
      checks: { expenseDeleteEscape: true, monthlyReviewResponsive: true, payPeriodsResponsive: true,
        reviewNavigationResponsive: true, dataHealthResponsive: true, reloadPersistence: true,
        blockedLedgerSafety: true, noConsoleErrors: true } };
  } finally {
    cdp?.close();
    await stopBrowser(child);
    await removeDisposableProfile(profile);
  }
  assertEvidence(!fs.existsSync(profile), 'Disposable Chromium profile cleanup failed.');
  evidence.profileCleanup = true;
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

function assertEvidence(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const evidence = await run(options); console.log(`Browser evidence passed: ${options.output}`); console.log(JSON.stringify(evidence.scenario));
}

function helpText() {
  return 'Usage: npm run test:browser -- [--output PATH]\nUses synthetic data in a disposable Chromium profile; defaults evidence to the OS temp directory.';
}

module.exports = { parseArgs, locateChromium, helpText, removeDisposableProfile, run };
if (require.main === module) main().catch(error => { console.error(`Browser evidence failed: ${error.message}`); process.exitCode = 1; });
