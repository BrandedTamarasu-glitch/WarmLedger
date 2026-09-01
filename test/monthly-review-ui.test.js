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

function loadView(review, payPeriodPlan = {
  summary: {
    methodFundingTotals: { bank: 625, credit_card: 275, savings: 75, investments: 25 },
    billsNeedingFundingAmount: 100
  }
}) {
  const container = new FakeNode('div');
  const document = {
    createElement: tag => new FakeNode(tag),
    getElementById: id => id === 'monthly-review-container' ? container : allNodes(container).find(node => node.id === id) || null,
    querySelectorAll: selector => selector === '[data-review-kind][data-record-id]'
      ? allNodes(container).filter(node => node.dataset.reviewKind && node.dataset.recordId) : []
  };
  let reviewReads = 0;
  let planReads = 0;
  let previewTrigger = null;
  let switchedView = null;
  let fundingRoute = null;
  const Store = {
    getMonthReview(monthKey) { reviewReads += 1; assert.equal(monthKey, '2026-03'); return review; },
    getPayPeriodPlan(monthKey) { planReads += 1; assert.equal(monthKey, '2026-03'); return payPeriodPlan; },
    getMonth() { throw new Error('passive render must not read canonical month records'); }
  };
  const App = {
    openRecurringPreview(trigger) { previewTrigger = trigger; },
    switchView(view) { switchedView = view; },
    openBudgetFunding(monthKey, expenseId, paycheckId) { fundingRoute = { monthKey, expenseId, paycheckId }; }
  };
  const context = vm.createContext({ document, Store, App, Intl, Math, Object, requestAnimationFrame(callback) { callback(); } });
  vm.runInContext(`${source}\n;globalThis.ExportedView = BudgetView;`, context, { filename: 'budget.js' });
  context.ExportedView.currentMonth = '2026-03';
  return {
    view: context.ExportedView, container, reads: () => reviewReads, planReads: () => planReads,
    previewTrigger: () => previewTrigger, switchedView: () => switchedView, fundingRoute: () => fundingRoute
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
  const { view, container, reads, planReads } = loadView(mixedReview());
  view.renderMonthlyReview();
  const text = allText(container);
  assert.equal(reads(), 1);
  assert.equal(planReads(), 1);
  assert.match(text, /Recurring items need review\./);
  assert.match(text, /Actual amounts are not entered for every item\./);
  assert.doesNotMatch(text, /Some planned expenses need paycheck funding\./);
  assert.match(text, /\$0\.00 entered \(partial; 1 not entered\)/);
  assert.match(text, /Actual expenses Planned \$1,000\.00 Actual \$0\.00/);
  assert.match(text, /Actual cash flow Incomplete/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
});

test('planned payment guidance restores bank and credit-card amounts with honest scope', () => {
  const { view, container, switchedView } = loadView(mixedReview()); view.renderMonthlyReview();
  const text = allText(container);
  assert.match(text, /Planned payment guidance/);
  assert.match(text, /Keep in bank for assigned bills \$625\.00/);
  assert.match(text, /Plan for credit card bills \$275\.00/);
  assert.match(text, /Plan for savings-funded bills \$75\.00/);
  assert.match(text, /Plan for investment-funded bills \$25\.00/);
  assert.match(text, /Bills still needing paycheck funding: \$100\.00/);
  assert.match(text, /Assigned bills only.*No payment or transfer is performed/);
  const button = allNodes(container).find(node => node.textContent === 'View by paycheck');
  assert.ok(button); button.onclick(); assert.equal(switchedView(), 'transfers');
});

test('Recurring and funding tiles are omitted while their compact prompts remain useful', () => {
  const { view, container } = loadView(mixedReview()); view.renderMonthlyReview();
  const text = allText(container);
  assert.match(text, /Recurring items need review\./);
  assert.doesNotMatch(text, /Recurring items Pending|Recurring exceptions|Expense funding|suppressed|Allow again|occurrence/);
  assert.equal(allNodes(container).some(node => node.dataset.exceptionAction), false);
});

test('unresolved review actions carry stable IDs and uniquely identify type and date', () => {
  const { view, container } = loadView(mixedReview()); view.renderMonthlyReview();
  const button = allNodes(container).find(node => node.dataset.reviewKind === 'income');
  assert.ok(button); assert.equal(button.dataset.recordId, 'pay-hostile');
  assert.equal(button.textContent, 'Enter actual income for <img src=x onerror=alert(1)>, 2026-03-01');
});

test('red funding prompt routes directly to the first bill needing funding and disappears when resolved', () => {
  const review = mixedReview(); const { view, container, fundingRoute } = loadView(review); view.renderMonthlyReview();
  let prompt = allNodes(container).find(node => node.className === 'monthly-review-funding-alert');
  assert.ok(prompt); assert.equal(prompt.textContent, '!'); assert.equal(prompt.dataset.recordId, 'expense-1');
  prompt.onclick(); assert.deepEqual({ ...fundingRoute() }, { monthKey: '2026-03', expenseId: 'expense-1', paycheckId: null });

  review.funding = { issueCount: 0, issues: [] }; review.states.needsAllocation = false;
  view.renderMonthlyReview(); prompt = allNodes(container).find(node => node.className === 'monthly-review-funding-alert');
  assert.equal(prompt, undefined);
});

test('empty Monthly Review recurring preview passes its own button as the focus trigger', () => {
  const review = mixedReview(); review.empty = true;
  const { view, container, previewTrigger } = loadView(review); view.renderMonthlyReview();
  const button = allNodes(container).find(node => node.textContent === 'Preview recurring items');
  assert.ok(button); button.onclick(); assert.equal(previewTrigger(), button);
});

test('empty review routes through existing controls and never reports ready', () => {
  const review = mixedReview(); review.empty = true;
  review.states = { needsRecurringReview: false, needsActuals: false, needsAllocation: false, ready: false };
  const { view, container, planReads } = loadView(review); view.renderMonthlyReview(); const text = allText(container);
  assert.equal(planReads(), 0);
  for (const label of ['Add paycheck', 'Add expense', 'Preview recurring items', 'Copy previous month']) assert.match(text, new RegExp(label));
  assert.match(text, /This month is empty and is not ready\./); assert.doesNotMatch(text, /Monthly review is ready\./);
});

test('empty review stays compact and never exposes recurring exceptions', () => {
  const review = mixedReview(); review.empty = true;
  review.states = { needsRecurringReview: false, needsActuals: false, needsAllocation: false, ready: false };
  review.recurring = { pendingCount: 0, conflictCount: 0, suppressedCount: 3 };
  const { view, container } = loadView(review); view.renderMonthlyReview(); const text = allText(container);
  assert.match(text, /Start this month/); assert.doesNotMatch(text, /Recurring items/);
  assert.doesNotMatch(text, /Recurring exceptions|suppressed|Allow again/);
  for (const label of ['Add paycheck', 'Add expense', 'Preview recurring items', 'Copy previous month']) assert.match(text, new RegExp(label));
  assert.doesNotMatch(text, /Monthly review is ready\./);
});

test('implementation is safe DOM, capability-neutral, and restores review focus by stable data', () => {
  const reviewRenderer = source.slice(source.indexOf('  renderMonthlyReview()'), source.indexOf('  renderNextReviewSteps('));
  assert.equal((source.match(/Store\.getMonthReview\(/g) || []).length, 1);
  assert.equal((source.match(/Store\.getPayPeriodPlan\(/g) || []).length, 1);
  assert.equal((source.match(/Store\.getSuppressedOccurrences\(/g) || []).length, 0);
  assert.doesNotMatch(source, /previewRecurringMonth|applyRecurringPreview/);
  assert.doesNotMatch(reviewRenderer, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /querySelector\s*\(\s*`[^`]*\$\{/);
  assert.match(source, /records\.find\(item => item\.id === id\)/);
  assert.match(source, /button\.dataset\.reviewKind = 'funding'; button\.dataset\.recordId = issue\.expenseId/);
  assert.doesNotMatch(reviewRenderer, /monthly-review-recurring-heading|monthly-review-funding-heading/);
  assert.match(source, /App\.openRecurringPreview\(button\)/);
  assert.doesNotMatch(source, /renderRecurringExceptions|App\.openUnsuppressDialog\(entry, button\)/);
  assert.match(source, /control\.dataset\.reviewKind === kind && control\.dataset\.recordId === id/);
  assert.match(source, /target \|\| document\.getElementById\(`monthly-review-\$\{kind\}-heading`\)/);
  assert.doesNotMatch(reviewRenderer, /announceStatus|runMutation/);
});
