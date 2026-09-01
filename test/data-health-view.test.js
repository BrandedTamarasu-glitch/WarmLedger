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
  nodes['data-health-heading'] = new NodeStub('h2');
  nodes['data-health-heading'].id = 'data-health-heading';
  nodes['month-sharded-storage-heading'] = new NodeStub('h3');
  nodes['month-sharded-storage-heading'].id = 'month-sharded-storage-heading';
  nodes['accounts-migration-heading'] = new NodeStub('h3');
  nodes['accounts-migration-heading'].id = 'accounts-migration-heading';
  nodes['review-accounts-migration'] = new NodeStub('button');
  nodes['review-accounts-migration'].id = 'review-accounts-migration';
  nodes['actual-account-migration-heading'] = new NodeStub('h3');
  nodes['actual-account-migration-heading'].id = 'actual-account-migration-heading';
  nodes['review-actual-account-migration'] = new NodeStub('button');
  nodes['review-actual-account-migration'].id = 'review-actual-account-migration';
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
      buildActualAccountMigration: summary => ({ state: summary.state, title: 'Actual account labels are ready',
        description: 'This ledger can add optional actual-account labels for saved paychecks and expenses. Planned account labels stay unchanged.',
        canPreview: summary.state === 'eligible', buttonLabel: summary.state === 'eligible' ? 'Review actual account upgrade' : null }),
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
  const renderOriginal = view.render.bind(view);
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
    getCurrentReviewTrigger: () => currentReviewTrigger,
    renderOriginal,
    getModalTrigger: () => context.ModalView.trigger
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

test('actual account migration card renders only before schema 7', () => {
  const storeFor = state => ({
    getDataHealth: () => ({ counts: { missingActuals: 0, missingDates: 0, fundingMismatches: 0 },
      missingActuals: [], missingDates: [], fundingMismatches: [], absentMonths: [], repeatedManualPatterns: [] }),
    getExactMoneyAudit: () => ({ subCentValueCount: 0, scannedValueCount: 0 }),
    getExactMoneyMigrationSummary: () => ({ state: 'already-migrated' }),
    getShardedPersistenceSummary: () => ({ state: 'already-sharded' }),
    getAccountsMigrationSummary: () => ({ state: 'already-migrated' }),
    getActualAccountMigrationSummary: () => ({ state, paycheckCount: 1, expenseCount: 2, accountCount: 3 })
  });
  for (const [state, expected] of [['eligible', true], ['blocked', true], ['already-migrated', false]]) {
    const { nodes, renderOriginal } = loadView({ store: storeFor(state) });
    renderOriginal();
    const cards = nodes['data-health-content'].children.filter(child =>
      String(child.className).includes('actual-account-migration'));
    assert.equal(cards.length === 1, expected);
    if (state === 'eligible') {
      const actions = cards[0].children.find(child => child.className === 'actual-account-migration-actions');
      assert.equal(actions.children[1].textContent, 'Review actual account upgrade');
    }
  }
});

test('actual account preview is count-only, Cancel-first, and cancel consumes no commit', () => {
  let commits = 0;
  const store = {
    previewActualAccountMigration: () => Object.freeze({ state: 'eligible', generation: 1,
      paycheckCount: 4, expenseCount: 5, accountCount: 6 }),
    commitActualAccountMigration: () => { commits += 1; },
    getStatus: () => ({ state: 'ready' })
  };
  const { view, modalOptions, trigger, nodes, getModalTrigger } = loadView({ store });
  view.previewActualAccountMigration(trigger);
  const options = modalOptions.at(-1);
  assert.equal(options.title, 'Add actual account labels to this ledger?');
  assert.equal(options.submitLabel, 'Add actual account labels');
  assert.equal(options.initialFocus(), nodes['modal-cancel']);
  const body = options.buildBody();
  assert.deepEqual(body.children.slice(0, 2).map(node => node.textContent), [
    'This adds optional actual-account labels to saved paychecks and expenses without changing saved budget values.',
    'Actual account labels are entered manually. They do not connect to a bank, prove payment, or reconcile activity.'
  ]);
  const summary = body.children.at(-1);
  assert.deepEqual(summary.children.map(node => node.textContent),
    ['Saved paychecks', '4', 'Saved expenses', '5', 'Accounts', '6']);
  options.onClose('cancel');
  assert.equal(view.actualAccountPreview, null);
  assert.equal(commits, 0);
  assert.equal(getModalTrigger(), trigger);
});

test('actual account confirm commits once, refreshes, and focuses the surviving Data Health heading', () => {
  const preview = Object.freeze({ state: 'eligible', generation: 1, paycheckCount: 1, expenseCount: 2, accountCount: 3 });
  let committed = null;
  const store = {
    previewActualAccountMigration: () => preview,
    commitActualAccountMigration: value => { committed = value; },
    getStatus: () => ({ state: 'ready' })
  };
  const { view, modalOptions, trigger, nodes, statuses, getRenders } = loadView({ store });
  view.previewActualAccountMigration(trigger);
  delete nodes['actual-account-migration-heading'];
  assert.equal(modalOptions.at(-1).onSave(), true);
  assert.equal(committed, preview);
  assert.equal(view.actualAccountPreview, null);
  assert.equal(getRenders(), 1);
  assert.match(statuses[0], /Actual account labels are now available/);
  assert.equal(nodes['data-health-heading'].focused, true);
});

test('failed actual account commit rerenders, shows recovery, and focuses a fresh action', () => {
  const recovery = { state: 'recovery-required' };
  const store = {
    previewActualAccountMigration: () => Object.freeze({ state: 'eligible', generation: 1,
      paycheckCount: 1, expenseCount: 2, accountCount: 3 }),
    commitActualAccountMigration: () => { throw Object.assign(new Error('failed'), { code: 'PRIMARY_WRITE_FAILED' }); },
    getStatus: () => ({ state: 'recovery-required' }),
    reload: () => recovery
  };
  const { view, modalOptions, trigger, errors, recoveries, nodes, getRenders } = loadView({ store });
  view.previewActualAccountMigration(trigger);
  assert.equal(modalOptions.at(-1).onSave(), true);
  assert.equal(view.actualAccountPreview, null);
  assert.equal(getRenders(), 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(recoveries, [recovery]);
  assert.equal(nodes['review-actual-account-migration'].focused, true);
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
