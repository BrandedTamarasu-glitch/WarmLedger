// Budget view - form rendering and interaction

const BudgetView = {
  currentMonth: null,
  collapsedCategories: {},

  init() {
    const now = new Date();
    this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.bindEvents();
    this.render();
  },

  bindEvents() {
    document.getElementById('btn-prev-month').addEventListener('click', () => this.changeMonth(-1));
    document.getElementById('btn-next-month').addEventListener('click', () => this.changeMonth(1));
    document.getElementById('btn-add-paycheck').addEventListener('click', () => this.showPaycheckModal());
    document.getElementById('btn-add-expense').addEventListener('click', () => this.showExpenseModal());
    document.getElementById('btn-copy-prev').addEventListener('click', () => this.copyPreviousMonth());
    document.getElementById('btn-clear-month').addEventListener('click', () => this.clearMonth());
  },

  changeMonth(delta) {
    const [y, m] = this.currentMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    this.render();
  },

  formatMonthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  },

  render() {
    document.getElementById('current-month-label').textContent = this.formatMonthLabel(this.currentMonth);
    this.renderPaychecks();
    this.renderExpenses();
    this.renderAllocation();
    this.updateSummary();
  },

  updateSummary() {
    const s = Store.calcMonthSummary(this.currentMonth);
    document.getElementById('summary-income').textContent = this.fmt(s.totalIncome);
    document.getElementById('summary-budgeted').textContent = this.fmt(s.totalBudgeted);
    const remEl = document.getElementById('summary-remaining');
    remEl.textContent = this.fmt(s.remaining);
    remEl.className = 'summary-value highlight';
    if (s.remaining < 0) remEl.classList.add('negative');
    else if (s.remaining > 0) remEl.classList.add('warning');
  },

  fmt(n) {
    return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  // ---- Paychecks ----
  renderPaychecks() {
    const month = Store.getMonth(this.currentMonth);
    const container = document.getElementById('paychecks-list');

    if (month.paychecks.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:14px;">No paychecks added yet. Click "+ Add Paycheck" to start.</div>';
      return;
    }

    container.innerHTML = month.paychecks.map(p => {
      const remaining = Store.calcPaycheckRemaining(this.currentMonth, p.id);
      let remClass = 'zero';
      if (remaining > 0.01) remClass = 'positive';
      else if (remaining < -0.01) remClass = 'negative';

      return `
        <div class="paycheck-card" data-id="${p.id}">
          <div class="paycheck-header">
            <div>
              <div class="paycheck-earner">${this.esc(p.earner)}</div>
              <div class="paycheck-date">${p.date || ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="paycheck-amount">${this.fmt(p.amount)}</div>
              <button class="btn-delete" onclick="BudgetView.deletePaycheck('${p.id}')" title="Delete">&times;</button>
            </div>
          </div>
          <div class="paycheck-remaining">
            <span>Remaining</span>
            <span class="paycheck-remaining-value ${remClass}">${this.fmt(remaining)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  showPaycheckModal(existing) {
    const earners = Store.getData().settings.earners;
    const title = existing ? 'Edit Paycheck' : 'Add Paycheck';

    App.showModal(title, `
      <div class="form-group">
        <label>Earner</label>
        <select id="field-earner">
          ${earners.map(e => `<option value="${e}" ${existing && existing.earner === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Amount (net/take-home)</label>
          <input type="number" id="field-amount" step="0.01" value="${existing ? existing.amount : ''}">
        </div>
        <div class="form-group">
          <label>Pay Date</label>
          <input type="date" id="field-date" value="${existing ? existing.date : ''}">
        </div>
      </div>
    `, () => {
      const earner = document.getElementById('field-earner').value;
      const amount = parseFloat(document.getElementById('field-amount').value) || 0;
      const date = document.getElementById('field-date').value;

      if (amount <= 0) return;

      if (existing) {
        Store.updatePaycheck(this.currentMonth, existing.id, { earner, amount, date });
      } else {
        Store.addPaycheck(this.currentMonth, { earner, amount, date });
      }
      this.render();
    });
  },

  deletePaycheck(id) {
    if (confirm('Delete this paycheck?')) {
      Store.deletePaycheck(this.currentMonth, id);
      this.render();
    }
  },

  // ---- Expenses ----

  getPaycheckShortLabel(paycheck) {
    const datePart = paycheck.date ? new Date(paycheck.date + 'T00:00:00').getDate() : '?';
    return `${paycheck.earner} (${datePart})`;
  },

  renderExpenses() {
    const month = Store.getMonth(this.currentMonth);
    const categories = Store.getData().categories;
    const container = document.getElementById('expenses-container');
    const paychecks = month.paychecks;

    // Group expenses by category
    const grouped = {};
    categories.forEach(c => { grouped[c.name] = []; });
    month.expenses.forEach(e => {
      if (!grouped[e.category]) grouped[e.category] = [];
      grouped[e.category].push(e);
    });

    // Build table header columns
    let thCols = '<th class="col-name">Name</th>';
    paychecks.forEach(p => {
      thCols += `<th class="col-pc" title="${this.esc(p.earner)} - ${p.date || ''}">${this.esc(this.getPaycheckShortLabel(p))}</th>`;
    });
    thCols += '<th class="col-total">Total</th><th class="col-actual">Actual</th><th class="col-method">Method</th><th class="col-del"></th>';

    let html = '';
    for (const cat of categories) {
      const items = grouped[cat.name] || [];
      if (items.length === 0) continue;

      const catProjected = items.reduce((s, e) => s + Store.expenseProjected(e), 0);
      const catActual = items.reduce((s, e) => s + (e.actual || 0), 0);
      const isCollapsed = this.collapsedCategories[cat.name];

      html += `
        <div class="category-group">
          <div class="category-header" onclick="BudgetView.toggleCategory('${cat.name}')">
            <div class="category-name">
              <span class="category-toggle ${isCollapsed ? '' : 'open'}">&#9654;</span>
              ${this.esc(cat.name)}
              <span style="color:var(--text-muted);font-size:12px;">(${items.length})</span>
            </div>
            <div class="category-total">Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}</div>
          </div>
          <div class="category-items" style="display:${isCollapsed ? 'none' : 'block'}">
            <table class="expense-table">
              <thead><tr>${thCols}</tr></thead>
              <tbody>
                ${items.map(e => this.renderExpenseRow(e, paychecks)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    if (!html) {
      html = '<div style="color:var(--text-muted);font-size:14px;">No expenses added yet. Click "+ Add Expense" to start.</div>';
    }

    container.innerHTML = html;
  },

  renderExpenseRow(expense, paychecks) {
    const projected = Store.expenseProjected(expense);
    const amounts = expense.paycheckAmounts || {};

    let pcCells = '';
    paychecks.forEach(p => {
      const val = amounts[p.id] || '';
      pcCells += `<td class="col-pc"><input type="number" value="${val}" step="0.01" placeholder="0"
        onchange="BudgetView.updatePaycheckAmount('${expense.id}', '${p.id}', this.value)"></td>`;
    });

    return `
      <tr data-id="${expense.id}">
        <td class="col-name">${this.esc(expense.name)}</td>
        ${pcCells}
        <td class="col-total expense-total">${this.fmt(projected)}</td>
        <td class="col-actual"><input type="number" value="${expense.actual || ''}" step="0.01" placeholder="0.00"
          onchange="BudgetView.updateExpenseField('${expense.id}', 'actual', this.value)"></td>
        <td class="col-method"><select onchange="BudgetView.updateExpenseField('${expense.id}', 'paymentMethod', this.value)">
          <option value="bank" ${expense.paymentMethod === 'bank' ? 'selected' : ''}>Bank</option>
          <option value="credit_card" ${expense.paymentMethod === 'credit_card' ? 'selected' : ''}>Credit Card</option>
          <option value="savings" ${expense.paymentMethod === 'savings' ? 'selected' : ''}>Savings</option>
          <option value="investments" ${expense.paymentMethod === 'investments' ? 'selected' : ''}>Investments</option>
        </select></td>
        <td class="col-del"><button class="btn-delete" onclick="BudgetView.deleteExpense('${expense.id}')" title="Delete">&times;</button></td>
      </tr>
    `;
  },

  updatePaycheckAmount(expenseId, paycheckId, value) {
    Store.updateExpensePaycheckAmount(this.currentMonth, expenseId, paycheckId, parseFloat(value) || 0);
    // Re-render totals without full re-render (avoid losing focus)
    this.refreshTotals(expenseId);
    this.renderPaychecks();
    this.renderAllocation();
    this.updateSummary();
  },

  refreshTotals(expenseId) {
    const month = Store.getMonth(this.currentMonth);
    const expense = month.expenses.find(e => e.id === expenseId);
    if (!expense) return;

    const row = document.querySelector(`tr[data-id="${expenseId}"]`);
    if (!row) return;
    const totalCell = row.querySelector('.expense-total');
    if (totalCell) {
      totalCell.textContent = this.fmt(Store.expenseProjected(expense));
    }

    // Update category totals
    const allInCat = month.expenses.filter(e => e.category === expense.category);
    const catProjected = allInCat.reduce((s, e) => s + Store.expenseProjected(e), 0);
    const catActual = allInCat.reduce((s, e) => s + (e.actual || 0), 0);
    const groups = document.querySelectorAll('.category-group');
    groups.forEach(g => {
      const nameEl = g.querySelector('.category-name');
      if (nameEl && nameEl.textContent.includes(expense.category)) {
        const totalEl = g.querySelector('.category-total');
        if (totalEl) totalEl.textContent = `Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}`;
      }
    });
  },

  updateExpenseField(id, field, value) {
    if (field === 'actual') {
      value = parseFloat(value) || 0;
    }
    Store.updateExpense(this.currentMonth, id, { [field]: value });
    if (field === 'actual') {
      this.refreshTotals(id);
    }
    this.renderPaychecks();
    this.renderAllocation();
    this.updateSummary();
  },

  toggleCategory(name) {
    this.collapsedCategories[name] = !this.collapsedCategories[name];
    this.renderExpenses();
  },

  showExpenseModal() {
    const categories = Store.getData().categories;

    App.showModal('Add Expense', `
      <div class="form-group">
        <label>Category</label>
        <select id="field-category" onchange="BudgetView.onCategoryChange()">
          ${categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Preset Item (or type custom below)</label>
        <select id="field-preset">
          <option value="">-- Custom --</option>
          ${categories[0].items.map(i => `<option value="${i}">${i}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="field-name" placeholder="Expense name">
      </div>
      <div class="form-group">
        <label>Payment Method</label>
        <select id="field-method">
          <option value="bank">Bank</option>
          <option value="credit_card">Credit Card</option>
          <option value="savings">Savings</option>
          <option value="investments">Investments</option>
        </select>
      </div>
    `, () => {
      const category = document.getElementById('field-category').value;
      const preset = document.getElementById('field-preset').value;
      const customName = document.getElementById('field-name').value.trim();
      const name = customName || preset;
      const paymentMethod = document.getElementById('field-method').value;

      if (!name) return;

      Store.addExpense(this.currentMonth, {
        category,
        name,
        paycheckAmounts: {},
        actual: 0,
        paymentMethod
      });
      this.render();
    });

    // Wire up preset selection to fill name
    document.getElementById('field-preset').addEventListener('change', function() {
      if (this.value) document.getElementById('field-name').value = this.value;
    });
  },

  onCategoryChange() {
    const categories = Store.getData().categories;
    const selected = document.getElementById('field-category').value;
    const cat = categories.find(c => c.name === selected);
    const presetEl = document.getElementById('field-preset');
    presetEl.innerHTML = '<option value="">-- Custom --</option>' +
      (cat ? cat.items.map(i => `<option value="${i}">${i}</option>`).join('') : '');
  },

  deleteExpense(id) {
    Store.deleteExpense(this.currentMonth, id);
    this.render();
  },

  // ---- Allocation ----
  renderAllocation() {
    const summary = Store.calcMonthSummary(this.currentMonth);
    const section = document.getElementById('allocation-section');
    const month = Store.getMonth(this.currentMonth);
    const expenseRemaining = summary.totalIncome - summary.totalProjected;

    if (expenseRemaining <= 0 && summary.totalProjected > 0) {
      section.style.display = 'none';
      return;
    }

    if (summary.totalIncome === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    document.getElementById('allocation-remaining').textContent = this.fmt(expenseRemaining);

    const alloc = month.allocations || { savings: 0, credit_card_debt: 0, investments: 0 };
    const allocTotal = Object.values(alloc).reduce((s, v) => s + (v || 0), 0);
    const unallocated = expenseRemaining - allocTotal;

    document.getElementById('allocation-inputs').innerHTML = ALLOCATION_TYPES.map(t => `
      <div class="allocation-item">
        <label>${t.label}</label>
        <input type="number" step="0.01" value="${alloc[t.key] || ''}" placeholder="0.00"
          onchange="BudgetView.updateAllocation('${t.key}', this.value)">
      </div>
    `).join('');

    const unallocEl = document.getElementById('allocation-unallocated');
    unallocEl.textContent = this.fmt(unallocated);
    unallocEl.style.color = Math.abs(unallocated) < 0.01 ? 'var(--green)' : 'var(--yellow)';
  },

  updateAllocation(key, value) {
    const month = Store.getMonth(this.currentMonth);
    const alloc = month.allocations || { savings: 0, credit_card_debt: 0, investments: 0 };
    alloc[key] = parseFloat(value) || 0;
    Store.updateAllocations(this.currentMonth, alloc);
    this.renderAllocation();
    this.updateSummary();
  },

  // ---- Copy / Clear ----
  copyPreviousMonth() {
    const [y, m] = this.currentMonth.split('-').map(Number);
    const prev = new Date(y, m - 2, 1);
    const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const prevMonth = Store.getMonth(prevKey);

    if (prevMonth.expenses.length === 0) {
      alert(`No data found for ${this.formatMonthLabel(prevKey)}`);
      return;
    }

    if (confirm(`Copy budget template from ${this.formatMonthLabel(prevKey)}? This will overwrite current month's data.`)) {
      Store.copyFromMonth(this.currentMonth, prevKey);
      this.render();
    }
  },

  clearMonth() {
    if (confirm('Clear all data for this month?')) {
      Store.clearMonth(this.currentMonth);
      this.render();
    }
  },

  esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
};
