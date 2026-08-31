'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');

function load({ year = 2026, monthIndex = 7 } = {}) {
  const elements = new Map();
  const buttons = ['current', 'last-3', 'last-6', 'ytd'].map(command => ({
    dataset: { dashboardQuickRange: command }, onclick: null, focused: false,
    focus() { this.focused = true; }
  }));
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', addEventListener() {}, replaceChildren() {}, append() {},
      classList: { toggle() {} }, hidden: false, textContent: ''
    });
    return elements.get(id);
  };
  let dateConstructions = 0;
  function LocalDate() { dateConstructions++; }
  LocalDate.prototype.getFullYear = () => year;
  LocalDate.prototype.getMonth = () => monthIndex;
  const storeCalls = [];
  const context = vm.createContext({
    console, Date: LocalDate,
    document: {
      activeElement: buttons[0],
      getElementById: element,
      querySelectorAll(selector) {
        if (selector === '[data-dashboard-basis]') return [];
        assert.equal(selector, '[data-dashboard-quick-range]'); return buttons;
      }
    },
    Store: new Proxy({}, { get(_target, key) { return (...args) => { storeCalls.push([key, ...args]); }; } }),
    Chart: function() {}, App: {}, ALLOCATION_TYPES: []
  });
  vm.runInContext(source, context);
  const api = vm.runInContext('({ DashboardView, dashboardQuickRange })', context);
  return { ...api, buttons, elements, element, storeCalls, getDateConstructions: () => dateConstructions };
}

test('pure civil quick ranges cover current, trailing windows, YTD, and year boundaries', () => {
  const { dashboardQuickRange } = load();
  assert.deepEqual({ ...dashboardQuickRange('current', { year: 2026, month: 1 }) }, { from: '2026-01', to: '2026-01' });
  assert.deepEqual({ ...dashboardQuickRange('last-3', { year: 2026, month: 1 }) }, { from: '2025-11', to: '2026-01' });
  assert.deepEqual({ ...dashboardQuickRange('last-6', { year: 2026, month: 3 }) }, { from: '2025-10', to: '2026-03' });
  assert.deepEqual({ ...dashboardQuickRange('ytd', { year: 2026, month: 12 }) }, { from: '2026-01', to: '2026-12' });
  assert.equal(Object.isFrozen(dashboardQuickRange('current', { year: 2026, month: 1 })), true);
  assert.equal(dashboardQuickRange('unknown', { year: 2026, month: 1 }), null);
  assert.equal(dashboardQuickRange('last-3', { year: 0, month: 1 }), null);
  assert.equal(dashboardQuickRange('current', { year: 2026, month: 13 }), null);
});

test('each command captures local time once, sets existing inputs, renders once, and preserves focus without Store writes', () => {
  for (const [index, expected] of [
    [0, { from: '2026-08', to: '2026-08' }],
    [1, { from: '2026-06', to: '2026-08' }],
    [2, { from: '2026-03', to: '2026-08' }],
    [3, { from: '2026-01', to: '2026-08' }]
  ]) {
    const harness = load();
    let renders = 0;
    harness.DashboardView.render = () => { renders++; };
    harness.DashboardView.bindEvents();
    const focused = harness.buttons[index];
    harness.buttons.forEach(button => { button.focused = false; });
    harness.buttons[index].focused = true;
    harness.buttons[index].onclick();
    assert.equal(harness.element('dash-from').value, expected.from);
    assert.equal(harness.element('dash-to').value, expected.to);
    assert.equal(renders, 1);
    assert.equal(harness.getDateConstructions(), 1);
    assert.deepEqual(harness.storeCalls, []);
    assert.equal(focused.focused, true);
    assert.equal(Object.hasOwn(focused, 'ariaPressed'), false);
  }
});

test('invalid direct commands are no-op and do not render or touch inputs', () => {
  const harness = load();
  let renders = 0;
  harness.DashboardView.render = () => { renders++; };
  harness.element('dash-from').value = '2024-01';
  harness.element('dash-to').value = '2024-12';
  assert.equal(harness.DashboardView.applyQuickRange('not-a-command'), false);
  assert.equal(renders, 0);
  assert.equal(harness.element('dash-from').value, '2024-01');
  assert.equal(harness.element('dash-to').value, '2024-12');
  assert.deepEqual(harness.storeCalls, []);
});
