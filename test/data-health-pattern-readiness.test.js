'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'data-health-view.js'), 'utf8');

class NodeStub {
  constructor(tag, text = '') { this.tag = tag; this.textContent = text; this.children = []; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, handler) { this.handler = handler; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
}

function load(records = {}) {
  const modalCalls = []; const statuses = [];
  const context = vm.createContext({
    console, requestAnimationFrame: callback => callback(),
    document: { createElement: tag => new NodeStub(tag), getElementById: () => new NodeStub('div'), querySelector: () => null },
    Store: { getMonth: monthKey => records[monthKey] || { paychecks: [], expenses: [] }, getDataHealth: () => ({ repeatedManualPatterns: [] }) },
    TemplatesView: {
      nextMonthStart(date) { const [year, month] = date.slice(0, 7).split('-').map(Number);
        return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`; },
      showTemplateModal(...args) { modalCalls.push(args); }
    },
    App: { announceStatus(message) { statuses.push(message); } }, BudgetView: {}
  });
  vm.runInContext(`${source}\n;globalThis.__view = DataHealthView;`, context);
  return { view: context.__view, Store: context.Store, modalCalls, statuses };
}

function pattern(kind, recordId) {
  return { kind, signature: `${kind}-signature`, monthKeys: ['2026-01', '2026-02', '2026-03'],
    occurrences: ['2026-01', '2026-02', '2026-03'].map(monthKey => ({ kind, monthKey, recordId })) };
}

test('blank-date repeated patterns remain schedule unknown with no fabricated day or start date', () => {
  const records = Object.fromEntries(['2026-01', '2026-02', '2026-03'].map(monthKey => [monthKey, { paychecks: [], expenses: [{
    id: 'expense', name: '<Blank & hostile>', categoryId: 'category', categoryItemId: null,
    plannedAmount: 25, actualAmount: 0, date: '', paymentMethod: 'bank'
  }] }]));
  const { view } = load(records); const draft = view.templateDraft(pattern('expense', 'expense'));
  assert.equal(draft.name, '<Blank & hostile>'); assert.equal(draft.enabled, false);
  assert.equal(draft.startDate, null); assert.equal(draft.recurrence, null);
  const section = view.patternsSection([pattern('expense', 'expense')]);
  const item = section.children[2].children[0]; const details = item.children[0]; const action = item.children[1];
  assert.match(details.children[1].textContent, /Schedule unknown — choose a schedule before saving/);
  assert.doesNotMatch(details.children[1].textContent, /day 1/);
  assert.equal(action.textContent, 'Review template suggestion');
  assert.equal(action['aria-label'], 'Review template suggestion for <Blank & hostile>');
});

test('known dates produce a conservative monthly candidate beginning after latest evidence', () => {
  const records = Object.fromEntries(['2026-01', '2026-02', '2026-03'].map(monthKey => [monthKey, { expenses: [], paychecks: [{
    id: 'income', earner: 'Income', earnerId: 'earner', plannedAmount: 100,
    actualAmount: null, date: `${monthKey}-15`
  }] }]));
  const { view } = load(records); const draft = view.templateDraft(pattern('income', 'income'));
  assert.equal(draft.startDate, '2026-04-01');
  assert.deepEqual(JSON.parse(JSON.stringify(draft.recurrence)), { cadence: 'monthly', day: 15 });
  const section = view.patternsSection([pattern('income', 'income')]);
  assert.match(section.children[2].children[0].children[0].children[1].textContent, /Possible monthly schedule on day 15/);
});

test('review action revalidates the pattern and opens the existing Add modal without mutation', () => {
  const records = { '2026-03': { expenses: [], paychecks: [{ id: 'income', earner: 'Income', earnerId: 'earner',
    plannedAmount: 100, actualAmount: 0, date: '2026-03-15' }] } };
  const current = pattern('income', 'income'); const { view, Store, modalCalls, statuses } = load(records);
  Store.getDataHealth = () => ({ repeatedManualPatterns: [current] });
  const trigger = new NodeStub('button'); view.openPatternTemplate(current, trigger);
  assert.equal(modalCalls.length, 1); assert.equal(modalCalls[0][0], 'income'); assert.equal(modalCalls[0][1], null);
  assert.strictEqual(modalCalls[0][2], trigger); assert.equal(modalCalls[0][3].enabled, false);
  Store.getDataHealth = () => ({ repeatedManualPatterns: [] }); view.openPatternTemplate(current, trigger);
  assert.equal(modalCalls.length, 1); assert.match(statuses[0], /pattern has changed/); assert.equal(trigger.focused, true);
});
