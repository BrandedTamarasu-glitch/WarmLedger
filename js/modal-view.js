// DOM-only modal presentation. Callers provide nodes, never markup strings.
const ModalView = {
  trigger: null,
  saveHandler: null,
  onClose: null,
  savePending: false,
  isOpen: false,

  element(tag, { id = '', className = '', text = '', attrs = {} } = {}, children = []) {
    const node = document.createElement(tag);
    if (id) node.id = id; if (className) node.className = className;
    if (text) node.textContent = text;
    Object.entries(attrs).forEach(([name, value]) => {
      if (typeof value === 'boolean') node[name] = value;
      else if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    });
    node.append(...children); return node;
  },

  input(id, type, attrs = {}) { return this.element('input', { id, attrs: { type, ...attrs } }); },
  option(value, text) { return this.element('option', { text, attrs: { value } }); },
  select(id, options = [], attrs = {}) {
    return this.element('select', { id, attrs }, options.map(([value, text]) => this.option(value, text)));
  },
  field(labelText, control, { id = '', className = 'form-group' } = {}) {
    const label = this.element('label', { text: labelText, attrs: { for: control.id } });
    return this.element('div', { id, className }, [label, control]);
  },
  fragment(...nodes) { const fragment = document.createDocumentFragment(); fragment.append(...nodes); return fragment; },

  open({ title, buildBody, onSave, onClose = null, submitLabel = 'Save', initialFocus = null }) {
    const body = buildBody();
    if (!(body instanceof Node)) throw new TypeError('Modal body must be a Node or DocumentFragment');
    this.trigger = document.activeElement;
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.isOpen = true;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').replaceChildren(body);
    const overlay = document.getElementById('modal-overlay');
    overlay.hidden = false;
    document.getElementById('application-shell').inert = true;
    const save = document.getElementById('modal-save');
    if (this.saveHandler) save.removeEventListener('click', this.saveHandler);
    save.textContent = submitLabel; save.className = 'btn btn-primary'; save.disabled = false;
    this.savePending = false;
    const handler = () => {
      if (this.saveHandler !== handler || this.savePending || save.disabled) return;
      this.savePending = true;
      save.disabled = true;
      let result;
      try {
        result = onSave();
      } catch (error) {
        this.savePending = false;
        save.disabled = false;
        throw error;
      }
      this.savePending = false;
      if (result === false) {
        save.disabled = false;
        if (this.saveHandler === handler) save.focus({ preventScroll: true });
        return;
      }
      this.close('confirm');
    };
    this.saveHandler = handler;
    save.addEventListener('click', handler);
    requestAnimationFrame(() => {
      const requested = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
      const first = document.querySelector('#modal-body input:not(:disabled), #modal-body select:not(:disabled), #modal-body textarea:not(:disabled), #modal-body button:not(:disabled)');
      (requested?.isConnected && !requested.disabled ? requested : first || document.getElementById('modal-cancel')).focus();
    });
  },

  close(reason = 'cancel') {
    if (!this.isOpen && document.getElementById('modal-overlay').hidden && !this.saveHandler) return;
    this.isOpen = false;
    const overlay = document.getElementById('modal-overlay');
    const save = document.getElementById('modal-save');
    const handler = this.saveHandler;
    if (handler) save.removeEventListener('click', handler);
    save.disabled = true;
    this.saveHandler = null;
    this.savePending = false;
    const onClose = this.onClose;
    this.onClose = null;
    overlay.hidden = true;
    const shell = document.getElementById('application-shell');
    if (!shell.hidden) shell.inert = false;
    try {
      if (onClose) onClose(reason);
    } finally {
      const trigger = this.trigger; this.trigger = null;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }
  },

  trapFocus(event) {
    const overlay = document.getElementById('modal-overlay');
    const controls = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(control => !control.disabled && !control.hidden);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!overlay.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  }
};
