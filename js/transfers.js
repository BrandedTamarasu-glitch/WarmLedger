// Pay periods view - a read-only projection of explicit monthly paycheck funding.
// The internal TransfersView name and transfers route remain compatibility contracts.
const TransfersView = {
  currentMonth: null,
  init() {
    const now = new Date(); this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('btn-transfers-prev').addEventListener('click', () => this.changeMonth(-1));
    document.getElementById('btn-transfers-next').addEventListener('click', () => this.changeMonth(1));
  },
  changeMonth(delta) {
    const [year, month] = this.currentMonth.split('-').map(Number); const date = new Date(year, month - 1 + delta, 1);
    this.currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; this.render();
  },
  syncMonth() { if (BudgetView.currentMonth) this.currentMonth = BudgetView.currentMonth; },
  formatMonthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  },
  formatDate(value) {
    return value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date not entered';
  },
  plannedIncome(paycheck) { return paycheck.plannedAmount; },
  fmt(value) { return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  },
  definition(list, term, value, className = '') {
    const dt = this.element('dt', '', term); const dd = this.element('dd', className, value); list.append(dt, dd);
  },
  fundingButton(expenseId, paycheckId, label, accessibleLabel) {
    const button = this.element('button', 'btn btn-sm pay-period-funding-action', label); button.type = 'button';
    button.setAttribute('aria-label', accessibleLabel);
    button.dataset.expenseId = expenseId; if (paycheckId !== null) button.dataset.paycheckId = paycheckId;
    button.addEventListener('click', () => App.openBudgetFunding(this.currentMonth, expenseId, paycheckId)); return button;
  },
  remainderText(period) {
    if (period.fundingState === 'over-assigned') return `${this.fmt(Math.abs(period.plannedRemainder))} over-assigned`;
    if (period.fundingState === 'balanced') return `${this.fmt(0)} balanced`;
    return `${this.fmt(period.plannedRemainder)} remaining`;
  },
  billContext(bill) {
    const parts = [];
    if (bill.splitAcrossPaychecks) parts.push(`Split across ${bill.fundedPaycheckCount} paychecks`);
    if (bill.fundingState === 'partially-funded') parts.push(`${this.fmt(bill.remainingToFund)} still needs funding`);
    else parts.push('Fully funded across paychecks');
    return parts.join(' · ');
  },
  methodLabel(method) {
    return ({ bank: 'Bank', credit_card: 'Credit card', savings: 'Savings', investments: 'Investments' })[method] || 'Other';
  },
  renderBill(bill, paycheckId, paycheckNumber) {
    const item = this.element('li', 'pay-period-bill'); const identity = this.element('div', 'pay-period-bill-identity');
    identity.append(this.element('strong', 'pay-period-bill-name', bill.name),
      this.element('span', 'pay-period-bill-meta', `${bill.category} · ${this.formatDate(bill.date)} · ${this.methodLabel(bill.paymentMethod)}`),
      this.element('span', `pay-period-state state-${bill.fundingState}`, this.billContext(bill)));
    const amounts = this.element('dl', 'pay-period-bill-amounts');
    this.definition(amounts, 'From this paycheck', this.fmt(bill.fundedByThisPaycheck));
    this.definition(amounts, 'Bill planned', this.fmt(bill.plannedAmount));
    item.append(identity, amounts, this.fundingButton(bill.expenseId, paycheckId, 'Review funding',
      `Review funding for ${bill.name} from Paycheck ${paycheckNumber}`)); return item;
  },
  methodGuidance(period) {
    const section = this.element('div', 'transfer-action pay-period-methods'); section.append(this.element('h4', '', 'Planned funding guidance'));
    const list = this.element('dl', 'pay-period-method-list');
    [['bank', 'Keep in bank'], ['credit_card', 'Plan for credit card'], ['savings', 'Plan for savings'],
      ['investments', 'Plan for investments']].forEach(([method, label]) => this.definition(list, label, this.fmt(period.methodTotals[method])));
    section.append(list); return section;
  },
  renderPeriod(period) {
    const section = this.element('section', `transfer-card pay-period-card state-${period.fundingState}`);
    const headingId = `pay-period-heading-${period.number}`; section.setAttribute('aria-labelledby', headingId);
    const header = this.element('header', 'transfer-card-header pay-period-card-header'); const identity = this.element('div');
    const heading = this.element('h3', '', `Paycheck ${period.number}`); heading.id = headingId;
    identity.append(heading, this.element('div', 'transfer-earner', period.earner), this.element('div', 'transfer-date', this.formatDate(period.date)));
    const state = this.element('span', `pay-period-state state-${period.fundingState}`, this.remainderText(period)); header.append(identity, state);
    const totals = this.element('dl', 'pay-period-totals');
    this.definition(totals, 'Planned income', this.fmt(period.plannedIncome));
    this.definition(totals, 'Actual income', period.actualIncome === null ? 'Not entered' : this.fmt(period.actualIncome), period.actualIncome === null ? 'is-missing' : '');
    this.definition(totals, 'Assigned to bills', this.fmt(period.assignedTotal));
    this.definition(totals, 'Planned remainder', this.remainderText(period), `state-${period.fundingState}`);
    const bills = this.element('div', 'transfer-action pay-period-bills'); bills.append(this.element('h4', '', 'Bills funded by this paycheck'));
    if (period.bills.length) {
      const list = this.element('ul', 'pay-period-bill-list');
      period.bills.forEach(bill => list.append(this.renderBill(bill, period.paycheckId, period.number))); bills.append(list);
    } else bills.append(this.element('p', 'transfer-empty', 'No bills are explicitly assigned to this paycheck.'));
    section.append(header, totals, bills, this.methodGuidance(period)); return section;
  },
  renderNeedsFunding(plan) {
    const section = this.element('section', 'budget-section pay-period-needs'); section.setAttribute('aria-labelledby', 'pay-period-needs-heading');
    const heading = this.element('h3', '', 'Bills needing funding'); heading.id = 'pay-period-needs-heading'; section.append(heading);
    if (!plan.billsNeedingFunding.length) {
      section.append(this.element('p', 'transfer-empty', 'Every planned bill is fully funded across paychecks.')); return section;
    }
    const intro = plan.paycheckCount === 0
      ? 'This month has no paychecks. These bills remain unfunded until paychecks and explicit assignments are added.'
      : 'These bills are fully unfunded or only partially funded across this month’s paychecks.';
    section.append(this.element('p', 'muted-text', intro)); const list = this.element('ul', 'pay-period-bill-list');
    plan.billsNeedingFunding.forEach(bill => {
      const item = this.element('li', 'pay-period-bill'); const identity = this.element('div', 'pay-period-bill-identity');
      const state = bill.fundingState === 'partially-funded'
        ? `Partially funded · ${this.fmt(bill.fundedAcrossPaychecks)} assigned across ${bill.fundedPaycheckCount} ${bill.fundedPaycheckCount === 1 ? 'paycheck' : 'paychecks'}`
        : 'Unfunded · no paycheck assignment entered';
      identity.append(this.element('strong', 'pay-period-bill-name', bill.name),
        this.element('span', 'pay-period-bill-meta', `${bill.category} · ${this.formatDate(bill.date)} · ${this.methodLabel(bill.paymentMethod)}`),
        this.element('span', `pay-period-state state-${bill.fundingState}`, state));
      const amounts = this.element('dl', 'pay-period-bill-amounts');
      this.definition(amounts, 'Planned', this.fmt(bill.plannedAmount)); this.definition(amounts, 'Still needs funding', this.fmt(bill.remainingToFund));
      item.append(identity, amounts, this.fundingButton(bill.expenseId, null, 'Fund this bill', `Fund ${bill.name}`)); list.append(item);
    }); section.append(list); return section;
  },
  summarySection(title, id, rows, className, description = '') {
    const section = this.element('section', `budget-section transfer-summary ${className}`); section.setAttribute('aria-labelledby', id);
    const heading = this.element('h3', '', title); heading.id = id; const list = this.element('dl', 'transfer-summary-table pay-period-summary-list');
    rows.forEach(([label, value, state = '']) => this.definition(list, label, value, state)); section.append(heading);
    if (description) section.append(this.element('p', 'muted-text pay-period-section-note', description));
    section.append(list); return section;
  },
  render() {
    document.getElementById('transfers-month-label').textContent = this.formatMonthLabel(this.currentMonth);
    const plan = Store.getPayPeriodPlan(this.currentMonth); const container = document.getElementById('transfers-content'); container.replaceChildren();
    const countText = plan.paycheckCount === 0 ? 'No paychecks this month'
      : plan.paycheckCount === 1 ? '1 paycheck this month' : `${plan.paycheckCount} paychecks this month`;
    container.append(this.element('p', 'pay-period-count', countText));
    if (!plan.exists) container.append(this.element('p', 'pay-period-month-state', 'This month has no saved budget activity.'));
    const summary = plan.summary;
    container.append(this.summarySection('Monthly planned destinations', 'pay-period-destinations-heading', [
      ['Keep in bank', this.fmt(summary.methodFundingTotals.bank), 'row-bank'],
      ['Plan for credit card', this.fmt(summary.methodFundingTotals.credit_card), 'row-cc'],
      ['Plan for savings', this.fmt(summary.methodFundingTotals.savings), 'row-savings'],
      ['Plan for investments', this.fmt(summary.methodFundingTotals.investments), 'row-invest']
    ], 'pay-period-destinations', 'These totals include only bills explicitly assigned to paychecks. The paycheck cards below show when each amount is planned.'));
    const grid = this.element('div', 'transfers-grid'); plan.periods.forEach(period => grid.append(this.renderPeriod(period))); container.append(grid);
    container.append(this.renderNeedsFunding(plan));
    const allocations = plan.monthlyAllocations;
    container.append(this.summarySection('Monthly remaining-funds allocations', 'pay-period-allocations-heading', [
      ['Savings', this.fmt(allocations.savings)], ['Credit card debt', this.fmt(allocations.credit_card_debt)],
      ['Investments', this.fmt(allocations.investments)], ['Total monthly allocations', this.fmt(allocations.total), 'row-total']
    ], 'pay-period-allocations', 'These remaining-funds allocations apply to the whole month and are not assigned to a specific paycheck.'));
    const actual = summary.actualIncomeComplete
      ? this.fmt(summary.actualIncomeEntered)
      : `${this.fmt(summary.actualIncomeEntered)} entered · ${summary.actualIncomeMissingCount} not entered`;
    container.append(this.summarySection('Monthly funding summary', 'pay-period-summary-heading', [
      ['Planned income', this.fmt(summary.plannedIncome)], ['Actual income', actual, summary.actualIncomeComplete ? '' : 'is-missing'],
      ['Planned bills', this.fmt(summary.plannedBills)], ['Funded across paychecks', this.fmt(summary.fundedAcrossPaychecks)],
      ['Bills still needing funding', this.fmt(summary.billsNeedingFundingAmount), summary.billsNeedingFundingAmount > 0.009 ? 'state-partially-funded' : ''],
      ['Paycheck funding remainder', this.fmt(summary.paycheckFundingRemainder)],
      ['Over-assigned across paychecks', this.fmt(summary.overAssignedAmount), summary.overAssignedAmount > 0.009 ? 'state-over-assigned' : ''],
      ['Monthly remaining-funds allocations', this.fmt(summary.monthlyAllocationsTotal)],
      ['Planned monthly balance', this.fmt(summary.plannedBalance), summary.plannedBalance < -0.009 ? 'state-over-assigned' : 'row-total'],
      ['Funding reconciliation difference', this.fmt(summary.reconciliationDifference)]
    ], 'pay-period-monthly-summary'));
  }
};
