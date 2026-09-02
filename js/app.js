// Main app - startup gating, routing, accessible dialogs, backup and recovery.
const App = {
  currentView: 'budget', viewsInitialized: false, restorePreview: null,
  restoreTrigger: null, modalTrigger: null, recurringPreview: null, recurringTrigger: null,
  deleteContext: null, expenseUndo: null, templatesInitialized: false,
  helpTrigger: null, helpRouteTarget: null,
  shownWarnings: new Set(), MAX_IMPORT_BYTES: 5 * 1024 * 1024,

  init() {
    this.bindAppEvents();
    const result = Store.load();
    if (result.state === 'recovery-required') return this.showRecovery(result);
    this.enterApplication(result.state === 'empty' ? 'A new local budget is ready.' : 'Budget loaded from this browser.', result.state);
    this.showWarnings(result.warnings || []);
  },

  bindAppEvents() {
    document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => this.switchView(tab.dataset.view)));
    document.getElementById('btn-help').addEventListener('click', event => this.openHelp(event.currentTarget));
    document.getElementById('help-dialog').addEventListener('close', () => this.onHelpClose());
    document.querySelectorAll('[data-help-view]').forEach(button => button.addEventListener('click', () => {
      this.helpRouteTarget = button.dataset.helpView; document.getElementById('help-dialog').close();
    }));
    document.getElementById('btn-export').addEventListener('click', () => this.downloadBackup());
    document.getElementById('btn-import').addEventListener('click', event => {
      this.restoreTrigger = event.currentTarget; document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', event => this.selectBackup(event));
    document.getElementById('btn-download-evidence').addEventListener('click', () => this.downloadEvidence());
    document.getElementById('btn-start-fresh').addEventListener('click', () => {
      const dialog = document.getElementById('fresh-dialog'); dialog.returnValue = ''; dialog.showModal();
    });
    document.getElementById('restore-dialog').addEventListener('close', () => this.onRestoreDialogClose());
    document.getElementById('fresh-dialog').addEventListener('close', () => this.onFreshDialogClose());
    document.getElementById('btn-preview-recurring').addEventListener('click', event => this.openRecurringPreview(event.currentTarget));
    document.getElementById('recurring-preview-dialog').addEventListener('close', () => this.onRecurringPreviewClose());
    document.getElementById('expense-delete-dialog').addEventListener('close', () => this.onExpenseDeleteClose());
    document.getElementById('expense-undo').addEventListener('click', () => this.undoExpenseDelete());
    document.getElementById('expense-undo-dismiss').addEventListener('click', () => this.clearExpenseUndo(true));
    document.getElementById('modal-close').addEventListener('click', () => this.hideModal('cancel'));
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal('cancel'));
    document.getElementById('modal-overlay').addEventListener('click', event => {
      if (event.target === event.currentTarget) this.hideModal('backdrop');
    });
    window.addEventListener('storage', event => this.onExternalStorageChange(event));
    document.addEventListener('keydown', event => {
      const overlay = document.getElementById('modal-overlay');
      if (overlay.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); this.hideModal('escape'); }
      else if (event.key === 'Tab') this.trapModalFocus(event);
    });
  },

  initializeViews() {
    if (this.viewsInitialized) return;
    BudgetView.init(); TransfersView.init(); DashboardView.init(); StructureView.init(); DataHealthView.init(); this.viewsInitialized = true;
    this.initializeTemplateFeatures();
  },

  initializeTemplateFeatures() {
    document.getElementById('nav-templates').hidden = false;
    document.getElementById('btn-preview-recurring').hidden = false;
    document.getElementById('view-templates').hidden = false;
    if (!this.templatesInitialized) { TemplatesView.init(); this.templatesInitialized = true; }
  },

  enterApplication(message, state = 'ready') {
    const shell = document.getElementById('application-shell');
    document.getElementById('recovery-panel').hidden = true;
    shell.hidden = false; shell.inert = false; shell.removeAttribute('aria-hidden');
    this.initializeViews();
    document.getElementById('last-saved').textContent = state === 'empty' ? 'Not saved yet' : 'Loaded from this browser';
    this.announceStatus(message);
    requestAnimationFrame(() => document.getElementById('current-month-label').focus({ preventScroll: true }));
  },

  showRecovery(result) {
    const shell = document.getElementById('application-shell');
    shell.hidden = true; shell.inert = true; shell.setAttribute('aria-hidden', 'true');
    document.getElementById('recovery-panel').hidden = false;
    document.getElementById('btn-download-evidence').hidden = !result.hasEvidence;
    this.renderRecoverySnapshots(result.snapshots || []);
    if ((result.warnings || []).includes('EVIDENCE_WRITE_FAILED')) this.showErrorCode('EVIDENCE_WRITE_FAILED');
    requestAnimationFrame(() => document.getElementById('recovery-title').focus());
  },

  renderRecoverySnapshots(snapshots) {
    const container = document.getElementById('recovery-snapshots'); container.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Available recovery snapshots'; container.append(heading);
    if (!snapshots.length) {
      const empty = document.createElement('p'); empty.textContent = 'No valid recovery snapshots were found.'; container.append(empty); return;
    }
    const list = document.createElement('ul');
    snapshots.forEach(snapshot => {
      const item = document.createElement('li');
      const label = this.formatTimestamp(snapshot.createdAt);
      const description = document.createElement('span'); description.textContent = `${label} — ${this.snapshotReason(snapshot.reason)}`;
      const button = document.createElement('button'); button.className = 'btn'; button.type = 'button';
      button.textContent = 'Restore this snapshot'; button.setAttribute('aria-label', `Restore snapshot from ${label}`);
      button.addEventListener('click', () => this.restoreSnapshot(snapshot.id, button));
      item.append(description, button); list.append(item);
    });
    container.append(list);
  },

  restoreSnapshot(id, button) {
    button.disabled = true;
    try { Store.restoreSnapshot(id); this.clearExpenseUndo(); this.enterApplication('Recovery snapshot restored.', 'ready'); this.markSaved(); }
    catch (error) { button.disabled = false; this.showError(error); }
  },

  downloadEvidence() {
    const evidence = Store.getCorruptEvidence();
    if (typeof evidence !== 'string') return this.showErrorCode('EVIDENCE_UNAVAILABLE');
    this.download(evidence, `warm-ledger-preserved-data-${this.fileTimestamp()}.txt`, 'text/plain');
    this.announceStatus('Preserved data downloaded.');
  },

  onFreshDialogClose() {
    const dialog = document.getElementById('fresh-dialog');
    if (dialog.returnValue !== 'confirm') return document.getElementById('btn-start-fresh').focus();
    try { Store.startFresh(); this.clearExpenseUndo(); this.enterApplication('A new budget was created.', 'ready'); this.markSaved(); }
    catch (error) { this.showError(error); document.getElementById('btn-start-fresh').focus(); }
  },

  switchView(view) {
    if (!this.viewsInitialized) return;
    this.currentView = view;
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    document.querySelectorAll('.view').forEach(panel => panel.classList.toggle('active', panel.id === `view-${view}`));
    if (view === 'transfers') { TransfersView.syncMonth(); TransfersView.render(); }
    else if (view === 'dashboard') requestAnimationFrame(() => DashboardView.render());
    else if (view === 'structure') StructureView.render();
    else if (view === 'templates') TemplatesView.render();
    else if (view === 'data-health') DataHealthView.render();
  },

  openHelp(trigger) {
    this.helpTrigger = trigger; this.helpRouteTarget = null;
    const dialog = document.getElementById('help-dialog'); dialog.returnValue = ''; dialog.showModal();
  },

  onHelpClose() {
    const target = this.helpRouteTarget; this.helpRouteTarget = null;
    if (!target) { this.helpTrigger?.focus({ preventScroll: true }); return; }
    const headings = { budget: 'current-month-label', structure: 'structure-heading',
      templates: 'templates-heading', 'data-health': 'data-health-heading' };
    if (!Object.hasOwn(headings, target)) { this.helpTrigger?.focus({ preventScroll: true }); return; }
    this.switchView(target);
    requestAnimationFrame(() => document.getElementById(headings[target])?.focus({ preventScroll: true }));
  },

  openBudgetFunding(monthKey, expenseId, paycheckId = null) {
    BudgetView.currentMonth = monthKey;
    this.switchView('budget');
    BudgetView.render();
    requestAnimationFrame(() => BudgetView.focusFundingControl(expenseId, paycheckId));
  },

  savedRecordResultFingerprint(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.matchedFields)) return null;
    return JSON.stringify({
      kind: result.kind, monthKey: result.monthKey, recordId: result.recordId,
      primaryLabel: result.primaryLabel, secondaryLabel: result.secondaryLabel,
      date: result.date, plannedAmount: result.plannedAmount, actualAmount: result.actualAmount,
      paymentMethod: Object.hasOwn(result, 'paymentMethod') ? result.paymentMethod : null,
      matchedFields: [...result.matchedFields]
    });
  },

  focusSavedRecordSearchFallback(result) {
    requestAnimationFrame(() => {
      const actions = [...document.querySelectorAll('[data-record-kind][data-month-key][data-record-id]')];
      const refreshed = result && actions.find(action => action.dataset.recordKind === result.kind &&
        action.dataset.monthKey === result.monthKey && action.dataset.recordId === result.recordId);
      const details = document.getElementById('dashboard-record-finder');
      (refreshed || details?.querySelector('summary') || document.getElementById('dashboard-heading'))
        ?.focus({ preventScroll: true });
    });
  },

  openSavedRecordResult(result) {
    if (this.currentView !== 'dashboard') this.switchView('dashboard');
    let report;
    try { report = DashboardView.rerunSavedRecordSearch(); }
    catch (_error) {
      this.announceStatus('The saved-record search could not be refreshed. Review the search and try again.');
      this.focusSavedRecordSearchFallback(null); return false;
    }
    const fingerprint = this.savedRecordResultFingerprint(result);
    const refreshed = fingerprint && report?.results?.find(candidate => candidate.kind === result.kind &&
      candidate.monthKey === result.monthKey && candidate.recordId === result.recordId &&
      this.savedRecordResultFingerprint(candidate) === fingerprint);
    if (!refreshed) {
      this.announceStatus('That saved record changed or is no longer in the current results. Review the refreshed search.');
      this.focusSavedRecordSearchFallback(result); return false;
    }
    BudgetView.currentMonth = refreshed.monthKey;
    this.switchView('budget');
    BudgetView.focusSavedRecordResult(refreshed);
    return true;
  },

  savedMonthComparisonRequestFingerprint(request) {
    if (!request || typeof request !== 'object') return null;
    const keys = ['baselineMonth', 'comparisonMonth', 'basis', 'section', 'dimensionKey'];
    if (!keys.every(key => Object.hasOwn(request, key) && typeof request[key] === 'string')) return null;
    return JSON.stringify(keys.map(key => [key, request[key]]));
  },

  savedMonthComparisonContributorFingerprint(contributor) {
    if (!contributor || typeof contributor !== 'object') return null;
    const keys = ['kind', 'recordId', 'monthKey', 'name', 'category', 'date', 'plannedAmount',
      'actualAmount', 'paymentMethod', 'displayAmount', 'displayStatus'];
    if (!keys.every(key => Object.hasOwn(contributor, key))) return null;
    const encode = value => {
      if (value === null) return ['null'];
      if (typeof value === 'number') return Number.isFinite(value)
        ? ['number', Object.is(value, -0) ? '-0' : String(value)] : ['invalid-number'];
      if (typeof value === 'string') return ['string', value];
      return ['invalid-type'];
    };
    const encoded = keys.map(key => [key, encode(contributor[key])]);
    return encoded.some(([, value]) => value[0].startsWith('invalid')) ? null : JSON.stringify(encoded);
  },

  failSavedMonthComparisonContributor(request, message) {
    if (this.currentView !== 'dashboard') this.switchView('dashboard');
    try {
      if (request) DashboardView.refreshSavedMonthComparisonExplanation(request,
        { announceMessage: message, focusFallback: true });
      else {
        this.announceStatus(message);
        DashboardView.focusSavedMonthComparisonFallback(null);
      }
    } catch (_error) {
      this.announceStatus('The comparison contributors could not be refreshed. Review the comparison and try again.');
      DashboardView.focusSavedMonthComparisonFallback(request);
    }
    return false;
  },

  openSavedMonthComparisonContributor(contributor, request) {
    if (this.currentView !== 'dashboard') this.switchView('dashboard');
    const activeRequest = DashboardView.savedMonthComparisonExplainRequest;
    const activeFingerprint = this.savedMonthComparisonRequestFingerprint(activeRequest);
    const requestFingerprint = this.savedMonthComparisonRequestFingerprint(request);
    const staleMessage = 'That saved expense changed or is no longer a contributor. Review the refreshed comparison details.';
    if (!activeFingerprint || requestFingerprint !== activeFingerprint) {
      this.failSavedMonthComparisonContributor(activeRequest, staleMessage); return false;
    }

    let explanation;
    try { explanation = DashboardView.refreshSavedMonthComparisonExplanation(activeRequest); }
    catch (_error) {
      this.failSavedMonthComparisonContributor(activeRequest,
        'The comparison contributors could not be refreshed. Review the comparison and try again.'); return false;
    }
    const fingerprint = this.savedMonthComparisonContributorFingerprint(contributor);
    const sides = explanation?.status === 'ready' ? [explanation.baseline, explanation.comparison] : [];
    const refreshed = fingerprint && sides
      .filter(side => side?.monthKey === contributor.monthKey)
      .flatMap(side => Array.isArray(side.records) ? side.records : [])
      .find(candidate => candidate.kind === 'expense' && candidate.recordId === contributor.recordId &&
        this.savedMonthComparisonContributorFingerprint(candidate) === fingerprint);
    if (!refreshed) {
      this.announceStatus(staleMessage);
      DashboardView.focusSavedMonthComparisonFallback(activeRequest);
      return false;
    }
    BudgetView.currentMonth = refreshed.monthKey;
    this.switchView('budget');
    BudgetView.focusSavedMonthComparisonContributor(refreshed);
    return true;
  },

  refreshAllViews() {
    BudgetView.render(); TransfersView.syncMonth(); TransfersView.render(); DashboardView.destroyAllCharts(); StructureView.render();
    this.initializeTemplateFeatures();
    TemplatesView.render();
    DataHealthView.render();
    if (this.currentView === 'dashboard') requestAnimationFrame(() => DashboardView.render());
  },

  onExternalStorageChange(event) {
    const prefix = 'zeroBudget' + '_';
    if (event.storageArea !== localStorage || !event.key ||
      !(event.key === `${prefix}data` || event.key === `${prefix}corrupt` || event.key.startsWith(`${prefix}snapshot:`))) return;
    let result;
    try { result = Store.reload(); }
    catch (error) { this.showError(error); return; }
    if (!result.changed) return;
    this.hideModal(); this.clearExpenseUndo();
    if (result.state === 'recovery-required') {
      this.showRecovery(result);
      this.announceStatus('Local budget data changed in another tab and now needs recovery. Nothing was overwritten.');
      return;
    }
    if (document.getElementById('application-shell').hidden) this.enterApplication('', result.state);
    else this.refreshAllViews();
    document.getElementById('last-saved').textContent = result.state === 'empty' ? 'Not saved yet' : 'Updated from another tab';
    this.announceStatus('This budget changed in another tab. The latest saved data is now shown.');
    requestAnimationFrame(() => document.getElementById('current-month-label')?.focus({ preventScroll: true }));
  },

  openRecurringPreview(trigger) {
    this.recurringTrigger = trigger;
    try {
      const preview = Store.previewRecurringMonth(BudgetView.currentMonth);
      this.recurringPreview = preview;
      const content = document.getElementById('recurring-preview-content'); content.replaceChildren(TemplatesView.buildPreview(preview));
      const apply = document.getElementById('recurring-preview-apply');
      apply.disabled = preview.counts.conflicts > 0 || preview.counts.additions === 0;
      if (preview.counts.conflicts > 0) apply.title = 'Resolve conflicts before adding recurring items.';
      else if (preview.counts.additions === 0) apply.title = 'There are no new recurring items to add.';
      else apply.removeAttribute('title');
      const dialog = document.getElementById('recurring-preview-dialog'); dialog.returnValue = ''; dialog.showModal();
      return true;
    } catch (error) {
      this.recurringPreview = null;
      this.showError(error);
      trigger.focus(); return false;
    }
  },

  onRecurringPreviewClose() {
    const dialog = document.getElementById('recurring-preview-dialog');
    const preview = this.recurringPreview; this.recurringPreview = null;
    if (dialog.returnValue !== 'confirm' || !preview) { this.recurringTrigger?.focus(); return; }
    this.runMutation(() => Store.applyRecurringPreview(preview), {
      onSuccess: result => {
        this.refreshAllViews();
        this.announceStatus(`${result.addedIncome} income and ${result.addedExpenses} expense recurring items added.`);
        requestAnimationFrame(() => this.recurringTrigger?.focus({ preventScroll: true }));
      },
      onFailure: () => this.recurringTrigger?.focus()
    });
  },

  confirmExpenseDelete(expense, monthKey, trigger) {
    this.deleteContext = { expenseId: expense.id, expenseName: expense.name, monthKey, trigger };
    document.getElementById('expense-delete-warning').textContent =
      `Delete “${expense.name}” from ${this.formatMonth(monthKey)}? You can undo this deletion until another saved change makes it stale.`;
    const dialog = document.getElementById('expense-delete-dialog'); dialog.returnValue = ''; dialog.showModal();
  },

  onExpenseDeleteClose() {
    const dialog = document.getElementById('expense-delete-dialog'); const context = this.deleteContext; this.deleteContext = null;
    if (!context) return;
    if (dialog.returnValue !== 'confirm') { context.trigger?.focus({ preventScroll: true }); return; }
    this.runMutation(() => Store.deleteExpense(context.monthKey, context.expenseId), {
      onSuccess: receipt => {
        BudgetView.render(); this.offerExpenseUndo(receipt, context);
        requestAnimationFrame(() => document.getElementById('expense-undo').focus({ preventScroll: true }));
      },
      onFailure: () => { BudgetView.render(); context.trigger?.focus({ preventScroll: true }); }
    });
  },

  offerExpenseUndo(receipt, context) {
    this.expenseUndo = { receipt, ...context };
    document.getElementById('expense-undo-message').textContent = `“${context.expenseName}” was deleted.`;
    document.getElementById('expense-undo-notice').hidden = false;
    this.announceStatus(`${context.expenseName} was deleted. Undo is available.`);
  },

  clearExpenseUndo(restoreFocus = false) {
    const context = this.expenseUndo; this.expenseUndo = null;
    document.getElementById('expense-undo-notice').hidden = true;
    if (restoreFocus) requestAnimationFrame(() => {
      const target = context?.trigger?.isConnected ? context.trigger : document.getElementById('expenses-heading');
      target?.focus({ preventScroll: true });
    });
  },

  undoExpenseDelete() {
    const context = this.expenseUndo; if (!context) return;
    this.runMutation(() => Store.undoDeleteExpense(context.receipt), {
      onSuccess: () => {
        this.clearExpenseUndo(); this.refreshAllViews(); this.switchView('budget'); BudgetView.currentMonth = context.monthKey; BudgetView.render();
        this.announceStatus(`${context.expenseName} was restored.`);
        requestAnimationFrame(() => {
          const target = document.querySelector(`[data-edit-type="expense"][data-record-id="${CSS.escape(context.expenseId)}"]`) ||
            document.getElementById('expenses-heading');
          target?.focus({ preventScroll: true });
        });
      },
      onFailure: () => { this.clearExpenseUndo(); }
    });
  },

  showModal(options) { ModalView.open(options); this.modalTrigger = ModalView.trigger; },

  hideModal(reason = 'cancel') {
    ModalView.trigger = this.modalTrigger || ModalView.trigger; ModalView.close(reason); this.modalTrigger = null;
  },

  trapModalFocus(event) {
    ModalView.trapFocus(event);
  },

  downloadBackup() {
    try {
      this.download(Store.exportData(), `warm-ledger-backup-${this.fileTimestamp()}.json`, 'application/json');
      this.announceStatus('Backup downloaded.');
    } catch (error) { this.showError(error); }
  },

  download(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  selectBackup(event) {
    const input = event.currentTarget; const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    if (file.size > this.MAX_IMPORT_BYTES) { this.showErrorCode('FILE_TOO_LARGE'); this.restoreTrigger?.focus(); return; }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      try {
        this.restorePreview = Store.previewImport(String(reader.result));
        this.renderRestorePreview(file.name, this.restorePreview);
        const dialog = document.getElementById('restore-dialog'); dialog.returnValue = ''; dialog.showModal();
      } catch (error) { this.restorePreview = null; this.showError(error); this.restoreTrigger?.focus(); }
    });
    reader.addEventListener('error', () => { this.showErrorCode('FILE_READ_FAILED'); this.restoreTrigger?.focus(); });
    reader.readAsText(file);
  },

  renderRestorePreview(filename, preview) {
    const list = document.getElementById('restore-preview'); list.replaceChildren();
    const range = preview.monthCount === 0 ? 'No saved months' : `${this.formatMonth(preview.firstMonth)} to ${this.formatMonth(preview.lastMonth)}`;
    [['File', filename], ['Backup version', String(preview.formatVersion)], ['Exported', this.formatTimestamp(preview.exportedAt)],
      ['Months', String(preview.monthCount)], ['Date range', range]].forEach(([term, value]) => {
      const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = term; dd.textContent = value;
      dd.className = 'break-anywhere'; list.append(dt, dd);
    });
  },

  onRestoreDialogClose() {
    const dialog = document.getElementById('restore-dialog');
    if (dialog.returnValue !== 'confirm' || !this.restorePreview) {
      this.restorePreview = null; this.restoreTrigger?.focus(); return;
    }
    const preview = this.restorePreview; this.restorePreview = null;
    try {
      Store.commitImport(preview); this.clearExpenseUndo(); this.refreshAllViews(); this.markSaved();
      this.announceStatus('Backup restored. Your budget views are up to date.');
      requestAnimationFrame(() => document.getElementById('current-month-label').focus({ preventScroll: true }));
    } catch (error) { this.showError(error); this.restoreTrigger?.focus(); }
  },

  announceStatus(message) {
    const status = document.getElementById('app-status'); document.getElementById('app-error').hidden = true; status.textContent = '';
    requestAnimationFrame(() => { status.textContent = message; });
  },
  runMutation(mutate, { onSuccess, onFailure } = {}) {
    try {
      const generation = Store.getStatus().generation;
      const result = mutate();
      if (Store.getStatus().generation !== generation) {
        this.markSaved();
        if (this.expenseUndo) this.clearExpenseUndo();
      }
      if (onSuccess) onSuccess(result);
      this.showWarnings(Store.getStatus().warnings || []);
      return true;
    } catch (error) {
      if (error?.code === 'STALE_WRITE') {
        try {
          const result = Store.reload(); this.clearExpenseUndo();
          if (result.state === 'recovery-required') this.showRecovery(result); else this.refreshAllViews();
        } catch (_reloadError) { /* The original stale-write message remains authoritative. */ }
      }
      this.showError(error);
      if (onFailure) onFailure();
      return false;
    }
  },
  markSaved() {
    const date = new Date();
    const target = document.getElementById('last-saved');
    target.textContent = `Last saved ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  },
  showWarnings(warnings) {
    if (!warnings.length) return;
    const relevant = warnings.find(code => !this.shownWarnings.has(code) && [
      'INVALID_SNAPSHOT_SKIPPED', 'SNAPSHOT_WRITE_FAILED', 'SNAPSHOT_CLEANUP_FAILED', 'SNAPSHOT_READ_FAILED',
      'EVIDENCE_WRITE_FAILED', 'CLOCK_FAILED', 'IDENTIFIER_GENERATION_FAILED'
    ].includes(code));
    if (relevant) { this.shownWarnings.add(relevant); this.showErrorCode(relevant); }
  },
  showError(error) { this.showErrorCode(error && error.code ? error.code : 'UNKNOWN'); },
  showErrorCode(code) {
    const messages = {
      INVALID_IMPORT: 'This file is not a valid Warm Ledger backup. Your current budget was not changed.',
      STALE_IMPORT_PREVIEW: 'Your budget changed while the backup was open. Select the backup again before restoring.',
      SNAPSHOT_WRITE_FAILED: 'Warm Ledger could not create a safety snapshot, so your budget was not replaced.',
      INVALID_EXACT_MONEY_MIGRATION_PREVIEW: 'That exact-money preview is no longer available. Review the migration again.',
      STALE_EXACT_MONEY_MIGRATION_PREVIEW: 'Your ledger changed while the exact-money preview was open. Review the migration again.',
      EXACT_MONEY_MIGRATION_BLOCKED: 'This ledger is not eligible for exact-money storage. Your saved data was not changed.',
      EXACT_MONEY_ALREADY_MIGRATED: 'Exact-money storage is already active for this ledger.',
      EXACT_MONEY_MIGRATION_VALIDATION_FAILED: 'The exact-money migration could not be verified. Your saved data was not changed.',
      ACCOUNTS_MIGRATION_REQUIRES_MANUAL_CLEARING: 'Accounts require the current manual-clearing data format. Complete the earlier storage upgrades before adding accounts.',
      INVALID_ACCOUNTS_MIGRATION_PREVIEW: 'That accounts preview is no longer available. Review the accounts upgrade again.',
      STALE_ACCOUNTS_MIGRATION_PREVIEW: 'Your ledger changed while the accounts preview was open. Review the accounts upgrade again. Your saved data was not changed.',
      ACCOUNTS_ALREADY_MIGRATED: 'Accounts are already available for this ledger.',
      ACCOUNTS_MIGRATION_VALIDATION_FAILED: 'The accounts upgrade could not be verified. Your saved data was not changed.',
      ACTUAL_ACCOUNT_MIGRATION_REQUIRES_ACCOUNTS: 'Actual account labels require the current local-accounts data format. Complete the accounts upgrade before adding actual account labels.',
      INVALID_ACTUAL_ACCOUNT_MIGRATION_PREVIEW: 'That actual account preview is no longer available. Review the actual account upgrade again.',
      STALE_ACTUAL_ACCOUNT_MIGRATION_PREVIEW: 'Your ledger changed while the actual account preview was open. Review the actual account upgrade again. Your saved data was not changed.',
      ACTUAL_ACCOUNTS_ALREADY_MIGRATED: 'Actual account labels are already available for this ledger.',
      ACTUAL_ACCOUNT_MIGRATION_VALIDATION_FAILED: 'The actual account upgrade could not be verified. Your saved data was not changed.',
      ACCOUNTS_UNAVAILABLE: 'Accounts are not available in this ledger format. Complete the accounts upgrade in Data Health first.',
      ACCOUNT_NOT_FOUND: 'That account is no longer available. Refresh the Structure view and try again.',
      ACCOUNT_ARCHIVED: 'Choose an active account, or select no account.',
      ACCOUNT_INCOMPATIBLE: 'Choose an account that is compatible with the selected deposit or payment method.',
      DUPLICATE_ACCOUNT_NAME: 'Account names must be unique. Choose another name.',
      INVALID_ACCOUNT_KIND: 'Choose a valid account kind.',
      DANGLING_ACCOUNT_REFERENCE: 'A saved account reference is no longer available. Your saved data was not changed.',
      INCOMPATIBLE_ACCOUNT_KIND: 'A saved account is not compatible with its deposit or payment method. Your saved data was not changed.',
      INVALID_MONTH_SHARD_MIGRATION_PREVIEW: 'That month-sharded preview is no longer available. Review the migration again.',
      STALE_MONTH_SHARD_MIGRATION_PREVIEW: 'Your ledger changed while the month-sharded preview was open. Review the migration again. Nothing was overwritten.',
      MONTH_SHARD_ALREADY_MIGRATED: 'Month-sharded local storage is already active for this ledger.',
      MONTH_SHARD_MIGRATION_EMPTY: 'No saved local data is present yet. Month-sharded local storage becomes relevant after this ledger contains saved months.',
      SHARDED_GLOBAL_WRITE_FAILED: 'Warm Ledger could not save the month-sharded migration in this browser. Check available storage and try again. Your saved data was not changed.',
      SHARDED_MONTH_WRITE_FAILED: 'Warm Ledger could not save the month-sharded migration in this browser. Check available storage and try again. Your saved data was not changed.',
      SHARDED_MANIFEST_WRITE_FAILED: 'Warm Ledger could not save the month-sharded migration in this browser. Check available storage and try again. Your saved data was not changed.',
      SHARDED_JOURNAL_WRITE_FAILED: 'Warm Ledger could not save the month-sharded migration in this browser. Check available storage and try again. Your saved data was not changed.',
      SHARDED_READBACK_FAILED: 'Warm Ledger could not save the month-sharded migration in this browser. Check available storage and try again. Your saved data was not changed.',
      SHARDED_METADATA_MISMATCH: 'Warm Ledger could not verify the month-sharded migration. Your saved data was not changed.',
      PRIMARY_WRITE_FAILED: 'Changes could not be saved in this browser. Your last saved budget is still available.',
      FILE_TOO_LARGE: 'This backup is too large to open. Choose a Warm Ledger JSON backup smaller than 5 MB.',
      FILE_READ_FAILED: 'This file could not be read. Your current budget was not changed.',
      EVIDENCE_WRITE_FAILED: 'The unreadable data is available only during this session. Download it before closing Warm Ledger.',
      EVIDENCE_UNAVAILABLE: 'No preserved data is available to download.',
      SNAPSHOT_NOT_FOUND: 'That recovery snapshot is no longer available. Choose another recovery option.',
      INVALID_SNAPSHOT_SKIPPED: 'One damaged local recovery snapshot was skipped. Your active budget is still available.',
      SNAPSHOT_CLEANUP_FAILED: 'An older local recovery snapshot could not be removed. Your active budget was saved.',
      SNAPSHOT_READ_FAILED: 'Local recovery snapshots could not be read. Download a JSON backup to keep a durable copy.',
      CLOCK_FAILED: 'Warm Ledger could not read this device’s clock, so a safety snapshot may not have been created. Download a JSON backup now.',
      IDENTIFIER_GENERATION_FAILED: 'Warm Ledger could not create a safe record identifier. Your last saved budget is unchanged. Try the action again.',
      INVALID_AMOUNT: 'Enter an amount between 0 and 1,000,000,000,000.',
      AMOUNT_OUT_OF_RANGE: 'Enter an amount between 0 and 1,000,000,000,000.',
      INVALID_STRING: 'Names must contain 1 to 120 characters without leading or trailing spaces.',
      MONTH_NOT_FOUND: 'That month is no longer available. The last saved budget is shown.',
      PAYCHECK_NOT_FOUND: 'That paycheck is no longer available. The last saved budget is shown.',
      EXPENSE_NOT_FOUND: 'That expense is no longer available. The last saved budget is shown.',
      CATEGORY_NOT_FOUND: 'That category is no longer available. Refresh the Structure view and try again.',
      CATEGORY_ITEM_NOT_FOUND: 'That preset item is no longer available. Refresh the Structure view and try again.',
      EARNER_NOT_FOUND: 'That earner is no longer available. Refresh the Structure view and try again.',
      DUPLICATE_CATEGORY_NAME: 'Category names must be unique. Choose another name.',
      DUPLICATE_EARNER_NAME: 'Earner names must be unique. Choose another name.',
      LAST_ACTIVE_CATEGORY: 'Keep at least one active category so new expenses can be created.',
      LAST_ACTIVE_EARNER: 'Keep at least one active earner so new paychecks can be created.',
      INVALID_PERMUTATION: 'The structure changed before it could be reordered. Refresh and try again.',
      RECORD_MONTH_MISMATCH: 'Choose a date within the month you are editing.',
      GENERATED_DATE_MISMATCH: 'A generated item no longer matches its scheduled date. Preview the month again.',
      ALLOCATION_EXCEEDS_PLANNED: 'Paycheck allocations cannot exceed the expense’s planned amount.',
      INVALID_DATE: 'Enter a valid calendar date.',
      INVALID_DATE_RANGE: 'The end date must be the same as or later than the start date.',
      INVALID_RECURRENCE_DAY: 'Enter a recurrence day from 1 through 31.',
      INVALID_RECURRENCE_DAYS: 'Choose two different days from 1 through 31, with the first day earlier than the second.',
      INVALID_MONTH: 'That month is not valid. Choose another month and try again.',
      INVALID_RECURRING_PREVIEW: 'This recurring preview is no longer valid. Preview the month again.',
      STALE_RECURRING_PREVIEW: 'Your budget changed after this preview. Preview the month again before adding items.',
      RECURRING_CONFLICT: 'Recurring items could not be added because the month contains conflicting generated records.',
      INCOME_TEMPLATE_NOT_FOUND: 'That income template is no longer available. Refresh Templates and try again.',
      EXPENSE_TEMPLATE_NOT_FOUND: 'That expense template is no longer available. Refresh Templates and try again.',
      EARNER_ARCHIVED: 'Choose an active earner for this template.',
      CATEGORY_ARCHIVED: 'Choose an active category for this template.',
      CATEGORY_ITEM_ARCHIVED: 'Choose an active preset item, or use no preset item.',
      STALE_DELETE_RECEIPT: 'Undo is no longer available because the budget changed. The expense remains deleted; nothing else was changed.',
      INVALID_DELETE_RECEIPT: 'This expense deletion can no longer be undone. Nothing else was changed.',
      INVALID_ACTUAL_RESOLUTIONS: 'Select at least one unresolved record and enter a valid actual amount. Nothing was changed.',
      ACTUAL_ALREADY_RESOLVED: 'One selected record already has an actual amount. Refresh Data Health and review the selection again.',
      ACTUAL_RECORD_NOT_FOUND: 'One selected record is no longer available. Refresh Data Health and review the selection again.',
      STALE_ACTUAL_RESOLUTION_PREVIEW: 'Your budget changed while this preview was open. No actual amounts were applied.',
      INVALID_ACTUAL_RESOLUTION_PREVIEW: 'This actual-amount preview is no longer valid. No actual amounts were applied.',
      INVALID_COMPARISON_BACKUP: 'This file is not a valid Warm Ledger backup. Nothing was imported and your ledger was not changed.',
      STORE_BUSY: 'Warm Ledger is saving in another tab. Wait a moment and try again. Nothing was overwritten.',
      STALE_WRITE: 'This budget changed in another tab. Review the latest saved data and try again. Nothing was overwritten.',
      INVALID_PURGE_PREVIEW: 'That local-data purge preview is no longer available. Review the purge again.',
      STALE_PURGE_PREVIEW: 'Local data changed while the purge confirmation was open. Review the purge again. Nothing was removed.',
      PURGE_FAILED: 'Local Warm Ledger data could not be removed. Your prior data was restored.',
      PURGE_RECOVERY_FAILED: 'Local data removal could not be safely recovered. Use Data Recovery before continuing.',
      UNKNOWN: 'Warm Ledger could not complete that action. Your last saved budget remains available.'
    };
    const alert = document.getElementById('app-error'); document.getElementById('app-status').textContent = '';
    alert.textContent = messages[code] || messages.UNKNOWN; alert.hidden = false;
    if (document.getElementById('modal-overlay').hidden) alert.focus({ preventScroll: true });
  },
  fileTimestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); },
  formatTimestamp(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time'; },
  formatMonth(value) {
    if (!value) return 'None'; const [year, month] = value.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  },
  snapshotReason(reason) {
    return ({
      daily: 'Daily safety snapshot',
      'pre-import': 'Before restoring a backup',
      'pre-sharding': 'Before converting to month-sharded storage',
      'pre-reset': 'Before clearing data'
    })[reason] || 'Safety snapshot';
  }
};
document.addEventListener('DOMContentLoaded', () => App.init());
