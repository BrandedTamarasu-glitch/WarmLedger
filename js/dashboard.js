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

function dashboardCsv(rows) {
  const encode = value => {
    const isText = typeof value === 'string';
    let text = value === null || value === undefined ? '' : String(value);
    if (isText && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `\uFEFF${rows.map(row => row.map(encode).join(',')).join('\r\n')}\r\n`;
}

function dashboardForecastMonths(horizon, civilDate) {
  if (![3, 6, 12].includes(horizon) || !civilDate || !Number.isInteger(civilDate.year) ||
      !Number.isInteger(civilDate.month) || civilDate.year < 0 || civilDate.year > 9999 ||
      civilDate.month < 1 || civilDate.month > 12) return null;
  const start = civilDate.year * 12 + civilDate.month;
  const months = [];
  for (let offset = 0; offset < horizon; offset++) {
    const ordinal = start + offset; const year = Math.floor(ordinal / 12); const month = ordinal % 12 + 1;
    if (year > 9999) return null;
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
  }
  return Object.freeze(months);
}

const DashboardView = {
  charts: {},
  basis: 'planned',
  forecastHorizon: 3,
  upcomingDayCount: 30,
  reviewQueueLookback: 12,
  savedRecordSearchRequest: null,
  savedMonthComparisonRequest: null,
  savedMonthComparisonDirty: false,
  savedMonthComparisonExplainRequest: null,

  init() {
    this.bindEvents();
    this.setDefaultDateRange();
  },

  bindEvents() {
    document.getElementById('dash-from').addEventListener('change', () => this.render());
    document.getElementById('dash-to').addEventListener('change', () => this.render());
    document.getElementById('btn-dashboard-csv').addEventListener('click', () => this.exportCsv());
    document.getElementById('btn-dashboard-print').addEventListener('click', () => this.printReport());
    document.getElementById('btn-dashboard-forecast-csv').addEventListener('click', () => this.exportForecastCsv());
    const comparisonForm = document.getElementById('dashboard-saved-month-comparison-form');
    if (comparisonForm?.addEventListener) comparisonForm.addEventListener('submit', event => {
      event.preventDefault(); this.compareSavedMonths({ announce: true });
    });
    for (const id of ['dashboard-comparison-baseline', 'dashboard-comparison-month']) {
      const control = document.getElementById(id);
      if (control?.addEventListener) control.addEventListener('change', () => this.changeSavedMonthComparison());
    }
    const comparisonCsv = document.getElementById('btn-dashboard-comparison-csv');
    if (comparisonCsv?.addEventListener) comparisonCsv.addEventListener('click', () => this.exportSavedMonthComparisonCsv());
    const comparisonPrint = document.getElementById('btn-dashboard-comparison-print');
    if (comparisonPrint?.addEventListener) comparisonPrint.addEventListener('click', () => this.printSavedMonthComparison());
    const finderForm = document.getElementById('dashboard-record-finder-form');
    if (finderForm?.addEventListener) finderForm.addEventListener('submit', event => {
      event.preventDefault(); this.submitSavedRecordSearch();
    });
    const finderClear = document.getElementById('dashboard-record-clear');
    if (finderClear?.addEventListener) finderClear.addEventListener('click', () => this.clearSavedRecordSearch());
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[data-dashboard-basis]').forEach(button => {
        button.onclick = () => this.applyBasis(button.dataset.dashboardBasis);
      });
      document.querySelectorAll('[data-dashboard-forecast-horizon]').forEach(button => {
        button.onclick = () => this.applyForecastHorizon(Number(button.dataset.dashboardForecastHorizon));
      });
      document.querySelectorAll('[data-dashboard-quick-range]').forEach(button => {
        button.onclick = () => this.applyQuickRange(button.dataset.dashboardQuickRange);
      });
      const upcomingControls = typeof document.getElementsByName === 'function'
        ? document.getElementsByName('dashboard-upcoming-days') : [];
      [...upcomingControls].forEach(control => {
        control.onchange = () => {
          if (!control.checked) return;
          this.upcomingDayCount = Number(control.value); this.renderUpcoming();
        };
      });
      const reviewControls = typeof document.getElementsByName === 'function'
        ? document.getElementsByName('dashboard-review-months') : [];
      [...reviewControls].forEach(control => {
        control.onchange = () => {
          if (!control.checked) return;
          this.reviewQueueLookback = Number(control.value); this.renderMonthReviewQueue();
        };
      });
    }
  },

  localCivilDate() {
    const today = new Date();
    return `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  },

  localCivilMonth() {
    return this.localCivilDate().slice(0, 7);
  },

  reviewRouteLabel(kind) {
    return ({ actuals: 'Enter actual amounts', dates: 'Add record dates', funding: 'Review paycheck funding',
      'manual-clearing': 'Review manual cleared marks' })[kind];
  },

  reviewRouteTarget(kind) {
    return ({ actuals: 'budget-actuals', dates: 'budget-dates', funding: 'budget-funding',
      'manual-clearing': 'manual-cleared-checklist' })[kind];
  },

  renderMonthReviewQueue() {
    const container = document.getElementById('dashboard-review-queue-content');
    if (!container || typeof Store.getMonthReviewQueue !== 'function') return;
    container.replaceChildren();
    let report;
    try { report = Store.getMonthReviewQueue({ anchorMonth: this.localCivilMonth(), lookbackMonths: this.reviewQueueLookback }); }
    catch (error) { App.showError(error); return; }
    const coverage = this.upcomingNode('dl', 'dashboard-review-coverage');
    [['Saved months', report.coverage.savedMonthCount], ['Saved empty months', report.coverage.emptyMonthCount],
      ['Months with listed attention', report.coverage.monthsWithAttentionCount],
      ['Saved months with no listed attention', report.coverage.savedMonthsClearCount]].forEach(([label, value]) => {
      const row = this.upcomingNode('div'); row.append(this.upcomingNode('dt', '', label), this.upcomingNode('dd', '', String(value))); coverage.append(row);
    });
    container.append(coverage);
    if (!report.items.length && !report.emptyMonths.length) {
      container.append(this.upcomingNode('p', 'dashboard-review-empty', 'No saved months in this window have listed attention or are empty.'));
      return;
    }
    if (report.items.length) {
      const section = this.upcomingNode('section', 'dashboard-review-attention');
      section.append(this.upcomingNode('h3', '', 'Saved months with listed attention'));
      const list = this.upcomingNode('ul', 'dashboard-review-list');
      report.items.forEach(item => list.append(this.reviewQueueItem(item)));
      section.append(list); container.append(section);
    }
    if (report.emptyMonths.length) {
      const section = this.upcomingNode('section', 'dashboard-review-empty-months');
      section.append(this.upcomingNode('h3', '', 'Saved empty months'));
      const list = this.upcomingNode('ul', 'dashboard-review-list');
      report.emptyMonths.forEach(monthKey => list.append(this.reviewEmptyMonthItem(monthKey)));
      section.append(list); container.append(section);
    }
  },

  reviewQueueItem(item) {
    const row = this.upcomingNode('li', 'dashboard-review-item');
    row.append(this.upcomingNode('h4', '', App.formatMonth(item.monthKey)));
    const facts = this.upcomingNode('ul', 'dashboard-review-facts');
    const labels = { actualsMissing: 'actual amounts not entered', datesMissing: 'record dates needed',
      fundingIssues: 'existing funding issues', notManuallyCleared: 'records not manually marked cleared' };
    Object.entries(labels).forEach(([key, label]) => {
      const count = item.counts[key]; if (count) facts.append(this.upcomingNode('li', '', `${count} ${label}.`));
    });
    if (!item.availability.manualClearing) facts.append(this.upcomingNode('li', '', 'Manual clearing is unavailable for this budget version.'));
    row.append(facts);
    const actions = this.upcomingNode('div', 'dashboard-review-actions');
    item.attentionKinds.forEach(kind => {
      const button = this.upcomingNode('button', 'btn btn-sm', this.reviewRouteLabel(kind)); button.type = 'button';
      button.dataset.reviewKind = kind; button.dataset.monthKey = item.monthKey;
      button.addEventListener('click', () => BudgetView.routeReviewNavigation(item.monthKey, kind, this.reviewRouteTarget(kind)));
      actions.append(button);
    });
    row.append(actions); return row;
  },

  reviewEmptyMonthItem(monthKey) {
    const row = this.upcomingNode('li', 'dashboard-review-item');
    row.append(this.upcomingNode('h4', '', App.formatMonth(monthKey)),
      this.upcomingNode('p', '', 'Saved month has no paychecks or expenses.'));
    const button = this.upcomingNode('button', 'btn btn-sm', 'Open monthly review'); button.type = 'button';
    button.dataset.emptyMonthKey = monthKey; button.addEventListener('click', () => this.openEmptyReviewMonth(monthKey));
    row.append(button); return row;
  },

  openEmptyReviewMonth(monthKey) {
    const current = Store.getMonthReviewQueue({ anchorMonth: this.localCivilMonth(), lookbackMonths: this.reviewQueueLookback });
    if (!current.emptyMonths.includes(monthKey)) {
      this.renderMonthReviewQueue(); App.announceStatus('Saved-month review facts changed. Review the refreshed list.');
      document.querySelector('#dashboard-review-queue > summary')?.focus({ preventScroll: true }); return false;
    }
    BudgetView.openMonthlyReviewMonth(monthKey); return true;
  },

  savedRecordRequestFromForm() {
    return {
      query: document.getElementById('dashboard-record-query').value,
      kind: document.getElementById('dashboard-record-kind').value,
      fromMonth: document.getElementById('dashboard-record-from').value || null,
      toMonth: document.getElementById('dashboard-record-to').value || null,
      limit: 200
    };
  },

  submitSavedRecordSearch() {
    const request = this.savedRecordRequestFromForm();
    try {
      const report = Store.findSavedRecords(request);
      this.savedRecordSearchRequest = Object.freeze({ ...request, query: report.query });
      this.renderSavedRecordResults(report);
      document.getElementById('dashboard-record-clear').hidden = false;
      return true;
    } catch (error) { App.showError(error); return false; }
  },

  rerunSavedRecordSearch() {
    if (!this.savedRecordSearchRequest) return null;
    const report = Store.findSavedRecords(this.savedRecordSearchRequest);
    this.renderSavedRecordResults(report); return report;
  },

  getSavedRecordSearchRequest() {
    return this.savedRecordSearchRequest ? { ...this.savedRecordSearchRequest } : null;
  },

  clearSavedRecordSearch() {
    this.savedRecordSearchRequest = null;
    document.getElementById('dashboard-record-finder-form').reset();
    document.getElementById('dashboard-record-results').replaceChildren();
    document.getElementById('dashboard-record-clear').hidden = true;
    document.getElementById('dashboard-record-query').focus({ preventScroll: true });
  },

  renderSavedRecordResults(report) {
    const container = document.getElementById('dashboard-record-results'); container.replaceChildren();
    if (!report.returnedCount) {
      container.append(this.upcomingNode('p', 'dashboard-record-results-empty', 'No saved records matched this search.'));
      return;
    }
    container.append(this.upcomingNode('p', 'dashboard-record-results-summary',
      `${report.returnedCount} of ${report.totalMatchCount} matching saved ${report.totalMatchCount === 1 ? 'record' : 'records'} shown.`));
    if (report.truncated) container.append(this.upcomingNode('p', 'dashboard-record-results-truncated',
      `Results are limited to ${report.returnedCount}. Narrow the search or month range to see other matches.`));
    const list = this.upcomingNode('ul', 'dashboard-record-result-list');
    report.results.forEach(result => list.append(this.savedRecordResultItem(result)));
    container.append(list);
  },

  savedRecordResultItem(result) {
    const item = this.upcomingNode('li', 'dashboard-record-result');
    item.append(this.upcomingNode('strong', 'dashboard-record-result-name', result.primaryLabel),
      this.upcomingNode('span', 'dashboard-record-result-meta',
        `${result.kind === 'income' ? 'Paycheck' : 'Expense'} · ${result.secondaryLabel} · ${App.formatMonth(result.monthKey)}`),
      this.upcomingNode('span', 'dashboard-record-result-meta',
        `${result.date || 'Date needed'} · Planned ${BudgetView.fmt(result.plannedAmount)} · ${result.actualAmount === null ? 'Actual: Not entered' : `Actual: ${BudgetView.fmt(result.actualAmount)}`}`));
    const button = this.upcomingNode('button', 'btn btn-sm dashboard-record-result-action',
      `Open ${result.primaryLabel} in ${App.formatMonth(result.monthKey)}`);
    button.type = 'button'; button.dataset.recordKind = result.kind;
    button.dataset.monthKey = result.monthKey; button.dataset.recordId = result.recordId;
    button.addEventListener('click', () => App.openSavedRecordResult(result)); item.append(button);
    return item;
  },

  upcomingNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  savedMonthComparisonFromControls() {
    return Object.freeze({
      baselineMonth: document.getElementById('dashboard-comparison-baseline')?.value || '',
      comparisonMonth: document.getElementById('dashboard-comparison-month')?.value || '',
      basis: this.basis
    });
  },

  changeSavedMonthComparison() {
    this.savedMonthComparisonDirty = true;
    this.closeSavedMonthComparisonExplanation();
    this.clearSavedMonthComparisonOutput();
    this.setSavedMonthComparisonStatus('Choose Compare to update this saved-month comparison.', false);
  },

  setSavedMonthComparisonStatus(message, isError) {
    const status = document.getElementById('dashboard-comparison-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
  },

  clearSavedMonthComparisonOutput() {
    this.savedMonthComparisonExplainRequest = null;
    const output = document.getElementById('dashboard-comparison-output');
    if (output) { output.hidden = true; output.replaceChildren(); }
  },

  populateSavedMonthComparisonPickers(availableMonths, request) {
    for (const [id, selected, label] of [
      ['dashboard-comparison-baseline', request.baselineMonth, 'Choose baseline month'],
      ['dashboard-comparison-month', request.comparisonMonth, 'Choose comparison month']
    ]) {
      const select = document.getElementById(id);
      if (!select || typeof document.createElement !== 'function') continue;
      select.replaceChildren();
      const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = label; select.append(prompt);
      for (const monthKey of availableMonths) {
        const option = document.createElement('option'); option.value = monthKey;
        option.textContent = App.formatMonth(monthKey); select.append(option);
      }
      select.value = availableMonths.includes(selected) ? selected : '';
    }
  },

  savedMonthComparisonResult({ initialize = false } = {}) {
    let request = this.savedMonthComparisonRequest;
    let result = Store.compareSavedMonths(request || { baselineMonth: '', comparisonMonth: '', basis: this.basis });
    if (!request && initialize && result.availableMonths.length >= 2) {
      request = Object.freeze({ baselineMonth: result.availableMonths.at(-2),
        comparisonMonth: result.availableMonths.at(-1), basis: this.basis });
      this.savedMonthComparisonRequest = request;
      result = Store.compareSavedMonths(request);
    }
    this.populateSavedMonthComparisonPickers(result.availableMonths, request || {
      baselineMonth: '', comparisonMonth: ''
    });
    return result;
  },

  comparisonAmount(value) {
    return value === null ? '— Incomplete' : BudgetView.fmt(value);
  },

  renderSavedMonthComparisonTable(result) {
    this.savedMonthComparisonExplainRequest = null;
    const output = document.getElementById('dashboard-comparison-output');
    if (!output) return;
    const context = this.upcomingNode('p', 'dashboard-comparison-context',
      `${App.formatMonth(result.comparisonMonth)} compared with ${App.formatMonth(result.baselineMonth)}. Basis: ${result.basis === 'planned' ? 'Planned' : 'Actual'}. Deltas are comparison minus baseline.`);
    if (result.basis === 'actual') context.append(document.createTextNode(
      ' Allocation rows remain planned-only; incomplete actual amounts are not treated as zero.'
    ));
    const region = this.upcomingNode('div', 'dashboard-data-table table-scroll dashboard-comparison-table');
    region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Saved month comparison table');
    const table = document.createElement('table');
    const caption = document.createElement('caption'); caption.textContent = 'Saved month comparison'; table.append(caption);
    const thead = table.createTHead(); const heading = thead.insertRow();
    for (const column of result.rowModel.columns) {
      const th = document.createElement('th'); th.scope = 'col';
      th.textContent = column === 'Baseline' ? `Baseline (${result.baselineMonth})`
        : column === 'Comparison' ? `Comparison (${result.comparisonMonth})` : column;
      heading.append(th);
    }
    const tbody = table.createTBody();
    for (const row of result.rowModel.rows) {
      const tr = tbody.insertRow();
      result.rowModel.columns.forEach((column, index) => {
        const cell = document.createElement(index === 1 ? 'th' : 'td');
        if (index === 1) cell.scope = 'row';
        cell.textContent = ['Baseline', 'Comparison', 'Delta'].includes(column)
          ? this.comparisonAmount(row[column]) : row[column];
        if (index === 1 && row.drilldownEligible) {
          const button = this.upcomingNode('button', 'btn btn-sm dashboard-comparison-explain-action', 'Explain change');
          button.type = 'button'; button.setAttribute('aria-expanded', 'false');
          button.dataset.comparisonSection = row.sectionKey;
          button.dataset.comparisonDimension = row.dimensionKey;
          button.onclick = () => this.toggleSavedMonthComparisonExplanation(row, button);
          cell.append(button);
        }
        tr.append(cell);
      });
    }
    region.append(table); output.replaceChildren(context, region); output.hidden = false;
  },

  compareSavedMonths({ announce = false, initialize = false } = {}) {
    if (typeof Store.compareSavedMonths !== 'function') return null;
    if (initialize && (this.savedMonthComparisonDirty || (this.savedMonthComparisonRequest &&
      this.savedMonthComparisonRequest.basis !== this.basis))) {
      this.savedMonthComparisonDirty = true;
      this.clearSavedMonthComparisonOutput();
      this.setSavedMonthComparisonStatus('Choose Compare to update this saved-month comparison.', false);
      return null;
    }
    if (!initialize) {
      this.closeSavedMonthComparisonExplanation();
      this.savedMonthComparisonRequest = this.savedMonthComparisonFromControls();
      this.savedMonthComparisonDirty = false;
    }
    const result = this.savedMonthComparisonResult({ initialize });
    if (result.status !== 'ready') {
      this.clearSavedMonthComparisonOutput();
      this.setSavedMonthComparisonStatus(result.summaryLabel, true);
      if (announce) App.announceStatus(result.summaryLabel);
      return result;
    }
    this.renderSavedMonthComparisonTable(result);
    this.setSavedMonthComparisonStatus(result.summaryLabel, false);
    if (announce) App.announceStatus(`Saved month comparison updated. ${result.summaryLabel}`);
    return result;
  },

  savedMonthComparisonExplainRequestFor(row) {
    if (!this.savedMonthComparisonRequest || !row?.drilldownEligible) return null;
    return Object.freeze({ ...this.savedMonthComparisonRequest,
      section: row.sectionKey, dimensionKey: row.dimensionKey });
  },

  sameSavedMonthComparisonExplanation(left, right) {
    return Boolean(left && right && ['baselineMonth', 'comparisonMonth', 'basis', 'section', 'dimensionKey']
      .every(key => left[key] === right[key]));
  },

  closeSavedMonthComparisonExplanation() {
    this.savedMonthComparisonExplainRequest = null;
    const detail = document.getElementById('dashboard-comparison-explanation');
    if (detail?.remove) detail.remove();
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('.dashboard-comparison-explain-action[aria-expanded="true"]')
        .forEach(button => button.setAttribute('aria-expanded', 'false'));
    }
  },

  toggleSavedMonthComparisonExplanation(row, button) {
    const request = this.savedMonthComparisonExplainRequestFor(row);
    if (!request || typeof Store.explainSavedMonthComparisonRow !== 'function') return null;
    if (this.sameSavedMonthComparisonExplanation(this.savedMonthComparisonExplainRequest, request)) {
      this.closeSavedMonthComparisonExplanation(); return null;
    }
    this.closeSavedMonthComparisonExplanation();
    const result = Store.explainSavedMonthComparisonRow(request);
    if (result.status !== 'ready') {
      this.setSavedMonthComparisonStatus(result.summaryLabel, true);
      App.announceStatus(result.summaryLabel); return result;
    }
    this.savedMonthComparisonExplainRequest = request;
    button?.setAttribute('aria-expanded', 'true');
    this.renderSavedMonthComparisonExplanation(result);
    return result;
  },

  savedMonthComparisonContributorItem(record, request) {
    const paymentLabel = ({ bank: 'Bank', credit_card: 'Credit Card', savings: 'Savings',
      investments: 'Investments' })[record.paymentMethod] || 'Other';
    const item = this.upcomingNode('li', 'dashboard-comparison-contributor');
    item.append(this.upcomingNode('strong', 'dashboard-comparison-contributor-name', record.name),
      this.upcomingNode('span', 'dashboard-comparison-contributor-meta',
        `${record.date || 'Date needed'} · ${record.category} · ${paymentLabel}`),
      this.upcomingNode('span', 'dashboard-comparison-contributor-meta',
        `Planned ${BudgetView.fmt(record.plannedAmount)} · ${record.actualAmount === null ? 'Actual: Not entered' : `Actual: ${BudgetView.fmt(record.actualAmount)}`}`),
      this.upcomingNode('span', 'dashboard-comparison-contributor-amount',
        `${request.basis === 'planned' ? 'Planned' : 'Actual'}: ${record.displayAmount === null ? 'Incomplete' : BudgetView.fmt(record.displayAmount)} · ${record.displayStatus}`));
    const edit = this.upcomingNode('button', 'btn btn-sm dashboard-comparison-contributor-edit',
      `Edit ${record.name} in ${App.formatMonth(record.monthKey)}`);
    edit.type = 'button'; edit.onclick = () => {
      if (typeof App.openSavedMonthComparisonContributor === 'function') {
        App.openSavedMonthComparisonContributor(record, request);
      }
    };
    item.append(edit); return item;
  },

  savedMonthComparisonExplanationSide(side, label, request) {
    const section = this.upcomingNode('section', 'dashboard-comparison-explanation-side');
    section.append(this.upcomingNode('h4', '', `${label}: ${App.formatMonth(side.monthKey)}`));
    section.append(this.upcomingNode('p', 'dashboard-comparison-explanation-count',
      `${side.returnedCount} of ${side.totalCount} contributing ${side.totalCount === 1 ? 'expense' : 'expenses'} shown.`));
    if (!side.totalCount) {
      section.append(this.upcomingNode('p', 'dashboard-comparison-explanation-empty',
        'No saved expenses contribute to this side of the comparison.'));
      return section;
    }
    if (side.truncated) section.append(this.upcomingNode('p', 'dashboard-comparison-explanation-truncated',
      'This list is truncated; the comparison total still includes every matching saved expense.'));
    const list = this.upcomingNode('ul', 'dashboard-comparison-contributor-list');
    side.records.forEach(record => list.append(this.savedMonthComparisonContributorItem(record, request)));
    section.append(list); return section;
  },

  renderSavedMonthComparisonExplanation(result) {
    const output = document.getElementById('dashboard-comparison-output');
    if (!output || result.status !== 'ready') return false;
    document.getElementById('dashboard-comparison-explanation')?.remove?.();
    const detail = this.upcomingNode('section', 'dashboard-comparison-explanation');
    detail.id = 'dashboard-comparison-explanation'; detail.setAttribute('role', 'region');
    const heading = this.upcomingNode('h3', '', `Explain change: ${result.rowLabel}`);
    heading.id = 'dashboard-comparison-explanation-heading'; detail.setAttribute('aria-labelledby', heading.id);
    const summary = this.upcomingNode('p', 'dashboard-comparison-explanation-summary',
      `${result.counts.returnedCount} of ${result.counts.totalCount} contributing expenses shown using the ${result.basis === 'planned' ? 'Planned' : 'Actual'} basis.`);
    if (result.counts.truncated) summary.append(document.createTextNode(' Results are capped at 200; comparison totals remain complete.'));
    const sides = this.upcomingNode('div', 'dashboard-comparison-explanation-sides');
    sides.append(this.savedMonthComparisonExplanationSide(result.baseline, 'Baseline', result),
      this.savedMonthComparisonExplanationSide(result.comparison, 'Comparison', result));
    detail.append(heading, summary, sides); output.append(detail); return true;
  },

  refreshSavedMonthComparisonExplanation(request, { announceMessage = '', focusFallback = false } = {}) {
    if (!request || typeof Store.explainSavedMonthComparisonRow !== 'function') return null;
    const result = Store.explainSavedMonthComparisonRow(request);
    this.closeSavedMonthComparisonExplanation();
    if (result.status === 'ready') {
      this.savedMonthComparisonExplainRequest = Object.freeze({ ...request });
      this.renderSavedMonthComparisonExplanation(result);
      const buttons = document.querySelectorAll?.('.dashboard-comparison-explain-action') || [];
      [...buttons].find(button => button.dataset.comparisonSection === request.section &&
        button.dataset.comparisonDimension === request.dimensionKey)?.setAttribute('aria-expanded', 'true');
    } else this.setSavedMonthComparisonStatus(result.summaryLabel, true);
    if (announceMessage) { this.setSavedMonthComparisonStatus(announceMessage, true); App.announceStatus(announceMessage); }
    if (focusFallback) this.focusSavedMonthComparisonFallback(request);
    return result;
  },

  focusSavedMonthComparisonFallback(request = this.savedMonthComparisonExplainRequest) {
    if (typeof document.querySelector === 'function' && request) {
      const buttons = document.querySelectorAll?.('.dashboard-comparison-explain-action') || [];
      const match = [...buttons].find(button => button.dataset.comparisonSection === request.section &&
        button.dataset.comparisonDimension === request.dimensionKey);
      if (match?.focus) { match.focus({ preventScroll: true }); return true; }
    }
    const fallback = document.querySelector?.('#dashboard-saved-month-comparison > summary') ||
      document.getElementById('dashboard-comparison-status');
    fallback?.focus?.({ preventScroll: true }); return Boolean(fallback);
  },

  savedMonthComparisonCsv(result) {
    return dashboardCsv([
      result.rowModel.columns,
      ...result.rowModel.rows.map(row => result.rowModel.columns.map(column => row[column]))
    ]);
  },

  exportSavedMonthComparisonCsv() {
    if (this.savedMonthComparisonDirty || !this.savedMonthComparisonRequest) {
      const message = 'Choose Compare before downloading this saved-month comparison.';
      this.clearSavedMonthComparisonOutput(); this.setSavedMonthComparisonStatus(message, true);
      App.announceStatus(message); return false;
    }
    const result = this.savedMonthComparisonResult();
    if (result.status !== 'ready') {
      this.clearSavedMonthComparisonOutput(); this.setSavedMonthComparisonStatus(result.summaryLabel, true);
      App.announceStatus(result.summaryLabel); return false;
    }
    this.renderSavedMonthComparisonTable(result);
    App.download(this.savedMonthComparisonCsv(result),
      `warm-ledger-comparison-${result.baselineMonth}-to-${result.comparisonMonth}-${result.basis}.csv`,
      'text/csv;charset=utf-8');
    App.announceStatus(`Saved month comparison CSV downloaded for ${result.baselineMonth} and ${result.comparisonMonth} using ${result.basis}.`);
    return true;
  },

  printSavedMonthComparison() {
    if (this.savedMonthComparisonDirty || !this.savedMonthComparisonRequest) {
      const message = 'Choose Compare before printing this saved-month comparison.';
      this.clearSavedMonthComparisonOutput(); this.setSavedMonthComparisonStatus(message, true);
      App.announceStatus(message); return false;
    }
    const result = this.savedMonthComparisonResult();
    if (result.status !== 'ready') {
      this.clearSavedMonthComparisonOutput(); this.setSavedMonthComparisonStatus(result.summaryLabel, true);
      App.announceStatus(result.summaryLabel); return false;
    }
    this.renderSavedMonthComparisonTable(result);
    document.body?.classList.add('printing-saved-month-comparison');
    try { globalThis.print(); }
    finally { document.body?.classList.remove('printing-saved-month-comparison'); }
    return true;
  },

  renderUpcoming() {
    const container = document.getElementById('dashboard-upcoming-content');
    if (!container || typeof Store.getUpcomingBillsAndPaydays !== 'function') return;
    container.replaceChildren();
    let projection;
    try { projection = Store.getUpcomingBillsAndPaydays({ anchorDate: this.localCivilDate(), dayCount: this.upcomingDayCount }); }
    catch (error) { App.showError(error); return; }
    container.append(this.upcomingNode('p', 'dashboard-upcoming-range',
      `${projection.dayCount}-day window: ${this.fullDate(projection.anchorDate)} through ${this.fullDate(projection.endDate)}.`),
    this.upcomingNode('p', 'dashboard-upcoming-counts',
      `${projection.counts.paydayCount} ${projection.counts.paydayCount === 1 ? 'payday' : 'paydays'} and ${projection.counts.billCount} ${projection.counts.billCount === 1 ? 'bill' : 'bills'} in saved plans.`),
    this.upcomingCoverage(projection.coverage));
    const timeline = this.upcomingNode('section', 'dashboard-upcoming-timeline');
    timeline.append(this.upcomingNode('h3', '', 'Scheduled records'));
    const dated = projection.dateGroups.filter(group => group.paydays.length || group.bills.length);
    if (!dated.length) timeline.append(this.upcomingNode('p', 'muted-text', 'No saved records with dates fall inside this window.'));
    dated.forEach(group => timeline.append(this.upcomingDateGroup(group)));
    container.append(timeline, this.upcomingDateNeeded(projection.dateNeeded));
  },

  upcomingCoverage(coverage) {
    const section = this.upcomingNode('section', 'dashboard-upcoming-coverage');
    section.append(this.upcomingNode('h3', '', 'Saved-plan coverage'));
    const list = this.upcomingNode('ul', 'dashboard-upcoming-coverage-list');
    coverage.forEach(entry => {
      const item = this.upcomingNode('li'); item.append(this.upcomingNode('span', '', App.formatMonth(entry.monthKey)),
        this.upcomingNode('strong', '', entry.state === 'saved-plan' ? 'Saved plan' : 'No saved plan')); list.append(item);
    });
    section.append(list); return section;
  },

  upcomingDateGroup(group) {
    const section = this.upcomingNode('section', 'dashboard-upcoming-date-group');
    const heading = this.upcomingNode('h4'); const time = this.upcomingNode('time', '', this.fullDate(group.date));
    time.dateTime = group.date; heading.append(time); section.append(heading);
    const list = this.upcomingNode('ul', 'dashboard-upcoming-list');
    group.paydays.forEach(item => list.append(this.upcomingPayday(item)));
    group.bills.forEach(item => list.append(this.upcomingBill(item)));
    section.append(list); return section;
  },

  upcomingPayday(item) {
    const row = this.upcomingNode('li', 'dashboard-upcoming-item');
    row.append(this.upcomingNode('strong', 'dashboard-upcoming-kind', 'Payday'),
      this.upcomingNode('span', 'dashboard-upcoming-name', item.earner),
      this.upcomingNode('span', '', `Planned ${BudgetView.fmt(item.plannedAmount)}`),
      this.upcomingNode('span', '', item.actualState === 'not-entered'
        ? 'Actual: Not entered' : `Actual: Entered ${BudgetView.fmt(item.actualAmount)}`));
    return row;
  },

  upcomingBill(item) {
    const row = this.upcomingNode('li', 'dashboard-upcoming-item');
    row.append(this.upcomingNode('strong', 'dashboard-upcoming-kind', 'Bill'),
      this.upcomingNode('span', 'dashboard-upcoming-name', item.name), this.upcomingNode('span', 'muted-text', item.category),
      this.upcomingNode('span', '', `Planned ${BudgetView.fmt(item.plannedAmount)}`),
      this.upcomingNode('span', '', item.actualState === 'not-entered'
        ? 'Actual: Not entered' : `Actual: Entered ${BudgetView.fmt(item.actualAmount)}`),
      this.upcomingNode('span', '', this.upcomingFunding(item)));
    return row;
  },

  upcomingFunding(item) {
    if (item.fundingState === 'unfunded') return 'Funding: Unfunded; no saved paycheck assignment.';
    if (item.fundingState === 'partially-funded') return `Funding: Partially funded; ${BudgetView.fmt(item.fundedAcrossPaychecks)} assigned and ${BudgetView.fmt(item.remainingToFund)} remaining to fund.`;
    return `Funding: Fully funded across ${item.fundedPaycheckCount} saved paycheck ${item.fundedPaycheckCount === 1 ? 'assignment' : 'assignments'}${item.splitAcrossPaychecks ? '; split across paychecks' : ''}.`;
  },

  upcomingDateNeeded(groups) {
    const section = this.upcomingNode('section', 'dashboard-upcoming-date-needed');
    section.append(this.upcomingNode('h3', '', 'Date needed'),
      this.upcomingNode('p', 'muted-text', 'These saved records have a blank date and are not placed on the timeline.'));
    if (!groups.length) { section.append(this.upcomingNode('p', 'muted-text', 'No saved records need a date in this window.')); return section; }
    groups.forEach(group => {
      const block = this.upcomingNode('section', 'dashboard-upcoming-needed-group');
      block.append(this.upcomingNode('h4', '', App.formatMonth(group.monthKey)));
      const list = this.upcomingNode('ul', 'dashboard-upcoming-list');
      group.paydays.forEach(item => list.append(this.upcomingPayday(item)));
      group.bills.forEach(item => list.append(this.upcomingBill(item)));
      block.append(list); section.append(block);
    });
    return section;
  },

  fullDate(date) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined,
      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  },

  applyBasis(basis) {
    if (basis !== 'planned' && basis !== 'actual') return false;
    this.basis = basis;
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[data-dashboard-basis]').forEach(button => {
        const selected = button.dataset.dashboardBasis === basis;
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('is-selected', selected);
      });
    }
    this.render();
    return true;
  },

  applyForecastHorizon(horizon) {
    if (![3, 6, 12].includes(horizon)) return false;
    this.forecastHorizon = horizon;
    document.querySelectorAll('[data-dashboard-forecast-horizon]').forEach(button => {
      const selected = Number(button.dataset.dashboardForecastHorizon) === horizon;
      button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('is-selected', selected);
    });
    this.renderForecast(); return true;
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

  prepareRange(monthKeys, basis = this.basis) {
    if (typeof Store.prepareDashboardRange === 'function') return Store.prepareDashboardRange({ monthKeys: [...monthKeys], basis });
    // Compatibility seam for isolated view tests; production always supplies the prepared Store API.
    const months = {};
    for (const monthKey of monthKeys) {
      const month = typeof Store.getMonth === 'function' ? Store.getMonth(monthKey) : {};
      const paychecks = month.paychecks || []; const expenses = month.expenses || [];
      const summary = typeof Store.calcMonthSummary === 'function' ? Store.calcMonthSummary(monthKey) : {};
      months[monthKey] = { summary, allocations: month.allocations || {},
        categoryTotals: typeof Store.calcCategoryTotals === 'function' ? Store.calcCategoryTotals(monthKey) : {},
        paymentMethodTotals: typeof Store.calcPaymentMethodTotals === 'function' ? Store.calcPaymentMethodTotals(monthKey, basis) : {},
        incompletePaymentMethods: basis === 'actual' ? expenses.filter(item => item.actualAmount === null).map(item => item.paymentMethod) : [],
        paycheckCount: paychecks.length, expenseCount: expenses.length };
    }
    return { basis, monthKeys: [...monthKeys], months };
  },

  asPrepared(value, basis = this.basis) {
    return Array.isArray(value) ? this.prepareRange(value, basis) : value;
  },

  preparedEntry(prepared, monthKey) {
    return prepared.months[monthKey];
  },

  buildCsv(monthsOrPrepared, basis) {
    const prepared = Array.isArray(monthsOrPrepared) ? this.prepareRange(monthsOrPrepared, basis) : monthsOrPrepared;
    const months = prepared.monthKeys;
    const rows = [['Month', 'Basis', 'Metric', 'Category', 'Payment method', 'Value', 'Status']];
    const add = (month, metric, category, paymentMethod, value) => rows.push([
      month, basis, metric, category, paymentMethod, value === null ? '' : value, value === null ? 'Incomplete' : 'Complete'
    ]);
    for (const month of months) {
      const entry = this.preparedEntry(prepared, month); const summary = entry.summary;
      const income = basis === 'planned' ? this.plannedIncome(summary) :
        (summary.unresolvedIncomeCount === 0 ? summary.totalActualIncome : null);
      const expenses = basis === 'planned' ? this.plannedExpenses(summary) : this.actualExpenses(summary);
      add(month, 'Income', '', '', income);
      add(month, 'Total expenses', '', '', expenses);
      const categoryTotals = entry.categoryTotals;
      for (const category of Object.keys(categoryTotals).sort()) {
        const value = basis === 'planned' ? this.categoryPlanned(categoryTotals[category]) : this.categoryActual(categoryTotals[category]);
        add(month, 'Category spending', category, '', value);
      }
      const methodTotals = entry.paymentMethodTotals;
      const incompleteMethods = new Set(basis === 'actual' ? entry.incompletePaymentMethods : []);
      for (const [key, label] of [['bank', 'Bank'], ['credit_card', 'Credit Card'], ['savings', 'Savings'], ['investments', 'Investments']]) {
        add(month, 'Bills by payment method', '', label, incompleteMethods.has(key) ? null : (methodTotals[key] ?? 0));
      }
    }
    return dashboardCsv(rows);
  },

  getForecastMonths() {
    const now = new Date();
    return dashboardForecastMonths(this.forecastHorizon, { year: now.getFullYear(), month: now.getMonth() + 1 }) || Object.freeze([]);
  },

  buildForecastModel(months, prepared = this.prepareRange(months, 'planned')) {
    const storedMonths = new Set(Store.getAllMonthKeys());
    const rows = months.map(month => {
      if (!storedMonths.has(month)) return Object.freeze({ month, saved: false, income: null, expenses: null, allocations: null, remainder: null });
      const entry = prepared.months[month]; const summary = entry.summary;
      const income = this.plannedIncome(summary); const expenses = this.plannedExpenses(summary);
      const allocations = summary.totalAllocated ?? Object.values(entry.allocations || {})
        .reduce((sum, value) => sum + value, 0);
      return Object.freeze({ month, saved: true, income, expenses, allocations,
        remainder: income - expenses - allocations });
    });
    const savedCount = rows.filter(row => row.saved).length;
    return Object.freeze({ months: Object.freeze([...months]), rows: Object.freeze(rows), savedCount });
  },

  renderForecast() {
    this.destroyChart('forecast');
    const model = this.buildForecastModel(this.getForecastMonths());
    const state = document.getElementById('dashboard-forecast-state');
    if (state) state.textContent = model.savedCount
      ? `${model.savedCount} of ${model.rows.length} forecast months have a saved plan. Missing months are not estimated.`
      : `No saved plans were found in the next ${model.rows.length} months. Missing months are not estimated.`;
    const labels = model.rows.map(row => this.formatMonthShort(row.month));
    const ctx = document.getElementById('chart-dashboard-forecast').getContext('2d');
    this.charts.forecast = new Chart(ctx, { type: 'bar', data: { labels, datasets: [
      { label: 'Planned income', data: model.rows.map(row => row.income), backgroundColor: DASHBOARD_THEME.info },
      { label: 'Planned expenses and allocations', data: model.rows.map(row => row.saved ? row.expenses + row.allocations : null), backgroundColor: DASHBOARD_THEME.accent },
      { label: 'Planned monthly remainder', data: model.rows.map(row => row.remainder), backgroundColor: DASHBOARD_THEME.positive }
    ] }, options: { responsive: true,
      plugins: { legend: { position: 'bottom', labels: { color: DASHBOARD_THEME.text, boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: DASHBOARD_THEME.muted }, grid: { color: DASHBOARD_THEME.grid } },
        y: { ticks: { color: DASHBOARD_THEME.muted, callback: value => '$' + value.toLocaleString() }, grid: { color: DASHBOARD_THEME.grid } }
      }
    } });
    this.renderDataTable('table-dashboard-forecast', { caption: 'Saved future month plans',
      columns: ['Month', 'Source', 'Planned income', 'Planned expenses', 'Planned allocations', 'Planned monthly remainder'],
      rows: model.rows.map(row => ({ header: this.formatMonthShort(row.month), cells: [row.saved ? 'Saved month plan' : 'No saved plan',
        this.formatForecastAmount(row.income), this.formatForecastAmount(row.expenses),
        this.formatForecastAmount(row.allocations), this.formatForecastAmount(row.remainder)] })) });
    return model;
  },

  formatForecastAmount(value) {
    return value === null ? '— No saved plan' : this.formatWholeAmount(value);
  },

  exportForecastCsv() {
    const model = this.buildForecastModel(this.getForecastMonths());
    const rows = [['Month', 'Source', 'Planned income', 'Planned expenses', 'Planned allocations', 'Planned monthly remainder']];
    model.rows.forEach(row => rows.push([row.month, row.saved ? 'Saved month plan' : 'No saved plan',
      row.income, row.expenses, row.allocations, row.remainder]));
    const from = model.months[0]; const to = model.months[model.months.length - 1];
    App.download(dashboardCsv(rows), `warm-ledger-forecast-${from}-to-${to}.csv`, 'text/csv;charset=utf-8');
    App.announceStatus(`Planned forecast CSV downloaded for ${from} to ${to}.`); return true;
  },

  exportCsv() {
    const range = this.validateDateRange(this.getDateRange());
    if (range.status !== 'ready') {
      this.clearRenderedOutput(); this.renderState(range);
      document.getElementById('dashboard-state')?.focus(); return false;
    }
    const content = this.buildCsv(range.months, this.basis);
    App.download(content, `warm-ledger-dashboard-${range.from}-to-${range.to}-${this.basis}.csv`, 'text/csv;charset=utf-8');
    App.announceStatus(`Dashboard CSV downloaded for ${range.from} to ${range.to} using ${this.basis} spending.`);
    return true;
  },

  printReport() {
    const range = this.validateDateRange(this.getDateRange());
    if (range.status !== 'ready') {
      this.clearRenderedOutput(); this.renderState(range);
      document.getElementById('dashboard-state')?.focus(); return false;
    }
    this.render();
    const results = document.getElementById('dashboard-results');
    if (!results || results.hidden) {
      document.getElementById('dashboard-state')?.focus(); return false;
    }
    globalThis.print();
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

  buildCategoryTrendModel(prepared, basis = 'actual') {
    prepared = this.asPrepared(prepared, basis);
    const months = prepared.monthKeys;
    const allCategories = new Set(); const dataByMonth = {};
    months.forEach(monthKey => {
      const totals = prepared.months[monthKey].categoryTotals; dataByMonth[monthKey] = totals;
      Object.keys(totals).forEach(category => allCategories.add(category));
    });
    const categories = [...allCategories]; const labels = months.map(month => this.formatMonthShort(month));
    const valueFor = total => basis === 'planned' ? this.categoryPlanned(total) : this.categoryActual(total);
    const basisLabel = basis === 'planned' ? 'Planned' : 'Actual';
    const datasets = categories.map(category => ({ label: category,
      data: months.map(month => valueFor(dataByMonth[month][category])) }));
    return { labels, datasets, table: { caption: `${basisLabel} spending by month and category`,
      columns: ['Month', 'Category', `${basisLabel} spending`], rows: months.flatMap((month, monthIndex) =>
        categories.map((category, categoryIndex) => ({ header: labels[monthIndex],
          cells: [category, this.formatWholeAmount(datasets[categoryIndex].data[monthIndex])] }))) } };
  },

  buildCompositionModel(prepared) {
    prepared = this.asPrepared(prepared, 'planned');
    const months = prepared.monthKeys;
    let targetMonth = months[months.length - 1];
    for (let index = months.length - 1; index >= 0; index--) {
      if (this.plannedIncome(prepared.months[months[index]].summary) > 0) { targetMonth = months[index]; break; }
    }
    const entry = prepared.months[targetMonth]; const summary = entry.summary; const plannedIncome = this.plannedIncome(summary);
    const totals = entry.categoryTotals; const labels = Object.keys(totals);
    const data = labels.map(category => this.categoryPlanned(totals[category]));
    const allocations = entry.allocations || {};
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

  buildProjectedActualModel(prepared) {
    prepared = this.asPrepared(prepared, 'actual');
    const months = prepared.monthKeys;
    const labels = months.map(month => this.formatMonthShort(month));
    const planned = months.map(month => this.plannedExpenses(prepared.months[month].summary));
    const actual = months.map(month => this.actualExpenses(prepared.months[month].summary));
    return { labels, planned, actual, table: { caption: 'Planned and actual expenses by month',
      columns: ['Month', 'Planned expenses', 'Actual expenses'], rows: labels.map((label, index) =>
        ({ header: label, cells: [this.formatWholeAmount(planned[index]), this.formatWholeAmount(actual[index])] })) } };
  },

  buildSavingsRateModel(prepared) {
    prepared = this.asPrepared(prepared, 'planned');
    const months = prepared.monthKeys;
    const labels = months.map(month => this.formatMonthShort(month));
    const rows = months.map(month => {
      const entry = prepared.months[month]; const summary = entry.summary; const allocation = entry.allocations || {};
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

  buildPaymentMethodModel(prepared, basis = 'planned') {
    prepared = this.asPrepared(prepared, basis);
    const months = prepared.monthKeys;
    const labels = months.map(month => this.formatMonthShort(month));
    const totals = months.map(mk => prepared.months[mk].paymentMethodTotals);
    const incompleteMethods = months.map(mk => new Set(basis === 'actual' ? prepared.months[mk].incompletePaymentMethods : []));
    const datasets = [
      { label: 'Bank', key: 'bank' }, { label: 'Credit Card', key: 'credit_card' },
      { label: 'Savings', key: 'savings' }, { label: 'Investments', key: 'investments' }
    ].map(method => ({ label: method.label, data: totals.map((total, index) =>
      incompleteMethods[index].has(method.key) ? null : (total[method.key] ?? 0)) }));
    const basisLabel = basis === 'planned' ? 'Planned' : 'Actual';
    return { labels, datasets, table: { caption: `${basisLabel} bills by payment method and month`,
      columns: ['Month', ...datasets.map(dataset => dataset.label)], rows: labels.map((label, monthIndex) =>
        ({ header: label, cells: datasets.map(dataset => this.formatWholeAmount(dataset.data[monthIndex])) })) } };
  },

  buildYoYModel(prepared, basis = 'actual') {
    prepared = this.asPrepared(prepared, basis);
    const months = prepared.monthKeys;
    const years = {};
    months.forEach(month => { const year = month.slice(0, 4); (years[year] ||= []).push(month); });
    const yearKeys = Object.keys(years).sort();
    const sequences = yearKeys.map(year => years[year].map(month => month.slice(5)));
    const eligible = yearKeys.length >= 2 && sequences[0].length > 0 &&
      sequences.every(sequence => JSON.stringify(sequence) === JSON.stringify(sequences[0]));
    if (!eligible) return { eligible: false, reason: 'Select at least two years with the same calendar months to compare categories.' };
    const categories = new Set(); months.forEach(month =>
      Object.keys(prepared.months[month].categoryTotals).forEach(category => categories.add(category)));
    const labels = [...categories];
    const datasets = yearKeys.map(year => ({ label: year, data: labels.map(category => {
      let total = 0;
      for (const month of years[year]) {
        const categoryTotal = prepared.months[month].categoryTotals[category];
        const value = basis === 'planned' ? this.categoryPlanned(categoryTotal) : this.categoryActual(categoryTotal);
        if (value === null) return null; total += value;
      }
      return total;
    }) }));
    const basisLabel = basis === 'planned' ? 'Planned' : 'Actual';
    return { eligible: true, labels, datasets, table: { caption: `${basisLabel} category spending by selected year`,
      columns: ['Category', ...yearKeys], rows: labels.map((label, categoryIndex) => ({ header: label,
        cells: datasets.map(dataset => this.formatWholeAmount(dataset.data[categoryIndex])) })) } };
  },

  buildCoverageOverview(entries) {
    if (!Array.isArray(entries)) {
      if (typeof DashboardModels !== 'undefined') return DashboardModels.coverage(entries);
      const legacyEntries = entries.monthKeys.map(monthKey => {
        const entry = entries.months[monthKey];
        return { monthKey, exists: entry.exists, month: { paychecks: Array(entry.paycheckCount).fill({ plannedAmount: 0, actualAmount: 0 }),
          expenses: Array(entry.expenseCount).fill({ plannedAmount: 0, actualAmount: 0 }), allocations: entry.allocations } };
      });
      return this.buildCoverageOverview(legacyEntries);
    }
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
    this.renderUpcoming();
    this.renderMonthReviewQueue();
    this.compareSavedMonths({ initialize: true });
    this.clearRenderedOutput();
    this.renderForecast();
    const range = this.validateDateRange(this.getDateRange());
    if (range.status !== 'ready') { this.renderState(range); return; }
    const prepared = this.prepareRange(range.months, this.basis);
    const overview = this.buildCoverageOverview(prepared);
    if (overview.coverage.financialActivityMonths === 0) {
      this.renderState({ ...range, status: 'empty' }); return;
    }
    this.renderState(range); this.renderOverview(prepared);
    const results = document.getElementById('dashboard-results');
    if (results) results.hidden = false;
    const printContext = document.getElementById('dashboard-print-context');
    if (printContext) printContext.textContent = `Reporting range: ${range.from} to ${range.to}. Spending basis: ${this.basis === 'planned' ? 'Planned' : 'Actual'}.`;
    this.renderCategoryTrend(prepared, this.basis);
    this.renderIncomePct(prepared);
    this.renderProjVsActual(prepared);
    this.renderSavingsRate(prepared);
    this.renderPaymentMethod(prepared, this.basis);
    this.renderYoY(prepared, this.basis);
    this.renderSummaryTable(prepared, this.basis);
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
  renderCategoryTrend(prepared, basis = 'actual') {
    this.destroyChart('categoryTrend');
    const model = this.buildCategoryTrendModel(prepared, basis);
    const heading = document.getElementById('dashboard-category-trend-heading');
    if (heading) heading.textContent = `${basis === 'planned' ? 'Planned' : 'Actual'} spending by category (month over month)`;
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
  renderIncomePct(prepared) {
    this.destroyChart('incomePct');
    const model = this.buildCompositionModel(prepared);
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
  renderProjVsActual(prepared) {
    this.destroyChart('projVsActual');
    const model = this.buildProjectedActualModel(prepared);

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
  renderSavingsRate(prepared) {
    this.destroyChart('savingsRate');
    const model = this.buildSavingsRateModel(prepared);

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
  renderPaymentMethod(prepared, basis = 'planned') {
    this.destroyChart('paymentMethod');
    const model = this.buildPaymentMethodModel(prepared, basis);
    const heading = document.getElementById('dashboard-payment-method-heading');
    if (heading) heading.textContent = `${basis === 'planned' ? 'Planned' : 'Actual'} bills by payment method`;
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
  renderYoY(prepared, basis = 'actual') {
    this.destroyChart('yoy');
    const model = this.buildYoYModel(prepared, basis);
    const heading = document.getElementById('dashboard-yoy-heading');
    if (heading) heading.textContent = `${basis === 'planned' ? 'Planned' : 'Actual'} selected-year category comparison`;
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
  renderSummaryTable(prepared, basis = 'actual') {
    prepared = this.asPrepared(prepared, basis);
    const months = prepared.monthKeys;
    const heading = document.getElementById('dashboard-summary-heading');
    if (heading) heading.textContent = `${basis === 'planned' ? 'Planned' : 'Actual'} monthly summary table`;
    const allCats = new Set();
    const dataByMonth = {};

    months.forEach(mk => {
      const totals = prepared.months[mk].categoryTotals;
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
      let complete = true;
      months.forEach(mk => {
        const totalForCategory = dataByMonth[mk][cat];
        const val = basis === 'planned' ? this.categoryPlanned(totalForCategory) : this.categoryActual(totalForCategory);
        row.insertCell().textContent = this.formatWholeAmount(val);
        if (val === null) complete = false;
        else {
          total += val;
          count++;
        }
      });
      const avg = complete && count > 0 ? total / count : (complete ? 0 : null);
      const cell = row.insertCell(); const strong = document.createElement('strong');
      strong.textContent = this.formatWholeAmount(avg); cell.append(strong);
    });

    const totalRow = tbody.insertRow(); totalRow.className = 'summary-total-row';
    let cell = totalRow.insertCell(); let strong = document.createElement('strong'); strong.textContent = 'Total'; cell.append(strong);
    let grandTotal = 0;
    let monthCount = 0;
    let grandComplete = true;
    months.forEach(mk => {
      const s = prepared.months[mk].summary;
      const val = basis === 'planned' ? this.plannedExpenses(s) : this.actualExpenses(s);
      cell = totalRow.insertCell(); strong = document.createElement('strong');
      strong.textContent = this.formatWholeAmount(val); cell.append(strong);
      if (val === null) grandComplete = false;
      else {
        grandTotal += val;
        monthCount++;
      }
    });
    const grandAvg = grandComplete && monthCount > 0 ? grandTotal / monthCount : (grandComplete ? 0 : null);
    cell = totalRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = this.formatWholeAmount(grandAvg); cell.append(strong);
    const incomeRow = tbody.insertRow(); cell = incomeRow.insertCell(); strong = document.createElement('strong');
    strong.textContent = basis === 'planned' ? 'Planned income' : 'Actual income'; cell.append(strong);
    months.forEach(mk => {
      const s = prepared.months[mk].summary;
      const income = basis === 'planned' ? this.plannedIncome(s) :
        (s.unresolvedIncomeCount === 0 ? s.totalActualIncome : null);
      incomeRow.insertCell().textContent = this.formatWholeAmount(income);
    });
    incomeRow.insertCell();
    document.getElementById('summary-table-container').replaceChildren(table);
  }
};
