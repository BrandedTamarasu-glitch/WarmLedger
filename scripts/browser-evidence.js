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
  localStorage.clear(); Store.startFresh(); App.enterApplication('', 'ready');
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
  App.refreshAllViews();

  const previewTrigger = document.getElementById('btn-preview-recurring');
  const passiveBefore = localStorage.getItem('zeroBudgetData'); previewTrigger.click(); await settle();
  const previewDialog = document.getElementById('recurring-preview-dialog');
  assert(previewDialog.open, 'Recurring preview did not open.');
  assert(document.activeElement.id === 'recurring-preview-cancel', 'Recurring preview did not focus Cancel.');
  assert(localStorage.getItem('zeroBudgetData') === passiveBefore, 'Opening recurring preview changed storage bytes.');
  previewDialog.close('cancel'); await settle();
  assert(document.activeElement === previewTrigger, 'Cancel did not restore preview-trigger focus.');
  assert(localStorage.getItem('zeroBudgetData') === passiveBefore, 'Cancel changed storage bytes.');

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

  Store.deleteExpense(month, generated.expenses[0].id); BudgetView.render(); await settle();
  const allow = document.querySelector('[data-exception-action="allow-again"]');
  assert(allow, 'Allow-again control is missing after generated deletion.');
  const allowPassive = localStorage.getItem('zeroBudgetData'); allow.click(); await settle();
  const allowDialog = document.getElementById('unsuppress-dialog');
  assert(allowDialog.open && document.activeElement.id === 'unsuppress-cancel', 'Allow-again dialog focus is incorrect.');
  assert(localStorage.getItem('zeroBudgetData') === allowPassive, 'Opening Allow-again changed storage bytes.');
  allowDialog.close('cancel'); await settle(); assert(localStorage.getItem('zeroBudgetData') === allowPassive, 'Allow-again Cancel changed bytes.');
  document.querySelector('[data-exception-action="allow-again"]').click(); await settle(); allowDialog.close('confirm'); await settle();
  assert(previewDialog.open, 'Confirmed Allow-again did not hand off to recurring preview.');
  assert(document.activeElement.id === 'recurring-preview-cancel', 'Allow-again preview handoff did not focus Cancel.');
  previewDialog.close('confirm'); await settle();

  const backup = Store.exportData(); const importBytes = localStorage.getItem('zeroBudgetData');
  const importPreview = Store.previewImport(backup);
  assert(localStorage.getItem('zeroBudgetData') === importBytes, 'Backup preview changed storage bytes.');
  Store.commitImport(importPreview); assert(localStorage.getItem('zeroBudgetData') === importBytes, 'No-op backup restore changed bytes.');
  const rerun = Store.previewRecurringMonth(month); assert(rerun.counts.additions === 0, 'Recurring apply was not idempotent.');
  return { month, passiveActionsByteExact: true, monthlyReviewEdit: true, allowAgain: true,
    previewCancelApply: true, backupRoundTrip: true, generatedIncome: Store.getMonth(month).paychecks.length,
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
    await cdp.send('Page.reload', { ignoreCache: true }); await new Promise(resolve => setTimeout(resolve, 700));
    const reload = await evaluate(cdp, `({ schemaVersion: Store.getData().schemaVersion,
      additions: Store.previewRecurringMonth(BudgetView.currentMonth).counts.additions })`);
    assertEvidence(reload.schemaVersion === 3 && reload.additions === 0, 'Reload did not preserve canonical/idempotent state.');
    const errors = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'));
    assertEvidence(errors.length === 0, 'Console or page exceptions were captured.');
    evidence = { passed: true, browser, disposableProfile: true, scenario, narrow,
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
