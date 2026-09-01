// Structure view - accessible management of categories, preset items, and earners.
const StructureView = {
  init() {
    document.getElementById('btn-add-category').addEventListener('click', event => this.showNameModal('category', null, event.currentTarget));
    document.getElementById('btn-add-earner').addEventListener('click', event => this.showNameModal('earner', null, event.currentTarget));
    this.render();
  },

  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  render() {
    const usage = Store.getStructureUsage();
    this.renderCategories(Store.getCategories({ includeArchived: true }), usage);
    this.renderEarners(Store.getEarners({ includeArchived: true }), usage);
  },

  renderCategories(categories, usage) {
    const container = document.getElementById('structure-categories');
    container.replaceChildren();
    if (!categories.length) {
      container.append(this.element('p', 'muted-text', 'No categories yet. Add a category to create expense choices.'));
      return;
    }
    const list = this.element('ul', 'structure-list');
    categories.forEach((category, index) => {
      const item = this.element('li', 'structure-card');
      const row = this.buildRow({
        type: 'category', record: category, index, total: categories.length,
        usage: usage.categoryExpenses[category.id] || 0
      });
      const itemHeader = this.element('div', 'structure-subheader');
      itemHeader.append(this.element('h4', '', 'Preset items'));
      const addItem = this.element('button', 'btn btn-sm', '+ Add preset item');
      addItem.type = 'button'; addItem.dataset.structureType = 'category-item';
      addItem.dataset.structureAction = 'add'; addItem.dataset.parentId = category.id;
      addItem.addEventListener('click', event => this.showNameModal('category-item', null, event.currentTarget, category.id));
      itemHeader.append(addItem);
      const nested = this.buildItemList(category, usage);
      item.append(row, itemHeader, nested); list.append(item);
    });
    container.append(list);
  },

  buildItemList(category, usage) {
    if (!category.items.length) return this.element('p', 'muted-text structure-empty', 'No preset items in this category.');
    const list = this.element('ul', 'structure-list structure-sublist');
    category.items.forEach((record, index) => {
      const item = this.element('li', 'structure-subcard');
      item.append(this.buildRow({
        type: 'category-item', record, index, total: category.items.length,
        categoryId: category.id, usage: usage.itemExpenses[record.id] || 0
      }));
      list.append(item);
    });
    return list;
  },

  renderEarners(earners, usage) {
    const container = document.getElementById('structure-earners');
    container.replaceChildren();
    if (!earners.length) {
      container.append(this.element('p', 'muted-text', 'No earners yet. Add an earner to create paycheck choices.'));
      return;
    }
    const list = this.element('ul', 'structure-list');
    earners.forEach((record, index) => {
      const item = this.element('li', 'structure-card');
      item.append(this.buildRow({ type: 'earner', record, index, total: earners.length, usage: usage.earnerPaychecks[record.id] || 0 }));
      list.append(item);
    });
    container.append(list);
  },

  buildRow({ type, record, index, total, categoryId = '', usage }) {
    const row = this.element('div', 'structure-row');
    const identity = this.element('div', 'structure-identity');
    identity.append(this.element('span', 'structure-name', record.name));
    identity.append(this.element('span', `structure-status ${record.archived ? 'is-archived' : ''}`, record.archived ? 'Archived' : 'Active'));
    const actions = this.element('div', 'structure-actions');
    actions.append(
      this.actionButton('Rename', type, 'rename', record, categoryId, () => this.showNameModal(type, record, null, categoryId)),
      this.actionButton(record.archived ? 'Restore' : 'Archive', type, record.archived ? 'restore' : 'archive', record, categoryId,
        event => record.archived ? this.setArchived(type, record, categoryId, false, event.currentTarget) : this.confirmArchive(type, record, categoryId, usage, event.currentTarget)),
      this.moveButton('↑', 'Move up', type, record, categoryId, -1, index === 0),
      this.moveButton('↓', 'Move down', type, record, categoryId, 1, index === total - 1)
    );
    row.append(identity, actions); return row;
  },

  actionButton(text, type, action, record, categoryId, handler) {
    const button = this.element('button', 'btn btn-sm', text); button.type = 'button';
    this.identify(button, type, action, record.id, categoryId);
    button.setAttribute('aria-label', `${text} ${record.name}`);
    button.addEventListener('click', handler); return button;
  },

  moveButton(text, label, type, record, categoryId, delta, disabled) {
    const button = this.actionButton(text, type, delta < 0 ? 'move-up' : 'move-down', record, categoryId,
      event => this.move(type, record, categoryId, delta, event.currentTarget));
    button.disabled = disabled; button.setAttribute('aria-label', `${label} ${record.name}`); return button;
  },

  identify(control, type, action, id, categoryId = '') {
    control.dataset.structureType = type; control.dataset.structureAction = action;
    control.dataset.recordId = id; control.dataset.parentId = categoryId;
  },

  showNameModal(type, existing, trigger, categoryId = '') {
    if (trigger) App.modalTrigger = trigger;
    const noun = type === 'category-item' ? 'preset item' : type;
    App.showModal({ title: `${existing ? 'Rename' : 'Add'} ${noun}`,
      buildBody: () => ModalView.field('Name', ModalView.input('field-structure-name', 'text', { maxlength: '120', required: true })),
      submitLabel: existing ? 'Rename' : 'Add', onSave: () => {
      const input = document.getElementById('field-structure-name');
      if (!input.reportValidity()) return false;
      const name = input.value;
      return App.runMutation(() => {
        if (type === 'category') return existing ? Store.renameCategory(existing.id, name) : Store.addCategory({ name });
        if (type === 'category-item') return existing
          ? Store.renameCategoryItem(categoryId, existing.id, name) : Store.addCategoryItem(categoryId, { name });
        return existing ? Store.renameEarner(existing.id, name) : Store.addEarner({ name });
      }, { onSuccess: result => {
        const action = existing ? 'renamed' : 'added';
        this.afterMutation(`${noun[0].toUpperCase()}${noun.slice(1)} ${action}.`, {
          type, action: existing ? 'rename' : 'rename', id: result.id, categoryId
        });
      } });
    }});
    const input = document.getElementById('field-structure-name'); input.value = existing ? existing.name : '';
    const save = document.getElementById('modal-save'); save.disabled = false; save.textContent = existing ? 'Rename' : 'Add'; save.className = 'btn btn-primary';
  },

  confirmArchive(type, record, categoryId, usage, trigger) {
    const noun = type === 'category-item' ? 'preset item' : type;
    App.showModal({ title: `Archive ${noun}?`,
      buildBody: () => ModalView.element('p', { id: 'structure-archive-message' }), submitLabel: 'Archive', onSave: () =>
      App.runMutation(() => this.archiveMutation(type, record.id, categoryId, true), {
        onSuccess: () => this.afterMutation(`${record.name} archived.`, { type, action: 'restore', id: record.id, categoryId })
      }) });
    App.modalTrigger = trigger;
    const message = document.getElementById('structure-archive-message');
    const usageLabel = usage === 1 ? '1 historical record uses' : `${usage} historical records use`;
    message.textContent = `${usageLabel} this ${noun}. History will remain visible, but this option will no longer appear for new records.`;
    const save = document.getElementById('modal-save'); save.disabled = false; save.textContent = 'Archive'; save.className = 'btn btn-danger';
  },

  setArchived(type, record, categoryId, archived, trigger) {
    App.runMutation(() => this.archiveMutation(type, record.id, categoryId, archived), {
      onSuccess: () => this.afterMutation(`${record.name} restored.`, { type, action: 'archive', id: record.id, categoryId }),
      onFailure: () => trigger.focus()
    });
  },

  archiveMutation(type, id, categoryId, archived) {
    if (type === 'category') return Store.setCategoryArchived(id, archived);
    if (type === 'category-item') return Store.setCategoryItemArchived(categoryId, id, archived);
    return Store.setEarnerArchived(id, archived);
  },

  move(type, record, categoryId, delta, trigger) {
    let records;
    if (type === 'category') records = Store.getCategories({ includeArchived: true });
    else if (type === 'category-item') records = Store.getCategoryItems(categoryId, { includeArchived: true });
    else records = Store.getEarners({ includeArchived: true });
    const from = records.findIndex(item => item.id === record.id); const to = from + delta;
    if (from < 0 || to < 0 || to >= records.length) return;
    const ids = records.map(item => item.id); [ids[from], ids[to]] = [ids[to], ids[from]];
    App.runMutation(() => {
      if (type === 'category') return Store.reorderCategories(ids);
      if (type === 'category-item') return Store.reorderCategoryItems(categoryId, ids);
      return Store.reorderEarners(ids);
    }, {
      onSuccess: () => this.afterMutation(`${record.name} moved to position ${to + 1} of ${records.length}.`, {
        type, action: delta < 0 ? 'move-up' : 'move-down', id: record.id, categoryId
      }),
      onFailure: () => trigger.focus()
    });
  },

  afterMutation(message, focusTarget) {
    App.refreshAllViews(); App.announceStatus(message); this.restoreFocus(focusTarget);
  },

  restoreFocus({ type, action, id, categoryId = '' }) {
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll('[data-structure-type][data-structure-action]')];
      const belongsToRecord = control => control.dataset.structureType === type &&
        control.dataset.recordId === id && control.dataset.parentId === categoryId;
      let target = controls.find(control => belongsToRecord(control) && control.dataset.structureAction === action && !control.disabled);
      if (!target) target = controls.find(control => belongsToRecord(control) && !control.disabled);
      (target || document.getElementById(type === 'earner' ? 'structure-earners-heading' : 'structure-categories-heading')).focus({ preventScroll: true });
    });
  }
};
