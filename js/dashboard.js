// Dashboard view - charts and analytics

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
    '#6366f1', '#22c55e', '#ef4444', '#eab308', '#3b82f6',
    '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4',
    '#84cc16', '#e11d48'
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
      data: months.map(mk => (dataByMonth[mk][cat]?.actual || dataByMonth[mk][cat]?.projected || 0)),
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
        plugins: { legend: { position: 'bottom', labels: { color: '#e4e6ef', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2e3347' } },
          y: { ticks: { color: '#8b8fa3', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3347' } }
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
      if (s.totalIncome > 0) { targetMonth = months[i]; break; }
    }

    const summary = Store.calcMonthSummary(targetMonth);
    const catTotals = Store.calcCategoryTotals(targetMonth);
    const income = summary.totalIncome || 1;

    const labels = Object.keys(catTotals);
    const data = labels.map(c => catTotals[c].actual || catTotals[c].projected || 0);
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
          legend: { position: 'bottom', labels: { color: '#e4e6ef', boxWidth: 12, font: { size: 11 } } },
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
    const projected = months.map(mk => Store.calcMonthSummary(mk).totalProjected);
    const actual = months.map(mk => Store.calcMonthSummary(mk).totalActual);

    const ctx = document.getElementById('chart-proj-vs-actual').getContext('2d');
    this.charts.projVsActual = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [
          { label: 'Projected', data: projected, backgroundColor: '#6366f1' },
          { label: 'Actual', data: actual, backgroundColor: '#22c55e' }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: '#e4e6ef', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2e3347' } },
          y: { ticks: { color: '#8b8fa3', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3347' } }
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
      return summary.totalIncome > 0 ? (totalSaved / summary.totalIncome) * 100 : 0;
    });

    const ctx = document.getElementById('chart-savings-rate').getContext('2d');
    this.charts.savingsRate = new Chart(ctx, {
      type: 'line',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [{
          label: 'Savings Rate %',
          data: rates,
          borderColor: '#22c55e',
          backgroundColor: '#22c55e33',
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2e3347' } },
          y: { ticks: { color: '#8b8fa3', callback: v => v + '%' }, grid: { color: '#2e3347' }, min: 0 }
        }
      }
    });
  },

  // 5. Payment method breakdown (bar)
  renderPaymentMethod(months) {
    this.destroyChart('paymentMethod');
    const bank = months.map(mk => Store.calcPaymentMethodTotals(mk).bank || 0);
    const cc = months.map(mk => Store.calcPaymentMethodTotals(mk).credit_card || 0);

    const ctx = document.getElementById('chart-payment-method').getContext('2d');
    this.charts.paymentMethod = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => this.formatMonthShort(m)),
        datasets: [
          { label: 'Bank', data: bank, backgroundColor: '#3b82f6' },
          { label: 'Credit Card', data: cc, backgroundColor: '#f97316' }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: '#e4e6ef', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2e3347' } },
          y: { ticks: { color: '#8b8fa3', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3347' }, stacked: true }
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
          catSums[c] += (totals[c]?.actual || totals[c]?.projected || 0);
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
        plugins: { legend: { position: 'bottom', labels: { color: '#e4e6ef', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2e3347' } },
          y: { ticks: { color: '#8b8fa3', callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3347' } }
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
        const val = dataByMonth[mk][cat]?.actual || dataByMonth[mk][cat]?.projected || 0;
        row.insertCell().textContent = `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        total += val;
        if (val > 0) count++;
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
      const val = s.totalActual || s.totalProjected;
      cell = totalRow.insertCell(); strong = document.createElement('strong');
      strong.textContent = `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`; cell.append(strong);
      grandTotal += val;
      if (val > 0) monthCount++;
    });
    const grandAvg = monthCount > 0 ? grandTotal / monthCount : 0;
    cell = totalRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = `$${grandAvg.toLocaleString(undefined, { maximumFractionDigits: 0 })}`; cell.append(strong);
    const incomeRow = tbody.insertRow(); cell = incomeRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = 'Income'; cell.append(strong);
    months.forEach(mk => {
      const s = Store.calcMonthSummary(mk);
      incomeRow.insertCell().textContent = `$${s.totalIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    });
    incomeRow.insertCell();
    document.getElementById('summary-table-container').replaceChildren(table);
  }
};
