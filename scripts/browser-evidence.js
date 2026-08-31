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
  const healthCheck = [...document.querySelectorAll('.actual-resolution-row input[type="checkbox"]')]
    .find(input => input.dataset.recordId === hostile.id);
  assert(healthCheck && !healthCheck.checked, 'Missing-actual choice was not default-unselected.');
  healthCheck.click(); const amount = document.getElementById(healthCheck.id.replace('resolve-actual-', 'resolve-amount-'));
  amount.value = '0'; const resolutionForm = healthCheck.closest('form'); resolutionForm.requestSubmit(); await settle();
  const resolutionDialog = document.getElementById('actual-resolution-dialog');
  assert(resolutionDialog.open && document.activeElement.id === 'actual-resolution-cancel', 'Actual preview did not focus Cancel.');
  assert(localStorage.getItem(primaryKey) === healthBefore, 'Actual preview changed bytes.');
  document.getElementById('actual-resolution-cancel').click(); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === hostile.id).actualAmount === null, 'Actual preview Cancel applied a value.');
  assert(localStorage.getItem(primaryKey) === healthBefore, 'Actual preview Cancel changed bytes.');
  resolutionForm.requestSubmit(); await settle(); document.getElementById('actual-resolution-confirm').click(); await settle();
  assert(Store.getMonth(month).expenses.find(item => item.id === hostile.id).actualAmount === 0, 'Selected actual zero was not applied.');

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
  App.switchView('data-health'); await settle();
  return { month, passiveActionsByteExact: true, monthlyReviewEdit: true, expenseDeleteCancelUndoStale: true,
    generatedTombstoneUndo: true, dataHealthPassiveRoutes: true, actualZeroPreviewCancelApply: true, actualApplyFailureAlertFocus: true,
    compareOnlyNoWrite: true, hostileLabelsSafe: true, recoveryGating: true, restoreInvalidatesUndo: true,
    payPeriodsPassiveByteExact: true, payPeriodsCanonicalActualsFundingStates: true,
    payPeriodsAllocationsReconcileHostileSafe: true, payPeriodsExactCanonicalCollapsedRoutes: true,
    payPeriodsFourDigitFunding: true, payPeriodsStaleAndZeroPaycheckRoutes: true,
    previewCancelApply: true, backupRoundTrip: true, dashboardBasisCsvPrintPassive: true,
    dashboardSavedMonthForecastPassive: true,
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
    const reload = await evaluate(cdp, `({ schemaVersion: Store.getData().schemaVersion,
      additions: Store.previewRecurringMonth(BudgetView.currentMonth).counts.additions })`);
    assertEvidence(reload.schemaVersion === 3 && reload.additions === 0, 'Reload did not preserve canonical/idempotent state.');
    const errors = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'));
    assertEvidence(errors.length === 0, 'Console or page exceptions were captured.');
    evidence = { passed: true, browser, disposableProfile: true, scenario, escapeDelete,
      monthlyReviewNarrow, monthlyPaymentGuidance, monthlyReviewForcedColors, payPeriodNarrow, payPeriodForcedColors,
      payPeriodReflow200Percent: { ...payPeriodReflow200Percent, method: '1280px viewport halved to 640 CSS pixels' }, narrow, forcedColors,
      reflow200Percent: { ...reflow200Percent, method: '1280px viewport halved to 640 CSS pixels' }, reload, errors: [] };
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
