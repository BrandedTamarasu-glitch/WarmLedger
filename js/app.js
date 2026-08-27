// Main app - routing, modal, import/export

const App = {
  currentView: 'budget',

  init() {
    Store.load();
    BudgetView.init();
    TransfersView.init();
    DashboardView.init();

    // Nav tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchView(tab.dataset.view));
    });

    // Export / Import
    document.getElementById('btn-export').addEventListener('click', () => this.exportData());
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', (e) => this.importData(e));

    // Modal close
    document.getElementById('modal-close').addEventListener('click', () => this.hideModal());
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideModal();
    });
  },

  switchView(view) {
    this.currentView = view;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));

    if (view === 'transfers') {
      TransfersView.syncMonth();
      TransfersView.render();
    } else if (view === 'dashboard') {
      DashboardView.render();
    }
  },

  // Modal
  showModal(title, bodyHtml, onSave) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-overlay').style.display = 'flex';

    const saveBtn = document.getElementById('modal-save');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.id = 'modal-save';

    newSaveBtn.addEventListener('click', () => {
      onSave();
      this.hideModal();
    });

    // Focus first input
    setTimeout(() => {
      const firstInput = document.querySelector('#modal-body input, #modal-body select');
      if (firstInput) firstInput.focus();
    }, 50);
  },

  hideModal() {
    document.getElementById('modal-overlay').style.display = 'none';
  },

  // Export — downloads both a JSON backup and a saved-data.js you drop back into js/
  exportData() {
    const data = Store.exportData();

    // 1. Download saved-data.js (drop into js/ folder to persist across browser clears)
    const seedContent = '// Auto-generated budget data — drop this file into js/ to persist data.\n'
      + '// Generated: ' + new Date().toISOString() + '\n\n'
      + 'window.BUDGET_SEED_DATA = ' + data + ';\n';
    this._download(seedContent, 'saved-data.js', 'application/javascript');

    // 2. Also download JSON backup
    setTimeout(() => {
      this._download(data, `budget-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    }, 500);
  },

  _download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  // Import
  importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        Store.importData(ev.target.result);
        BudgetView.render();
        alert('Budget data imported successfully!');
      } catch (err) {
        alert('Error importing data: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
