'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

class Node {
  constructor(id = '') { this.id = id; this.open = false; this.returnValue = ''; this.textContent = ''; this.dataset = {}; this.isConnected = true; }
  addEventListener() {}
  showModal() { this.open = true; }
  focus() { this.focused = true; }
}

function harness({ deferFrames = false } = {}) {
  const ids = Object.fromEntries([
    'unsuppress-dialog', 'unsuppress-cancel', 'unsuppress-summary', 'btn-preview-recurring',
    'monthly-review-exceptions-heading', 'monthly-review-recurring-heading', 'app-error', 'app-status', 'modal-overlay', 'last-saved'
  ].map(id => [id, new Node(id)]));
  ids['modal-overlay'].style = { display: 'none' }; ids['app-error'].hidden = true;
  const twinOne = { kind: 'income', sourceTemplateId: 'template', occurrenceKey: '2026-03-31#0001', scheduledDate: '2026-03-31', ordinal: 1, templateName: '<Renamed>', templateState: 'active', eligible: true };
  const twinTwo = { ...twinOne, occurrenceKey: '2026-03-31#0002', ordinal: 2 };
  let rows = [twinOne, twinTwo]; const calls = []; let generation = 1;
  const Store = {
    getSuppressedOccurrences: () => rows,
    unsuppressOccurrence: (...args) => { calls.push(args); generation += 1; return {}; },
    getStatus: () => ({ generation, warnings: [] })
  };
  const document = {
    addEventListener() {}, getElementById: id => ids[id] || null,
    querySelectorAll: () => []
  };
  const BudgetView = { currentMonth: '2026-03' };
  const frames = [];
  const context = vm.createContext({ document, Store, BudgetView,
    requestAnimationFrame: callback => deferFrames ? frames.push(callback) : callback(), Date, console });
  vm.runInContext(`${source}\n;globalThis.ExportedApp = App;`, context, { filename: 'app.js' });
  return { app: context.ExportedApp, ids, Store, BudgetView, twinOne, twinTwo, calls,
    flushFrames: () => { while (frames.length) frames.shift()(); }, setRows: value => { rows = value; } };
}

