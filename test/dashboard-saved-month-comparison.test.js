'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');

function ready(overrides = {}) {
  return Object.freeze({ status: 'ready', basis: 'planned', baselineMonth: '2026-01',
    comparisonMonth: '2026-02', availableMonths: Object.freeze(['2025-12', '2026-01', '2026-02']),
    summaryLabel: '2026-02 compared with 2026-01.', rowModel: Object.freeze({
      columns: Object.freeze(['Section', 'Metric', 'Baseline', 'Comparison', 'Delta', 'Status']),
      rows: Object.freeze([Object.freeze({ Section: 'Summary', Metric: 'Planned income', Baseline: 100,
        Comparison: 125, Delta: 25, Status: 'Complete' })])
    }), ...overrides });
}

function load(responder = request => ready({ ...request })) {
  const calls = []; const explainCalls = []; const downloads = []; const announcements = []; let prints = 0;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: false, textContent: '', focused: false, dataset: {},
      children: [], addEventListener() {}, replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); }, focus() { this.focused = true; },
      setAttribute(name, value) { this[name] = value; }, remove() { this.removed = true; },
      classList: { toggle() {}, add() {}, remove() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({ console, Date, Chart: function() {}, ALLOCATION_TYPES: [],
    print() { prints++; }, BudgetView: { fmt: value => `$${value}` },
    document: { getElementById: element, querySelectorAll() { return []; },
      createElement() { return { value: '', textContent: '', children: [], dataset: {},
        append(...children) { this.children.push(...children); }, setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this[`on${name}`] = handler; }, focus() { this.focused = true; }, remove() { this.removed = true; },
        createTHead() { return { insertRow() { return { append() {} }; } }; },
        createTBody() { return { insertRow() { return { append() {} }; } }; } }; },
      createTextNode(text) { return { textContent: text }; } },
    Store: { compareSavedMonths(request) { calls.push({ ...request }); return responder(request); },
      explainSavedMonthComparisonRow(request) { explainCalls.push({ ...request }); return load.explainResponder(request); } },
    App: { formatMonth: key => key, download(...args) { downloads.push(args); },
      announceStatus(message) { announcements.push(message); } }
  });
  vm.runInContext(source, context);
  const dashboard = vm.runInContext('DashboardView', context);
  dashboard.populateSavedMonthComparisonPickers = () => {};
  dashboard.renderSavedMonthComparisonTable = result => { element('dashboard-comparison-output').hidden = false; dashboard.rendered = result; };
  return { dashboard, element, calls, explainCalls, downloads, announcements, getPrints: () => prints };
}

load.explainResponder = request => Object.freeze({ status: 'ready', summaryLabel: 'Ready.', rowLabel: 'Home',
  ...request, counts: Object.freeze({ totalCount: 2, returnedCount: 2, truncated: false }),
  baseline: Object.freeze({ monthKey: request.baselineMonth, totalCount: 1, returnedCount: 1, truncated: false,
    records: Object.freeze([]) }),
  comparison: Object.freeze({ monthKey: request.comparisonMonth, totalCount: 1, returnedCount: 1, truncated: false,
    records: Object.freeze([]) }) });

