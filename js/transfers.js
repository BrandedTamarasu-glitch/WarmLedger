// Transfers view - per-paycheck breakdown of credit card vs bank

const TransfersView = {
  currentMonth: null,

  init() {
    const now = new Date();
    this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  },

  changeMonth(delta) {
    const [y, m] = this.currentMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    this.render();
  },

  syncMonth() {
    // Stay in sync with budget view's month
    if (BudgetView.currentMonth) {
      this.currentMonth = BudgetView.currentMonth;
    }
  },

  formatMonthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  },

  fmt(n) {
    return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  render() {
    document.getElementById('transfers-month-label').textContent = this.formatMonthLabel(this.currentMonth);

    const month = Store.getMonth(this.currentMonth);
    const container = document.getElementById('transfers-content');

    if (month.paychecks.length === 0) {
      container.innerHTML = '<div class="budget-section"><p style="color:var(--text-muted);">No paychecks for this month. Add paychecks in the Budget tab first.</p></div>';
      return;
    }

    let totalCCAll = 0;
    let totalBankAll = 0;
    let totalSavingsAll = 0;
    let totalInvestAll = 0;
    let totalIncomeAll = 0;

    let html = '<div class="transfers-grid">';

    month.paychecks.forEach(pc => {
      // Get all expenses assigned to this paycheck
      const expenses = month.expenses.filter(e =>
        e.paycheckAmounts && e.paycheckAmounts[pc.id] && e.paycheckAmounts[pc.id] > 0
      );

      const ccExpenses = expenses.filter(e => e.paymentMethod === 'credit_card');
      const bankExpenses = expenses.filter(e => e.paymentMethod === 'bank');
      const savingsExpenses = expenses.filter(e => e.paymentMethod === 'savings');
      const investExpenses = expenses.filter(e => e.paymentMethod === 'investments');

      const ccTotal = ccExpenses.reduce((s, e) => s + (e.paycheckAmounts[pc.id] || 0), 0);
      const bankTotal = bankExpenses.reduce((s, e) => s + (e.paycheckAmounts[pc.id] || 0), 0);
      const savingsTotal = savingsExpenses.reduce((s, e) => s + (e.paycheckAmounts[pc.id] || 0), 0);
      const investTotal = investExpenses.reduce((s, e) => s + (e.paycheckAmounts[pc.id] || 0), 0);
      const assigned = ccTotal + bankTotal + savingsTotal + investTotal;
      const unassigned = pc.amount - assigned;

      totalCCAll += ccTotal;
      totalBankAll += bankTotal;
      totalSavingsAll += savingsTotal;
      totalInvestAll += investTotal;
      totalIncomeAll += pc.amount;

      const datePart = pc.date ? new Date(pc.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

      html += `
        <div class="transfer-card">
          <div class="transfer-card-header">
            <div>
              <div class="transfer-earner">${this.esc(pc.earner)}</div>
              <div class="transfer-date">${datePart}</div>
            </div>
            <div class="transfer-amount">${this.fmt(pc.amount)}</div>
          </div>

          <div class="transfer-action send-cc">
            <div class="transfer-action-header">
              <span class="transfer-action-label">Send to Credit Card</span>
              <span class="transfer-action-amount">${this.fmt(ccTotal)}</span>
            </div>
            ${ccExpenses.length > 0 ? `
              <table class="transfer-detail-table">
                ${ccExpenses.map(e => `
                  <tr>
                    <td class="td-name">${this.esc(e.name)}</td>
                    <td class="td-cat">${this.esc(e.category)}</td>
                    <td class="td-amt">${this.fmt(e.paycheckAmounts[pc.id])}</td>
                  </tr>
                `).join('')}
              </table>
            ` : '<div class="transfer-empty">No credit card expenses</div>'}
          </div>

          <div class="transfer-action keep-bank">
            <div class="transfer-action-header">
              <span class="transfer-action-label">Keep in Bank</span>
              <span class="transfer-action-amount">${this.fmt(bankTotal)}</span>
            </div>
            ${bankExpenses.length > 0 ? `
              <table class="transfer-detail-table">
                ${bankExpenses.map(e => `
                  <tr>
                    <td class="td-name">${this.esc(e.name)}</td>
                    <td class="td-cat">${this.esc(e.category)}</td>
                    <td class="td-amt">${this.fmt(e.paycheckAmounts[pc.id])}</td>
                  </tr>
                `).join('')}
              </table>
            ` : '<div class="transfer-empty">No bank expenses</div>'}
          </div>

          <div class="transfer-action send-savings">
            <div class="transfer-action-header">
              <span class="transfer-action-label">Transfer to Savings</span>
              <span class="transfer-action-amount">${this.fmt(savingsTotal)}</span>
            </div>
            ${savingsExpenses.length > 0 ? `
              <table class="transfer-detail-table">
                ${savingsExpenses.map(e => `
                  <tr>
                    <td class="td-name">${this.esc(e.name)}</td>
                    <td class="td-cat">${this.esc(e.category)}</td>
                    <td class="td-amt">${this.fmt(e.paycheckAmounts[pc.id])}</td>
                  </tr>
                `).join('')}
              </table>
            ` : '<div class="transfer-empty">No savings transfers</div>'}
          </div>

          <div class="transfer-action send-invest">
            <div class="transfer-action-header">
              <span class="transfer-action-label">Transfer to Investments</span>
              <span class="transfer-action-amount">${this.fmt(investTotal)}</span>
            </div>
            ${investExpenses.length > 0 ? `
              <table class="transfer-detail-table">
                ${investExpenses.map(e => `
                  <tr>
                    <td class="td-name">${this.esc(e.name)}</td>
                    <td class="td-cat">${this.esc(e.category)}</td>
                    <td class="td-amt">${this.fmt(e.paycheckAmounts[pc.id])}</td>
                  </tr>
                `).join('')}
              </table>
            ` : '<div class="transfer-empty">No investment transfers</div>'}
          </div>

          ${unassigned > 0.01 ? `
            <div class="transfer-action unassigned">
              <div class="transfer-action-header">
                <span class="transfer-action-label">Unassigned</span>
                <span class="transfer-action-amount">${this.fmt(unassigned)}</span>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    });

    html += '</div>';

    // Monthly totals summary
    const allocations = month.allocations || {};
    const allocSavings = allocations.savings || 0;
    const allocDebt = allocations.credit_card_debt || 0;
    const allocInvest = allocations.investments || 0;

    html += `
      <div class="budget-section" style="margin-top:16px;">
        <h3 style="margin-bottom:16px;">Monthly Transfer Summary</h3>
        <table class="transfer-summary-table">
          <tbody>
            <tr>
              <td>Total Income</td>
              <td class="td-amt">${this.fmt(totalIncomeAll)}</td>
            </tr>
            <tr class="row-cc">
              <td>Total to Credit Card</td>
              <td class="td-amt">${this.fmt(totalCCAll)}</td>
            </tr>
            <tr class="row-bank">
              <td>Total Kept in Bank (expenses)</td>
              <td class="td-amt">${this.fmt(totalBankAll)}</td>
            </tr>
            <tr class="row-savings">
              <td>Total to Savings (expenses)</td>
              <td class="td-amt">${this.fmt(totalSavingsAll)}</td>
            </tr>
            <tr class="row-invest">
              <td>Total to Investments (expenses)</td>
              <td class="td-amt">${this.fmt(totalInvestAll)}</td>
            </tr>
            ${allocSavings > 0 ? `<tr class="row-savings"><td>+ Allocated to Savings (remaining funds)</td><td class="td-amt">${this.fmt(allocSavings)}</td></tr>` : ''}
            ${allocDebt > 0 ? `<tr class="row-cc"><td>+ Allocated to Credit Card Debt (remaining funds)</td><td class="td-amt">${this.fmt(allocDebt)}</td></tr>` : ''}
            ${allocInvest > 0 ? `<tr class="row-invest"><td>+ Allocated to Investments (remaining funds)</td><td class="td-amt">${this.fmt(allocInvest)}</td></tr>` : ''}
            <tr class="row-total">
              <td>Total Credit Card Payment</td>
              <td class="td-amt">${this.fmt(totalCCAll + allocDebt)}</td>
            </tr>
            <tr class="row-total">
              <td>Total to Keep in Bank</td>
              <td class="td-amt">${this.fmt(totalBankAll)}</td>
            </tr>
            <tr class="row-total">
              <td>Total to Transfer to Savings</td>
              <td class="td-amt">${this.fmt(totalSavingsAll + allocSavings)}</td>
            </tr>
            <tr class="row-total">
              <td>Total to Transfer to Investments</td>
              <td class="td-amt">${this.fmt(totalInvestAll + allocInvest)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = html;
  },

  esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
};
