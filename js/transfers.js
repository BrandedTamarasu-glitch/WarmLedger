// Transfers view - per-paycheck breakdown of credit card vs bank.
const TransfersView = {
  currentMonth: null,
  init() {
    const now = new Date(); this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('btn-transfers-prev').addEventListener('click', () => this.changeMonth(-1));
    document.getElementById('btn-transfers-next').addEventListener('click', () => this.changeMonth(1));
  },
  changeMonth(delta) {
    const [y, m] = this.currentMonth.split('-').map(Number); const date = new Date(y, m - 1 + delta, 1);
    this.currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; this.render();
  },
  syncMonth() { if (BudgetView.currentMonth) this.currentMonth = BudgetView.currentMonth; },
  formatMonthLabel(key) { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); },
  fmt(value) { return '$' + (value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  plannedIncome(paycheck) {
    return paycheck.plannedAmount;
  },
  element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  },
  detailSection(className, label, total, expenses, paycheckId, emptyText) {
    const section = this.element('div', `transfer-action ${className}`);
    const header = this.element('div', 'transfer-action-header');
    header.append(this.element('span', 'transfer-action-label', label), this.element('span', 'transfer-action-amount', this.fmt(total)));
    section.append(header);
    if (!expenses.length) { section.append(this.element('div', 'transfer-empty', emptyText)); return section; }
    const table = this.element('table', 'transfer-detail-table'); const body = table.createTBody();
    expenses.forEach(expense => {
      const row = body.insertRow();
      const name = row.insertCell(); name.className = 'td-name'; name.textContent = expense.name;
      const category = row.insertCell(); category.className = 'td-cat'; category.textContent = expense.category;
      const amount = row.insertCell(); amount.className = 'td-amt'; amount.textContent = this.fmt(expense.paycheckAmounts[paycheckId]);
    });
    section.append(table); return section;
  },
  summaryRow(body, label, amount, className) {
    const row = body.insertRow(); if (className) row.className = className;
    row.insertCell().textContent = label; const value = row.insertCell(); value.className = 'td-amt'; value.textContent = this.fmt(amount);
  },
  render() {
    document.getElementById('transfers-month-label').textContent = this.formatMonthLabel(this.currentMonth);
    const month = Store.getMonth(this.currentMonth); const container = document.getElementById('transfers-content'); container.replaceChildren();
    if (!month.paychecks.length) {
      const section = this.element('div', 'budget-section'); section.append(this.element('p', 'muted-text', 'No paychecks for this month. Add paychecks in the Budget tab first.')); container.append(section); return;
    }
    const totals = { credit_card: 0, bank: 0, savings: 0, investments: 0, income: 0 };
    const grid = this.element('div', 'transfers-grid');
    month.paychecks.forEach(paycheck => {
      const expenses = month.expenses.filter(expense => (expense.paycheckAmounts[paycheck.id] ?? 0) > 0);
      const groups = {};
      ['credit_card', 'bank', 'savings', 'investments'].forEach(method => {
        groups[method] = expenses.filter(expense => expense.paymentMethod === method);
        totals[method] += groups[method].reduce((sum, expense) => sum + expense.paycheckAmounts[paycheck.id], 0);
      });
      const plannedIncome = this.plannedIncome(paycheck);
      totals.income += plannedIncome;
      const card = this.element('div', 'transfer-card'); const header = this.element('div', 'transfer-card-header'); const identity = this.element('div');
      identity.append(this.element('div', 'transfer-earner', paycheck.earner), this.element('div', 'transfer-date', paycheck.date ? new Date(`${paycheck.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''));
      header.append(identity, this.element('div', 'transfer-amount', this.fmt(plannedIncome))); card.append(header);
      const definitions = [
        ['credit_card', 'send-cc', 'Send to Credit Card', 'No credit card expenses'], ['bank', 'keep-bank', 'Keep in Bank', 'No bank expenses'],
        ['savings', 'send-savings', 'Transfer to Savings', 'No savings transfers'], ['investments', 'send-invest', 'Transfer to Investments', 'No investment transfers']
      ];
      let assigned = 0;
      definitions.forEach(([method, className, label, empty]) => {
        const amount = groups[method].reduce((sum, expense) => sum + expense.paycheckAmounts[paycheck.id], 0); assigned += amount;
        card.append(this.detailSection(className, label, amount, groups[method], paycheck.id, empty));
      });
      if (plannedIncome - assigned > 0.01) card.append(this.detailSection('unassigned', 'Unassigned', plannedIncome - assigned, [], paycheck.id, ''));
      grid.append(card);
    });
    container.append(grid);
    const allocations = month.allocations; const summary = this.element('section', 'budget-section transfer-summary'); summary.append(this.element('h3', '', 'Monthly Transfer Summary'));
    const table = this.element('table', 'transfer-summary-table'); const body = table.createTBody();
    this.summaryRow(body, 'Total Income', totals.income); this.summaryRow(body, 'Total to Credit Card', totals.credit_card, 'row-cc');
    this.summaryRow(body, 'Total Kept in Bank (expenses)', totals.bank, 'row-bank'); this.summaryRow(body, 'Total to Savings (expenses)', totals.savings, 'row-savings');
    this.summaryRow(body, 'Total to Investments (expenses)', totals.investments, 'row-invest');
    if (allocations.savings > 0) this.summaryRow(body, '+ Allocated to Savings (remaining funds)', allocations.savings, 'row-savings');
    if (allocations.credit_card_debt > 0) this.summaryRow(body, '+ Allocated to Credit Card Debt (remaining funds)', allocations.credit_card_debt, 'row-cc');
    if (allocations.investments > 0) this.summaryRow(body, '+ Allocated to Investments (remaining funds)', allocations.investments, 'row-invest');
    this.summaryRow(body, 'Total Credit Card Payment', totals.credit_card + allocations.credit_card_debt, 'row-total');
    this.summaryRow(body, 'Total to Keep in Bank', totals.bank, 'row-total');
    this.summaryRow(body, 'Total to Transfer to Savings', totals.savings + allocations.savings, 'row-total');
    this.summaryRow(body, 'Total to Transfer to Investments', totals.investments + allocations.investments, 'row-total');
    summary.append(table); container.append(summary);
  }
};
