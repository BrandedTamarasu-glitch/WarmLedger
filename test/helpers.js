'use strict';

const SAMPLE_IDS = Object.freeze({
  paycheck: 'paycheck-example-1',
  expense: 'expense-example-1'
});

function makeV2Budget(overrides = {}) {
  const budget = {
    schemaVersion: 2,
    categories: [{
      id: 'category-example-1', name: 'Home', archived: false,
      items: [{ id: 'item-example-1', name: 'Rent', archived: false }]
    }],
    settings: { earners: [{ id: 'earner-example-1', name: 'Example Earner', archived: false }] },
    months: {
      '2026-01': {
        paychecks: [{
          id: SAMPLE_IDS.paycheck,
          earnerId: 'earner-example-1',
          earner: 'Example Earner',
          amount: 2500,
          date: '2026-01-15'
        }],
        expenses: [{
          id: SAMPLE_IDS.expense,
          categoryId: 'category-example-1',
          category: 'Home',
          categoryItemId: 'item-example-1',
          name: 'Rent',
          paycheckAmounts: { [SAMPLE_IDS.paycheck]: 1200 },
          actual: 1200,
          paymentMethod: 'bank'
        }],
        allocations: {
          savings: 400,
          credit_card_debt: 100,
          investments: 200
        }
      }
    }
  };

  return Object.assign(budget, overrides);
}

function makeBudget(overrides = {}) {
  const budget = {
    schemaVersion: 1,
    categories: [{ name: 'Home', items: ['Rent'] }],
    settings: { earners: ['Example Earner'] },
    months: {
      '2026-01': {
        paychecks: [{ id: SAMPLE_IDS.paycheck, earner: 'Example Earner', amount: 2500, date: '2026-01-15' }],
        expenses: [{
          id: SAMPLE_IDS.expense, category: 'Home', name: 'Rent',
          paycheckAmounts: { [SAMPLE_IDS.paycheck]: 1200 }, actual: 1200, paymentMethod: 'bank'
        }],
        allocations: { savings: 400, credit_card_debt: 100, investments: 200 }
      }
    }
  };
  return Object.assign(budget, overrides);
}

class MemoryStorage {
  constructor(initial = {}) {
    this._values = new Map();
    this.operations = [];
    this._faults = [];
    for (const [key, value] of Object.entries(initial)) {
      this._values.set(String(key), String(value));
    }
  }

  get length() {
    return this._values.size;
  }

  key(index) {
    return Array.from(this._values.keys())[index] ?? null;
  }

  getItem(key) {
    key = String(key);
    this._maybeThrow('getItem', key);
    this.operations.push({ op: 'getItem', key });
    return this._values.has(key) ? this._values.get(key) : null;
  }

  setItem(key, value) {
    key = String(key);
    this._maybeThrow('setItem', key);
    this.operations.push({ op: 'setItem', key });
    this._values.set(key, String(value));
  }

  removeItem(key) {
    key = String(key);
    this._maybeThrow('removeItem', key);
    this.operations.push({ op: 'removeItem', key });
    this._values.delete(key);
  }

  clear() {
    this._maybeThrow('clear', '');
    this.operations.push({ op: 'clear', key: '' });
    this._values.clear();
  }

  fail({ op, key, prefix, name = 'QuotaExceededError', once = false }) {
    this._faults.push({ op, key, prefix, name, once });
  }

  _maybeThrow(op, key) {
    const index = this._faults.findIndex(fault =>
      fault.op === op &&
      (fault.key === undefined || fault.key === key) &&
      (fault.prefix === undefined || key.startsWith(fault.prefix))
    );
    if (index === -1) return;
    const fault = this._faults[index];
    if (fault.once) this._faults.splice(index, 1);
    const error = new Error('Injected storage failure');
    error.name = fault.name;
    throw error;
  }
}

function makeClock(initial = '2026-01-15T12:00:00.000Z') {
  let current = new Date(initial);
  const now = () => new Date(current.getTime());
  now.set = value => { current = new Date(value); };
  now.advance = milliseconds => { current = new Date(current.getTime() + milliseconds); };
  return now;
}

function makeUuid(...ids) {
  let index = 0;
  return () => {
    if (index >= ids.length) throw new Error('Deterministic UUID queue exhausted');
    return ids[index++];
  };
}

module.exports = { SAMPLE_IDS, makeBudget, makeV1Budget: makeBudget, makeV2Budget, MemoryStorage, makeClock, makeUuid };
