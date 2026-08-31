// Read-only Data Health rendering and explicit, previewed repair workflows.
const DataHealthView = {
  preview: null,
  datePreview: null,

  init() {
    document.getElementById('actual-resolution-dialog').addEventListener('close', () => this.onActualDialogClose());
    document.getElementById('date-resolution-dialog').addEventListener('close', () => this.onDateDialogClose());
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

    const primaryCount = health.counts.missingActuals + health.counts.missingDates + health.counts.fundingMismatches;
    const overview = this.node('section', 'budget-section data-health-overview');
    overview.append(this.node('h3', '', primaryCount ? 'What needs attention' : 'Everything looks good'),
      this.node('p', '', primaryCount
        ? `${primaryCount} ${primaryCount === 1 ? 'record needs' : 'records need'} attention. Nothing changes until you choose an action.`
        : 'No unfinished amounts, funding problems, or blank dates were found.'));
    const priorities = [['Actual amounts to enter', health.counts.missingActuals], ['Funding to review', health.counts.fundingMismatches],
      ['Blank dates to set', health.counts.missingDates]].filter(([, count]) => count > 0);
    if (priorities.length) {
      const counts = this.node('ul', 'health-counts');
      priorities.forEach(([label, count]) => {
        const item = this.node('li'); item.append(this.node('span', '', label), this.node('strong', '', String(count))); counts.append(item);
      });
      overview.append(counts);
    }
    container.append(overview);

    if (health.missingActuals.length) container.append(this.actualsSection(health.missingActuals));
    if (health.missingDates.length) container.append(this.dateResolutionSection(health.missingDates));
    if (health.fundingMismatches.length) container.append(this.fundingSection(health.fundingMismatches));
    container.append(this.moreToolsSection(health));
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

  dateResolutionSection(references) {
    const section = this.section('Set blank dates', 'Use the first day of each record’s month. This keeps historic data unchanged until you confirm.');
    const button = this.node('button', 'btn btn-primary', `Review ${references.length} ${references.length === 1 ? 'date' : 'dates'}`); button.type = 'button'; button.id = 'review-default-dates';
    button.addEventListener('click', () => this.previewDefaultDates(button)); section.append(button); return section;
  },

  previewDefaultDates(trigger) {
    try {
      this.datePreview = Store.previewDefaultDateResolutions();
      const count = this.datePreview.resolutions.length;
      if (!count) { App.announceStatus('There are no blank dates to set.'); trigger.focus(); return; }
      const content = document.getElementById('date-resolution-preview'); content.replaceChildren(
        this.node('p', '', `${count} ${count === 1 ? 'record' : 'records'} will use the first day of their recorded month.`));
      const dialog = document.getElementById('date-resolution-dialog'); dialog.returnValue = ''; dialog.showModal();
    } catch (error) { this.datePreview = null; App.showError(error); trigger.focus(); }
  },

  onDateDialogClose() {
    const dialog = document.getElementById('date-resolution-dialog'); const preview = this.datePreview; this.datePreview = null;
    if (dialog.returnValue !== 'confirm' || !preview) {
      document.getElementById('review-default-dates')?.focus({ preventScroll: true }); return;
    }
    App.runMutation(() => Store.applyDefaultDateResolutions(preview), {
      onSuccess: resolutions => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus(`${resolutions.length} ${resolutions.length === 1 ? 'date was' : 'dates were'} set to the first of the month.`);
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

  moreToolsSection(health) {
    const details = this.node('details', 'data-health-more'); details.append(this.node('summary', '', 'More checks and tools'));
    const content = this.node('div', 'data-health-more-content');
    if (health.absentMonths.length) content.append(this.absentMonthsSection(health.absentMonths));
    if (health.repeatedManualPatterns.length) content.append(this.patternsSection(health.repeatedManualPatterns));
    content.append(this.comparisonSection()); details.append(content); return details;
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
    const section = this.section('Repeated manual patterns', 'These exact manual record patterns appear in at least three distinct months. Review any suggestion before saving a recurring template.');
    if (!patterns.length) { section.append(this.empty('No repeated manual patterns were found.')); return section; }
    const list = this.node('ul', 'health-issue-list'); patterns.forEach(pattern => {
      const item = this.node('li'); const details = this.node('div', 'health-issue-details');
      const draft = this.templateDraft(pattern);
      details.append(this.node('strong', 'break-anywhere', draft.name),
        this.node('span', 'muted-text', draft.recurrence
          ? `${pattern.monthKeys.length} months · ${pattern.occurrences.length} records · Possible monthly schedule on day ${draft.recurrence.day}`
          : `${pattern.monthKeys.length} months · ${pattern.occurrences.length} records · Schedule unknown — choose a schedule before saving`));
      const button = this.node('button', 'btn btn-sm', 'Review template suggestion'); button.type = 'button';
      button.setAttribute('aria-label', `Review template suggestion for ${draft.name}`);
      button.addEventListener('click', () => this.openPatternTemplate(pattern, button));
      item.append(details, button); list.append(item);
    }); section.append(list); return section;
  },

  openPatternTemplate(pattern, trigger) {
    const current = Store.getDataHealth().repeatedManualPatterns.find(item => item.kind === pattern.kind && item.signature === pattern.signature);
    if (!current) { App.announceStatus('That repeated pattern has changed. Refresh Data Health and try again.'); trigger.focus(); return; }
    const draft = this.templateDraft(current);
    TemplatesView.showTemplateModal(current.kind === 'income' ? 'income' : 'expense', null, trigger, draft);
  },

  templateDraft(pattern) {
    const reference = pattern.occurrences.reduce((latest, item) =>
      !latest || item.monthKey > latest.monthKey ? item : latest, null);
    const record = this.record(reference);
    const scheduleKnown = Boolean(record?.date);
    const latestMonth = pattern.monthKeys.at(-1);
    const draft = { name: pattern.kind === 'income' ? record.earner : record.name,
      plannedAmount: record.plannedAmount, enabled: false,
      startDate: scheduleKnown ? TemplatesView.nextMonthStart(`${latestMonth}-01`) : null, endDate: null,
      recurrence: scheduleKnown ? { cadence: 'monthly', day: Number(record.date.slice(8)) } : null };
    if (pattern.kind === 'income') draft.earnerId = record.earnerId;
    else Object.assign(draft, { categoryId: record.categoryId, categoryItemId: record.categoryItemId, paymentMethod: record.paymentMethod });
    return draft;
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
