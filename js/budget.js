// Budget view - form rendering and interaction

const BudgetView = {
  currentMonth: null,
  collapsedCategories: new Map(),

  init() {
    const now = new Date();
    this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.prepareFocusHeadings();
    this.bindEvents();
    this.render();
  },

  prepareFocusHeadings() {
    const paycheckHeading = document.querySelector('#paychecks-list')?.closest('section')?.querySelector('h3');
    const expenseHeading = document.querySelector('#expenses-container')?.closest('section')?.querySelector('h3');
    if (paycheckHeading) { paycheckHeading.id = 'paychecks-heading'; paycheckHeading.tabIndex = -1; }
    if (expenseHeading) { expenseHeading.id = 'expenses-heading'; expenseHeading.tabIndex = -1; }
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
    this.renderMonthlyReview();
  },

  updateSummary() {
    const s = Store.calcMonthSummary(this.currentMonth);
    const planning = this.planningTotals(s);
    document.getElementById('summary-income').textContent = this.fmt(planning.income);
    document.getElementById('summary-budgeted').textContent = this.fmt(planning.budgeted);
    const remEl = document.getElementById('summary-remaining');
    remEl.textContent = this.fmt(planning.remaining);
    remEl.className = 'summary-value highlight';
    if (planning.remaining < 0) remEl.classList.add('negative');
    else if (planning.remaining > 0) remEl.classList.add('warning');
  },

  planningTotals(summary) {
    const income = summary.totalPlannedIncome;
    const expenses = summary.totalPlannedExpenses;
    const allocated = summary.totalAllocated;
    return {
      income,
      expenses,
      expenseRemaining: income - expenses,
      budgeted: expenses + allocated,
      remaining: income - expenses - allocated
    };
  },

  allocationAvailable(summary) {
    const planning = this.planningTotals(summary);
    return planning.income !== 0 && !(planning.expenseRemaining <= 0 && planning.expenses > 0);
  },

  fmt(n) {
    return '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  actualAmount(record) {
    return record.actualAmount;
  },

  optionalAmount(input) {
    return input.value === '' ? null : Number(input.value);
  },

  appendRecordMarkers(container, record, { needsAllocation = false } = {}) {
    if (Object.hasOwn(record, 'sourceTemplateId') && record.sourceTemplateId !== null) {
      container.append(this.element('span', 'record-marker', ' · From template'));
    }
    if (needsAllocation) container.append(this.element('span', 'record-marker record-warning', ' · Needs allocation'));
  },

  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  reviewActualLabel(group) {
    if (group.completeActualTotal === null) {
      return `${this.fmt(group.enteredActualTotal)} entered (partial; ${group.unresolvedCount} not entered)`;
    }
    return this.fmt(group.completeActualTotal);
  },

  reviewCashFlowLabel(value) {
    return value === null ? 'Incomplete' : this.fmt(value);
  },

  reviewAction(label, targetId) {
    const button = this.element('button', 'btn btn-sm monthly-review-action', label); button.type = 'button';
    button.addEventListener('click', () => document.getElementById(targetId)?.click());
    return button;
  },

  reviewPreviewAction() {
    const button = this.element('button', 'btn btn-sm monthly-review-action', 'Preview recurring items'); button.type = 'button';
    button.addEventListener('click', () => App.openRecurringPreview(button));
    return button;
  },

  reviewPayPeriodsAction() {
    const button = this.element('button', 'btn btn-sm monthly-review-action', 'View by paycheck'); button.type = 'button';
    button.addEventListener('click', () => App.switchView('transfers')); return button;
  },

  reviewGroup(wrapper, id, title, kind = '') {
    const section = this.element('section', `monthly-review-group${kind ? ` monthly-review-${kind}` : ''}`);
    const heading = this.element('h4', '', title); heading.id = id; heading.tabIndex = -1;
    section.setAttribute('aria-labelledby', id); section.append(heading); wrapper.append(section); return section;
  },

  reviewMetric(container, label, value, tone = '') {
    const metric = this.element('div', `monthly-review-metric${tone ? ` ${tone}` : ''}`);
    metric.append(this.element('span', 'monthly-review-metric-label', label), this.element('strong', 'monthly-review-metric-value', value));
    container.append(metric);
  },

  reviewDestination(list, label, value, tone = '') {
    const item = this.element('div', `monthly-review-destination${tone ? ` ${tone}` : ''}`);
    item.append(this.element('dt', '', label), this.element('dd', '', value)); list.append(item);
  },

  reviewDrilldown(section, label) {
    const details = this.element('details', 'monthly-review-drilldown');
    details.append(this.element('summary', '', label)); section.append(details); return details;
  },

  renderMonthlyReview() {
    const container = document.getElementById('monthly-review-container');
    if (!container) return;
    const review = Store.getMonthReview(this.currentMonth);
    const wrapper = this.element('div', 'monthly-review');
    const heading = this.element('h3', '', 'Monthly Review'); heading.id = 'monthly-review-heading'; heading.tabIndex = -1;
    const header = this.element('div', 'monthly-review-header');
    const statusText = review.empty ? 'Not started' : review.states.ready ? 'Ready' : 'Needs attention';
    const statusTone = review.empty ? 'state-empty' : review.states.ready ? 'state-ready' : 'state-attention';
    header.append(heading, this.element('span', `monthly-review-status ${statusTone}`, statusText)); wrapper.append(header);

    const states = this.element('ul', 'monthly-review-states');
    const stateText = [];
    if (review.states.needsRecurringReview) stateText.push('Recurring items need review.');
    if (review.states.needsActuals) stateText.push('Actual amounts are not entered for every item.');
    if (review.states.needsAllocation) stateText.push('Some planned expenses need paycheck funding.');
    if (review.states.ready) stateText.push('Monthly review is ready.');
    if (review.empty) stateText.push('This month is empty and is not ready.');
    stateText.forEach(text => states.append(this.element('li', '', text))); wrapper.append(states);

    const grid = this.element('div', 'monthly-review-grid'); wrapper.append(grid);
    const recurring = this.reviewGroup(grid, 'monthly-review-recurring-heading', 'Recurring items', 'tile-recurring');
    const recurringMetrics = this.element('div', 'monthly-review-metrics');
    this.reviewMetric(recurringMetrics, 'Pending', String(review.recurring.pendingCount), review.recurring.pendingCount ? 'metric-attention' : '');
    this.reviewMetric(recurringMetrics, 'Conflicts', String(review.recurring.conflictCount), review.recurring.conflictCount ? 'metric-attention' : '');
    recurring.append(recurringMetrics);
    if (review.recurring.pendingCount || review.recurring.conflictCount) recurring.append(this.reviewPreviewAction());

    if (review.empty) {
      const empty = this.reviewGroup(grid, 'monthly-review-empty-heading', 'Start this month', 'tile-start');
      empty.append(this.element('p', '', 'Add records or bring forward a prior plan before reviewing this month.'));
      const actions = this.element('div', 'monthly-review-actions');
      actions.append(
        this.reviewAction('Add paycheck', 'btn-add-paycheck'),
        this.reviewAction('Add expense', 'btn-add-expense'),
        this.reviewPreviewAction(),
        this.reviewAction('Copy previous month', 'btn-copy-prev')
      );
      empty.append(actions); container.replaceChildren(wrapper); return;
    }

    const payPeriodPlan = Store.getPayPeriodPlan(this.currentMonth);
    const destinations = this.reviewGroup(grid, 'monthly-review-destinations-heading', 'Planned payment guidance', 'tile-destinations');
    const destinationList = this.element('dl', 'monthly-review-destination-list');
    const methodTotals = payPeriodPlan.summary.methodFundingTotals;
    this.reviewDestination(destinationList, 'Keep in bank for assigned bills', this.fmt(methodTotals.bank), 'destination-bank');
    this.reviewDestination(destinationList, 'Plan for credit card bills', this.fmt(methodTotals.credit_card), 'destination-card');
    this.reviewDestination(destinationList, 'Plan for savings-funded bills', this.fmt(methodTotals.savings));
    this.reviewDestination(destinationList, 'Plan for investment-funded bills', this.fmt(methodTotals.investments));
    destinations.append(destinationList);
    if (payPeriodPlan.summary.billsNeedingFundingAmount > 0.009) destinations.append(this.element('p', 'monthly-review-compact-note',
      `Bills still needing paycheck funding: ${this.fmt(payPeriodPlan.summary.billsNeedingFundingAmount)}.`));
    destinations.append(this.element('p', 'monthly-review-compact-note',
      'Assigned bills only. Monthly remaining-funds allocations are separate. No payment or transfer is performed.'));
    destinations.append(this.reviewPayPeriodsAction());

    this.renderReviewActualGroup(grid, 'income', review.income);
    this.renderReviewActualGroup(grid, 'expense', review.expenses);

    const funding = this.reviewGroup(grid, 'monthly-review-funding-heading', 'Expense funding', 'tile-funding');
    const fundingMetrics = this.element('div', 'monthly-review-metrics');
    this.reviewMetric(fundingMetrics, 'Needs attention', String(review.funding.issueCount), review.funding.issueCount ? 'metric-attention' : 'metric-positive');
    funding.append(fundingMetrics);
    if (!review.funding.issueCount) funding.append(this.element('p', 'monthly-review-compact-note', 'Every expense is funded.'));
    else {
      const drilldown = this.reviewDrilldown(funding, `Review ${review.funding.issueCount} funding ${review.funding.issueCount === 1 ? 'issue' : 'issues'}`);
      const list = this.element('ul', 'monthly-review-list');
      review.funding.issues.forEach(issue => {
        const item = this.element('li', 'monthly-review-item');
        const difference = issue.shortfall > 0 ? `Needs ${this.fmt(issue.shortfall)}` : `Over-assigned by ${this.fmt(Math.abs(issue.shortfall))}`;
        item.append(this.element('span', '', `${issue.name} — ${issue.category}: ${difference}.`));
        const button = this.element('button', 'btn btn-sm monthly-review-action', `Edit funding for ${issue.name}`); button.type = 'button';
        button.dataset.reviewKind = 'funding'; button.dataset.recordId = issue.expenseId;
        button.addEventListener('click', () => this.openReviewEditor('expense', issue.expenseId, button, { kind: 'funding', id: issue.expenseId }));
        item.append(button); list.append(item);
      });
      drilldown.append(list);
    }

    const balance = this.reviewGroup(grid, 'monthly-review-balance-heading', 'Balance', 'tile-balance');
    const balanceMetrics = this.element('div', 'monthly-review-metrics monthly-review-metrics-three');
    this.reviewMetric(balanceMetrics, 'Planned remainder', this.fmt(review.balance.plannedRemainder), 'metric-primary');
    this.reviewMetric(balanceMetrics, 'Actual cash flow', this.reviewCashFlowLabel(review.balance.actualCashFlow));
    this.reviewMetric(balanceMetrics, 'Allocations', this.fmt(review.balance.allocationsTotal));
    balance.append(balanceMetrics);

    container.replaceChildren(wrapper);
  },

  renderReviewActualGroup(wrapper, kind, group) {
    const isIncome = kind === 'income';
    const title = isIncome ? 'Actual income' : 'Actual expenses';
    const section = this.reviewGroup(wrapper, `monthly-review-${kind}-heading`, title, `tile-${kind}`);
    const metrics = this.element('div', 'monthly-review-metrics');
    this.reviewMetric(metrics, 'Planned', this.fmt(group.plannedTotal));
    this.reviewMetric(metrics, 'Actual', this.reviewActualLabel(group), group.unresolvedCount ? 'metric-attention' : 'metric-positive');
    section.append(metrics);
    if (!group.unresolvedCount) { section.append(this.element('p', 'monthly-review-compact-note', 'All actuals entered.')); return; }
    const drilldown = this.reviewDrilldown(section, `Enter ${group.unresolvedCount} missing ${isIncome ? 'income' : 'expense'} ${group.unresolvedCount === 1 ? 'actual' : 'actuals'}`);
    const list = this.element('ul', 'monthly-review-list');
    group.unresolved.forEach(record => {
      const item = this.element('li', 'monthly-review-item');
      const label = isIncome ? record.earner : `${record.name} — ${record.category}`;
      item.append(this.element('span', '', `${label}, ${record.date || 'no date'}: Not entered (planned ${this.fmt(record.plannedAmount)}).`));
      const buttonLabel = `Enter actual ${isIncome ? 'income' : 'expense'} for ${label}, ${record.date || 'no date'}`;
      const button = this.element('button', 'btn btn-sm monthly-review-action', buttonLabel); button.type = 'button';
      button.dataset.reviewKind = kind; button.dataset.recordId = record.id;
      button.addEventListener('click', () => this.openReviewEditor(kind, record.id, button)); item.append(button); list.append(item);
    });
    drilldown.append(list);
  },

  reviewDetail(list, term, value) {
    list.append(this.element('dt', '', term), this.element('dd', '', value));
  },

  openReviewEditor(kind, id, trigger, reviewFocus = { kind, id }) {
    const month = Store.getMonth(this.currentMonth);
    const records = kind === 'income' ? month.paychecks : month.expenses;
    const record = records.find(item => item.id === id);
    if (!record) { this.renderMonthlyReview(); this.restoreReviewFocus(reviewFocus.kind, reviewFocus.id); return; }
    if (kind === 'income') this.showPaycheckModal(record, reviewFocus);
    else this.showExpenseModal(record, reviewFocus);
  },

  restoreReviewFocus(kind, id) {
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll('[data-review-kind][data-record-id]')];
      const target = controls.find(control => control.dataset.reviewKind === kind && control.dataset.recordId === id);
      (target || document.getElementById(`monthly-review-${kind}-heading`))?.focus({ preventScroll: true });
    });
  },

  focusEditControl(type, id) {
    requestAnimationFrame(() => {
      const control = [...document.querySelectorAll('.btn-edit')]
        .find(button => button.dataset.editType === type && button.dataset.recordId === id);
      if (control) control.focus();
    });
  },

  focusMoveControl(type, action, id) {
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll('[data-move-type][data-move-action]')];
      const sameRecord = control => !control.disabled && control.dataset.moveType === type && control.dataset.recordId === id;
      const requested = controls.find(control => sameRecord(control) && control.dataset.moveAction === action);
      const fallback = controls.find(sameRecord);
      (requested || fallback || document.getElementById(type === 'paycheck' ? 'paychecks-heading' : 'expenses-heading'))
        .focus({ preventScroll: true });
    });
  },

  moveButton(type, action, record, disabled, handler) {
    const direction = action === 'move-up' ? 'up' : 'down';
    const button = this.element('button', 'btn btn-sm btn-move', direction === 'up' ? '↑' : '↓');
    button.type = 'button'; button.disabled = disabled;
    button.dataset.moveType = type; button.dataset.moveAction = action; button.dataset.recordId = record.id;
    button.setAttribute('aria-label', `Move ${record.earner || record.name} ${direction}`);
    button.addEventListener('click', handler); return button;
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
    month.paychecks.forEach((p, index) => {
      const remaining = Store.calcPaycheckRemaining(this.currentMonth, p.id);
      let remClass = 'zero';
      if (remaining > 0.01) remClass = 'positive';
      else if (remaining < -0.01) remClass = 'negative';
      const card = this.element('div', 'paycheck-card'); card.dataset.id = p.id;
      const header = this.element('div', 'paycheck-header'); const identity = this.element('div');
      identity.append(this.element('div', 'paycheck-earner', p.earner), this.element('div', 'paycheck-date', p.date));
      this.appendRecordMarkers(identity, p);
      const actions = this.element('div', 'paycheck-actions');
      const amount = this.element('div', 'paycheck-amount');
      amount.append(this.element('span', 'amount-label', `Planned ${this.fmt(p.plannedAmount)}`));
      amount.append(document.createTextNode(' · '));
      amount.append(this.element('span', 'amount-label', p.actualAmount === null ? 'Actual not entered' : `Actual ${this.fmt(p.actualAmount)}`));
      actions.append(amount);
      const editButton = this.element('button', 'btn btn-sm btn-edit', 'Edit'); editButton.type = 'button';
      editButton.dataset.editType = 'paycheck'; editButton.dataset.recordId = p.id;
      editButton.setAttribute('aria-label', `Edit paycheck for ${p.earner}`);
      editButton.addEventListener('click', () => this.showPaycheckModal(p)); actions.append(editButton);
      actions.append(
        this.moveButton('paycheck', 'move-up', p, index === 0, event => this.movePaycheck(p, -1, event.currentTarget)),
        this.moveButton('paycheck', 'move-down', p, index === month.paychecks.length - 1, event => this.movePaycheck(p, 1, event.currentTarget))
      );
      const button = this.element('button', 'btn-delete', '×'); button.type = 'button'; button.setAttribute('aria-label', `Delete paycheck for ${p.earner}`);
      button.addEventListener('click', () => this.deletePaycheck(p.id)); actions.append(button); header.append(identity, actions);
      const remainder = this.element('div', 'paycheck-remaining'); remainder.append(this.element('span', '', 'Remaining'), this.element('span', `paycheck-remaining-value ${remClass}`, this.fmt(remaining)));
      card.append(header, remainder); container.append(card);
    });
  },

  showPaycheckModal(existing, reviewFocus = null) {
    const earners = Store.getEarners();
    const title = existing ? 'Edit Paycheck' : 'Add Paycheck';
    const amountFields = `
        <div class="form-group">
          <label for="field-planned-amount">Planned amount</label>
          <input type="number" id="field-planned-amount" step="0.01" min="0" max="1000000000000" required>
        </div>
        <div class="form-group">
          <label for="field-actual-amount">Actual amount</label>
          <input type="number" id="field-actual-amount" step="0.01" min="0" max="1000000000000" placeholder="Not entered">
        </div>`;

    App.showModal(title, `
      <div class="form-group">
        <label for="field-earner">Earner</label>
        <select id="field-earner"></select>
      </div>
      <div class="form-row">
        ${amountFields}
        <div class="form-group">
          <label for="field-date">Pay Date</label>
          <input type="date" id="field-date">
        </div>
      </div>
    `, () => {
      const earnerId = document.getElementById('field-earner').value;
      const date = document.getElementById('field-date').value;
      const plannedInput = document.getElementById('field-planned-amount');
      const actualInput = document.getElementById('field-actual-amount');
      if (!plannedInput.reportValidity() || !actualInput.reportValidity()) return false;
      const updates = { plannedAmount: Number(plannedInput.value), actualAmount: this.optionalAmount(actualInput), date };
      if (!existing || earnerId !== existing.earnerId) updates.earnerId = earnerId;
      return App.runMutation(() => {
        if (existing) return Store.editPaycheck(this.currentMonth, existing.id, updates);
        return Store.addPaycheck(this.currentMonth, { earnerId, plannedAmount: updates.plannedAmount, actualAmount: updates.actualAmount, date });
      },
      { onSuccess: () => {
        this.render();
        if (reviewFocus) this.restoreReviewFocus(reviewFocus.kind, reviewFocus.id);
        else if (existing) this.focusEditControl('paycheck', existing.id);
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
    document.getElementById('field-planned-amount').value = existing ? existing.plannedAmount : '';
    document.getElementById('field-actual-amount').value = existing ? (existing.actualAmount ?? '') : '';
    document.getElementById('field-date').value = existing ? existing.date : '';
  },

  deletePaycheck(id) {
    if (confirm('Delete this paycheck?')) {
      App.runMutation(() => Store.deletePaycheck(this.currentMonth, id), { onSuccess: () => this.render(), onFailure: () => this.render() });
    }
  },

  movePaycheck(paycheck, delta, trigger) {
    const paychecks = Store.getMonth(this.currentMonth).paychecks;
    const from = paychecks.findIndex(record => record.id === paycheck.id); const to = from + delta;
    if (from < 0 || to < 0 || to >= paychecks.length) return;
    const ids = paychecks.map(record => record.id); [ids[from], ids[to]] = [ids[to], ids[from]];
    App.runMutation(() => Store.reorderPaychecks(this.currentMonth, ids), {
      onSuccess: () => {
        this.render(); App.announceStatus(`${paycheck.earner} paycheck moved to position ${to + 1} of ${paychecks.length}.`);
        this.focusMoveControl('paycheck', delta < 0 ? 'move-up' : 'move-down', paycheck.id);
      },
      onFailure: () => trigger.focus()
    });
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
      const catActual = items.reduce((s, e) => s + (this.actualAmount(e) ?? 0), 0);
      const isCollapsed = this.collapsedCategories.get(categoryLabel);

      const group = this.element('div', 'category-group'); group.dataset.category = categoryLabel;
      const header = this.element('button', 'category-header'); header.type = 'button'; header.setAttribute('aria-expanded', String(!isCollapsed));
      const name = this.element('span', 'category-name');
      name.append(this.element('span', `category-toggle ${isCollapsed ? '' : 'open'}`, '▶'), document.createTextNode(categoryLabel), this.element('span', 'category-count', `(${items.length})`));
      header.append(name, this.element('span', 'category-total', `Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}`));
      header.addEventListener('click', () => this.toggleCategory(categoryLabel));
      const itemsContainer = this.element('div', 'category-items'); itemsContainer.hidden = Boolean(isCollapsed);
      const table = this.element('table', 'expense-table'); const head = table.createTHead().insertRow();
      const labels = [['Name', 'col-name'], ...paychecks.map(p => [this.getPaycheckShortLabel(p), 'col-pc']), ['Planned', 'col-total'], ['Actual', 'col-actual'], ['Method', 'col-method'], ['Actions', 'col-actions']];
      labels.forEach(([label, cls], index) => { const th = document.createElement('th'); th.className = cls; th.textContent = label;
        if (index > 0 && index <= paychecks.length) th.title = `${paychecks[index - 1].earner} - ${paychecks[index - 1].date}`; head.append(th); });
      const body = table.createTBody(); items.forEach((expense, index) =>
        body.append(this.renderExpenseRow(expense, paychecks, index, items.length)));
      itemsContainer.append(table); group.append(header, itemsContainer); container.append(group);
    }
    if (!container.children.length) container.append(this.element('div', 'muted-text', 'No expenses added yet. Click “Add Expense” to start.'));
  },

  renderExpenseRow(expense, paychecks, groupIndex, groupSize) {
    const projected = Store.expenseProjected(expense);
    const amounts = expense.paycheckAmounts;

    const row = document.createElement('tr'); row.dataset.id = expense.id;
    const name = row.insertCell(); name.className = 'col-name';
    name.append(this.element('span', 'expense-name', expense.name));
    if (expense.date) name.append(this.element('span', 'expense-date', ` · ${expense.date}`));
    const assigned = Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
    this.appendRecordMarkers(name, expense, {
      needsAllocation: Store.fundingDirection(assigned - expense.plannedAmount) !== 0
    });
    paychecks.forEach(paycheck => {
      const cell = row.insertCell(); cell.className = 'col-pc'; const input = document.createElement('input');
      input.type = 'number'; input.step = '0.01'; input.placeholder = '0';
      input.dataset.fundingExpenseId = expense.id; input.dataset.fundingPaycheckId = paycheck.id;
      input.value = Object.hasOwn(amounts, paycheck.id) ? amounts[paycheck.id] : '';
      input.setAttribute('aria-label', `${expense.name} allocated to ${this.getPaycheckShortLabel(paycheck)}`);
      input.min = '0';
      const assignedElsewhere = assigned - (amounts[paycheck.id] ?? 0);
      input.max = String(Math.max(0, expense.plannedAmount - assignedElsewhere));
      input.addEventListener('change', () => input.checkValidity()
        ? this.updatePaycheckAmount(expense.id, paycheck.id, input.value)
        : this.rejectFundingAmount(input)); cell.append(input);
    });
    const total = row.insertCell(); total.className = 'col-total expense-total'; total.textContent = this.fmt(projected);
    const actualCell = row.insertCell(); actualCell.className = 'col-actual'; const actual = document.createElement('input');
    actual.type = 'number'; actual.step = '0.01'; actual.placeholder = 'Not entered';
    actual.value = this.actualAmount(expense) ?? '';
    actual.setAttribute('aria-label', `${expense.name} actual amount`);
    actual.min = '0'; actual.max = '1000000000000';
    actual.addEventListener('change', () => actual.reportValidity()
      ? this.updateExpenseField(expense.id, 'actualAmount', actual.value)
      : this.rejectAmount()); actualCell.append(actual);
    const methodCell = row.insertCell(); methodCell.className = 'col-method'; const method = document.createElement('select');
    [['bank', 'Bank'], ['credit_card', 'Credit Card'], ['savings', 'Savings'], ['investments', 'Investments']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = expense.paymentMethod === value; method.append(option);
    });
    method.setAttribute('aria-label', `${expense.name} payment method`);
    method.addEventListener('change', () => this.updateExpenseField(expense.id, 'paymentMethod', method.value)); methodCell.append(method);
    const actionCell = row.insertCell(); actionCell.className = 'col-actions';
    const editButton = this.element('button', 'btn btn-sm btn-edit', 'Edit'); editButton.type = 'button';
    editButton.dataset.editType = 'expense'; editButton.dataset.recordId = expense.id;
    editButton.setAttribute('aria-label', `Edit ${expense.name}`); editButton.addEventListener('click', () => this.showExpenseModal(expense));
    const moveUp = this.moveButton('expense', 'move-up', expense, groupIndex === 0,
      event => this.moveExpense(expense, -1, event.currentTarget));
    const moveDown = this.moveButton('expense', 'move-down', expense, groupIndex === groupSize - 1,
      event => this.moveExpense(expense, 1, event.currentTarget));
    const deleteButton = this.element('button', 'btn-delete', '×'); deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `Delete ${expense.name}`);
    deleteButton.addEventListener('click', event => this.deleteExpense(expense, event.currentTarget));
    actionCell.append(editButton, moveUp, moveDown, deleteButton);
    return row;
  },

  focusFundingControl(expenseId, paycheckId = null) {
    const month = Store.getMonth(this.currentMonth);
    const expense = month.expenses.find(record => record.id === expenseId);
    const expensesHeading = document.getElementById('expenses-heading');
    const focus = target => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    if (!expense) {
      App.announceStatus('That bill is no longer available. The current month’s expenses are shown.');
      focus(expensesHeading); return;
    }
    if (this.collapsedCategories.get(expense.category)) {
      this.collapsedCategories.set(expense.category, false);
      this.renderExpenses();
    }
    if (!month.paychecks.length) {
      App.announceStatus('Add a paycheck before assigning funding to this bill.');
      focus(document.getElementById('btn-add-paycheck')); return;
    }
    const controls = [...document.querySelectorAll('.expense-table input[data-funding-expense-id][data-funding-paycheck-id]')];
    const billControls = controls.filter(control => control.dataset.fundingExpenseId === expenseId);
    const target = paycheckId === null ? billControls[0]
      : billControls.find(control => control.dataset.fundingPaycheckId === paycheckId);
    if (target) { focus(target); return; }
    App.announceStatus('That paycheck funding control is no longer available. The bill is shown in the current month.');
    focus(expensesHeading);
  },

  moveExpense(expense, delta, trigger) {
    const expenses = Store.getMonth(this.currentMonth).expenses;
    const group = expenses.filter(record => record.category === expense.category);
    const groupIndex = group.findIndex(record => record.id === expense.id); const targetGroupIndex = groupIndex + delta;
    if (groupIndex < 0 || targetGroupIndex < 0 || targetGroupIndex >= group.length) return;
    const ids = expenses.map(record => record.id);
    const from = expenses.findIndex(record => record.id === expense.id);
    const to = expenses.findIndex(record => record.id === group[targetGroupIndex].id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    App.runMutation(() => Store.reorderExpenses(this.currentMonth, ids), {
      onSuccess: () => {
        this.render(); App.announceStatus(`${expense.name} moved to position ${targetGroupIndex + 1} of ${group.length} in ${expense.category}.`);
        this.focusMoveControl('expense', delta < 0 ? 'move-up' : 'move-down', expense.id);
      },
      onFailure: () => trigger.focus()
    });
  },

  updatePaycheckAmount(expenseId, paycheckId, value) {
    const amount = Number(value || 0);
    App.runMutation(() => Store.updateExpensePaycheckAmount(this.currentMonth, expenseId, paycheckId, amount), {
      onSuccess: () => { this.refreshFundingLimits(expenseId); this.refreshTotals(expenseId); this.renderPaychecks(); this.renderAllocation(); this.updateSummary(); },
      onFailure: () => this.render()
    });
  },

  refreshFundingLimits(expenseId) {
    const expense = Store.getMonth(this.currentMonth).expenses.find(record => record.id === expenseId);
    if (!expense) return;
    const assigned = Object.values(expense.paycheckAmounts).reduce((sum, amount) => sum + amount, 0);
    const controls = [...document.querySelectorAll('input[data-funding-expense-id][data-funding-paycheck-id]')]
      .filter(input => input.dataset.fundingExpenseId === expenseId);
    controls.forEach(input => {
      const current = expense.paycheckAmounts[input.dataset.fundingPaycheckId] ?? 0;
      input.max = String(Math.max(0, expense.plannedAmount - (assigned - current)));
    });
  },

  rejectFundingAmount(input) {
    const message = input.validity.rangeOverflow
      ? `This bill can receive at most ${this.fmt(Number(input.max))} from this paycheck. Reduce another paycheck’s allocation first.`
      : 'Enter a valid amount of 0 or more.';
    input.setCustomValidity(message); input.reportValidity(); App.announceStatus(message); input.setCustomValidity('');
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
    const catActual = allInCat.reduce((s, e) => s + (this.actualAmount(e) ?? 0), 0);
    const groups = document.querySelectorAll('.category-group');
    groups.forEach(g => {
      if (g.dataset.category === expense.category) {
        const totalEl = g.querySelector('.category-total');
        if (totalEl) totalEl.textContent = `Proj: ${this.fmt(catProjected)} | Act: ${this.fmt(catActual)}`;
      }
    });
  },

  updateExpenseField(id, field, value) {
    if (field === 'actualAmount') value = value === '' ? null : Number(value);
    App.runMutation(() => Store.updateExpense(this.currentMonth, id, { [field]: value }), {
      onSuccess: () => {
        if (field === 'actualAmount') this.refreshTotals(id);
        this.renderPaychecks(); this.renderAllocation(); this.updateSummary();
      },
      onFailure: () => this.render()
    });
  },

  toggleCategory(name) {
    this.collapsedCategories.set(name, !this.collapsedCategories.get(name));
    this.renderExpenses();
  },

  showExpenseModal(existing, reviewFocus = null) {
    const categories = Store.getCategories();
    const title = existing ? 'Edit Expense' : 'Add Expense';
    const amountAndDateFields = `
      <div class="form-row">
        <div class="form-group">
          <label for="field-planned-amount">Planned amount</label>
          <input type="number" id="field-planned-amount" step="0.01" min="0" max="1000000000000" required>
        </div>
        <div class="form-group">
          <label for="field-actual-amount">Actual amount</label>
          <input type="number" id="field-actual-amount" step="0.01" min="0" max="1000000000000" placeholder="Not entered">
        </div>
      </div>
      <div class="form-group">
        <label for="field-expense-date">Expense date</label>
        <input type="date" id="field-expense-date">
      </div>`;

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
      ${amountAndDateFields}
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
      const plannedInput = document.getElementById('field-planned-amount');
      const actualInput = document.getElementById('field-actual-amount');
      if (!plannedInput.reportValidity() || !actualInput.reportValidity()) return false;
      const updates = {
        paymentMethod,
        plannedAmount: Number(plannedInput.value),
        actualAmount: this.optionalAmount(actualInput),
        date: document.getElementById('field-expense-date').value
      };
      const structureChanged = !existing || categoryId !== existing.categoryId || categoryItemId !== existing.categoryItemId;
      if (structureChanged) Object.assign(updates, { categoryId, categoryItemId, name: customName });
      else if (categoryItemId === null && customName !== existing.name) updates.name = customName;
      return App.runMutation(() => {
        if (existing) return Store.editExpense(this.currentMonth, existing.id, updates);
        return Store.addExpense(this.currentMonth, {
          categoryId, categoryItemId, name: customName, date: updates.date, paycheckAmounts: {},
          plannedAmount: updates.plannedAmount, actualAmount: updates.actualAmount, paymentMethod
        });
      }, { onSuccess: () => {
          this.render();
          if (reviewFocus) this.restoreReviewFocus(reviewFocus.kind, reviewFocus.id);
          else if (existing) this.focusEditControl('expense', existing.id);
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
    const assigned = existing ? Object.values(existing.paycheckAmounts).reduce((sum, amount) => sum + amount, 0) : 0;
    const plannedInput = document.getElementById('field-planned-amount');
    plannedInput.min = String(assigned); plannedInput.value = existing ? existing.plannedAmount : '';
    document.getElementById('field-actual-amount').value = existing ? (existing.actualAmount ?? '') : '';
    document.getElementById('field-expense-date').value = existing ? existing.date : '';
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

  deleteExpense(expense, trigger) {
    App.confirmExpenseDelete(expense, this.currentMonth, trigger);
  },

  // ---- Allocation ----
  renderAllocation() {
    const summary = Store.calcMonthSummary(this.currentMonth);
    const planning = this.planningTotals(summary);
    const section = document.getElementById('allocation-section');
    const month = Store.getMonth(this.currentMonth);
    const expenseRemaining = planning.expenseRemaining;

    if (!this.allocationAvailable(summary)) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    document.getElementById('allocation-remaining').textContent = this.fmt(expenseRemaining);

    const alloc = month.allocations;
    const allocTotal = Object.values(alloc).reduce((s, v) => s + v, 0);
    const unallocated = expenseRemaining - allocTotal;

    const inputs = document.getElementById('allocation-inputs'); inputs.replaceChildren();
    ALLOCATION_TYPES.forEach(type => {
      const item = this.element('div', 'allocation-item'); const label = document.createElement('label'); const input = document.createElement('input');
      input.id = `allocation-${type.key}`; label.htmlFor = input.id; label.textContent = type.label; input.type = 'number'; input.step = '0.01';
      input.min = '0'; input.max = '1000000000000';
      input.value = alloc[type.key] ?? ''; input.placeholder = '0.00';
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
