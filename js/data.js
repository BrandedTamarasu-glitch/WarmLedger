// Data layer - models, storage, import/export
//
// Expense model:
//   { id, category, name, paycheckAmounts: { [paycheckId]: number }, actual, paymentMethod }
//   "projected" total = sum of all paycheckAmounts values

const DEFAULT_CATEGORIES = [
  {
    name: 'Housing',
    items: ['Mortgage/Rent', 'Phone', 'Electricity', 'Gas', 'Waste Management', 'Water & Sewage', 'HOA', 'Cable/Internet', 'Security']
  },
  {
    name: 'Transportation',
    items: ['Car Insurance', 'Licensing', 'Fuel', 'Maintenance', 'Toll']
  },
  {
    name: 'Insurance',
    items: ['Medical (Family)', 'Pet Insurance']
  },
  {
    name: 'Food',
    items: ['Costco', 'Groceries', 'Butcher', 'T&T', 'Box of Good']
  },
  {
    name: 'Pets',
    items: ['Supplies']
  },
  {
    name: 'Personal Care',
    items: ['Medical', 'Hair/Nails', 'Clothing']
  },
  {
    name: 'Misc',
    items: ['Weekend Fun', 'Buffer']
  },
  {
    name: 'Loans/Debt',
    items: ['Credit Card (Chase)', 'Credit Card (First Tech)']
  },
  {
    name: 'Taxes',
    items: ['Federal', 'State', 'Local', 'Other']
  },
  {
    name: 'Subscriptions',
    items: ['YouTube Premium', 'Amazon', 'Newsgroup Ninja', '1Password']
  },
  {
    name: 'Other',
    items: ['ZepBound', 'Sheppard Allowance']
  }
];

const ALLOCATION_TYPES = [
  { key: 'savings', label: 'Savings' },
  { key: 'credit_card_debt', label: 'Credit Card Debt' },
  { key: 'investments', label: 'Investments' }
];

const STORAGE_KEY = 'zeroBudget_data';

