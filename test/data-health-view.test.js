'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeV3Budget, MemoryStorage, makeClock, makeUuid } = require('./helpers.js');
const { STORAGE_KEY, createStore } = require('../js/data.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'data-health-view.js'), 'utf8');

class NodeStub {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, handler) { this[`on${type}`] = handler; }
  focus() { this.focused = true; }
}

function loadView({ store, render, showModal, runMutation } = {}) {
  const nodes = Object.create(null);
  nodes['modal-cancel'] = new NodeStub('button');
  nodes['modal-cancel'].id = 'modal-cancel';
  nodes['month-sharded-storage-heading'] = new NodeStub('h3');
  nodes['month-sharded-storage-heading'].id = 'month-sharded-storage-heading';
  nodes['accounts-migration-heading'] = new NodeStub('h3');
  nodes['accounts-migration-heading'].id = 'accounts-migration-heading';
  nodes['review-accounts-migration'] = new NodeStub('button');
  nodes['review-accounts-migration'].id = 'review-accounts-migration';
  let currentReviewTrigger = new NodeStub('button');
  currentReviewTrigger.id = 'review-month-sharded-storage';
  nodes['review-month-sharded-storage'] = currentReviewTrigger;
  const trigger = new NodeStub('button');
  trigger.focus = function focus() { this.focused = true; };
  nodes['modal-cancel'].focus = function focus() { this.focused = true; };
  nodes['month-sharded-storage-heading'].focus = function focus() { this.focused = true; };
  const statuses = [];
  const errors = [];
  const recoveries = [];
  let renders = 0;
  const modalOptions = [];
  const context = vm.createContext({
    console,
    requestAnimationFrame: callback => callback(),
    document: {
      createElement: tag => new NodeStub(tag),
      getElementById: id => nodes[id] || (nodes[id] = new NodeStub('div')),
      querySelector: () => null
    },
    Store: store,
    ZeroBudgetDataHealth: {
      buildExactMoneyMigration: () => ({ state: 'eligible' }),
      buildAccountsMigration: summary => ({ state: summary.state, title: 'Local accounts are ready',
        description: 'Ready', canPreview: true, buttonLabel: 'Review accounts upgrade' }),
      buildShardedPersistenceMigration: summary => ({
        state: summary.state,
        title: 'Month-sharded local storage is ready',
        description: 'Ready',
        canPreview: true,
        buttonLabel: 'Preview month-sharded storage'
      })
    },
    App: {
      showModal: options => {
        modalOptions.push(options);
        if (showModal) showModal(options);
      },
      runMutation: runMutation || ((mutate, { onSuccess, onFailure } = {}) => {
        try {
          const result = mutate();
          if (onSuccess) onSuccess(result);
          return true;
        } catch (error) {
          errors.push(error);
          if (onFailure) onFailure(error);
          return false;
        }
      }),
      showError: error => errors.push(error),
      showErrorCode: code => errors.push(code),
      showRecovery: recovery => recoveries.push(recovery),
      refreshAllViews: () => { renders += 1; },
      switchView: () => {},
      announceStatus: message => statuses.push(message),
      modalTrigger: null
    },
    ModalView: { trigger: null },
    BudgetView: {}
  });
  vm.runInContext(`${source}\n;globalThis.__view = DataHealthView;`, context, { filename: 'data-health-view.js' });
  const view = context.__view;
  view.render = render || (() => {
    renders += 1;
    currentReviewTrigger = new NodeStub('button');
    currentReviewTrigger.id = 'review-month-sharded-storage';
    currentReviewTrigger.focus = function focus() { this.focused = true; };
    nodes['review-month-sharded-storage'] = currentReviewTrigger;
    nodes['month-sharded-storage-heading'] = nodes['month-sharded-storage-heading'] || new NodeStub('h3');
    nodes['month-sharded-storage-heading'].focus = function focus() { this.focused = true; };
  });
  return {
    view,
    modalOptions,
    nodes,
    trigger,
    statuses,
    errors,
    recoveries,
    getRenders: () => renders,
    getCurrentReviewTrigger: () => currentReviewTrigger
  };
}

test('month-sharded preview clears on every non-confirm close reason', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  const store = createStore({ storage, now: makeClock(), uuid: makeUuid('preview-a', 'preview-b') });
  store.load();
  const { view, modalOptions, trigger } = loadView({ store });
  for (const reason of ['cancel', 'escape', 'backdrop']) {
    view.previewMonthShardedMigration(trigger);
    const preview = view.monthShardedPreview;
    assert.ok(preview);
    modalOptions.at(-1).onClose(reason);
    assert.equal(view.monthShardedPreview, null);
    assert.equal(preview !== null, true);
  }
});

test('accounts confirm consumes its preview and a failed attempt requires a fresh review', () => {
  let serial = 0;
  const store = {
    previewAccountsMigration: () => Object.freeze({ state: 'eligible', generation: ++serial,
      paycheckCount: 1, expenseCount: 2, templateCount: 3 }),
    commitAccountsMigration: () => { throw Object.assign(new Error('failed'), { code: 'PRIMARY_WRITE_FAILED' }); },
    getStatus: () => ({ state: 'ready' })
  };
  const { view, modalOptions, trigger, errors, nodes } = loadView({ store });
  view.previewAccountsMigration(trigger);
  const first = view.accountsPreview;
  assert.ok(first);
  assert.equal(modalOptions.at(-1).initialFocus(), nodes['modal-cancel']);
  assert.equal(modalOptions.at(-1).onSave(), true);
  assert.equal(view.accountsPreview, null);
  assert.equal(errors.length, 1);
  assert.equal(nodes['review-accounts-migration'].focused, true);

  view.previewAccountsMigration(trigger);
  assert.ok(view.accountsPreview);
  assert.notStrictEqual(view.accountsPreview, first);
  modalOptions.at(-1).onClose('cancel');
  assert.equal(view.accountsPreview, null);
});

test('failed confirm closes, rerenders fresh summary, and requires a new preview', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(makeV3Budget()) });
  storage.fail({ op: 'setItem', once: true });
  const store = createStore({ storage, now: makeClock(), uuid: makeUuid('preview-a', 'preview-b') });
  store.load();
  const { view, modalOptions, trigger, statuses, errors, recoveries, nodes, getRenders, getCurrentReviewTrigger } = loadView({ store });

  view.previewMonthShardedMigration(trigger);
  const firstPreview = view.monthShardedPreview;
  assert.ok(firstPreview);
  const firstResult = modalOptions.at(-1).onSave();
  assert.equal(firstResult, true);
  assert.equal(view.monthShardedPreview, null);
  assert.equal(getRenders(), 1);
  assert.ok(errors.length > 0);
  assert.equal(recoveries.length, 0);
  assert.equal(nodes['review-month-sharded-storage'].focused, true);
  assert.equal(nodes['month-sharded-storage-heading'].focused, undefined);

  view.previewMonthShardedMigration(trigger);
  const secondPreview = view.monthShardedPreview;
  assert.ok(secondPreview);
  assert.notStrictEqual(secondPreview, firstPreview);
  const secondResult = modalOptions.at(-1).onSave();
  assert.equal(secondResult, true);
  assert.equal(view.monthShardedPreview, null);
  assert.match(statuses[0], /month-sharded local storage/);
  assert.equal(nodes['month-sharded-storage-heading'].focused, true);
});
