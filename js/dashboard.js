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

function dashboardQuickRange(command, civilDate) {
  if (!civilDate || !Number.isInteger(civilDate.year) || !Number.isInteger(civilDate.month) ||
      civilDate.year < 0 || civilDate.year > 9999 || civilDate.month < 1 || civilDate.month > 12) return null;
  const widths = { current: 1, 'last-3': 3, 'last-6': 6 };
  if (command !== 'ytd' && !Object.hasOwn(widths, command)) return null;
  const format = ordinal => {
    const year = Math.floor(ordinal / 12); const month = ordinal % 12 + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  };
  const end = civilDate.year * 12 + civilDate.month - 1;
  const start = command === 'ytd' ? civilDate.year * 12 : end - widths[command] + 1;
  if (start < 0) return null;
  return Object.freeze({ from: format(start), to: format(end) });
}

const DashboardView = {
  charts: {},

  init() {
    this.bindEvents();
    this.setDefaultDateRange();
  },

  bindEvents() {
    document.getElementById('dash-from').addEventListener('change', () => this.render());
    document.getElementById('dash-to').addEventListener('change', () => this.render());
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[data-dashboard-quick-range]').forEach(button => {
        button.onclick = () => this.applyQuickRange(button.dataset.dashboardQuickRange);
      });
    }
  },

  applyQuickRange(command) {
    const now = new Date();
    const range = dashboardQuickRange(command, { year: now.getFullYear(), month: now.getMonth() + 1 });
    if (!range) return false;
    document.getElementById('dash-from').value = range.from;
    document.getElementById('dash-to').value = range.to;
    this.render();
    return true;
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
    for (const id of ['summary-table-container', 'dashboard-overview', 'table-category-trend',
      'table-proj-vs-actual', 'table-payment-method', 'table-income-pct', 'table-savings-rate', 'table-yoy']) {
      const element = document.getElementById(id);
      if (element) element.replaceChildren();
    }
    const compositionContext = document.getElementById('dashboard-composition-context');
    if (compositionContext) compositionContext.textContent = '';
    const results = document.getElementById('dashboard-results');
    if (results) results.hidden = true;
    const yoyState = document.getElementById('dashboard-yoy-state');
    if (yoyState) { yoyState.textContent = ''; yoyState.hidden = true; }
    const yoyCard = document.getElementById('dashboard-yoy-card');
    if (yoyCard) yoyCard.hidden = true;
  },

  renderDataTable(containerId, model) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.replaceChildren();
    const table = document.createElement('table');
    const caption = document.createElement('caption'); caption.textContent = model.caption; table.append(caption);
    const thead = table.createTHead();
    if (!thead || typeof thead.insertRow !== 'function' || typeof table.createTBody !== 'function') return;
    const headRow = thead.insertRow();
    for (const label of model.columns) {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; headRow.append(th);
    }
    const tbody = table.createTBody();
    for (const row of model.rows) {
      const tr = tbody.insertRow(); const th = document.createElement('th'); th.scope = 'row';
      th.textContent = row.header; tr.append(th);
      for (const value of row.cells) { const td = tr.insertCell(); td.textContent = value; }
    }
    container.replaceChildren(table);
  },

  buildCategoryTrendModel(months) {
    const allCategories = new Set(); const dataByMonth = {};
    months.forEach(monthKey => {
      const totals = Store.calcCategoryTotals(monthKey); dataByMonth[monthKey] = totals;
      Object.keys(totals).forEach(category => allCategories.add(category));
    });
    const categories = [...allCategories]; const labels = months.map(month => this.formatMonthShort(month));
    const datasets = categories.map(category => ({ label: category,
      data: months.map(month => this.categoryActual(dataByMonth[month][category])) }));
    return { labels, datasets, table: { caption: 'Actual spending by month and category',
      columns: ['Month', 'Category', 'Actual spending'], rows: months.flatMap((month, monthIndex) =>
        categories.map((category, categoryIndex) => ({ header: labels[monthIndex],
          cells: [category, this.formatWholeAmount(datasets[categoryIndex].data[monthIndex])] }))) } };
  },

  buildCompositionModel(months) {
    let targetMonth = months[months.length - 1];
    for (let index = months.length - 1; index >= 0; index--) {
      if (this.plannedIncome(Store.calcMonthSummary(months[index])) > 0) { targetMonth = months[index]; break; }
    }
    const summary = Store.calcMonthSummary(targetMonth); const plannedIncome = this.plannedIncome(summary);
    const totals = Store.calcCategoryTotals(targetMonth); const labels = Object.keys(totals);
    const data = labels.map(category => this.categoryPlanned(totals[category]));
    const allocations = Store.getMonth(targetMonth).allocations || {};
    ALLOCATION_TYPES.forEach(allocation => {
      if (allocations[allocation.key] > 0) { labels.push(allocation.label); data.push(allocations[allocation.key]); }
    });
    return { targetMonth, plannedIncome, labels, data, table: {
      caption: `Planned spending and allocations for ${this.formatMonthShort(targetMonth)}`,
      columns: ['Category or allocation', 'Planned amount', 'Percent of planned income'],
      rows: labels.map((label, index) => ({ header: label, cells: [this.formatWholeAmount(data[index]),
        plannedIncome === 0 ? 'Unavailable' : `${((data[index] / plannedIncome) * 100).toFixed(1)}%`] }))
    } };
  },

  buildProjectedActualModel(months) {
    const labels = months.map(month => this.formatMonthShort(month));
    const planned = months.map(month => this.plannedExpenses(Store.calcMonthSummary(month)));
    const actual = months.map(month => this.actualExpenses(Store.calcMonthSummary(month)));
    return { labels, planned, actual, table: { caption: 'Planned and actual expenses by month',
      columns: ['Month', 'Planned expenses', 'Actual expenses'], rows: labels.map((label, index) =>
        ({ header: label, cells: [this.formatWholeAmount(planned[index]), this.formatWholeAmount(actual[index])] })) } };
  },

  buildSavingsRateModel(months) {
    const labels = months.map(month => this.formatMonthShort(month));
    const rows = months.map(month => {
      const summary = Store.calcMonthSummary(month); const allocation = Store.getMonth(month).allocations || {};
      const plannedAllocation = (allocation.savings || 0) + (allocation.investments || 0);
      const plannedIncome = this.plannedIncome(summary);
      return { plannedAllocation, plannedIncome, chartRate: plannedIncome > 0 ? (plannedAllocation / plannedIncome) * 100 : 0 };
    });
    return { labels, rates: rows.map(row => row.chartRate), table: {
      caption: 'Planned savings and investment allocation rate by month',
      columns: ['Month', 'Planned savings and investments', 'Planned income', 'Allocation rate'],
      rows: rows.map((row, index) => ({ header: labels[index], cells: [this.formatWholeAmount(row.plannedAllocation),
        this.formatWholeAmount(row.plannedIncome), row.plannedIncome > 0 ? `${row.chartRate.toFixed(1)}%` : 'Unavailable'] }))
    } };
  },

  buildPaymentMethodModel(months) {
    const labels = months.map(month => this.formatMonthShort(month));
    const totals = months.map(mk => Store.calcPaymentMethodTotals(mk, 'planned'));
    const datasets = [
      { label: 'Bank', key: 'bank' }, { label: 'Credit Card', key: 'credit_card' },
      { label: 'Savings', key: 'savings' }, { label: 'Investments', key: 'investments' }
    ].map(method => ({ label: method.label, data: totals.map(total => total[method.key] ?? 0) }));
    return { labels, datasets, table: { caption: 'Planned bills by payment method and month',
      columns: ['Month', ...datasets.map(dataset => dataset.label)], rows: labels.map((label, monthIndex) =>
        ({ header: label, cells: datasets.map(dataset => this.formatWholeAmount(dataset.data[monthIndex])) })) } };
  },

  buildYoYModel(months) {
    const years = {};
    months.forEach(month => { const year = month.slice(0, 4); (years[year] ||= []).push(month); });
    const yearKeys = Object.keys(years).sort();
    const sequences = yearKeys.map(year => years[year].map(month => month.slice(5)));
    const eligible = yearKeys.length >= 2 && sequences[0].length > 0 &&
      sequences.every(sequence => JSON.stringify(sequence) === JSON.stringify(sequences[0]));
    if (!eligible) return { eligible: false, reason: 'Select at least two years with the same calendar months to compare categories.' };
    const categories = new Set(); months.forEach(month =>
      Object.keys(Store.calcCategoryTotals(month)).forEach(category => categories.add(category)));
    const labels = [...categories];
    const datasets = yearKeys.map(year => ({ label: year, data: labels.map(category => {
      let total = 0;
      for (const month of years[year]) {
        const value = this.categoryActual(Store.calcCategoryTotals(month)[category]);
        if (value === null) return null; total += value;
      }
      return total;
    }) }));
    return { eligible: true, labels, datasets, table: { caption: 'Actual category spending by selected year',
      columns: ['Category', ...yearKeys], rows: labels.map((label, categoryIndex) => ({ header: label,
        cells: datasets.map(dataset => this.formatWholeAmount(dataset.data[categoryIndex])) })) } };
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
    const model = this.buildCategoryTrendModel(months);
    const datasets = model.datasets.map((dataset, index) => ({
      label: dataset.label, data: dataset.data,
      borderColor: this.COLORS[index % this.COLORS.length],
      backgroundColor: this.COLORS[index % this.COLORS.length] + '33',
      tension: 0.3,
      fill: false
    }));

    const ctx = document.getElementById('chart-category-trend').getContext('2d');
    this.charts.categoryTrend = new Chart(ctx, {
      type: 'line',
      data: { labels: model.labels, datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
        }
      }
    });
    this.renderDataTable('table-category-trend', model.table);
  },

  // 2. % of income by category (doughnut - latest month with data)
  renderIncomePct(months) {
    this.destroyChart('incomePct');
    const model = this.buildCompositionModel(months);
    const { targetMonth, plannedIncome, labels, data } = model;
    const income = plannedIncome === 0 ? 1 : plannedIncome;
    const context = document.getElementById('dashboard-composition-context');
    if (context) context.textContent = plannedIncome > 0
      ? `${this.formatMonthShort(targetMonth)} composition: planned spending and allocations as a percentage of planned income.`
      : `${this.formatMonthShort(targetMonth)} composition: no planned income was entered, so percentages are not shown.`;

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
                if (plannedIncome === 0) return `${ctx.label}: $${ctx.raw.toLocaleString()} (percentage unavailable)`;
                const pct = ((ctx.raw / income) * 100).toFixed(1);
                return `${ctx.label}: $${ctx.raw.toLocaleString()} (${pct}%)`;
              }
            }
          }
        }
      }
    });
    this.renderDataTable('table-income-pct', model.table);
  },

  // 3. Projected vs Actual (grouped bar)
  renderProjVsActual(months) {
    this.destroyChart('projVsActual');
    const model = this.buildProjectedActualModel(months);

    const ctx = document.getElementById('chart-proj-vs-actual').getContext('2d');
    this.charts.projVsActual = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: model.labels,
        datasets: [
          { label: 'Planned expenses', data: model.planned, backgroundColor: DASHBOARD_THEME.accent },
          { label: 'Actual expenses', data: model.actual, backgroundColor: DASHBOARD_THEME.positive }
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
    this.renderDataTable('table-proj-vs-actual', model.table);
  },

  // 4. Savings rate over time (line)
  renderSavingsRate(months) {
    this.destroyChart('savingsRate');
    const model = this.buildSavingsRateModel(months);

    const ctx = document.getElementById('chart-savings-rate').getContext('2d');
    this.charts.savingsRate = new Chart(ctx, {
      type: 'line',
      data: {
        labels: model.labels,
        datasets: [{
          label: 'Planned savings & investment allocation rate',
          data: model.rates,
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
    this.renderDataTable('table-savings-rate', model.table);
  },

  // 5. Payment method breakdown (bar)
  renderPaymentMethod(months) {
    this.destroyChart('paymentMethod');
    const model = this.buildPaymentMethodModel(months);
    const colors = [DASHBOARD_THEME.info, DASHBOARD_THEME.warning, DASHBOARD_THEME.positive, DASHBOARD_THEME.accent];

    const ctx = document.getElementById('chart-payment-method').getContext('2d');
    this.charts.paymentMethod = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: model.labels,
        datasets: model.datasets.map((dataset, index) => ({ ...dataset, backgroundColor: colors[index] }))
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
    this.renderDataTable('table-payment-method', model.table);
  },

  // 6. Year-over-Year comparison (grouped bar by category)
  renderYoY(months) {
    this.destroyChart('yoy');
    const model = this.buildYoYModel(months);
    const card = document.getElementById('dashboard-yoy-card'); const state = document.getElementById('dashboard-yoy-state');
    if (!model.eligible) {
      const table = document.getElementById('table-yoy'); if (table) table.replaceChildren();
      if (card) card.hidden = true;
      if (state) { state.textContent = model.reason; state.hidden = false; }
      return;
    }
    if (card) card.hidden = false;
    if (state) { state.textContent = ''; state.hidden = true; }
    const datasets = model.datasets.map((dataset, index) => ({
        label: dataset.label, data: dataset.data,
        backgroundColor: this.COLORS[index % this.COLORS.length]
      }));

    const ctx = document.getElementById('chart-yoy').getContext('2d');
    this.charts.yoy = new Chart(ctx, {
      type: 'bar',
      data: { labels: model.labels, datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
          y: { ticks: { color: DASHBOARD_THEME.muted, callback: v => '$' + v.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
        }
      }
    });
    this.renderDataTable('table-yoy', model.table);
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
    strong.textContent = 'Planned income'; cell.append(strong);
    months.forEach(mk => {
      const s = Store.calcMonthSummary(mk);
      incomeRow.insertCell().textContent = this.formatWholeAmount(this.plannedIncome(s));
    });
    incomeRow.insertCell();
    document.getElementById('summary-table-container').replaceChildren(table);
  }
};
