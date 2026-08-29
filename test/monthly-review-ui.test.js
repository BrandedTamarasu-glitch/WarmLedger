'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'budget.js'), 'utf8');

class FakeNode {
  constructor(tag = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.textContent = ''; this.id = ''; this.tabIndex = 0; this.type = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this[`on${type}`] = handler; }
  focus() { this.focused = true; }
}

function allNodes(node) { return [node, ...node.children.flatMap(child => child instanceof FakeNode ? allNodes(child) : [])]; }
function allText(node) { return allNodes(node).map(item => item.textContent).filter(Boolean).join(' '); }

function loadView(review, exceptions = []) {
  const container = new FakeNode('div');
  const document = {
    createElement: tag => new FakeNode(tag),
    getElementById: id => id === 'monthly-review-container' ? container : allNodes(container).find(node => node.id === id) || null,
    querySelectorAll: selector => selector === '[data-review-kind][data-record-id]'
      ? allNodes(container).filter(node => node.dataset.reviewKind && node.dataset.recordId) : []
  };
  let reviewReads = 0;
  let exceptionReads = 0;
  let previewTrigger = null;
  let unsuppressCall = null;
  const Store = {
    getMonthReview(monthKey) { reviewReads += 1; assert.equal(monthKey, '2026-03'); return review; },
    getSuppressedOccurrences(monthKey) { exceptionReads += 1; assert.equal(monthKey, '2026-03'); return exceptions; },
    getMonth() { throw new Error('passive render must not read canonical month records'); }
  };
  const App = {
    openRecurringPreview(trigger) { previewTrigger = trigger; },
    openUnsuppressDialog(entry, trigger) { unsuppressCall = { entry, trigger }; }
  };
  const context = vm.createContext({ document, Store, App, Intl, Math, Object, requestAnimationFrame(callback) { callback(); } });
  vm.runInContext(`${source}\n;globalThis.ExportedView = BudgetView;`, context, { filename: 'budget.js' });
  context.ExportedView.currentMonth = '2026-03';
  return {
    view: context.ExportedView, container, reads: () => reviewReads, exceptionReads: () => exceptionReads,
    previewTrigger: () => previewTrigger, unsuppressCall: () => unsuppressCall
  };
}

function mixedReview() {
  return {
    monthKey: '2026-03', exists: true, empty: false,
    states: { needsRecurringReview: true, needsActuals: true, needsAllocation: true, ready: false },
    income: { plannedTotal: 3000, enteredActualTotal: 0, completeActualTotal: null, unresolvedCount: 1,
      unresolved: [{ id: 'pay-hostile', earner: '<img src=x onerror=alert(1)>', date: '2026-03-01', plannedAmount: 3000 }] },
    expenses: { plannedTotal: 1000, enteredActualTotal: 0, completeActualTotal: 0, unresolvedCount: 0, unresolved: [] },
    funding: { issueCount: 1, issues: [{ expenseId: 'expense-1', name: 'Rent', category: 'Home', plannedAmount: 1000, assignedAmount: 0, shortfall: 1000 }] },
    paycheckAssignments: [{ paycheckId: 'pay-hostile', earner: 'Employer', plannedAmount: 3000, assignedAmount: 0, remainingAmount: 3000 }],
    balance: { allocationsTotal: 0, plannedRemainder: 2000, actualCashFlow: null },
    recurring: { pendingCount: 2, conflictCount: 1, suppressedCount: 3 }
  };
}

