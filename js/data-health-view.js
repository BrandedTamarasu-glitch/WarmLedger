// Read-only Data Health rendering and explicit, previewed repair workflows.
const DataHealthView = {
  preview: null,
  datePreview: null,
  exactMoneyPreview: null,
  exactMoneyTrigger: null,
  monthShardedPreview: null,
  accountsPreview: null,
  actualAccountPreview: null,
  purgePreview: null,

  init() {
    document.getElementById('actual-resolution-dialog').addEventListener('close', () => this.onActualDialogClose());
    document.getElementById('date-resolution-dialog').addEventListener('close', () => this.onDateDialogClose());
    document.getElementById('exact-money-migration-dialog').addEventListener('close', () => this.onExactMoneyDialogClose());
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
    let health; let moneyAudit; let migration; let shardedSummary; let shardedMigration; let accountsSummary; let accountsMigration;
    let actualAccountSummary; let actualAccountMigration;
    try {
      health = Store.getDataHealth(); moneyAudit = Store.getExactMoneyAudit();
      migration = ZeroBudgetDataHealth.buildExactMoneyMigration(Store.getExactMoneyMigrationSummary());
      shardedSummary = Store.getShardedPersistenceSummary();
      shardedMigration = ZeroBudgetDataHealth.buildShardedPersistenceMigration(shardedSummary);
      accountsSummary = Store.getAccountsMigrationSummary();
      accountsMigration = ZeroBudgetDataHealth.buildAccountsMigration(accountsSummary);
      actualAccountSummary = Store.getActualAccountMigrationSummary();
      actualAccountMigration = ZeroBudgetDataHealth.buildActualAccountMigration(actualAccountSummary);
    }
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
    container.append(this.accountsMigrationSection(accountsSummary, accountsMigration));
    if (actualAccountMigration.state !== 'already-migrated') {
      container.append(this.actualAccountMigrationSection(actualAccountSummary, actualAccountMigration));
    }
    container.append(this.monthShardedMigrationSection(shardedSummary, shardedMigration));
    container.append(this.exactMoneyMigrationSection(migration));
    container.append(this.moneyPrecisionDisclosure(moneyAudit));
    container.append(this.localStoragePrivacySection());

    if (health.missingActuals.length) container.append(this.actualsSection(health.missingActuals));
    if (health.missingDates.length) container.append(this.dateResolutionSection(health.missingDates));
    if (health.fundingMismatches.length) container.append(this.fundingSection(health.fundingMismatches));
    container.append(this.moreToolsSection(health));
  },

  accountsMigrationSection(summary, migration) {
    const section = this.node('section', `budget-section data-health-section accounts-migration state-${migration.state}`);
    section.setAttribute('aria-labelledby', 'accounts-migration-heading');
    const heading = this.node('h3', '', migration.title); heading.id = 'accounts-migration-heading'; heading.tabIndex = -1;
    section.append(heading, this.node('p', '', migration.description));
    if (migration.canPreview) {
      section.append(this.node('p', 'muted-text',
        'Download a JSON backup first. When you confirm, Warm Ledger also creates a local safety snapshot before changing storage.'));
      const actions = this.node('div', 'accounts-migration-actions');
      const backup = this.node('button', 'btn', 'Download JSON backup'); backup.type = 'button';
      backup.addEventListener('click', () => App.downloadBackup());
      const review = this.node('button', 'btn btn-primary', migration.buttonLabel); review.type = 'button';
      review.id = 'review-accounts-migration';
      review.addEventListener('click', () => this.previewAccountsMigration(review));
      actions.append(backup, review); section.append(actions);
    }
    return section;
  },

  accountsSummaryList(summary) {
    const list = this.node('dl', 'accounts-migration-summary');
    [['Saved paychecks', String(summary.paycheckCount)], ['Saved expenses', String(summary.expenseCount)],
      ['Saved templates', String(summary.templateCount)]].forEach(([label, value]) => {
      list.append(this.node('dt', '', label), this.node('dd', '', value));
    });
    return list;
  },

  previewAccountsMigration(trigger) {
    try {
      this.accountsPreview = Store.previewAccountsMigration();
      const preview = this.accountsPreview;
      App.showModal({
        title: 'Add local accounts to this ledger?',
        submitLabel: 'Add local accounts',
        initialFocus: () => document.getElementById('modal-cancel'),
        onClose: reason => { if (reason !== 'confirm') this.accountsPreview = null; },
        buildBody: () => {
          const body = this.node('div', 'accounts-migration-preview');
          body.append(
            this.node('p', '', 'This adds optional account labels without changing saved budget values.'),
            this.node('p', '', 'Accounts are local planning labels only. They do not connect to a bank, prove payment, or reconcile activity.'),
            this.node('p', '', 'Warm Ledger creates a local safety snapshot before saving.'),
            this.accountsSummaryList(preview)
          );
          return body;
        },
        onSave: () => {
          if (!this.accountsPreview) { App.showErrorCode('INVALID_ACCOUNTS_MIGRATION_PREVIEW'); return false; }
          this.commitAccountsMigration();
          return true;
        }
      });
      App.modalTrigger = trigger; ModalView.trigger = trigger;
    } catch (error) {
      this.accountsPreview = null; App.showError(error); trigger.focus();
    }
  },

  commitAccountsMigration() {
    const preview = this.accountsPreview; this.accountsPreview = null;
    return App.runMutation(() => Store.commitAccountsMigration(preview), {
      onSuccess: () => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus('Local accounts are now available. Saved budget values did not change.');
        requestAnimationFrame(() => document.getElementById('accounts-migration-heading').focus({ preventScroll: true }));
      },
      onFailure: () => {
        this.render();
        if (Store.getStatus().state === 'recovery-required') App.showRecovery(Store.reload());
        requestAnimationFrame(() => {
          const target = document.getElementById('review-accounts-migration') || document.getElementById('accounts-migration-heading');
          target?.focus({ preventScroll: true });
        });
      }
    });
  },

  actualAccountMigrationSection(summary, migration) {
    const section = this.node('section', `budget-section data-health-section actual-account-migration state-${migration.state}`);
    section.setAttribute('aria-labelledby', 'actual-account-migration-heading');
    const heading = this.node('h3', '', migration.title); heading.id = 'actual-account-migration-heading'; heading.tabIndex = -1;
    section.append(heading, this.node('p', '', migration.description));
    if (migration.canPreview) {
      section.append(this.node('p', 'muted-text',
        'Download a JSON backup first. When you confirm, Warm Ledger also creates a local safety snapshot before changing storage.'));
      const actions = this.node('div', 'actual-account-migration-actions');
      const backup = this.node('button', 'btn', 'Download JSON backup'); backup.type = 'button';
      backup.addEventListener('click', () => App.downloadBackup());
      const review = this.node('button', 'btn btn-primary', migration.buttonLabel); review.type = 'button';
      review.id = 'review-actual-account-migration';
      review.addEventListener('click', () => this.previewActualAccountMigration(review));
      actions.append(backup, review); section.append(actions);
    }
    return section;
  },

  actualAccountSummaryList(summary) {
    const list = this.node('dl', 'actual-account-migration-summary');
    [['Saved paychecks', String(summary.paycheckCount)], ['Saved expenses', String(summary.expenseCount)],
      ['Accounts', String(summary.accountCount)]].forEach(([label, value]) => {
      list.append(this.node('dt', '', label), this.node('dd', '', value));
    });
    return list;
  },

  previewActualAccountMigration(trigger) {
    try {
      this.actualAccountPreview = Store.previewActualAccountMigration();
      const preview = this.actualAccountPreview;
      App.showModal({
        title: 'Add actual account labels to this ledger?',
        submitLabel: 'Add actual account labels',
        initialFocus: () => document.getElementById('modal-cancel'),
        onClose: reason => { if (reason !== 'confirm') this.actualAccountPreview = null; },
        buildBody: () => {
          const body = this.node('div', 'actual-account-migration-preview');
          body.append(
            this.node('p', '', 'This adds optional actual-account labels to saved paychecks and expenses without changing saved budget values.'),
            this.node('p', '', 'Actual account labels are entered manually. They do not connect to a bank, prove payment, or reconcile activity.'),
            this.node('p', '', 'Warm Ledger creates a local safety snapshot before saving.'),
            this.actualAccountSummaryList(preview)
          );
          return body;
        },
        onSave: () => {
          if (!this.actualAccountPreview) { App.showErrorCode('INVALID_ACTUAL_ACCOUNT_MIGRATION_PREVIEW'); return false; }
          this.commitActualAccountMigration();
          return true;
        }
      });
      App.modalTrigger = trigger; ModalView.trigger = trigger;
    } catch (error) {
      this.actualAccountPreview = null; App.showError(error); trigger.focus();
    }
  },

  commitActualAccountMigration() {
    const preview = this.actualAccountPreview; this.actualAccountPreview = null;
    return App.runMutation(() => Store.commitActualAccountMigration(preview), {
      onSuccess: () => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus('Actual account labels are now available. Saved budget values did not change.');
        requestAnimationFrame(() => document.getElementById('data-health-heading')?.focus({ preventScroll: true }));
      },
      onFailure: () => {
        this.render();
        if (Store.getStatus().state === 'recovery-required') App.showRecovery(Store.reload());
        requestAnimationFrame(() => {
          const target = document.getElementById('review-actual-account-migration') || document.getElementById('actual-account-migration-heading');
          target?.focus({ preventScroll: true });
        });
      }
    });
  },

  totalIssues(health) { return Object.values(health.counts).reduce((sum, count) => sum + count, 0); },

  exactMoneyMigrationSection(migration) {
    const section = this.node('section', `budget-section data-health-section exact-money-migration state-${migration.state}`);
    section.setAttribute('aria-labelledby', 'exact-money-migration-heading');
    const heading = this.node('h3', '', migration.title); heading.id = 'exact-money-migration-heading'; heading.tabIndex = -1;
    section.append(heading, this.node('p', '', migration.description));
    if (migration.state === 'eligible') {
      section.append(this.node('p', 'muted-text',
        'Download a JSON backup first. When you confirm, Warm Ledger also creates a local safety snapshot before changing storage.'));
      const actions = this.node('div', 'exact-money-actions');
      const backup = this.node('button', 'btn', 'Download JSON backup'); backup.type = 'button';
      backup.addEventListener('click', () => App.downloadBackup());
      const review = this.node('button', 'btn btn-primary', 'Review exact-money migration'); review.type = 'button';
      review.id = 'review-exact-money-migration';
      review.addEventListener('click', () => this.previewExactMoneyMigration(review));
      actions.append(backup, review); section.append(actions);
    }
    return section;
  },

  monthShardedMigrationSection(summary, migration) {
    const section = this.node('section', `budget-section data-health-section month-sharded-persistence state-${migration.state}`);
    section.setAttribute('aria-labelledby', 'month-sharded-storage-heading');
    const heading = this.node('h3', '', migration.title); heading.id = 'month-sharded-storage-heading'; heading.tabIndex = -1;
    section.append(heading, this.node('p', '', migration.description));
    if (migration.canPreview) {
      section.append(this.node('p', 'muted-text',
        'Download a JSON backup first. Warm Ledger also creates a local safety snapshot before changing storage.'));
      section.append(this.monthShardedSummaryList(summary));
      const actions = this.node('div', 'month-sharded-actions');
      const backup = this.node('button', 'btn', 'Download JSON backup'); backup.type = 'button';
      backup.addEventListener('click', () => App.downloadBackup());
      const preview = this.node('button', 'btn btn-primary', migration.buttonLabel); preview.type = 'button';
      preview.id = 'review-month-sharded-storage';
      preview.addEventListener('click', () => this.previewMonthShardedMigration(preview));
      actions.append(backup, preview); section.append(actions);
    }
    return section;
  },

  monthShardedSummaryList(summary) {
    const list = this.node('dl', 'month-sharded-summary');
    [
      ['Saved months', String(summary.monthCount)],
      ['First month', summary.firstMonth ? App.formatMonth(summary.firstMonth) : 'None'],
      ['Last month', summary.lastMonth ? App.formatMonth(summary.lastMonth) : 'None'],
      ['Current stored bytes', this.formatBytes(summary.currentStoredBytes)],
      ['Estimated sharded bytes', this.formatBytes(summary.estimatedShardedBytes)],
      ['Estimated peak additional bytes', this.formatBytes(summary.estimatedPeakAdditionalBytes)]
    ].forEach(([label, value]) => {
      list.append(this.node('dt', '', label), this.node('dd', '', value));
    });
    return list;
  },

  formatBytes(value) {
    return `${Number(value).toLocaleString()} bytes`;
  },

  previewMonthShardedMigration(trigger) {
    try {
      this.monthShardedPreview = Store.previewShardedPersistenceMigration();
      const preview = this.monthShardedPreview;
      App.showModal({
        title: 'Move this ledger to month-sharded storage?',
        submitLabel: 'Move to month-sharded storage',
        initialFocus: () => document.getElementById('modal-cancel'),
        onClose: reason => {
          if (reason !== 'confirm') this.monthShardedPreview = null;
        },
        buildBody: () => {
          const body = this.node('div', 'month-sharded-migration-preview');
          body.append(
            this.node('p', '', 'This changes only the saved local representation. Budget values and behavior stay the same.'),
            this.node('p', '', 'Warm Ledger creates a local safety snapshot before saving.'),
            this.node('p', '', 'Older app versions may require restoring a backup made before this migration.'),
            this.monthShardedSummaryList(preview)
          );
          return body;
        },
        onSave: () => {
          if (!this.monthShardedPreview) { App.showErrorCode('INVALID_MONTH_SHARD_MIGRATION_PREVIEW'); return false; }
          this.commitMonthShardedMigration();
          return true;
        }
      });
      App.modalTrigger = trigger; ModalView.trigger = trigger;
    } catch (error) {
      this.monthShardedPreview = null;
      App.showError(error);
      trigger.focus();
    }
  },

  commitMonthShardedMigration() {
    const preview = this.monthShardedPreview;
    this.monthShardedPreview = null;
    return App.runMutation(() => Store.commitShardedPersistenceMigration(preview), {
      onSuccess: () => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus('Warm Ledger now stores this ledger in month-sharded local storage. Budget values did not change.');
        requestAnimationFrame(() => document.getElementById('month-sharded-storage-heading').focus({ preventScroll: true }));
      },
      onFailure: () => {
        this.render();
        if (Store.getStatus().state === 'recovery-required') App.showRecovery(Store.reload());
        requestAnimationFrame(() => {
          const target = document.getElementById('review-month-sharded-storage') || document.getElementById('month-sharded-storage-heading');
          target?.focus({ preventScroll: true });
        });
      }
    });
  },

  previewExactMoneyMigration(trigger) {
    try {
      this.exactMoneyPreview = Store.previewExactMoneyMigration(); this.exactMoneyTrigger = trigger;
      const dialog = document.getElementById('exact-money-migration-dialog'); dialog.returnValue = ''; dialog.showModal();
      document.getElementById('exact-money-migration-cancel').focus({ preventScroll: true });
    } catch (error) { this.exactMoneyPreview = null; this.exactMoneyTrigger = null; App.showError(error); }
  },

  onExactMoneyDialogClose() {
    const dialog = document.getElementById('exact-money-migration-dialog');
    const preview = this.exactMoneyPreview; const trigger = this.exactMoneyTrigger;
    this.exactMoneyPreview = null; this.exactMoneyTrigger = null;
    if (dialog.returnValue !== 'confirm' || !preview) {
      trigger?.focus({ preventScroll: true }); return;
    }
    App.runMutation(() => Store.commitExactMoneyMigration(preview), {
      onSuccess: () => {
        App.refreshAllViews(); App.switchView('data-health');
        App.announceStatus('Exact-money storage is active. Ledger values were unchanged.');
        requestAnimationFrame(() => document.getElementById('exact-money-migration-heading').focus({ preventScroll: true }));
      },
      onFailure: () => { this.render(); }
    });
  },

  moneyPrecisionDisclosure(audit) {
    const flagged = audit.subCentValueCount > 0;
    const details = this.node('details', 'money-precision-audit');
    details.append(this.node('summary', '', flagged ? 'Money precision needs review' : 'Money precision'));
    const content = this.node('div', 'money-precision-content');
    content.append(this.node('p', '', flagged
      ? `${audit.subCentValueCount} stored money values include digits smaller than one cent across ${audit.affectedMonthCount} months and ${audit.affectedTemplateCount} templates. Warm Ledger has not changed or rounded them.`
      : `All ${audit.scannedValueCount} stored money values use whole-cent precision.`));
    content.append(this.node('p', 'muted-text',
      'This check cannot determine whether sub-cent digits were intentional or came from earlier calculations or imports. Keep a current JSON backup. Exact-money storage and any conversion workflow require a separate reviewed migration.'));
    details.append(content); return details;
  },

  localStoragePrivacySection() {
    const section = this.section('Local storage & privacy',
      'Warm Ledger stores active data, local safety snapshots, and preserved corrupt bytes as readable local browser data. Downloaded JSON backups and browser-evidence files are also readable unless manually deleted.');
    const warning = this.node('p', 'muted-text',
      'Purge removes the active budget, local safety snapshots, and preserved recovery bytes from this browser only. Downloaded files are not removed.');
    const button = this.node('button', 'btn btn-danger', 'Review local data purge'); button.type = 'button'; button.id = 'review-local-data-purge';
    button.addEventListener('click', () => this.previewPurge(button)); section.append(warning, button); return section;
  },

  previewPurge(trigger) {
    try {
      this.purgePreview = Store.previewLocalDataPurge();
      const preview = this.purgePreview;
      App.showModal({ title: 'Purge local Warm Ledger data?', submitLabel: 'Purge local data',
        initialFocus: () => document.getElementById('modal-cancel'),
        buildBody: () => {
          const warning = this.node('p', '', 'Purge removes the active budget, local safety snapshots, and preserved recovery bytes from this browser only.');
          const list = this.node('ul', 'preview-list');
          [['Active budget', preview.activeDataPresent ? 'Present' : 'Not present'],
            ['Local safety snapshots', String(preview.snapshotCount)],
            ['Preserved recovery bytes', preview.corruptEvidencePresent ? 'Present' : 'Not present']].forEach(([label, value]) => {
            const item = this.node('li'); item.append(this.node('span', '', label), this.node('strong', '', value)); list.append(item);
          });
          return ModalView.fragment(warning, list, this.node('p', 'muted-text', 'Downloaded backups and browser-evidence files must be deleted manually.'));
        },
        onSave: () => this.commitPurge()
      });
      App.modalTrigger = trigger; ModalView.trigger = trigger;
      document.getElementById('modal-save').className = 'btn btn-danger';
    } catch (error) { this.purgePreview = null; App.showError(error); trigger.focus(); }
  },

  commitPurge() {
    const preview = this.purgePreview; this.purgePreview = null;
    return App.runMutation(() => Store.commitLocalDataPurge(preview), {
      onSuccess: () => {
        App.clearExpenseUndo(); App.refreshAllViews();
        document.getElementById('last-saved').textContent = 'Not saved yet';
        App.announceStatus('Local Warm Ledger data was removed from this browser. Restore a backup or start fresh to continue.');
        requestAnimationFrame(() => document.getElementById('current-month-label')?.focus({ preventScroll: true }));
      },
      onFailure: () => { this.render(); }
    });
  },

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
