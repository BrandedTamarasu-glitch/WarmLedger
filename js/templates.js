// Recurring template management. Integration requires the Templates view element IDs
// listed in requiredElementIds, TemplatesView.init() from App.initializeViews(),
// TemplatesView.render() from App.refreshAllViews()/switchView(), and this script after data.js.
const TemplatesView = {
  requiredElementIds: Object.freeze([
    'btn-add-income-template', 'btn-add-expense-template',
    'templates-income', 'templates-expenses',
    'templates-income-heading', 'templates-expenses-heading',
    'template-readiness', 'template-readiness-heading',
    'template-readiness-disabled', 'template-readiness-suggestions',
    'template-activation-month', 'template-activation-preview',
    'template-activation-dialog', 'template-activation-content',
    'template-activation-cancel', 'template-activation-confirm'
  ]),

  activationPreview: null,
  activationTrigger: null,

  init() {
    document.getElementById('btn-add-income-template').addEventListener('click', event =>
      this.showTemplateModal('income', null, event.currentTarget));
    document.getElementById('btn-add-expense-template').addEventListener('click', event =>
      this.showTemplateModal('expense', null, event.currentTarget));
    document.getElementById('template-activation-month').value = this.nextLocalMonth();
    document.getElementById('template-activation-preview').addEventListener('click', event =>
      this.openActivationPreview(event.currentTarget));
    document.getElementById('template-activation-dialog').addEventListener('close', () => this.onActivationDialogClose());
    this.render();
  },

  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  render() {
    this.renderReadiness();
    this.renderSection('income', Store.getIncomeTemplates());
    this.renderSection('expense', Store.getExpenseTemplates());
  },

  localReferenceDate() {
    const today = new Date();
    return `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  },

  nextLocalMonth() {
    const today = new Date();
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return `${String(next.getFullYear()).padStart(4, '0')}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  },

  renderReadiness() {
    const referenceDate = this.localReferenceDate();
    const readiness = Store.getTemplateReadiness({ referenceDate });
    this.renderReadinessList('disabled', readiness.disabledTemplates, referenceDate);
    this.renderReadinessList('suggestions', readiness.suggestions, referenceDate);
  },

  renderReadinessList(type, entries, referenceDate) {
    const container = document.getElementById(`template-readiness-${type}`); container.replaceChildren();
    if (!entries.length) {
      container.append(this.element('p', 'muted-text', type === 'disabled'
        ? 'No disabled templates need review.' : 'No repeated-record suggestions need review.')); return;
    }
    const list = this.element('ul', 'template-readiness-list');
    entries.forEach(entry => list.append(type === 'disabled'
      ? this.disabledReadinessItem(entry, referenceDate) : this.suggestionReadinessItem(entry, referenceDate)));
    container.append(list);
  },

  readinessIdentity(readinessItem, entry, label) {
    const heading = this.element('h5', 'template-readiness-name', entry.name);
    const status = this.element('span', 'template-status state-disabled', label);
    readinessItem.append(heading, status);
  },

  disabledReadinessItem(entry, referenceDate) {
    const readinessItem = this.element('li', 'template-card template-readiness-card');
    this.readinessIdentity(readinessItem, entry, 'Disabled template');
    const details = this.element('dl', 'template-details');
    this.detail(details, 'Kind', entry.kind === 'income' ? 'Income' : 'Expense');
    this.detail(details, 'Planned amount', this.money(entry.plannedAmount));
    this.detail(details, 'Structure', this.readinessStructure(entry.kind, entry.structure));
    this.detail(details, 'Schedule', this.recurrenceLabel(entry.schedule.recurrence));
    this.detail(details, 'Active dates', `${entry.activeDates.startDate} through ${entry.activeDates.endDate || 'no end date'}`);
    this.detail(details, 'Upcoming while disabled', entry.upcoming.dates.length
      ? entry.upcoming.dates.join(', ') : entry.upcoming.reason);
    const button = this.readinessButton('Review disabled template', entry, 'disabled', referenceDate);
    const selectionLabel = this.element('label', 'template-activation-choice');
    const checkbox = this.element('input'); checkbox.type = 'checkbox';
    checkbox.dataset.activationKind = entry.kind; checkbox.dataset.activationTemplateId = entry.id;
    selectionLabel.append(checkbox, document.createTextNode(` Select ${entry.name} for activation preview`));
    readinessItem.append(details, selectionLabel, button); return readinessItem;
  },

  suggestionReadinessItem(entry, referenceDate) {
    const readinessItem = this.element('li', 'template-card template-readiness-card');
    this.readinessIdentity(readinessItem, entry, 'Suggestion — not saved');
    const details = this.element('dl', 'template-details');
    this.detail(details, 'Kind', entry.kind === 'income' ? 'Income' : 'Expense');
    this.detail(details, 'Planned amount', this.money(entry.plannedAmount));
    this.detail(details, 'Structure', this.readinessStructure(entry.kind, entry.structure));
    this.detail(details, 'Evidence', `${entry.evidence.count} records across ${entry.evidence.monthKeys.length} months: ${entry.evidence.monthKeys.join(', ')}`);
    this.detail(details, 'Schedule', entry.schedule.known
      ? `Possible ${this.recurrenceLabel(entry.schedule.recurrence).toLowerCase()}`
      : 'Schedule unknown — choose a schedule before saving.');
    this.detail(details, 'Possible upcoming dates', entry.upcoming.dates.length
      ? entry.upcoming.dates.join(', ') : entry.upcoming.reason);
    const button = this.readinessButton('Review suggestion', entry, 'suggestion', referenceDate);
    readinessItem.append(details, button); return readinessItem;
  },

  readinessStructure(kind, structure) {
    if (kind === 'income') {
      const earner = Store.getEarner(structure.earnerId);
      return `Earner: ${earner ? earner.name : 'No longer available'}`;
    }
    const category = Store.getCategory(structure.categoryId);
    const preset = structure.categoryItemId && category ? Store.getCategoryItem(category.id, structure.categoryItemId) : null;
    const method = ({ bank: 'Bank', credit_card: 'Credit card', savings: 'Savings', investments: 'Investments' })[structure.paymentMethod] || 'Unknown';
    return `Category: ${category ? category.name : 'No longer available'}; preset: ${preset ? preset.name : 'None'}; payment method: ${method}`;
  },

  readinessButton(text, entry, type, referenceDate) {
    const button = this.element('button', 'btn btn-sm template-readiness-action', text); button.type = 'button';
    button.dataset.readinessType = type; button.dataset.templateKind = entry.kind;
    button.dataset.readinessKey = type === 'disabled' ? entry.id : entry.key;
    button.setAttribute('aria-label', `${text}: ${entry.name}`);
    button.addEventListener('click', event => this.reviewReadiness(type, entry, referenceDate, event.currentTarget)); return button;
  },

  reviewReadiness(type, original, referenceDate, trigger) {
    const current = Store.getTemplateReadiness({ referenceDate });
    const entries = type === 'disabled' ? current.disabledTemplates : current.suggestions;
    const match = entries.find(entry => entry.kind === original.kind &&
      (type === 'disabled' ? entry.id === original.id : entry.key === original.key) &&
      entry.fingerprint === original.fingerprint);
    if (!match) { this.handleStaleReadiness(type, original); return; }
    if (type === 'suggestion') { this.showTemplateModal(match.kind, null, trigger, match.draft); return; }
    const records = match.kind === 'income' ? Store.getIncomeTemplates() : Store.getExpenseTemplates();
    const template = records.find(record => record.id === match.id);
    if (!template) { this.handleStaleReadiness(type, original); return; }
    this.showTemplateModal(match.kind, template, trigger);
  },

  handleStaleReadiness(type, original) {
    this.renderReadiness();
    App.announceStatus('Template readiness changed. Review the refreshed list.');
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll('[data-readiness-type][data-readiness-key]')];
      const key = type === 'disabled' ? original.id : original.key;
      const target = controls.find(control => control.dataset.readinessType === type &&
        control.dataset.templateKind === original.kind && control.dataset.readinessKey === key);
      (target || document.getElementById('template-readiness-heading')).focus({ preventScroll: true });
    });
  },

  selectedActivationTemplates() {
    return [...document.querySelectorAll('[data-activation-kind][data-activation-template-id]')]
      .filter(control => control.checked)
      .map(control => ({ kind: control.dataset.activationKind, templateId: control.dataset.activationTemplateId }));
  },

  openActivationPreview(trigger) {
    const month = document.getElementById('template-activation-month');
    if (!month.reportValidity()) { month.focus(); return false; }
    const selections = this.selectedActivationTemplates();
    if (!selections.length) {
      App.announceStatus('Select at least one saved disabled template to preview.');
      const first = document.querySelector('[data-activation-kind][data-activation-template-id]');
      (first || document.getElementById('template-readiness-disabled-heading')).focus({ preventScroll: true });
      return false;
    }
    try {
      const preview = Store.previewTemplateActivation({ targetMonth: month.value, selections });
      this.activationPreview = preview; this.activationTrigger = trigger;
      document.getElementById('template-activation-content').replaceChildren(this.buildActivationPreview(preview));
      const confirm = document.getElementById('template-activation-confirm');
      confirm.disabled = preview.counts.conflicts > 0;
      if (confirm.disabled) confirm.title = 'Resolve conflicts before enabling selected templates.';
      else confirm.removeAttribute('title');
      const dialog = document.getElementById('template-activation-dialog'); dialog.returnValue = ''; dialog.showModal();
      return true;
    } catch (error) {
      this.activationPreview = null; App.showError(error); trigger.focus(); return false;
    }
  },

  buildActivationPreview(preview) {
    const wrapper = this.element('div', 'recurring-preview template-activation-preview');
    wrapper.append(this.element('p', 'preview-summary',
      `${preview.counts.selected} selected; ${preview.counts.additions} possible additions, ${preview.counts.skips} skips, ${preview.counts.conflicts} conflicts.`));
    wrapper.append(this.element('p', 'field-help', 'Confirming enables only the selected templates. No budget records will be added.'));
    this.activationPreviewSection(wrapper, 'Selected templates', preview.selected,
      entry => `${entry.name} — ${entry.kind === 'income' ? 'Income' : 'Expense'}`);
    this.activationPreviewSection(wrapper, 'Possible income additions', preview.additions.income,
      entry => `${entry.name} — ${entry.scheduledDate} — ${this.money(entry.plannedAmount)}`);
    this.activationPreviewSection(wrapper, 'Possible expense additions', preview.additions.expenses,
      entry => `${entry.name} — ${entry.scheduledDate} — ${this.money(entry.plannedAmount)}`);
    this.activationPreviewSection(wrapper, 'Skipped occurrences', preview.skips,
      entry => `${entry.name} — ${entry.reason}`);
    this.activationPreviewSection(wrapper, 'Conflicts', preview.conflicts,
      entry => `${entry.occurrenceKey} — ${entry.reason}`);
    const impacted = new Set([
      ...preview.additions.income, ...preview.additions.expenses, ...preview.skips, ...preview.conflicts
    ].map(entry => entry.templateId));
    this.activationPreviewSection(wrapper, 'No occurrence in the preview month',
      preview.selected.filter(entry => !impacted.has(entry.templateId)), entry => entry.name);
    return wrapper;
  },

  activationPreviewSection(wrapper, heading, entries, label) {
    wrapper.append(this.element('h3', '', heading));
    const list = this.element('ul', 'preview-list');
    if (entries.length) entries.forEach(entry => list.append(this.element('li', '', label(entry))));
    else list.append(this.element('li', 'muted-text', 'None'));
    wrapper.append(list);
  },

  onActivationDialogClose() {
    const dialog = document.getElementById('template-activation-dialog');
    const preview = this.activationPreview; const trigger = this.activationTrigger;
    this.activationPreview = null; this.activationTrigger = null;
    if (dialog.returnValue !== 'confirm' || !preview) {
      requestAnimationFrame(() => trigger?.focus({ preventScroll: true })); return;
    }
    App.runMutation(() => Store.applyTemplateActivationPreview(preview), {
      onSuccess: () => {
        App.refreshAllViews(); App.announceStatus('Templates enabled. No budget records were added.');
        requestAnimationFrame(() => document.getElementById('template-readiness-heading').focus({ preventScroll: true }));
      },
      onFailure: () => requestAnimationFrame(() => trigger?.focus({ preventScroll: true }))
    });
  },

  renderSection(kind, templates) {
    const sectionId = kind === 'expense' ? 'expenses' : kind;
    const container = document.getElementById(`templates-${sectionId}`);
    container.replaceChildren();
    if (!templates.length) {
      container.append(this.element('p', 'muted-text',
        kind === 'income' ? 'No recurring income templates yet.' : 'No recurring expense templates yet.'));
      return;
    }
    const list = this.element('ul', 'template-list');
    templates.forEach((record, index) => {
      const item = this.element('li', 'template-card');
      const heading = this.element('h4', 'template-name', record.name);
      const state = record.archived ? 'Archived' : record.enabled ? 'Enabled' : 'Disabled';
      const status = this.element('span', `template-status state-${state.toLowerCase()}`, state);
      const details = this.element('dl', 'template-details');
      this.detail(details, 'Planned amount', this.money(record.plannedAmount));
      this.detail(details, 'Schedule', this.recurrenceLabel(record.recurrence));
      this.detail(details, 'Active dates', `${record.startDate} through ${record.endDate || 'no end date'}`);
      const actions = this.element('div', 'template-actions');
      actions.append(
        this.actionButton('Edit', kind, 'edit', record, event => this.showTemplateModal(kind, record, event.currentTarget)),
        this.actionButton(record.enabled ? 'Disable' : 'Enable', kind, 'toggle', record,
          event => this.setEnabled(kind, record, !record.enabled, event.currentTarget), record.archived),
        this.actionButton(record.archived ? 'Restore' : 'Archive', kind, record.archived ? 'restore' : 'archive', record,
          event => this.setArchived(kind, record, !record.archived, event.currentTarget)),
        this.moveButton('↑', 'Move up', kind, record, -1, index === 0),
        this.moveButton('↓', 'Move down', kind, record, 1, index === templates.length - 1)
      );
      item.append(heading, status, details, actions); list.append(item);
    });
    container.append(list);
  },

  detail(list, term, value) {
    list.append(this.element('dt', '', term), this.element('dd', '', value));
  },

  money(amount) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount);
  },

  nextMonthStart(date) {
    const year = Number(date.slice(0, 4)); const month = Number(date.slice(5, 7));
    return `${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  },

  monthlyExpenseDraft(expense, startDate) {
    return { name: expense.name, categoryId: expense.categoryId, categoryItemId: expense.categoryItemId,
      plannedAmount: expense.plannedAmount, paymentMethod: expense.paymentMethod, enabled: false,
      startDate, endDate: null, recurrence: { cadence: 'monthly', day: Number(expense.date.slice(8)) } };
  },

  recurrenceLabel(recurrence) {
    if (recurrence.cadence === 'monthly') return `Monthly on day ${recurrence.day} (clamped to month end)`;
    if (recurrence.cadence === 'twice-monthly') return `Twice monthly on days ${recurrence.days[0]} and ${recurrence.days[1]} (each clamped)`;
    return `${recurrence.cadence === 'weekly' ? 'Weekly' : 'Every two weeks'} from ${recurrence.anchorDate}`;
  },

  actionButton(text, kind, action, record, handler, disabled = false) {
    const button = this.element('button', 'btn btn-sm', text);
    button.type = 'button'; button.disabled = disabled;
    button.dataset.templateKind = kind; button.dataset.templateAction = action; button.dataset.recordId = record.id;
    button.setAttribute('aria-label', `${text} ${record.name}`);
    button.addEventListener('click', handler);
    return button;
  },

  moveButton(text, label, kind, record, delta, disabled) {
    return this.actionButton(text, kind, delta < 0 ? 'move-up' : 'move-down', record,
      event => this.move(kind, record, delta, event.currentTarget), disabled);
  },

  setEnabled(kind, record, enabled, trigger) {
    App.runMutation(() => kind === 'income'
      ? Store.updateIncomeTemplate(record.id, { enabled })
      : Store.updateExpenseTemplate(record.id, { enabled }), {
      onSuccess: () => this.afterMutation(`${record.name} ${enabled ? 'enabled' : 'disabled'}.`,
        { kind, action: 'toggle', id: record.id }),
      onFailure: () => trigger.focus()
    });
  },

  setArchived(kind, record, archived, trigger) {
    App.runMutation(() => kind === 'income'
      ? Store.setIncomeTemplateArchived(record.id, archived)
      : Store.setExpenseTemplateArchived(record.id, archived), {
      onSuccess: () => this.afterMutation(`${record.name} ${archived ? 'archived' : 'restored'}.`,
        { kind, action: archived ? 'restore' : 'archive', id: record.id }),
      onFailure: () => trigger.focus()
    });
  },

  move(kind, record, delta, trigger) {
    const records = kind === 'income' ? Store.getIncomeTemplates() : Store.getExpenseTemplates();
    const from = records.findIndex(item => item.id === record.id); const to = from + delta;
    if (from < 0 || to < 0 || to >= records.length) return;
    const ids = records.map(item => item.id); [ids[from], ids[to]] = [ids[to], ids[from]];
    App.runMutation(() => kind === 'income'
      ? Store.reorderIncomeTemplates(ids) : Store.reorderExpenseTemplates(ids), {
      onSuccess: () => this.afterMutation(`${record.name} moved to position ${to + 1} of ${records.length}.`,
        { kind, action: delta < 0 ? 'move-up' : 'move-down', id: record.id }),
      onFailure: () => trigger.focus()
    });
  },

  showTemplateModal(kind, existing, trigger, draft = null) {
    App.showModal({ title: `${existing ? 'Edit' : 'Add'} ${kind} template`, buildBody: () => this.formBody(kind),
      submitLabel: existing ? 'Save changes' : 'Add template', onSave: () => this.saveForm(kind, existing) });
    if (trigger) App.modalTrigger = trigger;
    const initial = existing || draft;
    this.populateStructuralChoices(kind, initial);
    this.populateForm(initial);
    if (!existing && !draft) document.getElementById('field-template-enabled').checked = true;
    this.syncCadenceFields();
    document.getElementById('field-template-cadence').addEventListener('change', () => this.syncCadenceFields());
    if (kind === 'expense') {
      document.getElementById('field-template-category').addEventListener('change', () => this.populateItemChoices(null));
    }
    const save = document.getElementById('modal-save');
    save.textContent = existing ? 'Save changes' : 'Add template';
  },

  formBody(kind) {
    const structural = kind === 'income' ? 'earner' : 'category';
    const nodes = [
      ModalView.field('Name', ModalView.input('field-template-name', 'text', { maxlength: '120', required: true })),
      ModalView.field('Planned amount', ModalView.input('field-template-amount', 'number', { min: '0', max: '1000000000000', step: '0.01', required: true })),
      ModalView.field(kind === 'income' ? 'Earner' : 'Category', ModalView.select(`field-template-${structural}`, [], { required: true }))
    ];
    if (this.accountsAvailable()) nodes.push(ModalView.field(kind === 'income' ? 'Deposit account' : 'Payment account',
      ModalView.select('field-template-account')));
    if (kind === 'expense') nodes.push(
      ModalView.field('Preset item (optional)', ModalView.select('field-template-item')),
      ModalView.field('Payment method', ModalView.select('field-template-method', [['bank', 'Bank'], ['credit_card', 'Credit card'], ['savings', 'Savings'], ['investments', 'Investments']]))
    );
    nodes.push(
      ModalView.field('Start date (inclusive)', ModalView.input('field-template-start', 'date', { required: true })),
      ModalView.field('End date (inclusive, optional)', ModalView.input('field-template-end', 'date')),
      ModalView.field('Repeats', ModalView.select('field-template-cadence', [['', 'Choose a schedule'], ['monthly', 'Monthly'], ['twice-monthly', 'Twice monthly'], ['weekly', 'Weekly'], ['biweekly', 'Every two weeks']], { required: true })),
      this.templateScheduleField('template-monthly-fields', [['Day of month', 'field-template-day', 'number', { min: '1', max: '31', value: '1' }]], 'Short months use their final day.'),
      this.templateScheduleField('template-twice-fields', [['First day', 'field-template-day-one', 'number', { min: '1', max: '31', value: '1' }], ['Second day', 'field-template-day-two', 'number', { min: '1', max: '31', value: '15' }]], 'Each day clamps independently; both occurrences remain if they land together.'),
      this.templateScheduleField('template-anchor-fields', [['Anchor date', 'field-template-anchor', 'date', {}]])
    );
    const enabled = ModalView.input('field-template-enabled', 'checkbox', { checked: true });
    const enabledLabel = ModalView.element('label'); enabledLabel.append(enabled, document.createTextNode(' Enabled')); nodes.push(enabledLabel);
    return ModalView.fragment(...nodes);
  },

  templateScheduleField(id, fields, help = '') {
    const node = ModalView.element('div', { id });
    fields.forEach(([labelText, inputId, type, attrs]) => {
      const input = ModalView.input(inputId, type, attrs); const label = ModalView.element('label', { text: labelText, attrs: { for: inputId } });
      node.append(label, input);
    });
    if (help) node.append(ModalView.element('p', { className: 'field-help', text: help }));
    return node;
  },

  populateStructuralChoices(kind, existing) {
    if (kind === 'income') {
      const select = document.getElementById('field-template-earner');
      this.addOptions(select, Store.getEarners(), existing && Store.getEarner(existing.earnerId), existing && existing.earnerId);
    } else {
      const select = document.getElementById('field-template-category');
      this.addOptions(select, Store.getCategories(), existing && Store.getCategory(existing.categoryId), existing && existing.categoryId);
      this.populateItemChoices(existing && existing.categoryItemId);
      document.getElementById('field-template-method').value = existing ? existing.paymentMethod : 'bank';
    }
    if (this.accountsAvailable()) {
      const method = kind === 'expense' ? document.getElementById('field-template-method').value : null;
      this.populateAccountChoices(kind, method, existing?.accountId ?? null);
      if (kind === 'expense') document.getElementById('field-template-method').addEventListener('change', event =>
        this.populateAccountChoices(kind, event.currentTarget.value, null));
    }
  },

  accountsAvailable() {
    try { Store.getAccounts(); return true; } catch (error) { if (error.code === 'ACCOUNTS_UNAVAILABLE') return false; throw error; }
  },

  populateAccountChoices(kind, paymentMethod, selectedId) {
    const select = document.getElementById('field-template-account'); select.replaceChildren();
    const empty = this.element('option', '', 'No account selected'); empty.value = ''; select.append(empty);
    const expenseKinds = ({ bank: ['bank', 'cash', 'other'], credit_card: ['credit_card'], savings: ['savings'], investments: ['investments'] })[paymentMethod] || [];
    const kinds = kind === 'income' ? ['bank', 'savings', 'cash', 'investments', 'other'] : expenseKinds;
    const accounts = Store.getAccounts().filter(account => kinds.includes(account.kind));
    const current = selectedId ? Store.getAccounts({ includeArchived: true }).find(account => account.id === selectedId) : null;
    if (current?.archived && kinds.includes(current.kind)) accounts.unshift(current);
    accounts.forEach(account => { const option = this.element('option', '', `${account.name}${account.archived ? ' (Archived)' : ''}`);
      option.value = account.id; option.selected = account.id === selectedId; select.append(option); });
    select.value = selectedId || '';
  },

  addOptions(select, activeRecords, current, selectedId) {
    select.replaceChildren();
    const records = [...activeRecords];
    if (current && current.archived && !records.some(item => item.id === current.id)) records.push(current);
    records.forEach(record => {
      const option = this.element('option', '', `${record.name}${record.archived ? ' (Archived)' : ''}`);
      option.value = record.id; option.selected = record.id === selectedId; select.append(option);
    });
  },

  populateItemChoices(selectedId) {
    const categoryId = document.getElementById('field-template-category').value;
    const select = document.getElementById('field-template-item'); select.replaceChildren();
    const empty = this.element('option', '', 'No preset item'); empty.value = ''; select.append(empty);
    const items = categoryId ? Store.getCategoryItems(categoryId) : [];
    const current = selectedId && categoryId ? Store.getCategoryItem(categoryId, selectedId) : null;
    this.addOptionsAppend(select, items, current, selectedId);
  },

  addOptionsAppend(select, activeRecords, current, selectedId) {
    const records = [...activeRecords];
    if (current && current.archived && !records.some(item => item.id === current.id)) records.push(current);
    records.forEach(record => {
      const option = this.element('option', '', `${record.name}${record.archived ? ' (Archived)' : ''}`);
      option.value = record.id; option.selected = record.id === selectedId; select.append(option);
    });
  },

  populateForm(existing) {
    document.getElementById('field-template-name').value = existing ? existing.name : '';
    document.getElementById('field-template-amount').value = existing ? existing.plannedAmount : '';
    document.getElementById('field-template-start').value = existing ? existing.startDate || '' : '';
    document.getElementById('field-template-end').value = existing ? existing.endDate || '' : '';
    document.getElementById('field-template-enabled').checked = existing ? existing.enabled : false;
    const recurrence = existing ? existing.recurrence : { cadence: 'monthly', day: 1 };
    document.getElementById('field-template-cadence').value = recurrence ? recurrence.cadence : '';
    if (recurrence && recurrence.cadence === 'monthly') document.getElementById('field-template-day').value = recurrence.day;
    if (recurrence && recurrence.cadence === 'twice-monthly') {
      document.getElementById('field-template-day-one').value = recurrence.days[0];
      document.getElementById('field-template-day-two').value = recurrence.days[1];
    }
    if (recurrence && recurrence.anchorDate) document.getElementById('field-template-anchor').value = recurrence.anchorDate;
  },

  syncCadenceFields() {
    const cadence = document.getElementById('field-template-cadence').value;
    document.getElementById('template-monthly-fields').hidden = cadence !== 'monthly';
    document.getElementById('template-twice-fields').hidden = cadence !== 'twice-monthly';
    document.getElementById('template-anchor-fields').hidden = cadence !== 'weekly' && cadence !== 'biweekly';
    const monthly = document.getElementById('field-template-day');
    const first = document.getElementById('field-template-day-one');
    const second = document.getElementById('field-template-day-two');
    const anchor = document.getElementById('field-template-anchor');
    monthly.required = cadence === 'monthly'; monthly.disabled = cadence !== 'monthly';
    first.required = cadence === 'twice-monthly'; first.disabled = cadence !== 'twice-monthly';
    second.required = cadence === 'twice-monthly'; second.disabled = cadence !== 'twice-monthly';
    anchor.required = cadence === 'weekly' || cadence === 'biweekly'; anchor.disabled = !anchor.required;
  },

  readRecurrence() {
    const cadence = document.getElementById('field-template-cadence').value;
    if (!cadence) return null;
    if (cadence === 'monthly') return { cadence, day: Number(document.getElementById('field-template-day').value) };
    if (cadence === 'twice-monthly') return { cadence, days: [
      Number(document.getElementById('field-template-day-one').value),
      Number(document.getElementById('field-template-day-two').value)
    ] };
    return { cadence, anchorDate: document.getElementById('field-template-anchor').value };
  },

  saveForm(kind, existing) {
    const controls = [...document.querySelectorAll('#modal-body input, #modal-body select')];
    if (controls.some(control => !control.reportValidity())) return false;
    const input = {
      name: document.getElementById('field-template-name').value,
      plannedAmount: Number(document.getElementById('field-template-amount').value),
      enabled: document.getElementById('field-template-enabled').checked,
      startDate: document.getElementById('field-template-start').value,
      endDate: document.getElementById('field-template-end').value || null,
      recurrence: this.readRecurrence()
    };
    if (kind === 'income') input.earnerId = document.getElementById('field-template-earner').value;
    else {
      input.categoryId = document.getElementById('field-template-category').value;
      input.categoryItemId = document.getElementById('field-template-item').value || null;
      input.paymentMethod = document.getElementById('field-template-method').value;
    }
    if (this.accountsAvailable()) input.accountId = document.getElementById('field-template-account').value || null;
    return App.runMutation(() => {
      if (kind === 'income') return existing ? Store.updateIncomeTemplate(existing.id, input) : Store.addIncomeTemplate(input);
      return existing ? Store.updateExpenseTemplate(existing.id, input) : Store.addExpenseTemplate(input);
    }, { onSuccess: result => this.afterMutation(existing
      ? `${kind === 'income' ? 'Income' : 'Expense'} template updated.`
      : input.enabled ? `${kind === 'income' ? 'Income' : 'Expense'} template added.`
        : `Disabled ${kind === 'income' ? 'income' : 'expense'} template added. It will not add budget records until enabled.`,
    { kind, action: 'edit', id: result.id }) });
  },

  buildPreview(preview) {
    const wrapper = this.element('div', 'recurring-preview');
    const summary = this.element('p', 'preview-summary',
      `${preview.counts.additions} additions, ${preview.counts.skips} skipped, ${preview.counts.conflicts} conflicts.`);
    wrapper.append(summary);
    [['Income additions', preview.additions.income], ['Expense additions', preview.additions.expenses]].forEach(([heading, entries]) => {
      wrapper.append(this.element('h4', '', heading));
      const list = this.element('ul', 'preview-list');
      entries.forEach(entry => list.append(this.element('li', '', `${entry.name} — ${entry.scheduledDate} — ${this.money(entry.plannedAmount)}`)));
      if (!entries.length) list.append(this.element('li', 'muted-text', 'None'));
      wrapper.append(list);
    });
    if (preview.skips.length) {
      wrapper.append(this.element('h4', '', 'Skipped'));
      const list = this.element('ul', 'preview-list');
      preview.skips.forEach(entry => list.append(this.element('li', '', `${entry.name} — ${entry.reason}`))); wrapper.append(list);
    }
    if (preview.conflicts.length) {
      wrapper.append(this.element('h4', '', 'Conflicts'));
      const list = this.element('ul', 'preview-list');
      preview.conflicts.forEach(entry => list.append(this.element('li', '', `${entry.occurrenceKey} — ${entry.reason}`))); wrapper.append(list);
    }
    return wrapper;
  },

  afterMutation(message, focusTarget) {
    App.refreshAllViews(); App.announceStatus(message); this.restoreFocus(focusTarget);
  },

  restoreFocus({ kind, action, id }) {
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll('[data-template-kind][data-template-action]')];
      const target = controls.find(control => control.dataset.templateKind === kind &&
        control.dataset.recordId === id && control.dataset.templateAction === action && !control.disabled) ||
        controls.find(control => control.dataset.templateKind === kind && control.dataset.recordId === id && !control.disabled);
      const sectionId = kind === 'expense' ? 'expenses' : kind;
      (target || document.getElementById(`templates-${sectionId}-heading`)).focus({ preventScroll: true });
    });
  }
};