test('native Cancel-first dialog is labelled, described, and contains the frozen warning', () => {
  assert.match(html, /id="unsuppress-dialog"[^>]*aria-labelledby="unsuppress-title"[^>]*aria-describedby="unsuppress-warning"/);
  assert.ok(html.indexOf('id="unsuppress-cancel"') < html.indexOf('id="unsuppress-confirm"'));
  assert.match(html, /id="unsuppress-cancel"[^>]*autofocus/);
  assert.match(html, /Allowing again removes this exception\. It does not restore or create a record\. Current template values may differ\. Use Preview recurring items next to review what will be generated\./);
  assert.match(styles, /\.unsuppress-dialog \.btn \{ min-height: 44px/);
  assert.match(styles, /\.restore-dialog[\s\S]*?max-height: calc\(100dvh - 2rem\)/);
});

test('open captures only scalar twin identity, uses safe text, and guards reentrancy', () => {
  const { app, ids, twinOne, twinTwo } = harness(); const trigger = new Node('origin');
  app.openUnsuppressDialog(twinTwo, trigger);
  assert.deepEqual({ ...app.unsuppressContext, trigger: undefined }, {
    monthKey: '2026-03', sourceTemplateId: 'template', occurrenceKey: '2026-03-31#0002',
    scheduledDate: '2026-03-31', ordinal: 2, templateName: '<Renamed>', trigger: undefined
  });
  assert.equal(ids['unsuppress-summary'].textContent, '<Renamed> — 2026-03-31, occurrence 2.');
  app.openUnsuppressDialog(twinOne, new Node('other'));
  assert.equal(app.unsuppressContext.occurrenceKey, twinTwo.occurrenceKey); assert.equal(ids['unsuppress-cancel'].focused, true);
});

test('Cancel and Escape-style close clear context before branching and perform zero Store calls', () => {
  for (const returnValue of ['cancel', '']) {
    const { app, ids, twinOne, calls } = harness(); const trigger = new Node('origin');
    app.openUnsuppressDialog(twinOne, trigger); ids['unsuppress-dialog'].returnValue = returnValue;
    app.onUnsuppressDialogClose();
    assert.equal(app.unsuppressContext, null); assert.equal(calls.length, 0); assert.equal(trigger.focused, true);
  }
});

test('Confirm unsuppresses the captured twin, refreshes, reports no record, and opens only the existing preview path', () => {
  const { app, ids, twinTwo, calls } = harness(); const trigger = new Node('origin'); let refreshed = 0; let status; let preview;
  app.refreshAllViews = () => { refreshed += 1; trigger.isConnected = false; };
  app.announceStatus = message => { status = message; };
  app.openRecurringPreview = (button, options) => { preview = { button, options }; return true; };
  app.openUnsuppressDialog(twinTwo, trigger); ids['unsuppress-dialog'].returnValue = 'confirm'; app.onUnsuppressDialogClose();
  assert.deepEqual(calls, [['2026-03', 'template', '2026-03-31#0002']]); assert.equal(refreshed, 1);
  assert.equal(status, 'This recurring occurrence can be generated again; no record was added.');
  assert.equal(preview.button, ids['btn-preview-recurring']); assert.deepEqual({ ...preview.options }, { afterUnsuppress: true });
  const handler = source.slice(source.indexOf('  onUnsuppressDialogClose()'), source.indexOf('  restoreUnsuppressFocus('));
  assert.doesNotMatch(handler, /applyRecurringPreview|previewRecurringMonth/);
  assert.match(source, /onRecurringPreviewClose\(\)[\s\S]*Store\.applyRecurringPreview\(preview\)/);
});

test('month change suppresses preview handoff and stale or failed paths stay truthful', () => {
  const h = harness(); let previewed = false; let status; h.app.refreshAllViews = () => {};
  h.app.announceStatus = message => { status = message; }; h.app.openRecurringPreview = () => { previewed = true; };
  const trigger = new Node('origin'); h.app.openUnsuppressDialog(h.twinOne, trigger); h.BudgetView.currentMonth = '2026-04';
  h.ids['unsuppress-dialog'].returnValue = 'confirm'; h.app.onUnsuppressDialogClose();
  assert.equal(previewed, false); assert.match(status, /can be generated again; no record was added/);

  const stale = harness(); let code; stale.setRows([]); stale.app.showErrorCode = value => { code = value; };
  stale.app.openUnsuppressDialog(stale.twinOne, new Node('stale'));
  assert.equal(code, 'SUPPRESSED_OCCURRENCE_NOT_FOUND'); assert.equal(stale.app.unsuppressContext, null);

  const failed = harness(); let refreshed = 0; let shown;
  failed.Store.unsuppressOccurrence = () => { const error = new Error('private'); error.code = 'PRIMARY_WRITE_FAILED'; throw error; };
  failed.app.refreshAllViews = () => { refreshed += 1; }; failed.app.showError = error => { shown = error.code; };
  failed.app.openUnsuppressDialog(failed.twinOne, new Node('failure'));
  failed.ids['unsuppress-dialog'].returnValue = 'confirm'; failed.app.onUnsuppressDialogClose();
  assert.equal(shown, 'PRIMARY_WRITE_FAILED'); assert.equal(refreshed, 0);
});

test('queued preview handoff rechecks month immediately before opening', () => {
  const h = harness({ deferFrames: true }); let previewed = false; const origin = new Node('origin');
  h.app.refreshAllViews = () => { origin.isConnected = false; }; h.app.announceStatus = () => {};
  h.app.openRecurringPreview = () => { previewed = true; };
  h.app.openUnsuppressDialog(h.twinOne, origin);
  h.ids['unsuppress-dialog'].returnValue = 'confirm'; h.app.onUnsuppressDialogClose();
  assert.equal(previewed, false);
  h.BudgetView.currentMonth = '2026-04'; h.flushFrames();
  assert.equal(previewed, false);
  assert.equal(h.ids['monthly-review-exceptions-heading'].focused, true);
});

test('integration uses redacted errors and no dynamic HTML sink', () => {
  for (const code of ['SUPPRESSED_OCCURRENCE_NOT_FOUND', 'SUPPRESSED_OCCURRENCE_INELIGIBLE', 'UNSUPPRESS_PREVIEW_FAILED', 'MONTH_NOT_FOUND', 'PRIMARY_WRITE_FAILED']) {
    assert.match(source, new RegExp(`${code}:`));
  }
  const start = source.indexOf('  openUnsuppressDialog('); const end = source.indexOf('  showModal(', start);
  const flow = source.slice(start, end);
  assert.doesNotMatch(flow, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(flow, /unsuppress-summary'\)\.textContent/);
});
