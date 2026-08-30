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

  getMonthsInRange() {
    const { from, to } = this.getDateRange();
    if (!from || !to) return [];

    const months = [];
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    let d = new Date(fy, fm - 1, 1);
    const end = new Date(ty, tm - 1, 1);

    while (d <= end) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push(key);
      d.setMonth(d.getMonth() + 1);
    }
    return months;
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
    const months = this.getMonthsInRange();
    if (months.length === 0) return;

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