const Store = {
  _data: null,

  _defaults() {
    return {
      categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
      months: {},
      settings: {
        earners: ['Cory', 'Sara']
      }
    };
  },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this._data = JSON.parse(raw);
        if (!this._data.categories) {
          this._data.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
        }
        if (!this._data.settings) {
          this._data.settings = { earners: ['Cory', 'Sara'] };
        }
        this._migrateExpenses();
      } else if (window.BUDGET_SEED_DATA) {
        // Seed from saved-data.js file (survives browser data clears)
        this._data = JSON.parse(JSON.stringify(window.BUDGET_SEED_DATA));
        this._migrateExpenses();
        this.save();
      } else {
        this._data = this._defaults();
      }
    } catch {
      this._data = this._defaults();
    }
    return this._data;
  },

  _migrateExpenses() {
    for (const mk of Object.keys(this._data.months)) {
      const month = this._data.months[mk];
      if (!month.expenses) continue;
      month.expenses.forEach(e => {
        if (e.paycheckId !== undefined && !e.paycheckAmounts) {
          e.paycheckAmounts = {};
          if (e.paycheckId && e.projected) {
            e.paycheckAmounts[e.paycheckId] = e.projected;
          }
          delete e.paycheckId;
          delete e.projected;
        }
      });
    }
  },

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
  },

  getData() {
    if (!this._data) this.load();
    return this._data;
  },

  // Month helpers
  getMonth(monthKey) {
    const data = this.getData();
    if (!data.months[monthKey]) {
      data.months[monthKey] = {
        paychecks: [],
        expenses: [],
        allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
      };
      this.save();
    }
    return data.months[monthKey];
  },

  getAllMonthKeys() {
    return Object.keys(this.getData().months).sort();
  },

  // Get projected total for an expense (sum of paycheckAmounts)
  expenseProjected(expense) {
    if (!expense.paycheckAmounts) return 0;
    return Object.values(expense.paycheckAmounts).reduce((s, v) => s + (v || 0), 0);
  },

  // Paycheck CRUD
  addPaycheck(monthKey, paycheck) {
    const month = this.getMonth(monthKey);
    paycheck.id = crypto.randomUUID();
    month.paychecks.push(paycheck);
    this.save();
    return paycheck;
  },

  updatePaycheck(monthKey, id, updates) {
    const month = this.getMonth(monthKey);
    const idx = month.paychecks.findIndex(p => p.id === id);
    if (idx >= 0) {
      Object.assign(month.paychecks[idx], updates);
      this.save();
    }
  },

  deletePaycheck(monthKey, id) {
    const month = this.getMonth(monthKey);
    month.paychecks = month.paychecks.filter(p => p.id !== id);
    // Remove this paycheck's amounts from expenses
    month.expenses.forEach(e => {
      if (e.paycheckAmounts) {
        delete e.paycheckAmounts[id];
      }
    });
    this.save();
  },

  // Expense CRUD
  addExpense(monthKey, expense) {
    const month = this.getMonth(monthKey);
    expense.id = crypto.randomUUID();
    if (!expense.paycheckAmounts) expense.paycheckAmounts = {};
    month.expenses.push(expense);
    this.save();
    return expense;
  },

  updateExpense(monthKey, id, updates) {
    const month = this.getMonth(monthKey);
    const idx = month.expenses.findIndex(e => e.id === id);
    if (idx >= 0) {
      Object.assign(month.expenses[idx], updates);
      this.save();
    }
  },

  updateExpensePaycheckAmount(monthKey, expenseId, paycheckId, amount) {
    const month = this.getMonth(monthKey);
    const expense = month.expenses.find(e => e.id === expenseId);
    if (expense) {
      if (!expense.paycheckAmounts) expense.paycheckAmounts = {};
      expense.paycheckAmounts[paycheckId] = amount;
      this.save();
    }
  },

  deleteExpense(monthKey, id) {
    const month = this.getMonth(monthKey);
    month.expenses = month.expenses.filter(e => e.id !== id);
    this.save();
  },

  // Allocations
  updateAllocations(monthKey, allocations) {
    const month = this.getMonth(monthKey);
    month.allocations = allocations;
    this.save();
  },

  // Copy previous month's budget as template
  copyFromMonth(targetKey, sourceKey) {
    const source = this.getMonth(sourceKey);
    const target = this.getMonth(targetKey);

    // Copy paychecks (new IDs, keep structure)
    const idMap = {};
    target.paychecks = source.paychecks.map(p => {
      const newId = crypto.randomUUID();
      idMap[p.id] = newId;
      return { ...p, id: newId };
    });

    // Copy expenses, remap paycheck IDs, zero out actuals
    target.expenses = source.expenses.map(e => {
      const newAmounts = {};
      if (e.paycheckAmounts) {
        for (const [pid, amt] of Object.entries(e.paycheckAmounts)) {
          const newPid = idMap[pid];
          if (newPid) newAmounts[newPid] = amt;
        }
      }
      return {
        ...e,
        id: crypto.randomUUID(),
        actual: 0,
        paycheckAmounts: newAmounts
      };
    });

    target.allocations = { savings: 0, credit_card_debt: 0, investments: 0 };
    this.save();
  },

  clearMonth(monthKey) {
    const data = this.getData();
    data.months[monthKey] = {
      paychecks: [],
      expenses: [],
      allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
    };
    this.save();
  },

  // Calculations
  calcMonthSummary(monthKey) {
    const month = this.getMonth(monthKey);
    const totalIncome = month.paychecks.reduce((s, p) => s + (p.amount || 0), 0);
    const totalProjected = month.expenses.reduce((s, e) => s + this.expenseProjected(e), 0);
    const totalActual = month.expenses.reduce((s, e) => s + (e.actual || 0), 0);
    const totalAllocated = Object.values(month.allocations || {}).reduce((s, v) => s + (v || 0), 0);
    const totalBudgeted = totalProjected + totalAllocated;
    const remaining = totalIncome - totalBudgeted;

    return { totalIncome, totalProjected, totalActual, totalAllocated, totalBudgeted, remaining };
  },

  calcPaycheckRemaining(monthKey, paycheckId) {
    const month = this.getMonth(monthKey);
    const paycheck = month.paychecks.find(p => p.id === paycheckId);
    if (!paycheck) return 0;
    const assigned = month.expenses.reduce((s, e) => {
      return s + ((e.paycheckAmounts && e.paycheckAmounts[paycheckId]) || 0);
    }, 0);
    return paycheck.amount - assigned;
  },

  calcCategoryTotals(monthKey) {
    const month = this.getMonth(monthKey);
    const totals = {};
    month.expenses.forEach(e => {
      if (!totals[e.category]) totals[e.category] = { projected: 0, actual: 0 };
      totals[e.category].projected += this.expenseProjected(e);
      totals[e.category].actual += (e.actual || 0);
    });
    return totals;
  },

  calcPaymentMethodTotals(monthKey) {
    const month = this.getMonth(monthKey);
    const totals = { bank: 0, credit_card: 0, savings: 0, investments: 0 };
    month.expenses.forEach(e => {
      const method = e.paymentMethod || 'bank';
      totals[method] = (totals[method] || 0) + (e.actual || this.expenseProjected(e) || 0);
    });
    return totals;
  },

  // Export / Import
  exportData() {
    return JSON.stringify(this.getData(), null, 2);
  },

  importData(jsonStr) {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.months) throw new Error('Invalid budget data');
    this._data = parsed;
    this._migrateExpenses();
    this.save();
  }
};
