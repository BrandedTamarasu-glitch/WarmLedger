// Budget view - form rendering and interaction

const BudgetView = {
  currentMonth: null,
  collapsedCategories: new Map(),

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

  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  focusEditControl(type, id) {
    requestAnimationFrame(() => {
      const control = [...document.querySelectorAll('.btn-edit')]
        .find(button => button.dataset.editType === type && button.dataset.recordId === id);
      if (control) control.focus();
    });
  },

  // ---- Paychecks ----
  renderPaychecks() {
    const month = Store.getMonth(this.currentMonth);
    const container = document.getElementById('paychecks-list');

    if (month.paychecks.length === 0) {
      container.replaceChildren(this.element('div', 'muted-text', 'No paychecks added yet. Click “Add Paycheck” to start.'));
      return;
    }
    container.replaceChildren();
    month.paychecks.forEach(p => {
      const remaining = Store.calcPaycheckRemaining(this.currentMonth, p.id);
      let remClass = 'zero';
      if (remaining > 0.01) remClass = 'positive';
      else if (remaining < -0.01) remClass = 'negative';
      const card = this.element('div', 'paycheck-card'); card.dataset.id = p.id;
      const header = this.element('div', 'paycheck-header'); const identity = this.element('div');
      identity.append(this.element('div', 'paycheck-earner', p.earner), this.element('div', 'paycheck-date', p.date));
      const actions = this.element('div', 'paycheck-actions'); actions.append(this.element('div', 'paycheck-amount', this.fmt(p.amount)));
      const editButton = this.element('button', 'btn btn-sm btn-edit', 'Edit'); editButton.type = 'button';
      editButton.dataset.editType = 'paycheck'; editButton.dataset.recordId = p.id;
      editButton.setAttribute('aria-label', `Edit paycheck for ${p.earner}`);
      editButton.addEventListener('click', () => this.showPaycheckModal(p)); actions.append(editButton);
      const button = this.element('button', 'btn-delete', '×'); button.type = 'button'; button.setAttribute('aria-label', `Delete paycheck for ${p.earner}`);
      button.addEventListener('click', () => this.deletePaycheck(p.id)); actions.append(button); header.append(identity, actions);
      const remainder = this.element('div', 'paycheck-remaining'); remainder.append(this.element('span', '', 'Remaining'), this.element('span', `paycheck-remaining-value ${remClass}`, this.fmt(remaining)));
      card.append(header, remainder); container.append(card);
    });
  },

  showPaycheckModal(existing) {
    const earners = Store.getEarners();
    const title = existing ? 'Edit Paycheck' : 'Add Paycheck';

    App.showModal(title, `
      <div class="form-group">
        <label for="field-earner">Earner</label>
        <select id="field-earner"></select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="field-amount">Amount (net/take-home)</label>
          <input type="number" id="field-amount" step="0.01" min="0.01" max="1000000000000" required>
        </div>
        <div class="form-group">
          <label for="field-date">Pay Date</label>
          <input type="date" id="field-date">
        </div>
      </div>
    `, () => {
      const earnerId = document.getElementById('field-earner').value;
      const amountInput = document.getElementById('field-amount');
      if (!amountInput.reportValidity()) return false;
      const amount = Number(amountInput.value);
      const date = document.getElementById('field-date').value;

      const updates = { amount, date };
      if (!existing || earnerId !== existing.earnerId) updates.earnerId = earnerId;
      return App.runMutation(() => existing
        ? Store.editPaycheck(this.currentMonth, existing.id, updates)
        : Store.addPaycheck(this.currentMonth, { earnerId, amount, date }),
      { onSuccess: () => {
        this.render();
        if (existing) this.focusEditControl('paycheck', existing.id);
      } });
    });
    document.getElementById('modal-save').disabled = false;
    const earnerSelect = document.getElementById('field-earner');
    const currentEarner = existing ? Store.getEarner(existing.earnerId) : null;
    if (currentEarner && currentEarner.archived) {
      const option = document.createElement('option'); option.value = currentEarner.id;
      option.textContent = `${currentEarner.name} (Archived)`; option.selected = true; earnerSelect.append(option);
    }
    earners.forEach(earner => {
      const option = document.createElement('option'); option.value = earner.id; option.textContent = earner.name;
      option.selected = Boolean(existing && existing.earnerId === earner.id); earnerSelect.append(option);
    });
    if (!earnerSelect.options.length) {
      const option = document.createElement('option'); option.textContent = 'No active earners available'; option.disabled = true; option.selected = true;
      earnerSelect.append(option); document.getElementById('modal-save').disabled = true;
    }
    document.getElementById('field-amount').value = existing ? existing.amount : '';
    document.getElementById('field-date').value = existing ? existing.date : '';
  },

  deletePaycheck(id) {
    if (confirm('Delete this paycheck?')) {
      App.runMutation(() => Store.deletePaycheck(this.currentMonth, id), { onSuccess: () => this.render(), onFailure: () => this.render() });
    }
  },

  // ---- Expenses ----

  getPaycheckShortLabel(paycheck) {
    const datePart = paycheck.date ? new Date(paycheck.date + 'T00:00:00').getDate() : '?';
    return `${paycheck.earner} (${datePart})`;
  },

  renderExpenses() {
    const month = Store.getMonth(this.currentMonth);
    const categories = Store.getCategories({ includeArchived: true });
    const container = document.getElementById('expenses-container');
    const paychecks = month.paychecks;

    // Group expenses by category
    const grouped = new Map();
    categories.forEach(c => { grouped.set(c.name, []); });
    month.expenses.forEach(e => {
      if (!grouped.has(e.category)) grouped.set(e.category, []);
      grouped.get(e.category).push(e);
    });

    container.replaceChildren();
    for (const [categoryLabel, items] of grouped) {
      if (items.length === 0) continue;

      const catProjected = items.reduce((s, e) => s + Store.expenseProjected(e), 0);
      const catActual = items.reduce((s, e) => s + (e.actual || 0), 0);
      const isCollapsed = this.collapsedCategories.get(categoryLabel);

      const group = this.element('div', 'category-group'); group.dataset.category = categoryLabel;
      const header = this.element('button', 'category-header'); header.type = 'button'; header.setAttribute('aria-expanded', String(!isCollapsed));
      const name = this.element('span', 'category-name');
      name.append(this.element('span', `category-toggle ${isCollapsed ? '' : 'open'}`, '▶'), document.createTextNode(categoryLabel), this.element('span', 'category-count', `(${items.length})`));
      header.append(name, this.element('span', 'category-total', `Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}`));
      header.addEventListener('click', () => this.toggleCategory(categoryLabel));
      const itemsContainer = this.element('div', 'category-items'); itemsContainer.hidden = Boolean(isCollapsed);
      const table = this.element('table', 'expense-table'); const head = table.createTHead().insertRow();
      const labels = [['Name', 'col-name'], ...paychecks.map(p => [this.getPaycheckShortLabel(p), 'col-pc']), ['Total', 'col-total'], ['Actual', 'col-actual'], ['Method', 'col-method'], ['Actions', 'col-actions']];
      labels.forEach(([label, cls], index) => { const th = document.createElement('th'); th.className = cls; th.textContent = label;
        if (index > 0 && index <= paychecks.length) th.title = `${paychecks[index - 1].earner} - ${paychecks[index - 1].date}`; head.append(th); });
      const body = table.createTBody(); items.forEach(expense => body.append(this.renderExpenseRow(expense, paychecks)));
      itemsContainer.append(table); group.append(header, itemsContainer); container.append(group);
    }
    if (!container.children.length) container.append(this.element('div', 'muted-text', 'No expenses added yet. Click “Add Expense” to start.'));
  },

  renderExpenseRow(expense, paychecks) {
    const projected = Store.expenseProjected(expense);
    const amounts = expense.paycheckAmounts || {};

    const row = document.createElement('tr'); row.dataset.id = expense.id;
    const name = row.insertCell(); name.className = 'col-name'; name.textContent = expense.name;
    paychecks.forEach(paycheck => {
      const cell = row.insertCell(); cell.className = 'col-pc'; const input = document.createElement('input');
      input.type = 'number'; input.step = '0.01'; input.placeholder = '0'; input.value = amounts[paycheck.id] || '';
      input.min = '0'; input.max = '1000000000000';
      input.addEventListener('change', () => input.reportValidity() ? this.updatePaycheckAmount(expense.id, paycheck.id, input.value) : this.rejectAmount()); cell.append(input);
    });
    const total = row.insertCell(); total.className = 'col-total expense-total'; total.textContent = this.fmt(projected);
    const actualCell = row.insertCell(); actualCell.className = 'col-actual'; const actual = document.createElement('input');
    actual.type = 'number'; actual.step = '0.01'; actual.placeholder = '0.00'; actual.value = expense.actual || '';
    actual.min = '0'; actual.max = '1000000000000';
    actual.addEventListener('change', () => actual.reportValidity() ? this.updateExpenseField(expense.id, 'actual', actual.value) : this.rejectAmount()); actualCell.append(actual);
    const methodCell = row.insertCell(); methodCell.className = 'col-method'; const method = document.createElement('select');
    [['bank', 'Bank'], ['credit_card', 'Credit Card'], ['savings', 'Savings'], ['investments', 'Investments']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = expense.paymentMethod === value; method.append(option);
    });
    method.addEventListener('change', () => this.updateExpenseField(expense.id, 'paymentMethod', method.value)); methodCell.append(method);
    const actionCell = row.insertCell(); actionCell.className = 'col-actions';
    const editButton = this.element('button', 'btn btn-sm btn-edit', 'Edit'); editButton.type = 'button';
    editButton.dataset.editType = 'expense'; editButton.dataset.recordId = expense.id;
    editButton.setAttribute('aria-label', `Edit ${expense.name}`); editButton.addEventListener('click', () => this.showExpenseModal(expense));
    const deleteButton = this.element('button', 'btn-delete', '×'); deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `Delete ${expense.name}`); deleteButton.addEventListener('click', () => this.deleteExpense(expense.id));
    actionCell.append(editButton, deleteButton);
    return row;
  },

  updatePaycheckAmount(expenseId, paycheckId, value) {
    const amount = Number(value || 0);
    App.runMutation(() => Store.updateExpensePaycheckAmount(this.currentMonth, expenseId, paycheckId, amount), {
      onSuccess: () => { this.refreshTotals(expenseId); this.renderPaychecks(); this.renderAllocation(); this.updateSummary(); },
      onFailure: () => this.render()
    });
  },

  refreshTotals(expenseId) {
    const month = Store.getMonth(this.currentMonth);
    const expense = month.expenses.find(e => e.id === expenseId);
    if (!expense) return;

    const row = [...document.querySelectorAll('tr[data-id]')].find(item => item.dataset.id === expenseId);
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
      if (g.dataset.category === expense.category) {
        const totalEl = g.querySelector('.category-total');
        if (totalEl) totalEl.textContent = `Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}`;
      }
    });
  },

  updateExpenseField(id, field, value) {
    if (field === 'actual') {
      value = parseFloat(value) || 0;
    }
    App.runMutation(() => Store.updateExpense(this.currentMonth, id, { [field]: value }), {
      onSuccess: () => {
        if (field === 'actual') this.refreshTotals(id);
        this.renderPaychecks(); this.renderAllocation(); this.updateSummary();
      },
      onFailure: () => this.render()
    });
  },

  toggleCategory(name) {
    this.collapsedCategories.set(name, !this.collapsedCategories.get(name));
    this.renderExpenses();
  },

  showExpenseModal(existing) {
    const categories = Store.getCategories();
    const title = existing ? 'Edit Expense' : 'Add Expense';

    App.showModal(title, `
      <div class="form-group">
        <label for="field-category">Category</label>
        <select id="field-category"></select>
      </div>
      <div class="form-group" id="preset-group">
        <label for="field-preset">Preset Item (or type custom below)</label>
        <select id="field-preset">
          <option value="">-- Custom --</option>
        </select>
      </div>
      <div class="form-group">
        <label for="field-name">Name</label>
        <input type="text" id="field-name" maxlength="120" placeholder="Expense name" required>
      </div>
      <div class="form-group">
        <label for="field-method">Payment Method</label>
        <select id="field-method">
          <option value="bank">Bank</option>
          <option value="credit_card">Credit Card</option>
          <option value="savings">Savings</option>
          <option value="investments">Investments</option>
        </select>
      </div>
    `, () => {
      const categoryId = document.getElementById('field-category').value;
      const categoryItemId = document.getElementById('field-preset').value || null;
      const customName = document.getElementById('field-name').value.trim();
      const paymentMethod = document.getElementById('field-method').value;

      if (categoryItemId === null && (!customName || customName.length > 120)) { document.getElementById('field-name').reportValidity(); return false; }
      const updates = { paymentMethod };
      const structureChanged = !existing || categoryId !== existing.categoryId || categoryItemId !== existing.categoryItemId;
      if (structureChanged) Object.assign(updates, { categoryId, categoryItemId, name: customName });
      else if (categoryItemId === null && customName !== existing.name) updates.name = customName;
      return App.runMutation(() => existing
        ? Store.editExpense(this.currentMonth, existing.id, updates)
        : Store.addExpense(this.currentMonth, {
          categoryId, categoryItemId, name: customName, paycheckAmounts: {},
          actual: 0,
          paymentMethod
        }), { onSuccess: () => {
          this.render();
          if (existing) this.focusEditControl('expense', existing.id);
      } });
    });
    document.getElementById('modal-save').disabled = false;

    const categorySelect = document.getElementById('field-category');
    const currentCategory = existing ? Store.getCategory(existing.categoryId) : null;
    if (currentCategory && currentCategory.archived) {
      const option = document.createElement('option'); option.value = currentCategory.id;
      option.textContent = `${currentCategory.name} (Archived)`; option.selected = true; categorySelect.append(option);
    }
    categories.forEach(category => {
      const option = document.createElement('option'); option.value = category.id; option.textContent = category.name;
      option.selected = Boolean(existing && existing.categoryId === category.id); categorySelect.append(option);
    });
    categorySelect.addEventListener('change', () => this.onCategoryChange(null));
    this.onCategoryChange(existing ? existing.categoryItemId : null);

    document.getElementById('field-name').value = existing && existing.categoryItemId === null ? existing.name : '';
    document.getElementById('field-method').value = existing ? existing.paymentMethod : 'bank';
    document.getElementById('field-preset').addEventListener('change', function() {
      const isPreset = Boolean(this.value);
      document.getElementById('field-name').disabled = isPreset;
      document.getElementById('field-name').required = !isPreset;
    });
    if (!categorySelect.options.length) {
      const option = document.createElement('option'); option.textContent = 'No active categories available'; option.disabled = true; option.selected = true;
      categorySelect.append(option); document.getElementById('field-preset').disabled = true; document.getElementById('field-name').disabled = true;
      document.getElementById('modal-save').disabled = true;
    }
  },

  onCategoryChange(existingId = null) {
    const selected = document.getElementById('field-category').value;
    const cat = Store.getCategory(selected);
    const presetEl = document.getElementById('field-preset');
    presetEl.replaceChildren();
    const custom = document.createElement('option'); custom.value = ''; custom.textContent = '-- Custom --'; presetEl.append(custom);
    const currentItem = existingId && cat ? Store.getCategoryItem(cat.id, existingId) : null;
    if (currentItem && currentItem.archived) {
      const option = document.createElement('option'); option.value = currentItem.id; option.textContent = `${currentItem.name} (Archived)`;
      option.selected = true; presetEl.append(option);
    }
    if (cat) Store.getCategoryItems(cat.id).forEach(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
      option.selected = item.id === existingId; presetEl.append(option);
    });
    const isPreset = Boolean(presetEl.value);
    document.getElementById('field-name').disabled = isPreset;
    document.getElementById('field-name').required = !isPreset;
  },

  deleteExpense(id) {
    App.runMutation(() => Store.deleteExpense(this.currentMonth, id), { onSuccess: () => this.render(), onFailure: () => this.render() });
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

    const inputs = document.getElementById('allocation-inputs'); inputs.replaceChildren();
    ALLOCATION_TYPES.forEach(type => {
      const item = this.element('div', 'allocation-item'); const label = document.createElement('label'); const input = document.createElement('input');
      input.id = `allocation-${type.key}`; label.htmlFor = input.id; label.textContent = type.label; input.type = 'number'; input.step = '0.01';
      input.min = '0'; input.max = '1000000000000';
      input.value = alloc[type.key] || ''; input.placeholder = '0.00';
      input.addEventListener('change', () => input.reportValidity() ? this.updateAllocation(type.key, input.value) : this.rejectAmount());
      item.append(label, input); inputs.append(item);
    });

    const unallocEl = document.getElementById('allocation-unallocated');
    unallocEl.textContent = this.fmt(unallocated);
    unallocEl.style.color = Math.abs(unallocated) < 0.01 ? 'var(--green)' : 'var(--yellow)';
  },

  updateAllocation(key, value) {
    App.runMutation(() => Store.updateAllocation(this.currentMonth, key, Number(value || 0)), {
      onSuccess: () => { this.renderAllocation(); this.updateSummary(); }, onFailure: () => this.render()
    });
  },

  rejectAmount() {
    App.showErrorCode('AMOUNT_OUT_OF_RANGE');
    this.render();
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
      App.runMutation(() => Store.copyFromMonth(this.currentMonth, prevKey), { onSuccess: () => this.render(), onFailure: () => this.render() });
    }
  },

  clearMonth() {
    if (confirm('Clear all data for this month?')) {
      App.runMutation(() => Store.clearMonth(this.currentMonth), { onSuccess: () => this.render(), onFailure: () => this.render() });
    }
  }
};
