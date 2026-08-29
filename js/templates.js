// Recurring template management. Integration requires the Templates view element IDs
// listed in requiredElementIds, TemplatesView.init() from App.initializeViews(),
// TemplatesView.render() from App.refreshAllViews()/switchView(), and this script after data.js.
const TemplatesView = {
  requiredElementIds: Object.freeze([
    'btn-add-income-template', 'btn-add-expense-template',
    'templates-income', 'templates-expenses',
    'templates-income-heading', 'templates-expenses-heading'
  ]),

  init() {
    document.getElementById('btn-add-income-template').addEventListener('click', event =>
      this.showTemplateModal('income', null, event.currentTarget));
    document.getElementById('btn-add-expense-template').addEventListener('click', event =>
      this.showTemplateModal('expense', null, event.currentTarget));
    this.render();
  },

  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  render() {
    this.renderSection('income', Store.getIncomeTemplates());
    this.renderSection('expense', Store.getExpenseTemplates());
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

  showTemplateModal(kind, existing, trigger) {
    if (trigger) App.modalTrigger = trigger;
    App.showModal(`${existing ? 'Edit' : 'Add'} ${kind} template`, this.formMarkup(kind), () => this.saveForm(kind, existing));
    this.populateStructuralChoices(kind, existing);
    this.populateForm(existing);
    this.syncCadenceFields();
    document.getElementById('field-template-cadence').addEventListener('change', () => this.syncCadenceFields());
    if (kind === 'expense') {
      document.getElementById('field-template-category').addEventListener('change', () => this.populateItemChoices(null));
    }
    const save = document.getElementById('modal-save');
    save.textContent = existing ? 'Save changes' : 'Add template';
  },

  formMarkup(kind) {
    return `
      <div class="form-group"><label for="field-template-name">Name</label><input id="field-template-name" type="text" maxlength="120" required></div>
      <div class="form-group"><label for="field-template-amount">Planned amount</label><input id="field-template-amount" type="number" min="0" max="1000000000000" step="0.01" required></div>
      <div class="form-group"><label for="field-template-${kind === 'income' ? 'earner' : 'category'}">${kind === 'income' ? 'Earner' : 'Category'}</label><select id="field-template-${kind === 'income' ? 'earner' : 'category'}" required></select></div>
      ${kind === 'expense' ? '<div class="form-group"><label for="field-template-item">Preset item (optional)</label><select id="field-template-item"></select></div><div class="form-group"><label for="field-template-method">Payment method</label><select id="field-template-method"><option value="bank">Bank</option><option value="credit_card">Credit card</option><option value="savings">Savings</option><option value="investments">Investments</option></select></div>' : ''}
      <div class="form-group"><label for="field-template-start">Start date (inclusive)</label><input id="field-template-start" type="date" required></div>
      <div class="form-group"><label for="field-template-end">End date (inclusive, optional)</label><input id="field-template-end" type="date"></div>
      <div class="form-group"><label for="field-template-cadence">Repeats</label><select id="field-template-cadence"><option value="monthly">Monthly</option><option value="twice-monthly">Twice monthly</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option></select></div>
      <div id="template-monthly-fields"><label for="field-template-day">Day of month</label><input id="field-template-day" type="number" min="1" max="31" value="1"><p class="field-help">Short months use their final day.</p></div>
      <div id="template-twice-fields"><label for="field-template-day-one">First day</label><input id="field-template-day-one" type="number" min="1" max="31" value="1"><label for="field-template-day-two">Second day</label><input id="field-template-day-two" type="number" min="1" max="31" value="15"><p class="field-help">Each day clamps independently; both occurrences remain if they land together.</p></div>
      <div id="template-anchor-fields"><label for="field-template-anchor">Anchor date</label><input id="field-template-anchor" type="date"></div>
      <label><input id="field-template-enabled" type="checkbox" checked> Enabled</label>`;
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
    document.getElementById('field-template-start').value = existing ? existing.startDate : '';
    document.getElementById('field-template-end').value = existing ? existing.endDate || '' : '';
    document.getElementById('field-template-enabled').checked = existing ? existing.enabled : true;
    const recurrence = existing ? existing.recurrence : { cadence: 'monthly', day: 1 };
    document.getElementById('field-template-cadence').value = recurrence.cadence;
    if (recurrence.cadence === 'monthly') document.getElementById('field-template-day').value = recurrence.day;
    if (recurrence.cadence === 'twice-monthly') {
      document.getElementById('field-template-day-one').value = recurrence.days[0];
      document.getElementById('field-template-day-two').value = recurrence.days[1];
    }
    if (recurrence.anchorDate) document.getElementById('field-template-anchor').value = recurrence.anchorDate;
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
    return App.runMutation(() => {
      if (kind === 'income') return existing ? Store.updateIncomeTemplate(existing.id, input) : Store.addIncomeTemplate(input);
      return existing ? Store.updateExpenseTemplate(existing.id, input) : Store.addExpenseTemplate(input);
    }, { onSuccess: result => this.afterMutation(`${kind === 'income' ? 'Income' : 'Expense'} template ${existing ? 'updated' : 'added'}.`,
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