test('initial comparison passively defaults to the two most recent distinct saved months without focus movement', () => {
  const { dashboard, calls, element } = load(request => {
    if (!request.baselineMonth) return ready({ status: 'incomplete', baselineMonth: '', comparisonMonth: '',
      summaryLabel: 'Choose two saved months to compare.', rowModel: { columns: [], rows: [] } });
    return ready({ ...request });
  });
  const result = dashboard.compareSavedMonths({ initialize: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls.map(call => [call.baselineMonth, call.comparisonMonth]), [['', ''], ['2026-01', '2026-02']]);
  assert.equal(dashboard.savedMonthComparisonRequest.baselineMonth, '2026-01');
  assert.equal(dashboard.savedMonthComparisonRequest.comparisonMonth, '2026-02');
  assert.equal(element('dashboard-comparison-baseline').focused, false);
  assert.equal(element('dashboard-comparison-month').focused, false);
});

test('selection changes clear stale output and explicit Compare validates distinct months', () => {
  const { dashboard, element, announcements } = load(request => request.baselineMonth === request.comparisonMonth
    ? ready({ ...request, status: 'same-month', summaryLabel: 'Choose two different saved months.',
      rowModel: { columns: [], rows: [] } }) : ready({ ...request }));
  element('dashboard-comparison-output').hidden = false;
  element('dashboard-comparison-baseline').value = '2026-02';
  element('dashboard-comparison-month').value = '2026-02';
  dashboard.changeSavedMonthComparison();
  assert.equal(element('dashboard-comparison-output').hidden, true);
  assert.equal(dashboard.savedMonthComparisonRequest, null);
  const result = dashboard.compareSavedMonths({ announce: true });
  assert.equal(result.status, 'same-month'); assert.equal(element('dashboard-comparison-output').hidden, true);
  assert.match(element('dashboard-comparison-status').textContent, /different saved months/);
  assert.match(announcements.at(-1), /different saved months/);
});

test('CSV and print rebuild through Store, preserve row order, and reject stale selections', () => {
  let stale = false;
  const { dashboard, element, calls, downloads, getPrints } = load(request => stale
    ? ready({ ...request, status: 'missing-baseline', summaryLabel: 'The baseline month is no longer available.',
      availableMonths: ['2026-02'], rowModel: { columns: [], rows: [] } })
    : ready({ ...request }));
  dashboard.savedMonthComparisonRequest = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  assert.equal(dashboard.exportSavedMonthComparisonCsv(), true);
  assert.equal(downloads[0][1], 'warm-ledger-comparison-2026-01-to-2026-02-planned.csv');
  assert.match(downloads[0][0], /"Summary","Planned income","100","125","25","Complete"/);
  assert.equal(dashboard.printSavedMonthComparison(), true); assert.equal(getPrints(), 1);
  stale = true; element('dashboard-comparison-output').hidden = false;
  assert.equal(dashboard.exportSavedMonthComparisonCsv(), false);
  assert.equal(element('dashboard-comparison-output').hidden, true);
  assert.match(element('dashboard-comparison-status').textContent, /no longer available/);
  assert.ok(calls.length >= 3);
});

test('unsubmitted picker changes remain drafts across passive renders and cannot be exported or printed', () => {
  const { dashboard, element, calls, downloads, getPrints } = load(request => ready({ ...request, basis: request.basis }));
  dashboard.savedMonthComparisonRequest = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  element('dashboard-comparison-baseline').value = '2025-12';
  element('dashboard-comparison-month').value = '2026-01';
  dashboard.changeSavedMonthComparison();
  const beforePassive = calls.length;
  assert.equal(dashboard.compareSavedMonths({ initialize: true }), null);
  assert.equal(calls.length, beforePassive);
  assert.deepEqual({ ...dashboard.savedMonthComparisonRequest },
    { baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  assert.equal(dashboard.exportSavedMonthComparisonCsv(), false);
  assert.equal(dashboard.printSavedMonthComparison(), false);
  assert.equal(downloads.length, 0); assert.equal(getPrints(), 0);
  dashboard.compareSavedMonths({ announce: true });
  assert.deepEqual({ ...dashboard.savedMonthComparisonRequest },
    { baselineMonth: '2025-12', comparisonMonth: '2026-01', basis: 'planned' });
  assert.equal(dashboard.savedMonthComparisonDirty, false);
});

test('global basis changes require Compare and do not rewrite the last requested basis', () => {
  const { dashboard, calls, element } = load(request => ready({ ...request, basis: request.basis }));
  dashboard.savedMonthComparisonRequest = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  element('dashboard-comparison-baseline').value = '2026-01';
  element('dashboard-comparison-month').value = '2026-02';
  dashboard.basis = 'actual'; const beforePassive = calls.length;
  assert.equal(dashboard.compareSavedMonths({ initialize: true }), null);
  assert.equal(calls.length, beforePassive);
  assert.equal(dashboard.savedMonthComparisonRequest.basis, 'planned');
  assert.equal(dashboard.savedMonthComparisonDirty, true);
  dashboard.compareSavedMonths();
  assert.equal(calls.at(-1).basis, 'actual');
  assert.equal(dashboard.savedMonthComparisonRequest.basis, 'actual');
});

test('explanation is lazy, replaces a different row, and toggles the same row closed', () => {
  const { dashboard, explainCalls } = load();
  dashboard.savedMonthComparisonRequest = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  const rendered = []; dashboard.renderSavedMonthComparisonExplanation = result => { rendered.push(result.dimensionKey); return true; };
  const home = { drilldownEligible: true, sectionKey: 'categories', dimensionKey: 'Home' };
  const bank = { drilldownEligible: true, sectionKey: 'payment_methods', dimensionKey: 'bank' };
  const button = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  assert.equal(explainCalls.length, 0);
  dashboard.toggleSavedMonthComparisonExplanation(home, button);
  assert.equal(explainCalls.length, 1); assert.deepEqual(rendered, ['Home']); assert.equal(button['aria-expanded'], 'true');
  dashboard.toggleSavedMonthComparisonExplanation(bank, button);
  assert.equal(explainCalls.length, 2); assert.deepEqual(rendered, ['Home', 'bank']);
  assert.equal(dashboard.savedMonthComparisonExplainRequest.dimensionKey, 'bank');
  dashboard.toggleSavedMonthComparisonExplanation(bank, button);
  assert.equal(explainCalls.length, 2); assert.equal(dashboard.savedMonthComparisonExplainRequest, null);
});

test('picker changes and Compare close explanation state before clearing or rerendering', () => {
  const { dashboard, element } = load();
  dashboard.savedMonthComparisonRequest = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned' });
  dashboard.savedMonthComparisonExplainRequest = Object.freeze({ ...dashboard.savedMonthComparisonRequest,
    section: 'categories', dimensionKey: 'Home' });
  dashboard.changeSavedMonthComparison();
  assert.equal(dashboard.savedMonthComparisonExplainRequest, null);
  element('dashboard-comparison-baseline').value = '2026-01'; element('dashboard-comparison-month').value = '2026-02';
  dashboard.savedMonthComparisonExplainRequest = Object.freeze({ ...dashboard.savedMonthComparisonRequest,
    section: 'categories', dimensionKey: 'Home' });
  dashboard.compareSavedMonths();
  assert.equal(dashboard.savedMonthComparisonExplainRequest, null);
});

test('detail sides preserve truthful empty, truncated, and incomplete actual copy', () => {
  const { dashboard } = load();
  const empty = dashboard.savedMonthComparisonExplanationSide({ monthKey: '2026-01', totalCount: 0,
    returnedCount: 0, truncated: false, records: [] }, 'Baseline', { basis: 'actual' });
  assert.match(empty.children.map(child => child.textContent).join(' '), /No saved expenses contribute/);
  const record = { monthKey: '2026-02', recordId: 'expense-1', name: 'Rent', category: 'Home', date: '',
    paymentMethod: 'bank', plannedAmount: 100, actualAmount: null, displayAmount: null, displayStatus: 'Incomplete' };
  const truncated = dashboard.savedMonthComparisonExplanationSide({ monthKey: '2026-02', totalCount: 250,
    returnedCount: 200, truncated: true, records: [record] }, 'Comparison', { basis: 'actual' });
  assert.match(truncated.children.map(child => child.textContent).join(' '), /truncated/);
  const item = dashboard.savedMonthComparisonContributorItem(record, { basis: 'actual' });
  assert.match(item.children.map(child => child.textContent).join(' '), /Actual: Incomplete · Incomplete/);
});

test('refresh helper reruns the exact request, renders current data, announces, and focuses fallback', () => {
  const { dashboard, explainCalls, announcements } = load();
  const request = Object.freeze({ baselineMonth: '2026-01', comparisonMonth: '2026-02', basis: 'planned',
    section: 'categories', dimensionKey: 'Home' });
  let rendered = 0; let focused = 0;
  dashboard.renderSavedMonthComparisonExplanation = () => { rendered++; return true; };
  dashboard.focusSavedMonthComparisonFallback = candidate => { assert.equal(candidate, request); focused++; return true; };
  const result = dashboard.refreshSavedMonthComparisonExplanation(request,
    { announceMessage: 'That saved expense changed. Review refreshed contributors.', focusFallback: true });
  assert.equal(result.status, 'ready'); assert.deepEqual(explainCalls[0], { ...request });
  assert.equal(rendered, 1); assert.equal(focused, 1); assert.match(announcements[0], /changed/);
});
