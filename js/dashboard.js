// Dashboard view - charts and analytics

const DASHBOARD_THEME = Object.freeze({
  text: '#f7f0e6',
  muted: '#b7aa9a',
  grid: '#40382d',
  accent: '#e09a72',
  positive: '#8fc89a',
  warning: '#e7bd75',
  danger: '#f08a80',
  info: '#8eb7c7'
});

const DashboardView = {
  charts: {},

  init() {
    this.bindEvents();
    this.setDefaultDateRange();
  },

  bindEvents() {
    document.getElementById('dash-from').addEventListener('change', () => this.render());
    document.getElementById('dash-to').addEventListener('change', () => this.render());
  },

  setDefaultDateRange() {
    const now = new Date();
    const from = new Date(now.getFullYear(), 0, 1);
    document.getElementById('dash-from').value = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('dash-to').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  },

  getDateRange() {
    return {
      from: document.getElementById('dash-from').value,
      to: document.getElementById('dash-to').value
    };
  },

  validateDateRange({ from, to } = {}) {
    const validMonth = value => typeof value === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.test(value);
    if (from === '' || to === '' || from === undefined || to === undefined) {
      return Object.freeze({ status: 'incomplete', from: from || '', to: to || '', months: Object.freeze([]) });
    }
    if (!validMonth(from) || !validMonth(to)) {
      return Object.freeze({ status: 'invalid', from, to, months: Object.freeze([]) });
    }
    const ordinal = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
    const start = ordinal(from); const end = ordinal(to);
    if (start > end) return Object.freeze({ status: 'reversed', from, to, months: Object.freeze([]) });
    const monthCount = end - start + 1;
    if (monthCount > 600) return Object.freeze({ status: 'too-wide', from, to, monthCount, months: Object.freeze([]) });
    const months = [];
    for (let current = start; current <= end; current++) {
      const year = Math.floor(current / 12); const month = current % 12 + 1;
      months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    }
    return Object.freeze({ status: 'ready', from, to, monthCount, months: Object.freeze(months) });
  },

  getMonthsInRange() {
    return [...this.validateDateRange(this.getDateRange()).months];
  },

  clearRenderedOutput() {
    this.destroyAllCharts();
    for (const id of ['summary-table-container', 'dashboard-overview']) {
      const element = document.getElementById(id);
      if (element) element.replaceChildren();
    }
    const results = document.getElementById('dashboard-results');
    if (results) results.hidden = true;
  },

  buildCoverageOverview(entries) {
    const snapshot = entries.map(entry => ({ monthKey: entry.monthKey, exists: entry.exists, month: entry.month }));
    let financialActivityMonths = 0; let plannedIncome = 0; let plannedExpenses = 0;
    let actualEnteredCount = 0; let actualMissingCount = 0;
    for (const entry of snapshot) {
      const allocationTotal = Object.values(entry.month.allocations).reduce((sum, amount) => sum + amount, 0);
      if (entry.month.paychecks.length || entry.month.expenses.length || allocationTotal !== 0) financialActivityMonths++;
      for (const paycheck of entry.month.paychecks) {
        plannedIncome += paycheck.plannedAmount;
        if (paycheck.actualAmount === null) actualMissingCount++; else actualEnteredCount++;
      }
      for (const expense of entry.month.expenses) {
        plannedExpenses += expense.plannedAmount;
        if (expense.actualAmount === null) actualMissingCount++; else actualEnteredCount++;
      }
    }
    const overview = {
      coverage: { selectedMonths: snapshot.length, financialActivityMonths },
      actualEntries: { enteredCount: actualEnteredCount, missingCount: actualMissingCount,
        complete: actualMissingCount === 0 },
      plannedTotals: { income: plannedIncome, expenses: plannedExpenses }
    };
    Object.values(overview).forEach(Object.freeze);
    return Object.freeze(overview);
  },

  renderOverview(entries) {
    const overview = this.buildCoverageOverview(entries);
    const container = document.getElementById('dashboard-overview');
    if (!container) return overview;
    const cards = [
      ['Coverage', `${overview.coverage.financialActivityMonths} of ${overview.coverage.selectedMonths} selected months have financial activity.`],
      ['Actual entries', overview.actualEntries.complete
        ? `${overview.actualEntries.enteredCount} entered; none missing.`
        : `${overview.actualEntries.enteredCount} entered; ${overview.actualEntries.missingCount} missing. Data Health reviews the full budget.`],
      ['Planned totals', `${this.formatWholeAmount(overview.plannedTotals.income)} income; ${this.formatWholeAmount(overview.plannedTotals.expenses)} expenses.`]
    ];
    for (const [heading, copy] of cards) {
      const section = document.createElement('section'); section.className = 'dashboard-overview-card';
      const title = document.createElement('h3'); title.textContent = heading;
      const text = document.createElement('p'); text.textContent = copy; section.append(title, text);
      if (heading === 'Actual entries' && !overview.actualEntries.complete) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary';
        button.textContent = 'Review missing actuals in Data Health';
        button.addEventListener('click', () => this.openDataHealth()); section.append(button);
      }
      container.append(section);
    }
    return overview;
  },

  renderState(state) {
    const container = document.getElementById('dashboard-state');
    if (!container) return;
    container.replaceChildren();
    container.classList.toggle('is-error', ['incomplete', 'invalid', 'reversed', 'too-wide'].includes(state.status));
    if (state.status === 'ready') { container.hidden = true; return; }
    const messages = {
      incomplete: 'Choose both a From and To month.',
      invalid: 'Enter valid From and To months.',
      reversed: 'The From month must not be after the To month.',
      'too-wide': 'Choose a range of 600 months or fewer.',
      empty: 'This range has no financial activity.'
    };
    const text = document.createElement('p'); text.textContent = messages[state.status] || 'Dashboard unavailable.';
    container.append(text); container.hidden = false;
    if (state.status === 'empty') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary';
      button.textContent = 'Go to Budget'; button.addEventListener('click', () => App.switchView('budget')); container.append(button);
    }
  },

  openDataHealth() {
    App.switchView('data-health');
    const heading = document.getElementById('data-health-heading');
    if (heading) heading.focus();
  },

  formatMonthShort(key) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  },

  plannedIncome(summary) {
    return summary.totalPlannedIncome;
  },

  plannedExpenses(summary) {
    return summary.totalPlannedExpenses;
  },

  actualExpenses(summary) {
    return summary.unresolvedExpenseCount === 0 ? summary.totalActualExpenses : null;
  },

  categoryPlanned(total) {
    if (!total) return 0;
    return total.planned;
  },

  categoryActual(total) {
    if (!total) return 0;
    return total.unresolvedCount === 0 ? total.actual : null;
  },

  formatWholeAmount(value) {
    if (value === null) return '— Incomplete';
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  },

  render() {
    this.clearRenderedOutput();
    const range = this.validateDateRange(this.getDateRange());
    if (range.status !== 'ready') { this.renderState(range); return; }
    const storedMonths = new Set(Store.getAllMonthKeys());
    const entries = range.months.map(monthKey => ({
      monthKey, exists: storedMonths.has(monthKey), month: Store.getMonth(monthKey)
    }));
    const overview = this.buildCoverageOverview(entries);
    if (overview.coverage.financialActivityMonths === 0) {
      this.renderState({ ...range, status: 'empty' }); return;
    }
    this.renderState(range); this.renderOverview(entries);
    const results = document.getElementById('dashboard-results');
    if (results) results.hidden = false;
    const months = [...range.months];

    this.renderCategoryTrend(months);
    this.renderIncomePct(months);
    this.renderProjVsActual(months);
    this.renderSavingsRate(months);
    this.renderPaymentMethod(months);
    this.renderYoY(months);
    this.renderSummaryTable(months);
  },

  destroyChart(id) {
    if (this.charts[id]) {
      this.charts[id].destroy();
      this.charts[id] = null;
    }
  },

  destroyAllCharts() {
    Object.keys(this.charts).forEach(id => this.destroyChart(id));
  },

  COLORS: [
    '#e09a72', '#8fc89a', '#e7bd75', '#8eb7c7',
    '#b8a1d9', '#76b7aa', '#d98fa3', '#d9a65f',
    '#a8b878', '#78a9c2', '#d78374', '#b9a58f'
  ],

  // 1. Category spending trend (line chart)
  renderCategoryTrend(months) {
    this.destroyChart('categoryTrend');
    const allCategories = new Set();
    const dataByMonth = {};

    months.forEach(mk => {
      const totals = Store.calcCategoryTotals(mk);
      dataByMonth[mk] = totals;
      Object.keys(totals).forEach(c => allCategories.add(c));
    });

    const cats = [...allCategories];
    const datasets = cats.map((cat, i) => ({
      label: cat,
      data: months.map(mk => this.categoryActual(dataByMonth[mk][cat])),
      borderColor: this.COLORS[i % this.COLORS.length],
      backgroundColor: this.COLORS[i % this.COLORS.length] + '33',
      tension: 0.3,
      fill: false
    }));

    const ctx = document.getElementById('chart-category-trend').getContext('2d');
    this.charts.categoryTrend = new Chart(ctx, {
      type: 'line',
      data: { labels: months.map(m => this.formatMonthShort(m)), datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
        }
      }
    });
  },

  // 2. % of income by category (doughnut - latest month with data)
  renderIncomePct(months) {
    this.destroyChart('incomePct');
    // Use the most recent month that has data
    let targetMonth = months[months.length - 1];
    for (let i = months.length - 1; i >= 0; i--) {
      const s = Store.calcMonthSummary(months[i]);
      if (this.plannedIncome(s) > 0) { targetMonth = months[i]; break; }
    }

    const summary = Store.calcMonthSummary(targetMonth);
    const catTotals = Store.calcCategoryTotals(targetMonth);
    const plannedIncome = this.plannedIncome(summary);
    const income = plannedIncome === 0 ? 1 : plannedIncome;

    const labels = Object.keys(catTotals);
    const data = labels.map(c => this.categoryPlanned(catTotals[c]));
    const allocations = Store.getMonth(targetMonth).allocations || {};
    // Add allocations as categories
    ALLOCATION_TYPES.forEach(a => {
      if (allocations[a.key] > 0) {
        labels.push(a.label);
        data.push(allocations[a.key]);
      }
    });

    const ctx = document.getElementById('chart-income-pct').getContext('2d');
    this.charts.incomePct = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: this.COLORS.slice(0, labels.length),
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const pct = ((ctx.raw / income) * 100).toFixed(1);
                return `${ctx.label}: $${ctx.raw.toLocaleString()} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  },

  // 3. Projected vs Actual (grouped bar)
  renderProjVsActual(months) {
    this.destroyChart('projVsActual');
    const projected = months.map(mk => this.plannedExpenses(Store.calcMonthSummary(mk)));
    const actual = months.map(mk => this.actualExpenses(Store.calcMonthSummary(mk)));

    const ctx = document.getElementById('chart-proj-vs-actual').getContext('2d');
    this.charts.projVsActual = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [
          { label: 'Projected', data: projected, backgroundColor: DASHBOARD_THEME.accent },
          { label: 'Actual', data: actual, backgroundColor: DASHBOARD_THEME.positive }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
        }
      }
    });
  },

  // 4. Savings rate over time (line)
  renderSavingsRate(months) {
    this.destroyChart('savingsRate');
    const rates = months.map(mk => {
      const summary = Store.calcMonthSummary(mk);
      const alloc = Store.getMonth(mk).allocations || {};
      const totalSaved = (alloc.savings || 0) + (alloc.investments || 0);
      const income = this.plannedIncome(summary);
      return income > 0 ? (totalSaved / income) * 100 : 0;
    });

    const ctx = document.getElementById('chart-savings-rate').getContext('2d');
    this.charts.savingsRate = new Chart(ctx, {
      type: 'line',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [{
          label: 'Savings Rate %',
          data: rates,
          borderColor: DASHBOARD_THEME.positive,
          backgroundColor: DASHBOARD_THEME.positive + '33',
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => v + '%' }, grid: { color: DASHBOARD_THEME.grid }, min: 0 }
        }
      }
    });
  },

  // 5. Payment method breakdown (bar)
  renderPaymentMethod(months) {
    this.destroyChart('paymentMethod');
    const bank = months.map(mk => Store.calcPaymentMethodTotals(mk, 'planned').bank ?? 0);
    const cc = months.map(mk => Store.calcPaymentMethodTotals(mk, 'planned').credit_card ?? 0);

    const ctx = document.getElementById('chart-payment-method').getContext('2d');
    this.charts.paymentMethod = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [
          { label: 'Bank', data: bank, backgroundColor: DASHBOARD_THEME.info },
          { label: 'Credit Card', data: cc, backgroundColor: DASHBOARD_THEME.warning }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid }, stacked: true }
        }
      }
    });
  },

  // 6. Year-over-Year comparison (grouped bar by category)
  renderYoY(months) {
    this.destroyChart('yoy');
    // Group months by year
    const years = {};
    months.forEach(mk => {
      const y = mk.split('-')[0];
      if (!years[y]) years[y] = [];
      years[y].push(mk);
    });

    const yearKeys = Object.keys(years).sort();
    if (yearKeys.length < 1) return;

    // Get all categories across all months
    const allCats = new Set();
    months.forEach(mk => {
      const totals = Store.calcCategoryTotals(mk);
      Object.keys(totals).forEach(c => allCats.add(c));
    });
    const cats = [...allCats];

    const datasets = yearKeys.map((year, yi) => {
      const yearMonths = years[year];
      const catSums = {};
      cats.forEach(c => { catSums[c] = 0; });
      yearMonths.forEach(mk => {
        const totals = Store.calcCategoryTotals(mk);
        cats.forEach(c => {
          const value = this.categoryActual(totals[c]);
          if (catSums[c] !== null) catSums[c] = value === null ? null : catSums[c] + value;
        });
      });
      return {
        label: year,
        data: cats.map(c => catSums[c]),
        backgroundColor: this.COLORS[yi % this.COLORS.length]
      };
    });

    const ctx = document.getElementById('chart-yoy').getContext('2d');
    this.charts.yoy = new Chart(ctx, {
      type: 'bar',
      data: { labels: cats, datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
        }
      }
    });
  },

  // 7. Summary table
  renderSummaryTable(months) {
    const allCats = new Set();
    const dataByMonth = {};

    months.forEach(mk => {
      const totals = Store.calcCategoryTotals(mk);
      dataByMonth[mk] = totals;
      Object.keys(totals).forEach(c => allCats.add(c));
    });

    const cats = [...allCats];

    const table = document.createElement('table');
    const thead = table.createTHead();
    const headRow = thead.insertRow();
    ['Category', ...months.map(m => this.formatMonthShort(m)), 'Avg'].forEach(label => {
      const th = document.createElement('th'); th.textContent = label; headRow.append(th);
    });
    const tbody = table.createTBody();
    cats.forEach(cat => {
      const row = tbody.insertRow(); const name = row.insertCell(); name.textContent = cat;
      let total = 0;
      let count = 0;
      months.forEach(mk => {
        const val = this.categoryActual(dataByMonth[mk][cat]);
        row.insertCell().textContent = this.formatWholeAmount(val);
        if (val !== null) {
          total += val;
          count++;
        }
      });
      const avg = count > 0 ? total / count : 0;
      const cell = row.insertCell(); const strong = document.createElement('strong');
      strong.textContent = `$${avg.toLocaleString(undefined, { maximumFractionDigits: 0 })}`; cell.append(strong);
    });

    const totalRow = tbody.insertRow(); totalRow.className = 'summary-total-row';
    let cell = totalRow.insertCell(); let strong = document.createElement('strong'); strong.textContent = 'Total'; cell.append(strong);
    let grandTotal = 0;
    let monthCount = 0;
    months.forEach(mk => {
      const s = Store.calcMonthSummary(mk);
      const val = this.actualExpenses(s);
      cell = totalRow.insertCell(); strong = document.createElement('strong');
      strong.textContent = this.formatWholeAmount(val); cell.append(strong);
      if (val !== null) {
        grandTotal += val;
        monthCount++;
      }
    });
    const grandAvg = monthCount > 0 ? grandTotal / monthCount : 0;
    cell = totalRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = `$${grandAvg.toLocaleString(undefined, { maximumFractionDigits: 0 })}`; cell.append(strong);
    const incomeRow = tbody.insertRow(); cell = incomeRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = 'Income'; cell.append(strong);
    months.forEach(mk => {
      const s = Store.calcMonthSummary(mk);
      incomeRow.insertCell().textContent = this.formatWholeAmount(this.plannedIncome(s));
    });
    incomeRow.insertCell();
    document.getElementById('summary-table-container').replaceChildren(table);
  }
};
