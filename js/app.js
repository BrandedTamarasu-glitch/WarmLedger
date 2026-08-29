// Main app - startup gating, routing, accessible dialogs, backup and recovery.
const App = {
  currentView: 'budget', viewsInitialized: false, restorePreview: null,
  restoreTrigger: null, modalTrigger: null, shownWarnings: new Set(), MAX_IMPORT_BYTES: 5 * 1024 * 1024,

  init() {
    this.bindAppEvents();
    const result = Store.load();
    if (result.state === 'recovery-required') return this.showRecovery(result);
    this.enterApplication(result.state === 'empty' ? 'A new local budget is ready.' : 'Budget loaded from this browser.', result.state);
    this.showWarnings(result.warnings || []);
  },

  bindAppEvents() {
    document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => this.switchView(tab.dataset.view)));
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
    document.getElementById('modal-close').addEventListener('click', () => this.hideModal());
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
    document.getElementById('modal-overlay').addEventListener('click', event => {
      if (event.target === event.currentTarget) this.hideModal();
    });
    document.addEventListener('keydown', event => {
      const overlay = document.getElementById('modal-overlay');
      if (overlay.style.display === 'none') return;
      if (event.key === 'Escape') { event.preventDefault(); this.hideModal(); }
      else if (event.key === 'Tab') this.trapModalFocus(event);
    });
  },

  initializeViews() {
    if (this.viewsInitialized) return;
    BudgetView.init(); TransfersView.init(); DashboardView.init(); this.viewsInitialized = true;
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
    try { Store.restoreSnapshot(id); this.enterApplication('Recovery snapshot restored.', 'ready'); this.markSaved(); }
    catch (error) { button.disabled = false; this.showError(error); }
  },

  downloadEvidence() {
    const evidence = Store.getCorruptEvidence();
    if (typeof evidence !== 'string') return this.showErrorCode('EVIDENCE_UNAVAILABLE');
    this.download(evidence, `zerobudget-preserved-data-${this.fileTimestamp()}.txt`, 'text/plain');
    this.announceStatus('Preserved data downloaded.');
  },

  onFreshDialogClose() {
    const dialog = document.getElementById('fresh-dialog');
    if (dialog.returnValue !== 'confirm') return document.getElementById('btn-start-fresh').focus();
    try { Store.startFresh(); this.enterApplication('A new budget was created.', 'ready'); this.markSaved(); }
    catch (error) { this.showError(error); document.getElementById('btn-start-fresh').focus(); }
  },

  switchView(view) {
    if (!this.viewsInitialized) return;
    this.currentView = view;
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    document.querySelectorAll('.view').forEach(panel => panel.classList.toggle('active', panel.id === `view-${view}`));
    if (view === 'transfers') { TransfersView.syncMonth(); TransfersView.render(); }
    else if (view === 'dashboard') requestAnimationFrame(() => DashboardView.render());
  },

  refreshAllViews() {
    BudgetView.render(); TransfersView.syncMonth(); TransfersView.render(); DashboardView.destroyAllCharts();
    if (this.currentView === 'dashboard') requestAnimationFrame(() => DashboardView.render());
  },

  showModal(title, bodyHtml, onSave) {
    this.modalTrigger = document.activeElement;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    const overlay = document.getElementById('modal-overlay'); overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'modal-title');
    document.getElementById('application-shell').inert = true;
    const save = document.getElementById('modal-save'); const replacement = save.cloneNode(true); save.replaceWith(replacement);
    replacement.addEventListener('click', () => { if (onSave() !== false) this.hideModal(); });
    requestAnimationFrame(() => (document.querySelector('#modal-body input, #modal-body select') || document.getElementById('modal-cancel')).focus());
  },

  hideModal() {
    document.getElementById('modal-overlay').style.display = 'none';
    const shell = document.getElementById('application-shell');
    if (!shell.hidden) shell.inert = false;
    if (this.modalTrigger && this.modalTrigger.isConnected) this.modalTrigger.focus();
  },

  trapModalFocus(event) {
    const overlay = document.getElementById('modal-overlay');
    const controls = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(control => !control.disabled && !control.hidden);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!overlay.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  },

  downloadBackup() {
    try {
      this.download(Store.exportData(), `zerobudget-backup-${this.fileTimestamp()}.json`, 'application/json');
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
      Store.commitImport(preview); this.refreshAllViews(); this.markSaved();
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
      if (Store.getStatus().generation !== generation) this.markSaved();
      if (onSuccess) onSuccess(result);
      this.showWarnings(Store.getStatus().warnings || []);
      return true;
    } catch (error) {
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
      INVALID_IMPORT: 'This file is not a valid ZeroBudget backup. Your current budget was not changed.',
      STALE_IMPORT_PREVIEW: 'Your budget changed while the backup was open. Select the backup again before restoring.',
      SNAPSHOT_WRITE_FAILED: 'ZeroBudget could not create a safety snapshot, so your budget was not replaced.',
      PRIMARY_WRITE_FAILED: 'Changes could not be saved in this browser. Your last saved budget is still available.',
      FILE_TOO_LARGE: 'This backup is too large to open. Choose a ZeroBudget JSON backup smaller than 5 MB.',
      FILE_READ_FAILED: 'This file could not be read. Your current budget was not changed.',
      EVIDENCE_WRITE_FAILED: 'The unreadable data is available only during this session. Download it before closing ZeroBudget.',
      EVIDENCE_UNAVAILABLE: 'No preserved data is available to download.',
      SNAPSHOT_NOT_FOUND: 'That recovery snapshot is no longer available. Choose another recovery option.',
      INVALID_SNAPSHOT_SKIPPED: 'One damaged local recovery snapshot was skipped. Your active budget is still available.',
      SNAPSHOT_CLEANUP_FAILED: 'An older local recovery snapshot could not be removed. Your active budget was saved.',
      SNAPSHOT_READ_FAILED: 'Local recovery snapshots could not be read. Download a JSON backup to keep a durable copy.',
      CLOCK_FAILED: 'ZeroBudget could not read this device’s clock, so a safety snapshot may not have been created. Download a JSON backup now.',
      IDENTIFIER_GENERATION_FAILED: 'ZeroBudget could not create a safe record identifier. Your last saved budget is unchanged. Try the action again.',
      INVALID_AMOUNT: 'Enter an amount between 0 and 1,000,000,000,000.',
      AMOUNT_OUT_OF_RANGE: 'Enter an amount between 0 and 1,000,000,000,000.',
      INVALID_STRING: 'Names must contain 1 to 120 characters without leading or trailing spaces.',
      MONTH_NOT_FOUND: 'That month is no longer available. The last saved budget is shown.',
      PAYCHECK_NOT_FOUND: 'That paycheck is no longer available. The last saved budget is shown.',
      EXPENSE_NOT_FOUND: 'That expense is no longer available. The last saved budget is shown.',
      UNKNOWN: 'ZeroBudget could not complete that action. Your last saved budget remains available.'
    };
    const alert = document.getElementById('app-error'); document.getElementById('app-status').textContent = '';
    alert.textContent = messages[code] || messages.UNKNOWN; alert.hidden = false;
    if (document.getElementById('modal-overlay').style.display === 'none') alert.focus({ preventScroll: true });
  },
  fileTimestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); },
  formatTimestamp(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time'; },
  formatMonth(value) {
    if (!value) return 'None'; const [year, month] = value.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  },
  snapshotReason(reason) {
    return ({ daily: 'Daily safety snapshot', 'pre-import': 'Before restoring a backup', 'pre-reset': 'Before clearing data' })[reason] || 'Safety snapshot';
  }
};
document.addEventListener('DOMContentLoaded', () => App.init());
