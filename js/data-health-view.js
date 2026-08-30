// Read-only Data Health rendering and explicit, previewed repair workflows.
const DataHealthView = {
  preview: null,

  init() {
    document.getElementById('actual-resolution-dialog').addEventListener('close', () => this.onActualDialogClose());
    this.render();
  },

  node(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  render() {
    const container = document.getElementById('data-health-content'); container.replaceChildren();
    let health;
    try { health = Store.getDataHealth(); }
    catch (error) { App.showError(error); return; }

    const overview = this.node('section', 'budget-section data-health-overview');
    const title = this.node('h3', '', 'Ledger overview'); overview.append(title);
    const summary = this.node('p', '', this.totalIssues(health) === 0
      ? 'No tracked data-health issues were found.'
      : `${this.totalIssues(health)} tracked items may need review. Nothing has been changed.`);
    overview.append(summary);
    const counts = this.node('ul', 'health-counts');
    [['Actual amounts not entered', health.counts.missingActuals], ['Dates not entered', health.counts.missingDates],
      ['Funding mismatches', health.counts.fundingMismatches], ['Missing months in the ledger range', health.counts.absentMonths],
      ['Repeated manual patterns', health.counts.repeatedManualPatterns]].forEach(([label, count]) => {
      const item = this.node('li'); item.append(this.node('span', '', label), this.node('strong', '', String(count))); counts.append(item);
    });
    overview.append(counts); container.append(overview);

    container.append(this.actualsSection(health.missingActuals));
    container.append(this.recordIssueSection('Dates not entered', 'Records with a blank date are kept as entered.', health.missingDates));
    container.append(this.fundingSection(health.fundingMismatches));
    container.append(this.absentMonthsSection(health.absentMonths));
    container.append(this.patternsSection(health.repeatedManualPatterns));
    container.append(this.comparisonSection());
  },

  totalIssues(health) { return Object.values(health.counts).reduce((sum, count) => sum + count, 0); },

  record(reference) {
    const month = Store.getMonth(reference.monthKey);
    const records = reference.kind === 'income' ? month.paychecks : month.expenses;
    return records.find(record => record.id === reference.recordId) || null;
  },

  recordLabel(reference) {
    const record = this.record(reference);
    return record ? (reference.kind === 'income' ? record.earner : record.name) : 'Record no longer available';
  },

  section(title, description) {
    const section = this.node('section', 'budget-section data-health-section');
    section.append(this.node('h3', '', title), this.node('p', 'muted-text', description)); return section;
  },

  empty(text) { return this.node('p', 'health-empty', text); },

  routeButton(reference, label = 'Review record') {
    const button = this.node('button', 'btn btn-sm', label); button.type = 'button';
    button.addEventListener('click', () => this.routeRecord(reference, button)); return button;
  },

  routeRecord(reference, trigger) {
    const record = this.record(reference);
    if (!record) { App.showErrorCode(reference.kind === 'income' ? 'PAYCHECK_NOT_FOUND' : 'EXPENSE_NOT_FOUND'); trigger.focus(); return; }
    App.switchView('budget'); BudgetView.currentMonth = reference.monthKey; BudgetView.render();
    if (reference.kind === 'income') BudgetView.showPaycheckModal(record);
    else BudgetView.showExpenseModal(record);
  },

  issueList(references) {
    const list = this.node('ul', 'health-issue-list');
    references.forEach(reference => {
      const item = this.node('li'); const details = this.node('div', 'health-issue-details');
      details.append(this.node('strong', 'break-anywhere', this.recordLabel(reference)),
        this.node('span', 'muted-text', `${reference.kind === 'income' ? 'Income' : 'Expense'} · ${App.formatMonth(reference.monthKey)}`));
      item.append(details, this.routeButton(reference)); list.append(item);
    });
    return list;
  },

  recordIssueSection(title, description, references) {
    const section = this.section(title, description);
    section.append(references.length ? this.issueList(references) : this.empty('No records in this category.')); return section;
  },

  actualsSection(references) {
    const section = this.section('Actual amounts not entered',
      'Select only the records you want to resolve, then type each actual amount. Zero is accepted as an explicit value.');
    if (!references.length) { section.append(this.empty('Every record has an entered actual amount.')); return section; }
    const form = this.node('form', 'actual-resolution-form'); form.noValidate = true;
    references.forEach((reference, index) => {
      const row = this.node('div', 'actual-resolution-row');
      const check = document.createElement('input'); check.type = 'checkbox'; check.id = `resolve-actual-${index}`;
      check.dataset.kind = reference.kind; check.dataset.monthKey = reference.monthKey; check.dataset.recordId = reference.recordId;
      const label = document.createElement('label'); label.htmlFor = check.id; label.append(
        this.node('strong', 'break-anywhere', this.recordLabel(reference)),
        this.node('span', 'muted-text', `${reference.kind === 'income' ? 'Income' : 'Expense'} · ${App.formatMonth(reference.monthKey)}`));
      const amountLabel = document.createElement('label'); const amount = document.createElement('input');
      amount.type = 'number'; amount.min = '0'; amount.max = '1000000000000'; amount.step = '0.01'; amount.disabled = true;
      amount.id = `resolve-amount-${index}`; amountLabel.htmlFor = amount.id; amountLabel.textContent = 'Actual amount'; amountLabel.append(amount);
      check.addEventListener('change', () => { amount.disabled = !check.checked; if (check.checked) amount.focus(); });
      row.append(check, label, amountLabel); form.append(row);
    });
    const preview = this.node('button', 'btn btn-primary', 'Preview selected amounts'); preview.type = 'submit'; form.append(preview);
    form.addEventListener('submit', event => { event.preventDefault(); this.previewActuals(form, preview); });
    section.append(form); return section;
  },

  previewActuals(form, trigger) {
    const proposals = [...form.querySelectorAll('input[type="checkbox"]:checked')].map(check => {
      const amount = document.getElementById(check.id.replace('resolve-actual-', 'resolve-amount-'));
      return { kind: check.dataset.kind, monthKey: check.dataset.monthKey, recordId: check.dataset.recordId,
        actualAmount: amount.value === '' ? NaN : Number(amount.value), amount };
    });
    if (!proposals.length) { App.announceStatus('Select at least one record and enter its actual amount. Nothing was changed.'); trigger.focus(); return; }
    const invalid = proposals.find(item => !Number.isFinite(item.actualAmount) || item.actualAmount < 0 || item.actualAmount > 1000000000000);
    if (invalid) { App.showErrorCode('INVALID_AMOUNT'); invalid.amount.focus(); return; }
    const selections = proposals.map(({ amount, ...item }) => item);
    try {
      this.preview = Store.previewActualResolutions(selections);
      const content = document.getElementById('actual-resolution-preview'); content.replaceChildren();
      const list = this.node('ul', 'preview-list');
      selections.forEach(item => {
        const entry = this.node('li'); entry.append(this.node('span', 'break-anywhere', this.recordLabel(item)),
          this.node('strong', '', BudgetView.fmt(item.actualAmount))); list.append(entry);
      });
      content.append(list); const dialog = document.getElementById('actual-resolution-dialog'); dialog.returnValue = ''; dialog.showModal();
    } catch (error) { this.preview = null; App.showError(error); trigger.focus(); }
  },

  onActualDialogClose() {
    const dialog = document.getElementById('actual-resolution-dialog'); const preview = this.preview; this.preview = null;
    if (dialog.returnValue !== 'confirm' || !preview) {
      document.querySelector('.actual-resolution-form button[type="submit"]')?.focus({ preventScroll: true }); return;
    }
    App.runMutation(() => Store.applyActualResolutions(preview), {
      onSuccess: resolutions => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus(`${resolutions.length} actual ${resolutions.length === 1 ? 'amount was' : 'amounts were'} applied.`);
        requestAnimationFrame(() => document.getElementById('data-health-heading').focus({ preventScroll: true }));
      },
      onFailure: () => { this.render(); }
    });
  },

  fundingSection(issues) {
    const section = this.section('Funding mismatches', 'These expenses are funded by an amount different from their planned total.');
    if (!issues.length) { section.append(this.empty('No funding mismatches were found.')); return section; }
    const list = this.node('ul', 'health-issue-list');
    issues.forEach(issue => {
      const item = this.node('li'); const details = this.node('div', 'health-issue-details');
      details.append(this.node('strong', 'break-anywhere', this.recordLabel(issue)),
        this.node('span', 'muted-text', `${App.formatMonth(issue.monthKey)} · Planned ${BudgetView.fmt(issue.plannedAmount)} · Funded ${BudgetView.fmt(issue.fundedAmount)}`));
      item.append(details, this.routeButton(issue, 'Review allocations')); list.append(item);
    });
    section.append(list); return section;
  },

  absentMonthsSection(months) {
    const section = this.section('Missing months in the ledger range', 'These month keys are absent between the earliest and latest nonempty months.');
    if (!months.length) { section.append(this.empty('No months are missing inside the ledger range.')); return section; }
    const list = this.node('ul', 'health-issue-list'); months.forEach(monthKey => {
      const item = this.node('li'); const button = this.node('button', 'btn btn-sm', 'Open month'); button.type = 'button';
      button.addEventListener('click', () => { App.switchView('budget'); BudgetView.currentMonth = monthKey; BudgetView.render();
        requestAnimationFrame(() => document.getElementById('current-month-label').focus({ preventScroll: true })); });
      item.append(this.node('strong', '', App.formatMonth(monthKey)), button); list.append(item);
    }); section.append(list); return section;
  },

  patternsSection(patterns) {
    const section = this.section('Repeated manual patterns', 'These manual record patterns appear in at least three distinct months and may be useful when reviewing recurring templates.');
    if (!patterns.length) { section.append(this.empty('No repeated manual patterns were found.')); return section; }
    const list = this.node('ul', 'health-issue-list'); patterns.forEach(pattern => {
      const item = this.node('li'); const details = this.node('div', 'health-issue-details');
      details.append(this.node('strong', '', pattern.kind === 'income' ? 'Repeated manual income' : 'Repeated manual expense'),
        this.node('span', 'muted-text', `${pattern.monthKeys.length} months · ${pattern.occurrences.length} records`));
      const button = this.node('button', 'btn btn-sm', 'Review Templates'); button.type = 'button';
      button.addEventListener('click', () => { App.switchView('templates'); requestAnimationFrame(() =>
        document.getElementById(pattern.kind === 'income' ? 'templates-income-heading' : 'templates-expenses-heading')?.focus({ preventScroll: true })); });
      item.append(details, button); list.append(item);
    }); section.append(list); return section;
  },

  comparisonSection() {
    const section = this.section('Compare an additive backup',
      'Compare a Warm Ledger backup with this ledger. This report imports nothing and offers no apply action.');
    const label = document.createElement('label'); label.htmlFor = 'health-compare-file'; label.textContent = 'Backup file (under 5 MB)';
    const input = document.createElement('input'); input.type = 'file'; input.id = 'health-compare-file'; input.accept = '.json,application/json';
    const output = this.node('div', 'backup-comparison'); output.id = 'health-compare-result'; output.setAttribute('aria-live', 'polite');
    input.addEventListener('change', () => this.compareBackup(input, output)); section.append(label, input, output); return section;
  },

  compareBackup(input, output) {
    const file = input.files && input.files[0]; input.value = ''; output.replaceChildren(); if (!file) return;
    if (file.size > App.MAX_IMPORT_BYTES) { App.showErrorCode('FILE_TOO_LARGE'); input.focus(); return; }
    const reader = new FileReader(); reader.addEventListener('load', () => {
      try { this.renderComparison(Store.compareAdditiveBackup(String(reader.result)), file.name, output); }
      catch (error) { App.showError(error); input.focus(); }
    });
    reader.addEventListener('error', () => { App.showErrorCode('FILE_READ_FAILED'); input.focus(); }); reader.readAsText(file);
  },

  renderComparison(comparison, filename, output) {
    output.replaceChildren(this.node('h4', '', 'Comparison report'),
      this.node('p', 'break-anywhere', `${filename}: comparison complete. Nothing was imported and your ledger was not changed.`));
    const list = this.node('dl', 'comparison-summary');
    [['Identical months', comparison.counts.identical], ['Addable whole months', comparison.counts.addable],
      ['Conflicting months', comparison.counts.conflicting], ['Structural conflicts', comparison.counts.structuralConflicts]].forEach(([term, value]) => {
      list.append(this.node('dt', '', term), this.node('dd', '', String(value)));
    }); output.append(list);
    [['Addable month keys', comparison.months.addable], ['Conflicting month keys', comparison.months.conflicting],
      ['Identical month keys', comparison.months.identical]].forEach(([title, months]) => {
      const group = this.node('p'); group.append(this.node('strong', '', `${title}: `),
        document.createTextNode(months.length ? months.map(month => App.formatMonth(month)).join(', ') : 'None')); output.append(group);
    });
    output.append(this.node('p', '', `Categories: ${comparison.structure.categories}. Earners: ${comparison.structure.earners}. Templates: ${comparison.structure.templates}.`));
    App.announceStatus('Backup comparison complete. Nothing was imported.');
  }
};
