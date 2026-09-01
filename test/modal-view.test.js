'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'modal-view.js'), 'utf8');

class NodeStub {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this.isConnected = true;
    this.listeners = Object.create(null);
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  removeEventListener(type, handler) {
    if (this.listeners[type] === handler) delete this.listeners[type];
  }
  focus() { this.document.activeElement = this; this.focused = true; }
  click() {
    if (this.disabled) return;
    const handler = this.listeners.click;
    if (handler) handler({ currentTarget: this, target: this });
  }
}

function createHarness() {
  const nodes = Object.create(null);
  const document = {
    activeElement: null,
    createElement: tag => {
      const node = new NodeStub(tag);
      node.document = document;
      return node;
    },
    createDocumentFragment: () => {
      const node = new NodeStub('fragment');
      node.document = document;
      return node;
    },
    getElementById(id) { return nodes[id]; },
    querySelector() { return null; }
  };
  for (const id of ['application-shell', 'modal-overlay', 'modal-title', 'modal-body', 'modal-save', 'modal-cancel', 'modal-close']) {
    nodes[id] = document.createElement('div');
    nodes[id].id = id;
    nodes[id].document = document;
  }
  nodes['application-shell'].hidden = false;
  nodes['modal-overlay'].hidden = true;
  nodes['modal-save'].textContent = 'Save';
  nodes['modal-save'].disabled = false;
  nodes['modal-cancel'].textContent = 'Cancel';
  const trigger = document.createElement('button');
  trigger.id = 'trigger';
  trigger.document = document;
  trigger.focus();
  const prior = {
    document: global.document,
    Node: global.Node,
    requestAnimationFrame: global.requestAnimationFrame
  };
  const context = vm.createContext({
    console,
    document,
    Node: NodeStub,
    requestAnimationFrame: callback => callback()
  });
  vm.runInContext(`${source}\n;globalThis.__modal = ModalView;`, context, { filename: 'modal-view.js' });
  return {
    document,
    nodes,
    trigger,
    modal: context.__modal,
    restore() {
      global.document = prior.document;
      global.Node = prior.Node;
      global.requestAnimationFrame = prior.requestAnimationFrame;
    }
  };
}

test('close reasons clear the save handler so hidden saves do nothing', () => {
  const { document, nodes, trigger, modal, restore } = createHarness();
  try {
    let saves = 0;
    for (const reason of ['cancel', 'escape', 'backdrop']) {
      const closeReasons = [];
      document.activeElement = trigger;
      modal.open({
        title: 'Test modal',
        buildBody: () => document.createElement('section'),
        onSave: () => { saves += 1; return true; },
        onClose: closeReason => closeReasons.push(closeReason)
      });
      modal.close(reason);
      assert.equal(nodes['modal-overlay'].hidden, true);
      assert.equal(modal.saveHandler, null);
      nodes['modal-save'].click();
      assert.equal(saves, 0);
      assert.equal(closeReasons.at(-1), reason);
    }
  } finally {
    restore();
  }
});

test('double confirm only commits once even if the handler is invoked reentrantly', () => {
  const { document, nodes, trigger, modal, restore } = createHarness();
  try {
    let saves = 0;
    document.activeElement = trigger;
    modal.open({
      title: 'Test modal',
      buildBody: () => document.createElement('section'),
      onSave: () => {
        saves += 1;
        if (saves === 1) modal.saveHandler();
        return true;
      }
    });
    modal.saveHandler();
    assert.equal(saves, 1);
    assert.equal(nodes['modal-overlay'].hidden, true);
    assert.equal(modal.saveHandler, null);
  } finally {
    restore();
  }
});

test('failed confirm keeps the modal open, focusable, and ready to retry', () => {
  const { document, nodes, trigger, modal, restore } = createHarness();
  try {
    let saves = 0;
    document.activeElement = trigger;
    modal.open({
      title: 'Test modal',
      buildBody: () => document.createElement('section'),
      onSave: () => { saves += 1; return false; }
    });
    modal.saveHandler();
    assert.equal(saves, 1);
    assert.equal(nodes['modal-overlay'].hidden, false);
    assert.equal(nodes['modal-save'].disabled, false);
    assert.strictEqual(document.activeElement, nodes['modal-save']);
    assert.ok(modal.saveHandler);
  } finally {
    restore();
  }
});