test('Monthly Review renders concurrent textual states and null versus explicit zero without writes', () => {
  const { view, container, reads, exceptionReads } = loadView(mixedReview());
  view.renderMonthlyReview();
  const text = allText(container);
  assert.equal(reads(), 1);
  assert.equal(exceptionReads(), 1);
  assert.match(text, /Recurring items need review\./);
  assert.match(text, /Actual amounts are not entered for every item\./);
  assert.match(text, /Some planned expenses need paycheck funding\./);
  assert.match(text, /\$0\.00 entered \(partial; 1 not entered\)/);
  assert.match(text, /Actual expenses Planned \$1,000\.00 Actual \$0\.00/);
  assert.match(text, /Actual cash flow Incomplete/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
});

test('recurring exceptions safely render twins and every state, delegating eligible identity to App', () => {
  const hostile = '<b>Renamed & hostile</b>';
  const activeOne = { kind: 'income', sourceTemplateId: 'template-twin', occurrenceKey: '2026-03-31#0001', scheduledDate: '2026-03-31', ordinal: 1,
    templateName: hostile, templateState: 'active', eligible: true };
  const activeTwo = { ...activeOne, occurrenceKey: '2026-03-31#0002', ordinal: 2 };
  const exceptions = [activeOne, activeTwo,
    ...['disabled', 'archived', 'out-of-range', 'schedule-changed'].map((state, index) => ({
      kind: 'expense', sourceTemplateId: `template-${state}`, occurrenceKey: `2026-03-0${index + 1}#0001`,
      scheduledDate: `2026-03-0${index + 1}`, ordinal: 1, templateName: `Template ${state}`, templateState: state, eligible: false
    }))];
  const { view, container, unsuppressCall } = loadView(mixedReview(), exceptions); view.renderMonthlyReview();
  const text = allText(container);
  assert.match(text, /Recurring exceptions/); assert.match(text, /<b>Renamed & hostile<\/b>/);
  assert.match(text, /occurrence 1\. Current state: active/); assert.match(text, /occurrence 2\. Current state: active/);
  assert.match(text, /Enable the template/); assert.match(text, /Restore the template/);
  assert.match(text, /Adjust the template date range/); assert.match(text, /Restore the matching template schedule/);
  const buttons = allNodes(container).filter(node => node.dataset.exceptionAction === 'allow-again');
  assert.equal(buttons.length, 2); assert.equal(buttons[1].dataset.occurrenceKey, '2026-03-31#0002');
  buttons[1].onclick(); assert.equal(unsuppressCall().entry, activeTwo); assert.equal(unsuppressCall().trigger, buttons[1]);
  assert.equal(allNodes(container).some(node => node.dataset.sourceTemplateId === 'template-disabled' && node.dataset.exceptionAction), false);
});

test('unresolved review actions carry stable IDs and uniquely identify type and date', () => {
  const { view, container } = loadView(mixedReview()); view.renderMonthlyReview();
  const button = allNodes(container).find(node => node.dataset.reviewKind === 'income');
  assert.ok(button); assert.equal(button.dataset.recordId, 'pay-hostile');
  assert.equal(button.textContent, 'Enter actual income for <img src=x onerror=alert(1)>, 2026-03-01');
});

test('funding focus returns to the stable funding action or its group heading', () => {
  const review = mixedReview(); const { view, container } = loadView(review); view.renderMonthlyReview();
  let fundingButton = allNodes(container).find(node => node.dataset.reviewKind === 'funding');
  assert.ok(fundingButton); assert.equal(fundingButton.dataset.recordId, 'expense-1');
  let editorCall;
  view.openReviewEditor = (...args) => { editorCall = args; }; fundingButton.onclick();
  assert.equal(editorCall[0], 'expense'); assert.equal(editorCall[1], 'expense-1'); assert.equal(editorCall[2], fundingButton);
  assert.deepEqual({ ...editorCall[3] }, { kind: 'funding', id: 'expense-1' });
  view.restoreReviewFocus('funding', 'expense-1'); assert.equal(fundingButton.focused, true);

  review.funding = { issueCount: 0, issues: [] }; review.states.needsAllocation = false;
  view.renderMonthlyReview(); view.restoreReviewFocus('funding', 'expense-1');
  fundingButton = allNodes(container).find(node => node.dataset.reviewKind === 'funding');
  assert.equal(fundingButton, undefined);
  assert.equal(allNodes(container).find(node => node.id === 'monthly-review-funding-heading').focused, true);
});

test('Monthly Review recurring preview passes its own button as the focus trigger', () => {
  const { view, container, previewTrigger } = loadView(mixedReview()); view.renderMonthlyReview();
  const button = allNodes(container).find(node => node.textContent === 'Preview recurring items');
  assert.ok(button); button.onclick(); assert.equal(previewTrigger(), button);
});

test('empty review routes through existing controls and never reports ready', () => {
  const review = mixedReview(); review.empty = true;
  review.states = { needsRecurringReview: false, needsActuals: false, needsAllocation: false, ready: false };
  const { view, container } = loadView(review); view.renderMonthlyReview(); const text = allText(container);
  for (const label of ['Add paycheck', 'Add expense', 'Preview recurring items', 'Copy previous month']) assert.match(text, new RegExp(label));
  assert.match(text, /This month is empty and is not ready\./); assert.doesNotMatch(text, /Monthly review is ready\./);
});

test('empty review preserves Start actions while exposing eligible, ineligible, and twin exceptions', () => {
  const review = mixedReview(); review.empty = true;
  review.states = { needsRecurringReview: false, needsActuals: false, needsAllocation: false, ready: false };
  review.recurring = { pendingCount: 0, conflictCount: 0, suppressedCount: 3 };
  const twinOne = { kind: 'income', sourceTemplateId: 'twin', occurrenceKey: '2026-03-31#0001', scheduledDate: '2026-03-31', ordinal: 1,
    templateName: 'Twins', templateState: 'active', eligible: true };
  const exceptions = [twinOne, { ...twinOne, occurrenceKey: '2026-03-31#0002', ordinal: 2 }, {
    kind: 'expense', sourceTemplateId: 'disabled', occurrenceKey: '2026-03-04#0001', scheduledDate: '2026-03-04', ordinal: 1,
    templateName: 'Disabled item', templateState: 'disabled', eligible: false
  }];
  const { view, container } = loadView(review, exceptions); view.renderMonthlyReview(); const text = allText(container);
  assert.match(text, /Recurring items/); assert.match(text, /Recurring exceptions/); assert.match(text, /Start this month/);
  assert.match(text, /occurrence 1\. Current state: active/); assert.match(text, /occurrence 2\. Current state: active/);
  assert.match(text, /Enable the template before allowing this occurrence again/);
  assert.equal(allNodes(container).filter(node => node.dataset.exceptionAction === 'allow-again').length, 2);
  for (const label of ['Add paycheck', 'Add expense', 'Preview recurring items', 'Copy previous month']) assert.match(text, new RegExp(label));
  assert.doesNotMatch(text, /Monthly review is ready\./);
});

test('implementation is safe DOM, capability-neutral, and restores review focus by stable data', () => {
  const reviewRenderer = source.slice(source.indexOf('  renderMonthlyReview()'), source.indexOf('  renderReviewActualGroup('));
  assert.equal((source.match(/Store\.getMonthReview\(/g) || []).length, 1);
  assert.equal((source.match(/Store\.getSuppressedOccurrences\(/g) || []).length, 1);
  assert.doesNotMatch(source, /previewRecurringMonth|applyRecurringPreview/);
  assert.doesNotMatch(reviewRenderer, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /querySelector\s*\(\s*`[^`]*\$\{/);
  assert.match(source, /records\.find\(item => item\.id === id\)/);
  assert.match(source, /button\.dataset\.reviewKind = 'funding'; button\.dataset\.recordId = issue\.expenseId/);
  assert.match(source, /App\.openRecurringPreview\(button\)/);
  assert.match(source, /App\.openUnsuppressDialog\(entry, button\)/);
  assert.match(source, /control\.dataset\.reviewKind === kind && control\.dataset\.recordId === id/);
  assert.match(source, /target \|\| document\.getElementById\(`monthly-review-\$\{kind\}-heading`\)/);
  assert.doesNotMatch(reviewRenderer, /announceStatus|runMutation/);
});
