(function(root, factory) {
  'use strict';
  const Schema = root && root.ZeroBudgetSchema ? root.ZeroBudgetSchema
    : (typeof require === 'function' ? require('./data-schema.js') : null);
  const Recurrence = root && root.ZeroBudgetRecurrence ? root.ZeroBudgetRecurrence
    : (typeof require === 'function' ? require('./recurrence.js') : null);
  const DataHealth = root && root.ZeroBudgetDataHealth ? root.ZeroBudgetDataHealth
    : (typeof require === 'function' ? require('./data-health.js') : null);
  const api = factory(Schema, Recurrence, DataHealth);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.localStorage) {
    root.ZeroBudgetStore = api;
    root.Store = api.createStore({
      storage: root.localStorage,
      now: () => new Date(),
      uuid: () => root.crypto.randomUUID()
    });
    root.ALLOCATION_TYPES = api.ALLOCATION_TYPES;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Schema, Recurrence, DataHealth) {
  'use strict';
  if (!Schema) throw new Error('ZeroBudgetSchema is required');

  const STORAGE_KEY = 'zeroBudget_data';
  const CORRUPT_KEY = 'zeroBudget_corrupt';
  const SNAPSHOT_PREFIX = 'zeroBudget_snapshot:';
  const SNAPSHOT_LIMIT = 7;
  const ALLOCATION_TYPES = Object.freeze([
    Object.freeze({ key: 'savings', label: 'Savings' }),
    Object.freeze({ key: 'credit_card_debt', label: 'Credit Card Debt' }),
    Object.freeze({ key: 'investments', label: 'Investments' })
  ]);
  const EMPTY_ALLOCATIONS = Object.freeze({ savings: 0, credit_card_debt: 0, investments: 0 });
  const GENERIC_CATEGORY_NAMES = Object.freeze([
    'Housing', 'Transportation', 'Insurance', 'Food', 'Pets', 'Personal Care',
    'Miscellaneous', 'Debt', 'Taxes', 'Subscriptions', 'Other'
  ]);
  const GENERIC_EARNER_NAMES = Object.freeze(['Primary', 'Secondary']);
  const FUNDING_TOLERANCE = 0.009;
  const FUNDING_EPSILON = Number.EPSILON * 64;

  function fundingDirection(value) {
    if (value > FUNDING_TOLERANCE + FUNDING_EPSILON) return 1;
    if (value < -FUNDING_TOLERANCE - FUNDING_EPSILON) return -1;
    return 0;
  }

  class StoreError extends Error {
    constructor(code) {
      super(`Budget storage error (${code})`);
      this.name = 'StoreError';
      this.code = code;
    }
  }

  function storageError(code) {
    return new StoreError(code);
  }

  function emptyMonth() {
    return { paychecks: [], expenses: [], allocations: { ...EMPTY_ALLOCATIONS }, suppressedOccurrences: [] };
  }

  function defaultData() {
    const result = {
      schemaVersion: 3,
      categories: GENERIC_CATEGORY_NAMES.map((name, index) => ({
        id: `default-category-${String(index + 1).padStart(4, '0')}`,
        name,
        archived: false,
        items: []
      })),
      settings: { earners: GENERIC_EARNER_NAMES.map((name, index) => ({
        id: `default-earner-${String(index + 1).padStart(4, '0')}`,
        name,
        archived: false
      })) },
      templates: { income: [], expenses: [] },
      months: {}
    };
    return result;
  }

  function freezeDetached(value) {
    const detached = Schema.clone(value);
    const freeze = item => {
      if (item && typeof item === 'object' && !Object.isFrozen(item)) {
        Object.values(item).forEach(freeze);
        Object.freeze(item);
      }
      return item;
    };
    return freeze(detached);
  }

  function stableCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function semanticEqual(left, right) {
    return stableCanonical(left) === stableCanonical(right);
  }

  function localDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function firstDayOfMonth(monthKey) { return `${monthKey}-01`; }
  function normalizeMonthlyDate(monthKey, date) { return date === '' ? firstDayOfMonth(monthKey) : date; }

  function createStore({ storage, now = () => new Date(), uuid = () => crypto.randomUUID(), schemaPolicy = Schema.ACTIVE_SCHEMA_POLICY } = {}) {
    if (schemaPolicy !== Schema.ACTIVE_SCHEMA_POLICY && schemaPolicy !== Schema.V3_SCHEMA_POLICY) {
      throw new StoreError('INVALID_SCHEMA_POLICY');
    }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new StoreError('STORAGE_UNAVAILABLE');
    }
    if (typeof now !== 'function' || typeof uuid !== 'function') throw new StoreError('INVALID_ADAPTER');
    const previewCapabilities = new WeakMap();
    const deleteReceipts = new WeakMap();
    const actualResolutionCapabilities = new WeakMap();
    const defaultDateResolutionCapabilities = new WeakMap();

    let data = null;
    let committedRaw = null;
    let loadState = 'unloaded';
    let corruptEvidence = null;
    let generation = 0;
    let snapshotSequence = 0;
    let warnings = [];

    function warn(code) {
      if (!warnings.includes(code)) warnings.push(code);
    }

    function requireReady() {
      if (loadState === 'unloaded') load();
      if (loadState === 'recovery-required') throw new StoreError('RECOVERY_REQUIRED');
      if (!data) throw new StoreError('STORE_NOT_READY');
    }

    function read(key, code = 'STORAGE_READ_FAILED') {
      try { return storage.getItem(key); }
      catch (error) { throw storageError(code, error); }
    }

    function write(key, value, code) {
      try { storage.setItem(key, value); }
      catch (error) { throw storageError(code, error); }
    }

    function remove(key, code) {
      try { storage.removeItem(key); }
      catch (error) { throw storageError(code, error); }
    }

    function snapshotKeys() {
      const keys = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (typeof key === 'string' && key.startsWith(SNAPSHOT_PREFIX)) keys.push(key);
        }
      } catch (error) {
        throw storageError('SNAPSHOT_READ_FAILED', error);
      }
      return keys;
    }

    function safeSnapshotId() {
      let source;
      try { source = String(uuid()); }
      catch (error) { throw storageError('IDENTIFIER_GENERATION_FAILED', error); }
      snapshotSequence += 1;
      return `${encodeURIComponent(source)}-${snapshotSequence}`;
    }

    function instantNow() {
      try {
        const instant = now();
        if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('Invalid clock value');
        return instant;
      } catch (error) {
        throw storageError('CLOCK_FAILED', error);
      }
    }

    function snapshotRecords({ strict = false } = {}) {
      let keys;
      try { keys = snapshotKeys(); }
      catch (error) {
        if (strict) throw error;
        warn(error.code);
        return [];
      }
      const records = [];
      for (const key of keys) {
        try {
          const raw = read(key, 'SNAPSHOT_READ_FAILED');
          if (raw === null) continue;
          const envelope = schemaPolicy.parseSnapshot(raw);
          records.push({
            id: key.slice(SNAPSHOT_PREFIX.length), key,
            createdAt: envelope.createdAt, localDate: envelope.localDate,
            reason: envelope.reason, data: envelope.data
          });
        } catch (error) {
          if (error instanceof StoreError) {
            if (strict) throw error;
            warn(error.code);
          } else {
            warn('INVALID_SNAPSHOT_SKIPPED');
          }
        }
      }
      records.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      return records;
    }

    function createSnapshot(priorData, reason, { required = false } = {}) {
      const instant = instantNow();
      let envelope;
      try {
        envelope = schemaPolicy.buildSnapshot(priorData, {
          createdAt: instant.toISOString(), localDate: localDate(instant), reason
        });
      } catch (error) {
        if (error instanceof Schema.DataError) throw error;
        throw storageError('CLOCK_FAILED', error);
      }
      const key = SNAPSHOT_PREFIX + safeSnapshotId();
      try {
        write(key, JSON.stringify(envelope), 'SNAPSHOT_WRITE_FAILED');
        schemaPolicy.parseSnapshot(read(key, 'SNAPSHOT_READ_FAILED'));
      } catch (error) {
        try { remove(key, 'SNAPSHOT_CLEANUP_FAILED'); } catch { warn('SNAPSHOT_CLEANUP_FAILED'); }
        if (required) throw error;
        warn(error.code || 'SNAPSHOT_WRITE_FAILED');
        return null;
      }
      return key;
    }

    function maybeDailySnapshot(priorData) {
      if (committedRaw === null) return;
      let today;
      try { today = localDate(instantNow()); } catch { warn('CLOCK_FAILED'); return; }
      if (snapshotRecords().some(record => record.reason === 'daily' && record.localDate === today)) return;
      try { createSnapshot(priorData, 'daily'); }
      catch (error) { warn(error.code || 'SNAPSHOT_WRITE_FAILED'); }
    }

    function pruneSnapshots() {
      const records = snapshotRecords();
      for (const record of records.slice(SNAPSHOT_LIMIT)) {
        try { remove(record.key, 'SNAPSHOT_CLEANUP_FAILED'); }
        catch { warn('SNAPSHOT_CLEANUP_FAILED'); }
      }
    }

    function commitCandidate(candidate, { snapshotReason = null, requiredSnapshot = false, daily = true, prune = true } = {}) {
      requireReady();
      const canonical = schemaPolicy.migrateActive(candidate);
      const nextRaw = JSON.stringify(canonical);
      const priorData = schemaPolicy.clone(data);
      if (nextRaw === JSON.stringify(data)) return schemaPolicy.clone(data);
      if (snapshotReason && committedRaw !== null) {
        createSnapshot(priorData, snapshotReason, { required: requiredSnapshot });
      } else if (daily) {
        maybeDailySnapshot(priorData);
      }
      write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
      data = canonical;
      committedRaw = nextRaw;
      loadState = 'ready';
      corruptEvidence = null;
      generation += 1;
      if (prune) pruneSnapshots();
      return schemaPolicy.clone(data);
    }

    function transact(mutator, options) {
      requireReady();
      const candidate = schemaPolicy.clone(data);
      const result = mutator(candidate);
      commitCandidate(candidate, options);
      return result === undefined ? undefined : schemaPolicy.clone(result);
    }

    function preserveEvidence(raw) {
      corruptEvidence = raw;
      try { write(CORRUPT_KEY, raw, 'EVIDENCE_WRITE_FAILED'); }
      catch { warn('EVIDENCE_WRITE_FAILED'); }
    }

    function load() {
      warnings = [];
      let raw;
      try { raw = read(STORAGE_KEY); }
      catch (error) {
        data = null; committedRaw = null; corruptEvidence = null;
        loadState = 'recovery-required'; generation += 1;
        return { state: loadState, warnings: [error.code], hasEvidence: false, snapshots: listSnapshotMetadata() };
      }
      if (raw === null) {
        data = defaultData(); committedRaw = null; corruptEvidence = null;
        loadState = 'empty'; generation += 1;
        return { state: loadState, warnings: [], migrated: false };
      }
      try {
        const parsed = schemaPolicy.parseActive(raw);
        data = parsed; committedRaw = raw; corruptEvidence = null;
        loadState = 'ready'; generation += 1;
        return { state: loadState, warnings: [], migrated: raw !== JSON.stringify(parsed) };
      } catch {
        data = null; committedRaw = null; loadState = 'recovery-required'; generation += 1;
        preserveEvidence(raw);
        return {
          state: loadState, warnings: [...warnings], hasEvidence: true,
          snapshots: listSnapshotMetadata()
        };
      }
    }

    function getData() { requireReady(); return schemaPolicy.clone(data); }
    function getCategories({ includeArchived = false } = {}) {
      requireReady();
      return freezeDetached(data.categories.filter(category => includeArchived || !category.archived));
    }
    function getCategory(categoryId) {
      requireReady();
      const category = data.categories.find(item => item.id === categoryId);
      return category ? freezeDetached(category) : null;
    }
    function getCategoryItems(categoryId, { includeArchived = false } = {}) {
      requireReady();
      const category = data.categories.find(item => item.id === categoryId);
      if (!category) return [];
      return freezeDetached(category.items.filter(item => includeArchived || !item.archived));
    }
    function getCategoryItem(categoryId, itemId) {
      requireReady();
      const category = data.categories.find(item => item.id === categoryId);
      const item = category && category.items.find(entry => entry.id === itemId);
      return item ? freezeDetached(item) : null;
    }
    function getEarners({ includeArchived = false } = {}) {
      requireReady();
      return freezeDetached(data.settings.earners.filter(earner => includeArchived || !earner.archived));
    }
    function getEarner(earnerId) {
      requireReady();
      const earner = data.settings.earners.find(item => item.id === earnerId);
      return earner ? freezeDetached(earner) : null;
    }
    function getStructureUsage() {
      requireReady();
      const categoryExpenses = Object.create(null);
      const itemExpenses = Object.create(null);
      const earnerPaychecks = Object.create(null);
      for (const category of data.categories) {
        categoryExpenses[category.id] = 0;
        for (const item of category.items) itemExpenses[item.id] = 0;
      }
      for (const earner of data.settings.earners) earnerPaychecks[earner.id] = 0;
      for (const month of Object.values(data.months)) {
        for (const paycheck of month.paychecks) earnerPaychecks[paycheck.earnerId] += 1;
        for (const expense of month.expenses) {
          categoryExpenses[expense.categoryId] += 1;
          if (expense.categoryItemId !== null) itemExpenses[expense.categoryItemId] += 1;
        }
      }
      return freezeDetached({ categoryExpenses, itemExpenses, earnerPaychecks });
    }
    function peekMonth(monthKey) { requireReady(); return schemaPolicy.clone(data.months[monthKey] || emptyMonth()); }
    function ensureMonth(monthKey) {
      return transact(candidate => {
        if (!Object.hasOwn(candidate.months, monthKey)) candidate.months[monthKey] = emptyMonth();
        return candidate.months[monthKey];
      });
    }
    function requireMonth(candidate, monthKey) {
      if (!Object.hasOwn(candidate.months, monthKey)) candidate.months[monthKey] = emptyMonth();
      return candidate.months[monthKey];
    }
    function findOrThrow(items, id, code) {
      const item = items.find(entry => entry.id === id);
      if (!item) throw new StoreError(code);
      return item;
    }
    function newId() {
      try { return String(uuid()); }
      catch (error) { throw storageError('IDENTIFIER_GENERATION_FAILED', error); }
    }

    function patchOf(value, allowed) {
      requireReady();
      const patch = schemaPolicy.clone(value);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StoreError('INVALID_PATCH');
      const keys = Object.keys(patch);
      if (keys.length === 0) throw new StoreError('EMPTY_PATCH');
      if (keys.some(key => !allowed.includes(key))) throw new StoreError('FORBIDDEN_FIELD');
      return patch;
    }

    function activeEarner(candidate, id) {
      const earner = candidate.settings.earners.find(item => item.id === id);
      if (!earner) throw new StoreError('EARNER_NOT_FOUND');
      if (earner.archived) throw new StoreError('EARNER_ARCHIVED');
      return earner;
    }

    function activeCategory(candidate, id) {
      const category = candidate.categories.find(item => item.id === id);
      if (!category) throw new StoreError('CATEGORY_NOT_FOUND');
      if (category.archived) throw new StoreError('CATEGORY_ARCHIVED');
      return category;
    }

    function activeCategoryItem(category, id) {
      const item = category.items.find(entry => entry.id === id);
      if (!item) throw new StoreError('CATEGORY_ITEM_NOT_FOUND');
      if (item.archived) throw new StoreError('CATEGORY_ITEM_ARCHIVED');
      return item;
    }

    function applyExpenseStructure(expense, category, categoryItemId, customName) {
      expense.categoryId = category.id;
      expense.category = category.name;
      expense.categoryItemId = categoryItemId;
      if (categoryItemId === null) {
        if (typeof customName !== 'string' || customName.length === 0) throw new StoreError('EXPENSE_NAME_REQUIRED');
        expense.name = customName;
      } else {
        expense.name = activeCategoryItem(category, categoryItemId).name;
      }
    }

    function uniqueName(items, name, duplicateCode, exceptId = null) {
      if (items.some(item => item.id !== exceptId && item.name === name)) throw new StoreError(duplicateCode);
    }

    function orderedPermutation(input, items) {
      requireReady();
      const orderedIds = schemaPolicy.clone(input);
      if (!Array.isArray(orderedIds) || orderedIds.length !== items.length) throw new StoreError('INVALID_PERMUTATION');
      const expected = new Set(items.map(item => item.id));
      const received = new Set(orderedIds);
      if (received.size !== orderedIds.length || received.size !== expected.size ||
          orderedIds.some(id => !expected.has(id))) throw new StoreError('INVALID_PERMUTATION');
      const byId = new Map(items.map(item => [item.id, item]));
      return orderedIds.map(id => byId.get(id));
    }

    function addTombstone(month, record) {
      if (!record || record.sourceTemplateId === null || record.occurrenceKey === null) return;
      const exists = month.suppressedOccurrences.some(entry =>
        entry.sourceTemplateId === record.sourceTemplateId && entry.occurrenceKey === record.occurrenceKey);
      if (!exists) month.suppressedOccurrences.push({
        sourceTemplateId: record.sourceTemplateId, occurrenceKey: record.occurrenceKey
      });
    }

    function tombstoneGenerated(month) {
      const tombstones = schemaPolicy.clone(month.suppressedOccurrences);
      const holder = { suppressedOccurrences: tombstones };
      for (const record of [...month.paychecks, ...month.expenses]) addTombstone(holder, record);
      return tombstones;
    }

    function addCategory(input) {
      const patch = patchOf(input, ['name']);
      if (!Object.hasOwn(patch, 'name')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        uniqueName(candidate.categories, patch.name, 'DUPLICATE_CATEGORY_NAME');
        const category = { id: newId(), name: patch.name, archived: false, items: [] };
        candidate.categories.push(category);
        return category;
      });
    }

    function renameCategory(categoryId, name) {
      requireReady();
      const nextName = schemaPolicy.clone(name);
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        uniqueName(candidate.categories, nextName, 'DUPLICATE_CATEGORY_NAME', categoryId);
        category.name = nextName;
        return category;
      });
    }

    function setCategoryArchived(categoryId, archived) {
      requireReady();
      if (typeof archived !== 'boolean') throw new StoreError('INVALID_ARCHIVE_STATE');
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        if (archived && !category.archived && candidate.categories.filter(item => !item.archived).length === 1) {
          throw new StoreError('LAST_ACTIVE_CATEGORY');
        }
        category.archived = archived;
        return category;
      });
    }

    function reorderCategories(orderedIds) {
      requireReady();
      return transact(candidate => {
        candidate.categories = orderedPermutation(orderedIds, candidate.categories);
        return candidate.categories;
      });
    }

    function addCategoryItem(categoryId, input) {
      const patch = patchOf(input, ['name']);
      if (!Object.hasOwn(patch, 'name')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        const item = { id: newId(), name: patch.name, archived: false };
        category.items.push(item);
        return item;
      });
    }

    function renameCategoryItem(categoryId, itemId, name) {
      requireReady();
      const nextName = schemaPolicy.clone(name);
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        const item = findOrThrow(category.items, itemId, 'CATEGORY_ITEM_NOT_FOUND');
        item.name = nextName;
        return item;
      });
    }

    function setCategoryItemArchived(categoryId, itemId, archived) {
      requireReady();
      if (typeof archived !== 'boolean') throw new StoreError('INVALID_ARCHIVE_STATE');
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        const item = findOrThrow(category.items, itemId, 'CATEGORY_ITEM_NOT_FOUND');
        item.archived = archived;
        return item;
      });
    }

    function reorderCategoryItems(categoryId, orderedIds) {
      requireReady();
      return transact(candidate => {
        const category = findOrThrow(candidate.categories, categoryId, 'CATEGORY_NOT_FOUND');
        category.items = orderedPermutation(orderedIds, category.items);
        return category.items;
      });
    }

    function addEarner(input) {
      const patch = patchOf(input, ['name']);
      if (!Object.hasOwn(patch, 'name')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        uniqueName(candidate.settings.earners, patch.name, 'DUPLICATE_EARNER_NAME');
        const earner = { id: newId(), name: patch.name, archived: false };
        candidate.settings.earners.push(earner);
        return earner;
      });
    }

    function renameEarner(earnerId, name) {
      requireReady();
      const nextName = schemaPolicy.clone(name);
      return transact(candidate => {
        const earner = findOrThrow(candidate.settings.earners, earnerId, 'EARNER_NOT_FOUND');
        uniqueName(candidate.settings.earners, nextName, 'DUPLICATE_EARNER_NAME', earnerId);
        earner.name = nextName;
        return earner;
      });
    }

    function setEarnerArchived(earnerId, archived) {
      requireReady();
      if (typeof archived !== 'boolean') throw new StoreError('INVALID_ARCHIVE_STATE');
      return transact(candidate => {
        const earner = findOrThrow(candidate.settings.earners, earnerId, 'EARNER_NOT_FOUND');
        if (archived && !earner.archived && candidate.settings.earners.filter(item => !item.archived).length === 1) {
          throw new StoreError('LAST_ACTIVE_EARNER');
        }
        earner.archived = archived;
        return earner;
      });
    }

    function reorderEarners(orderedIds) {
      requireReady();
      return transact(candidate => {
        candidate.settings.earners = orderedPermutation(orderedIds, candidate.settings.earners);
        return candidate.settings.earners;
      });
    }

    function templateList(kind) {
      requireReady();
      return data.templates[kind];
    }
    function getIncomeTemplates() { return freezeDetached(templateList('income')); }
    function getExpenseTemplates() { return freezeDetached(templateList('expenses')); }
    function getIncomeTemplate(id) {
      const value = templateList('income').find(item => item.id === id);
      return value ? freezeDetached(value) : null;
    }
    function getExpenseTemplate(id) {
      const value = templateList('expenses').find(item => item.id === id);
      return value ? freezeDetached(value) : null;
    }

    const TEMPLATE_COMMON = ['name', 'plannedAmount', 'enabled', 'startDate', 'endDate', 'recurrence'];
    function addTemplate(kind, input) {
      const structural = kind === 'income' ? ['earnerId'] : ['categoryId', 'categoryItemId', 'paymentMethod'];
      const patch = patchOf(input, [...TEMPLATE_COMMON, ...structural]);
      if ([...TEMPLATE_COMMON, ...structural].some(key => !Object.hasOwn(patch, key))) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        if (kind === 'income') activeEarner(candidate, patch.earnerId);
        else {
          const category = activeCategory(candidate, patch.categoryId);
          if (patch.categoryItemId !== null) activeCategoryItem(category, patch.categoryItemId);
        }
        const created = { id: newId(), ...patch, archived: false };
        candidate.templates[kind].push(created);
        return created;
      });
    }
    function updateTemplate(kind, id, updates) {
      const structural = kind === 'income' ? ['earnerId'] : ['categoryId', 'categoryItemId', 'paymentMethod'];
      const patch = patchOf(updates, [...TEMPLATE_COMMON, ...structural]);
      return transact(candidate => {
        const current = findOrThrow(candidate.templates[kind], id, kind === 'income' ? 'INCOME_TEMPLATE_NOT_FOUND' : 'EXPENSE_TEMPLATE_NOT_FOUND');
        if (kind === 'income' && Object.hasOwn(patch, 'earnerId') && patch.earnerId !== current.earnerId) {
          activeEarner(candidate, patch.earnerId);
        }
        if (kind === 'expenses') {
          const nextCategoryId = Object.hasOwn(patch, 'categoryId') ? patch.categoryId : current.categoryId;
          const nextItemId = Object.hasOwn(patch, 'categoryItemId') ? patch.categoryItemId : current.categoryItemId;
          const changed = nextCategoryId !== current.categoryId || nextItemId !== current.categoryItemId;
          if (changed) {
            const category = activeCategory(candidate, nextCategoryId);
            if (nextItemId !== null) activeCategoryItem(category, nextItemId);
          }
        }
        Object.assign(current, patch);
        return current;
      });
    }
    function setTemplateArchived(kind, id, archived) {
      if (typeof archived !== 'boolean') throw new StoreError('INVALID_ARCHIVE_STATE');
      return transact(candidate => {
        const current = findOrThrow(candidate.templates[kind], id, kind === 'income' ? 'INCOME_TEMPLATE_NOT_FOUND' : 'EXPENSE_TEMPLATE_NOT_FOUND');
        current.archived = archived;
        return current;
      });
    }
    function reorderTemplates(kind, orderedIds) {
      return transact(candidate => {
        candidate.templates[kind] = orderedPermutation(orderedIds, candidate.templates[kind]);
        return candidate.templates[kind];
      });
    }
    const addIncomeTemplate = input => addTemplate('income', input);
    const addExpenseTemplate = input => addTemplate('expenses', input);
    const updateIncomeTemplate = (id, updates) => updateTemplate('income', id, updates);
    const updateExpenseTemplate = (id, updates) => updateTemplate('expenses', id, updates);
    const archiveIncomeTemplate = (id, archived) => setTemplateArchived('income', id, archived);
    const archiveExpenseTemplate = (id, archived) => setTemplateArchived('expenses', id, archived);
    const reorderIncomeTemplates = ids => reorderTemplates('income', ids);
    const reorderExpenseTemplates = ids => reorderTemplates('expenses', ids);

    function addPaycheck(monthKey, input) {
      const paycheck = patchOf(input, ['earnerId', 'plannedAmount', 'actualAmount', 'date']);
      const amountFieldsPresent = Object.hasOwn(paycheck, 'plannedAmount') && Object.hasOwn(paycheck, 'actualAmount');
      if (!Object.hasOwn(paycheck, 'earnerId') || !amountFieldsPresent || !Object.hasOwn(paycheck, 'date')) {
        throw new StoreError('MISSING_FIELD');
      }
      return transact(candidate => {
        const earner = activeEarner(candidate, paycheck.earnerId);
        const month = requireMonth(candidate, monthKey);
        const created = { id: newId(), earnerId: earner.id, earner: earner.name, plannedAmount: paycheck.plannedAmount,
          actualAmount: paycheck.actualAmount, date: normalizeMonthlyDate(monthKey, paycheck.date), sourceTemplateId: null, occurrenceKey: null };
        month.paychecks.push(created);
        return created;
      });
    }
    function updatePaycheck(monthKey, id, updates) {
      const patch = patchOf(updates, ['plannedAmount', 'actualAmount', 'date']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const paycheck = findOrThrow(month.paychecks, id, 'PAYCHECK_NOT_FOUND');
        if (Object.hasOwn(patch, 'date')) patch.date = normalizeMonthlyDate(monthKey, patch.date);
        Object.assign(paycheck, patch);
        return paycheck;
      });
    }
    function reassignPaycheckEarner(monthKey, id, earnerId) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const paycheck = findOrThrow(month.paychecks, id, 'PAYCHECK_NOT_FOUND');
        const earner = activeEarner(candidate, earnerId);
        paycheck.earnerId = earner.id; paycheck.earner = earner.name;
        return paycheck;
      });
    }
    function editPaycheck(monthKey, id, updates) {
      const patch = patchOf(updates, ['earnerId', 'plannedAmount', 'actualAmount', 'date']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const paycheck = findOrThrow(month.paychecks, id, 'PAYCHECK_NOT_FOUND');
        if (Object.hasOwn(patch, 'earnerId')) {
          const earner = activeEarner(candidate, patch.earnerId);
          paycheck.earnerId = earner.id; paycheck.earner = earner.name;
        }
        if (Object.hasOwn(patch, 'plannedAmount')) paycheck.plannedAmount = patch.plannedAmount;
        if (Object.hasOwn(patch, 'actualAmount')) paycheck.actualAmount = patch.actualAmount;
        if (Object.hasOwn(patch, 'date')) paycheck.date = normalizeMonthlyDate(monthKey, patch.date);
        return paycheck;
      });
    }
    function deletePaycheck(monthKey, id) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const index = month.paychecks.findIndex(paycheck => paycheck.id === id);
        if (index < 0) throw new StoreError('PAYCHECK_NOT_FOUND');
        const removed = month.paychecks[index];
        if (removed.sourceTemplateId !== null) addTombstone(month, removed);
        month.paychecks.splice(index, 1);
        for (const expense of month.expenses) delete expense.paycheckAmounts[id];
      });
    }
    function reorderPaychecks(monthKey, orderedIds) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        month.paychecks = orderedPermutation(orderedIds, month.paychecks);
        return month.paychecks;
      });
    }
    function addExpense(monthKey, input) {
      const expense = patchOf(input, ['categoryId', 'categoryItemId', 'name', 'date', 'paycheckAmounts', 'plannedAmount', 'actualAmount', 'paymentMethod']);
      if (!Object.hasOwn(expense, 'categoryId') || !Object.hasOwn(expense, 'categoryItemId') ||
          !Object.hasOwn(expense, 'paymentMethod') || !Object.hasOwn(expense, 'date') ||
          !Object.hasOwn(expense, 'plannedAmount') || !Object.hasOwn(expense, 'actualAmount')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        const category = activeCategory(candidate, expense.categoryId);
        const created = { id: newId() };
        applyExpenseStructure(created, category, expense.categoryItemId, expense.name);
        created.date = normalizeMonthlyDate(monthKey, expense.date);
        created.paycheckAmounts = expense.paycheckAmounts || {};
        created.plannedAmount = expense.plannedAmount;
        created.actualAmount = expense.actualAmount;
        created.paymentMethod = expense.paymentMethod;
        created.sourceTemplateId = null; created.occurrenceKey = null;
        requireMonth(candidate, monthKey).expenses.push(created);
        return created;
      });
    }
    function updateExpense(monthKey, id, updates) {
      const patch = patchOf(updates, ['name', 'date', 'plannedAmount', 'actualAmount', 'paymentMethod']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const expense = findOrThrow(month.expenses, id, 'EXPENSE_NOT_FOUND');
        if (Object.hasOwn(patch, 'name') && patch.name !== expense.name) {
          expense.name = patch.name;
          expense.categoryItemId = null;
        }
        if (Object.hasOwn(patch, 'date')) expense.date = normalizeMonthlyDate(monthKey, patch.date);
        if (Object.hasOwn(patch, 'plannedAmount')) expense.plannedAmount = patch.plannedAmount;
        if (Object.hasOwn(patch, 'actualAmount')) expense.actualAmount = patch.actualAmount;
        if (Object.hasOwn(patch, 'paymentMethod')) expense.paymentMethod = patch.paymentMethod;
        return expense;
      });
    }
    function reassignExpenseStructure(monthKey, id, structure) {
      const patch = patchOf(structure, ['categoryId', 'categoryItemId', 'name']);
      if (!Object.hasOwn(patch, 'categoryId') || !Object.hasOwn(patch, 'categoryItemId')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const expense = findOrThrow(month.expenses, id, 'EXPENSE_NOT_FOUND');
        applyExpenseStructure(expense, activeCategory(candidate, patch.categoryId), patch.categoryItemId, patch.name);
        return expense;
      });
    }
    function editExpense(monthKey, id, updates) {
      const patch = patchOf(updates, ['categoryId', 'categoryItemId', 'name', 'date', 'plannedAmount', 'actualAmount', 'paymentMethod']);
      const structural = Object.hasOwn(patch, 'categoryId') || Object.hasOwn(patch, 'categoryItemId');
      if (structural && (!Object.hasOwn(patch, 'categoryId') || !Object.hasOwn(patch, 'categoryItemId'))) {
        throw new StoreError('MISSING_FIELD');
      }
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const expense = findOrThrow(month.expenses, id, 'EXPENSE_NOT_FOUND');
        if (structural) applyExpenseStructure(expense, activeCategory(candidate, patch.categoryId), patch.categoryItemId, patch.name);
        else if (Object.hasOwn(patch, 'name') && patch.name !== expense.name) {
          expense.name = patch.name; expense.categoryItemId = null;
        }
        if (Object.hasOwn(patch, 'date')) expense.date = normalizeMonthlyDate(monthKey, patch.date);
        if (Object.hasOwn(patch, 'plannedAmount')) expense.plannedAmount = patch.plannedAmount;
        if (Object.hasOwn(patch, 'actualAmount')) expense.actualAmount = patch.actualAmount;
        if (Object.hasOwn(patch, 'paymentMethod')) expense.paymentMethod = patch.paymentMethod;
        return expense;
      });
    }
    function updateExpensePaycheckAmount(monthKey, expenseId, paycheckId, amount) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        if (!month.paychecks.some(paycheck => paycheck.id === paycheckId)) throw new StoreError('PAYCHECK_NOT_FOUND');
        const expense = findOrThrow(month.expenses, expenseId, 'EXPENSE_NOT_FOUND');
        expense.paycheckAmounts[paycheckId] = amount;
        return expense;
      });
    }
    function deleteExpense(monthKey, id) {
      const details = transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const index = month.expenses.findIndex(expense => expense.id === id);
        if (index < 0) throw new StoreError('EXPENSE_NOT_FOUND');
        const removed = month.expenses[index];
        const tombstone = removed.sourceTemplateId === null ? null : {
          sourceTemplateId: removed.sourceTemplateId, occurrenceKey: removed.occurrenceKey
        };
        const tombstoneCreated = tombstone !== null && !month.suppressedOccurrences.some(entry =>
          entry.sourceTemplateId === tombstone.sourceTemplateId && entry.occurrenceKey === tombstone.occurrenceKey);
        if (tombstoneCreated) month.suppressedOccurrences.push(tombstone);
        month.expenses.splice(index, 1);
        return { monthKey, index, removed, tombstone, tombstoneCreated };
      });
      const receipt = Object.freeze(Object.create(null));
      deleteReceipts.set(receipt, { generation, ...details });
      return receipt;
    }
    function undoDeleteExpense(receipt) {
      requireReady();
      const capability = receipt && typeof receipt === 'object' ? deleteReceipts.get(receipt) : null;
      if (receipt && typeof receipt === 'object') deleteReceipts.delete(receipt);
      if (!capability) throw new StoreError('INVALID_DELETE_RECEIPT');
      if (capability.generation !== generation) throw new StoreError('STALE_DELETE_RECEIPT');
      return transact(candidate => {
        const month = candidate.months[capability.monthKey];
        if (!month || capability.index < 0 || capability.index > month.expenses.length ||
            month.expenses.some(expense => expense.id === capability.removed.id)) {
          throw new StoreError('STALE_DELETE_RECEIPT');
        }
        if (capability.tombstoneCreated) {
          const matches = month.suppressedOccurrences.reduce((found, entry, index) =>
            entry.sourceTemplateId === capability.tombstone.sourceTemplateId &&
            entry.occurrenceKey === capability.tombstone.occurrenceKey ? [...found, index] : found, []);
          if (matches.length !== 1) throw new StoreError('STALE_DELETE_RECEIPT');
          month.suppressedOccurrences.splice(matches[0], 1);
        }
        month.expenses.splice(capability.index, 0, capability.removed);
        return capability.removed;
      });
    }
    function reorderExpenses(monthKey, orderedIds) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        month.expenses = orderedPermutation(orderedIds, month.expenses);
        return month.expenses;
      });
    }
    function updateAllocations(monthKey, allocations) {
      return transact(candidate => {
        const month = requireMonth(candidate, monthKey);
        month.allocations = schemaPolicy.clone(allocations);
        return month.allocations;
      });
    }
    function updateAllocation(monthKey, key, amount) {
      if (!ALLOCATION_TYPES.some(type => type.key === key)) throw new StoreError('INVALID_ALLOCATION_KEY');
      return transact(candidate => {
        const month = requireMonth(candidate, monthKey);
        month.allocations[key] = amount;
        return month.allocations;
      });
    }
    function copyFromMonth(targetKey, sourceKey) {
      return transact(candidate => {
        const source = candidate.months[sourceKey];
        if (!source) throw new StoreError('MONTH_NOT_FOUND');
        const priorTarget = candidate.months[targetKey];
        const suppressedOccurrences = priorTarget ? tombstoneGenerated(priorTarget) : [];
        const idMap = Object.create(null);
        const paychecks = source.paychecks.map(paycheck => {
          const id = newId(); idMap[paycheck.id] = id;
          return { ...paycheck, id, date: paycheck.date.startsWith(`${targetKey}-`) ? paycheck.date : firstDayOfMonth(targetKey),
            actualAmount: null, sourceTemplateId: null, occurrenceKey: null };
        });
        const expenses = source.expenses.map(expense => {
          const paycheckAmounts = {};
          for (const [paycheckId, amount] of Object.entries(expense.paycheckAmounts)) {
            if (idMap[paycheckId]) paycheckAmounts[idMap[paycheckId]] = amount;
          }
          return { ...expense, id: newId(), date: expense.date.startsWith(`${targetKey}-`) ? expense.date : firstDayOfMonth(targetKey),
            actualAmount: null, sourceTemplateId: null, occurrenceKey: null, paycheckAmounts };
        });
        candidate.months[targetKey] = { paychecks, expenses, allocations: { ...EMPTY_ALLOCATIONS } };
        candidate.months[targetKey].suppressedOccurrences = suppressedOccurrences;
        return candidate.months[targetKey];
      }, { snapshotReason: 'pre-reset', requiredSnapshot: committedRaw !== null, daily: false });
    }
    function clearMonth(monthKey) {
      return transact(candidate => {
        const replacement = emptyMonth();
        if (candidate.months[monthKey]) replacement.suppressedOccurrences = tombstoneGenerated(candidate.months[monthKey]);
        candidate.months[monthKey] = replacement;
        return candidate.months[monthKey];
      }, { snapshotReason: 'pre-reset', requiredSnapshot: committedRaw !== null, daily: false });
    }

    function classifyRecurring(canonical, monthKey) {
      if (!Recurrence) throw new StoreError('RECURRENCE_UNAVAILABLE');
      const monthMatch = /^(\d{4})-(\d{2})$/.exec(monthKey);
      if (!monthMatch) throw new StoreError('INVALID_MONTH');
      try { Recurrence.daysInMonth(Number(monthMatch[1]), Number(monthMatch[2])); }
      catch { throw new StoreError('INVALID_MONTH'); }
      const month = canonical.months[monthKey] || emptyMonth();
      const existing = new Set();
      const suppressed = new Set(month.suppressedOccurrences.map(item => `${item.sourceTemplateId}\u0000${item.occurrenceKey}`));
      const conflicts = [];
      for (const record of [...month.paychecks, ...month.expenses]) {
        if (record.sourceTemplateId === null) continue;
        const pair = `${record.sourceTemplateId}\u0000${record.occurrenceKey}`;
        if (existing.has(pair)) conflicts.push({ templateId: record.sourceTemplateId, occurrenceKey: record.occurrenceKey, reason: 'duplicate' });
        existing.add(pair);
      }
      const additions = { income: [], expenses: [] };
      const skips = [];
      for (const [kind, templates] of [['income', canonical.templates.income], ['expenses', canonical.templates.expenses]]) {
        for (const source of templates) {
          if (source.archived) { skips.push({ kind, templateId: source.id, name: source.name, reason: 'archived' }); continue; }
          if (!source.enabled) { skips.push({ kind, templateId: source.id, name: source.name, reason: 'disabled' }); continue; }
          const occurrences = Recurrence.occurrencesForMonth(source, monthKey);
          if (occurrences.length === 0) { skips.push({ kind, templateId: source.id, name: source.name, reason: 'out-of-range' }); continue; }
          for (const occurrence of occurrences) {
            const pair = `${source.id}\u0000${occurrence.occurrenceKey}`;
            const display = { kind, templateId: source.id, name: source.name, plannedAmount: source.plannedAmount,
              scheduledDate: occurrence.scheduledDate, occurrenceKey: occurrence.occurrenceKey };
            if (existing.has(pair)) skips.push({ ...display, reason: 'existing' });
            else if (suppressed.has(pair)) skips.push({ ...display, reason: 'suppressed' });
            else additions[kind].push(display);
          }
        }
      }
      return {
        monthKey, additions, skips, conflicts,
        counts: { additions: additions.income.length + additions.expenses.length, skips: skips.length, conflicts: conflicts.length }
      };
    }

    function recurringModel(monthKey) {
      return freezeDetached(classifyRecurring(data, monthKey));
    }

    function previewRecurringMonth(monthKey) {
      requireReady();
      const preview = recurringModel(monthKey);
      previewCapabilities.set(preview, { generation, monthKey, fingerprint: JSON.stringify(preview) });
      return preview;
    }

    function applyRecurringPreview(preview) {
      requireReady();
      const capability = preview && typeof preview === 'object' ? previewCapabilities.get(preview) : null;
      if (preview && typeof preview === 'object') previewCapabilities.delete(preview);
      if (!capability) throw new StoreError('INVALID_RECURRING_PREVIEW');
      if (capability.generation !== generation) throw new StoreError('STALE_RECURRING_PREVIEW');
      const current = recurringModel(capability.monthKey);
      if (JSON.stringify(current) !== capability.fingerprint) throw new StoreError('STALE_RECURRING_PREVIEW');
      if (current.conflicts.length > 0) throw new StoreError('RECURRING_CONFLICT');
      if (current.counts.additions === 0) return { addedIncome: 0, addedExpenses: 0 };
      const result = transact(candidate => {
        const month = requireMonth(candidate, capability.monthKey);
        for (const item of current.additions.income) {
          const source = findOrThrow(candidate.templates.income, item.templateId, 'INCOME_TEMPLATE_NOT_FOUND');
          const earner = candidate.settings.earners.find(entry => entry.id === source.earnerId);
          month.paychecks.push({
            id: newId(), earnerId: earner.id, earner: earner.name,
            plannedAmount: source.plannedAmount, actualAmount: null, date: item.scheduledDate,
            sourceTemplateId: source.id, occurrenceKey: item.occurrenceKey
          });
        }
        for (const item of current.additions.expenses) {
          const source = findOrThrow(candidate.templates.expenses, item.templateId, 'EXPENSE_TEMPLATE_NOT_FOUND');
          const category = candidate.categories.find(entry => entry.id === source.categoryId);
          month.expenses.push({
            id: newId(), categoryId: category.id, category: category.name,
            categoryItemId: source.categoryItemId, name: source.name, date: item.scheduledDate,
            paycheckAmounts: {}, plannedAmount: source.plannedAmount, actualAmount: null,
            paymentMethod: source.paymentMethod, sourceTemplateId: source.id, occurrenceKey: item.occurrenceKey
          });
        }
        return { addedIncome: current.additions.income.length, addedExpenses: current.additions.expenses.length };
      });
      return result;
    }

    function suppressedProjection(canonical, monthKey) {
      classifyRecurring(canonical, monthKey);
      const month = canonical.months[monthKey];
      if (!month) return [];
      const templates = new Map();
      canonical.templates.income.forEach(template => templates.set(template.id, { kind: 'income', template }));
      canonical.templates.expenses.forEach(template => templates.set(template.id, { kind: 'expense', template }));
      return month.suppressedOccurrences.map(entry => {
        const source = templates.get(entry.sourceTemplateId);
        const scheduledDate = entry.occurrenceKey.slice(0, 10);
        const ordinal = Number(entry.occurrenceKey.slice(11));
        let templateState;
        if (source.template.archived) templateState = 'archived';
        else if (!source.template.enabled) templateState = 'disabled';
        else if (scheduledDate < source.template.startDate ||
            (source.template.endDate !== null && scheduledDate > source.template.endDate)) templateState = 'out-of-range';
        else {
          const occurrences = Recurrence.occurrencesForMonth(source.template, monthKey);
          templateState = occurrences.some(item => item.occurrenceKey === entry.occurrenceKey) ? 'active' : 'schedule-changed';
        }
        return {
          kind: source.kind, sourceTemplateId: entry.sourceTemplateId, occurrenceKey: entry.occurrenceKey,
          scheduledDate, ordinal, templateName: source.template.name, templateState,
          eligible: templateState === 'active'
        };
      });
    }

    function getSuppressedOccurrences(monthKey) {
      requireReady();
      return freezeDetached(suppressedProjection(data, monthKey));
    }

    function getMonthReview(monthKey) {
      requireReady();
      const recurring = classifyRecurring(data, monthKey);
      const month = data.months[monthKey];
      const exists = Boolean(month);
      const current = month || emptyMonth();
      const allocationsTotal = Object.values(current.allocations).reduce((sum, amount) => sum + amount, 0);
      const plannedIncome = current.paychecks.reduce((sum, paycheck) => sum + paycheck.plannedAmount, 0);
      const enteredIncome = current.paychecks.reduce((sum, paycheck) => sum + (paycheck.actualAmount ?? 0), 0);
      const unresolvedIncome = current.paychecks.filter(paycheck => paycheck.actualAmount === null).map(paycheck => ({
        id: paycheck.id, earner: paycheck.earner, date: paycheck.date, plannedAmount: paycheck.plannedAmount
      }));
      const plannedExpenses = current.expenses.reduce((sum, expense) => sum + expense.plannedAmount, 0);
      const enteredExpenses = current.expenses.reduce((sum, expense) => sum + (expense.actualAmount ?? 0), 0);
      const unresolvedExpenses = current.expenses.filter(expense => expense.actualAmount === null).map(expense => ({
        id: expense.id, name: expense.name, category: expense.category, date: expense.date,
        plannedAmount: expense.plannedAmount
      }));
      const issues = [];
      for (const expense of current.expenses) {
        const assignedAmount = Object.values(expense.paycheckAmounts).reduce((sum, amount) => sum + amount, 0);
        const shortfall = expense.plannedAmount - assignedAmount;
        if (fundingDirection(shortfall) !== 0) issues.push({
          expenseId: expense.id, name: expense.name, category: expense.category,
          plannedAmount: expense.plannedAmount, assignedAmount, shortfall
        });
      }
      const paycheckAssignments = current.paychecks.map(paycheck => {
        const assignedAmount = current.expenses.reduce((sum, expense) =>
          sum + (expense.paycheckAmounts[paycheck.id] || 0), 0);
        return {
          paycheckId: paycheck.id, earner: paycheck.earner, plannedAmount: paycheck.plannedAmount,
          assignedAmount, remainingAmount: paycheck.plannedAmount - assignedAmount
        };
      });
      const pendingCount = recurring.counts.additions;
      const conflictCount = recurring.counts.conflicts;
      const suppressedCount = current.suppressedOccurrences.length;
      const empty = current.paychecks.length === 0 && current.expenses.length === 0 && allocationsTotal === 0;
      const needsRecurringReview = pendingCount > 0 || conflictCount > 0;
      const needsActuals = unresolvedIncome.length > 0 || unresolvedExpenses.length > 0;
      const needsAllocation = issues.length > 0;
      return freezeDetached({
        monthKey, exists, empty,
        states: {
          needsRecurringReview, needsActuals, needsAllocation,
          ready: exists && !empty && !needsRecurringReview && !needsActuals && !needsAllocation
        },
        income: {
          plannedTotal: plannedIncome, enteredActualTotal: enteredIncome,
          completeActualTotal: unresolvedIncome.length ? null : enteredIncome,
          unresolvedCount: unresolvedIncome.length, unresolved: unresolvedIncome
        },
        expenses: {
          plannedTotal: plannedExpenses, enteredActualTotal: enteredExpenses,
          completeActualTotal: unresolvedExpenses.length ? null : enteredExpenses,
          unresolvedCount: unresolvedExpenses.length, unresolved: unresolvedExpenses
        },
        funding: { issueCount: issues.length, issues },
        paycheckAssignments,
        balance: {
          allocationsTotal, plannedRemainder: plannedIncome - plannedExpenses - allocationsTotal,
          actualCashFlow: unresolvedIncome.length || unresolvedExpenses.length ? null : enteredIncome - enteredExpenses
        },
        recurring: { pendingCount, conflictCount, suppressedCount }
      });
    }

    function getPayPeriodPlan(monthKey) {
      requireReady();
      if (typeof monthKey !== 'string') throw new StoreError('INVALID_MONTH');
      const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
      if (!match) throw new StoreError('INVALID_MONTH');
      try { Recurrence.daysInMonth(Number(match[1]), Number(match[2])); }
      catch { throw new StoreError('INVALID_MONTH'); }
      const month = data.months[monthKey];
      const exists = Boolean(month);
      const current = month || emptyMonth();
      const methods = () => ({ bank: 0, credit_card: 0, savings: 0, investments: 0 });
      const expenseFunding = current.expenses.map(expense => {
        const fundedAcrossPaychecks = Object.values(expense.paycheckAmounts)
          .reduce((sum, amount) => sum + amount, 0);
        const rawRemaining = expense.plannedAmount - fundedAcrossPaychecks;
        const remainingDirection = fundingDirection(rawRemaining);
        const remainingToFund = remainingDirection > 0 ? rawRemaining : 0;
        const fundedPaycheckCount = Object.values(expense.paycheckAmounts)
          .filter(amount => amount > 0).length;
        let fundingState;
        if (remainingDirection > 0) fundingState = fundedAcrossPaychecks > 0
          ? 'partially-funded' : 'unfunded';
        else fundingState = 'fully-funded';
        return { expense, fundedAcrossPaychecks, remainingToFund, fundedPaycheckCount, fundingState };
      });
      const periods = current.paychecks.map((paycheck, index) => {
        const methodTotals = methods();
        const bills = [];
        let assignedTotal = 0;
        for (const funding of expenseFunding) {
          const amount = funding.expense.paycheckAmounts[paycheck.id] || 0;
          assignedTotal += amount;
          methodTotals[funding.expense.paymentMethod] += amount;
          if (amount <= 0) continue;
          bills.push({
            expenseId: funding.expense.id, name: funding.expense.name, category: funding.expense.category,
            date: funding.expense.date, paymentMethod: funding.expense.paymentMethod,
            plannedAmount: funding.expense.plannedAmount, fundedByThisPaycheck: amount,
            fundedAcrossPaychecks: funding.fundedAcrossPaychecks,
            remainingToFund: funding.remainingToFund,
            fundedPaycheckCount: funding.fundedPaycheckCount,
            splitAcrossPaychecks: funding.fundedPaycheckCount > 1,
            fundingState: funding.fundingState === 'partially-funded' ? 'partially-funded' : 'fully-funded'
          });
        }
        const plannedRemainder = paycheck.plannedAmount - assignedTotal;
        const remainderDirection = fundingDirection(plannedRemainder);
        const fundingState = remainderDirection > 0 ? 'remaining'
          : remainderDirection < 0 ? 'over-assigned' : 'balanced';
        return {
          number: index + 1, paycheckId: paycheck.id, earner: paycheck.earner, date: paycheck.date,
          plannedIncome: paycheck.plannedAmount, actualIncome: paycheck.actualAmount,
          bills, methodTotals, assignedTotal, plannedRemainder, fundingState
        };
      });
      const billsNeedingFunding = expenseFunding.filter(funding => funding.remainingToFund > 0).map(funding => ({
        expenseId: funding.expense.id, name: funding.expense.name, category: funding.expense.category,
        date: funding.expense.date, paymentMethod: funding.expense.paymentMethod,
        plannedAmount: funding.expense.plannedAmount, fundedAcrossPaychecks: funding.fundedAcrossPaychecks,
        remainingToFund: funding.remainingToFund, fundedPaycheckCount: funding.fundedPaycheckCount,
        fundingState: funding.fundingState
      }));
      const monthlyAllocationsTotal = Object.values(current.allocations).reduce((sum, amount) => sum + amount, 0);
      const monthlyAllocations = { ...current.allocations, total: monthlyAllocationsTotal };
      const plannedIncome = current.paychecks.reduce((sum, paycheck) => sum + paycheck.plannedAmount, 0);
      const actualIncomeEntered = current.paychecks.reduce((sum, paycheck) => sum + (paycheck.actualAmount ?? 0), 0);
      const actualIncomeMissingCount = current.paychecks.filter(paycheck => paycheck.actualAmount === null).length;
      const plannedBills = current.expenses.reduce((sum, expense) => sum + expense.plannedAmount, 0);
      const fundedAcrossPaychecks = expenseFunding.reduce((sum, funding) => sum + funding.fundedAcrossPaychecks, 0);
      const billsNeedingFundingAmount = billsNeedingFunding.reduce((sum, bill) => sum + bill.remainingToFund, 0);
      const paycheckFundingRemainder = plannedIncome - fundedAcrossPaychecks;
      const overAssignedAmount = periods.reduce((sum, period) =>
        sum + (fundingDirection(period.plannedRemainder) < 0 ? -period.plannedRemainder : 0), 0);
      const plannedBalance = plannedIncome - plannedBills - monthlyAllocationsTotal;
      const methodFundingTotals = methods();
      for (const period of periods) for (const method of Object.keys(methodFundingTotals)) {
        methodFundingTotals[method] += period.methodTotals[method];
      }
      const rawReconciliation = plannedBalance -
        (paycheckFundingRemainder - billsNeedingFundingAmount - monthlyAllocationsTotal);
      const reconciliationDifference = fundingDirection(rawReconciliation) !== 0
        ? rawReconciliation : 0;
      return freezeDetached({
        monthKey, exists, paycheckCount: current.paychecks.length, periods, billsNeedingFunding,
        monthlyAllocations,
        summary: {
          plannedIncome, actualIncomeEntered, actualIncomeMissingCount,
          actualIncomeComplete: actualIncomeMissingCount === 0,
          plannedBills, fundedAcrossPaychecks, billsNeedingFundingAmount, paycheckFundingRemainder,
          overAssignedAmount, monthlyAllocationsTotal, plannedBalance, reconciliationDifference,
          methodFundingTotals
        }
      });
    }

    function unsuppressOccurrence(monthKey, sourceTemplateId, occurrenceKey) {
      requireReady();
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const index = month.suppressedOccurrences.findIndex(entry =>
          entry.sourceTemplateId === sourceTemplateId && entry.occurrenceKey === occurrenceKey);
        if (index < 0) throw new StoreError('SUPPRESSED_OCCURRENCE_NOT_FOUND');
        const projection = suppressedProjection(candidate, monthKey)[index];
        if (!projection.eligible) throw new StoreError('SUPPRESSED_OCCURRENCE_INELIGIBLE');
        return month.suppressedOccurrences.splice(index, 1)[0];
      });
    }

    function expenseProjected(expense) {
      return expense.plannedAmount;
    }
    function calcMonthSummary(monthKey) {
      const month = peekMonth(monthKey);
      const totalIncome = month.paychecks.reduce((sum, paycheck) => sum + (paycheck.actualAmount ?? 0), 0);
      const totalProjected = month.expenses.reduce((sum, expense) => sum + expense.plannedAmount, 0);
      const totalActual = month.expenses.reduce((sum, expense) => sum + (expense.actualAmount ?? 0), 0);
      const totalAllocated = Object.values(month.allocations).reduce((sum, value) => sum + value, 0);
      const totalBudgeted = totalProjected + totalAllocated;
      const summary = { totalIncome, totalProjected, totalActual, totalAllocated, totalBudgeted, remaining: totalIncome - totalBudgeted };
      return {
        ...summary,
        totalPlannedIncome: month.paychecks.reduce((sum, paycheck) => sum + paycheck.plannedAmount, 0),
        totalActualIncome: totalIncome,
        unresolvedIncomeCount: month.paychecks.filter(paycheck => paycheck.actualAmount === null).length,
        totalPlannedExpenses: totalProjected,
        totalActualExpenses: totalActual,
        unresolvedExpenseCount: month.expenses.filter(expense => expense.actualAmount === null).length
      };
    }
    function calcPaycheckRemaining(monthKey, paycheckId) {
      const month = peekMonth(monthKey);
      const paycheck = month.paychecks.find(item => item.id === paycheckId);
      if (!paycheck) return 0;
      const assigned = month.expenses.reduce((sum, expense) => sum + (expense.paycheckAmounts[paycheckId] || 0), 0);
      return paycheck.plannedAmount - assigned;
    }
    function calcCategoryTotals(monthKey) {
      const totals = Object.create(null);
      for (const expense of peekMonth(monthKey).expenses) {
        if (!Object.hasOwn(totals, expense.category)) totals[expense.category] =
          { planned: 0, actual: 0, unresolvedCount: 0, projected: 0 };
        const planned = expense.plannedAmount;
        totals[expense.category].projected += planned;
        totals[expense.category].planned += planned;
        if (expense.actualAmount === null) totals[expense.category].unresolvedCount += 1;
        else totals[expense.category].actual += expense.actualAmount;
      }
      return totals;
    }
    function calcPaymentMethodTotals(monthKey, mode) {
      const totals = { bank: 0, credit_card: 0, savings: 0, investments: 0 };
      if (mode !== 'planned' && mode !== 'actual') throw new StoreError('INVALID_TOTAL_MODE');
      for (const expense of peekMonth(monthKey).expenses) {
        totals[expense.paymentMethod] += mode === 'planned' ? expense.plannedAmount : (expense.actualAmount ?? 0);
      }
      return totals;
    }
    function getAllMonthKeys() { requireReady(); return Object.keys(data.months).sort(); }

    function getDataHealth() {
      requireReady();
      if (!DataHealth) throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      return DataHealth.analyze(schemaPolicy.clone(data));
    }

    function getTemplateReadiness(options) {
      requireReady();
      if (!DataHealth || typeof DataHealth.buildTemplateReadiness !== 'function') {
        throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new StoreError('INVALID_REFERENCE_DATE');
      }
      try { return DataHealth.buildTemplateReadiness(schemaPolicy.clone(data), options.referenceDate); }
      catch { throw new StoreError('INVALID_REFERENCE_DATE'); }
    }

    function previewActualResolutions(proposals) {
      requireReady();
      let selections;
      try { selections = schemaPolicy.clone(proposals); }
      catch { throw new StoreError('INVALID_ACTUAL_RESOLUTIONS'); }
      if (!Array.isArray(selections) || selections.length === 0) throw new StoreError('INVALID_ACTUAL_RESOLUTIONS');
      const seen = new Set();
      const staged = schemaPolicy.clone(data);
      for (const item of selections) {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            !['income', 'expense'].includes(item.kind) || typeof item.monthKey !== 'string' ||
            typeof item.recordId !== 'string' || typeof item.actualAmount !== 'number' ||
            !Number.isFinite(item.actualAmount) || item.actualAmount < 0) throw new StoreError('INVALID_ACTUAL_RESOLUTIONS');
        const key = `${item.kind}\u0000${item.monthKey}\u0000${item.recordId}`;
        if (seen.has(key)) throw new StoreError('DUPLICATE_ACTUAL_RESOLUTION');
        seen.add(key);
        const month = data.months[item.monthKey];
        const records = month && (item.kind === 'income' ? month.paychecks : month.expenses);
        const record = records && records.find(entry => entry.id === item.recordId);
        if (!record) throw new StoreError('ACTUAL_RECORD_NOT_FOUND');
        if (record.actualAmount !== null) throw new StoreError('ACTUAL_ALREADY_RESOLVED');
        const stagedMonth = staged.months[item.monthKey];
        const stagedRecords = item.kind === 'income' ? stagedMonth.paychecks : stagedMonth.expenses;
        stagedRecords.find(entry => entry.id === item.recordId).actualAmount = item.actualAmount;
      }
      try { schemaPolicy.migrateActive(staged); }
      catch { throw new StoreError('INVALID_ACTUAL_RESOLUTIONS'); }
      const preview = freezeDetached({ generation, resolutions: selections });
      actualResolutionCapabilities.set(preview, { generation, fingerprint: JSON.stringify(selections), selections });
      return preview;
    }

    function applyActualResolutions(preview) {
      requireReady();
      const capability = preview && typeof preview === 'object' ? actualResolutionCapabilities.get(preview) : null;
      if (preview && typeof preview === 'object') actualResolutionCapabilities.delete(preview);
      if (!capability) throw new StoreError('INVALID_ACTUAL_RESOLUTION_PREVIEW');
      if (capability.generation !== generation) throw new StoreError('STALE_ACTUAL_RESOLUTION_PREVIEW');
      return transact(candidate => {
        for (const item of capability.selections) {
          const month = candidate.months[item.monthKey];
          const records = month && (item.kind === 'income' ? month.paychecks : month.expenses);
          const record = records && records.find(entry => entry.id === item.recordId);
          if (!record || record.actualAmount !== null) throw new StoreError('STALE_ACTUAL_RESOLUTION_PREVIEW');
          record.actualAmount = item.actualAmount;
        }
        return capability.selections;
      });
    }

    function previewDefaultDateResolutions() {
      requireReady();
      if (!DataHealth) throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      const resolutions = DataHealth.analyze(schemaPolicy.clone(data)).missingDates.map(reference => ({
        ...reference, date: firstDayOfMonth(reference.monthKey)
      }));
      const preview = freezeDetached({ generation, resolutions });
      defaultDateResolutionCapabilities.set(preview, { generation, resolutions });
      return preview;
    }

    function applyDefaultDateResolutions(preview) {
      requireReady();
      const capability = preview && typeof preview === 'object' ? defaultDateResolutionCapabilities.get(preview) : null;
      if (preview && typeof preview === 'object') defaultDateResolutionCapabilities.delete(preview);
      if (!capability) throw new StoreError('INVALID_DATE_RESOLUTION_PREVIEW');
      if (capability.generation !== generation) throw new StoreError('STALE_DATE_RESOLUTION_PREVIEW');
      return transact(candidate => {
        for (const item of capability.resolutions) {
          const month = candidate.months[item.monthKey];
          const records = month && (item.kind === 'income' ? month.paychecks : month.expenses);
          const record = records && records.find(entry => entry.id === item.recordId);
          if (!record || record.date !== '') throw new StoreError('STALE_DATE_RESOLUTION_PREVIEW');
          record.date = item.date;
        }
        return capability.resolutions;
      });
    }

    function compareAdditiveBackup(text) {
      requireReady();
      let incoming;
      try { incoming = schemaPolicy.parseBackup(text).data; }
      catch { throw new StoreError('INVALID_COMPARISON_BACKUP'); }
      const classifications = { identical: [], addable: [], conflicting: [] };
      for (const monthKey of Object.keys(incoming.months).sort()) {
        if (!Object.hasOwn(data.months, monthKey)) classifications.addable.push(monthKey);
        else if (semanticEqual(data.months[monthKey], incoming.months[monthKey])) classifications.identical.push(monthKey);
        else classifications.conflicting.push(monthKey);
      }
      const structure = {};
      const classifyArray = (current, candidate) => {
        if (semanticEqual(current, candidate)) return 'identical';
        if (candidate.length > current.length && current.every((item, index) =>
          semanticEqual(item, candidate[index]))) return 'addable';
        return 'conflicting';
      };
      for (const [name, current, candidate] of [
        ['categories', data.categories, incoming.categories],
        ['earners', data.settings.earners, incoming.settings.earners],
      ]) structure[name] = classifyArray(current, candidate);
      const incomeTemplates = classifyArray(data.templates.income, incoming.templates.income);
      const expenseTemplates = classifyArray(data.templates.expenses, incoming.templates.expenses);
      structure.templates = incomeTemplates === 'identical' && expenseTemplates === 'identical' ? 'identical'
        : ![incomeTemplates, expenseTemplates].includes('conflicting') ? 'addable' : 'conflicting';
      return freezeDetached({ structure, months: classifications, counts: {
        identical: classifications.identical.length, addable: classifications.addable.length,
        conflicting: classifications.conflicting.length,
        structuralConflicts: Object.values(structure).filter(value => value === 'conflicting').length
      } });
    }

    function buildExport() { requireReady(); return schemaPolicy.buildBackup(data, instantNow().toISOString()); }
    function exportData() { return JSON.stringify(buildExport(), null, 2); }
    function previewImport(text) {
      requireReady();
      let envelope;
      try { envelope = schemaPolicy.parseBackup(text); }
      catch { throw new StoreError('INVALID_IMPORT'); }
      const monthKeys = Object.keys(envelope.data.months).sort();
      return {
        generation, exportedAt: envelope.exportedAt, formatVersion: envelope.formatVersion,
        monthCount: monthKeys.length, firstMonth: monthKeys[0] || null,
        lastMonth: monthKeys.at(-1) || null, data: schemaPolicy.clone(envelope.data)
      };
    }
    function commitImport(preview) {
      requireReady();
      if (!preview || preview.generation !== generation) throw new StoreError('STALE_IMPORT_PREVIEW');
      let candidate;
      try { candidate = schemaPolicy.migrateActive(preview.data); }
      catch { throw new StoreError('INVALID_IMPORT'); }
      return commitCandidate(candidate, {
        snapshotReason: 'pre-import', requiredSnapshot: committedRaw !== null, daily: false
      });
    }
    function importData(text) { return commitImport(previewImport(text)); }
    function listSnapshots() {
      return snapshotRecords().slice(0, SNAPSHOT_LIMIT).map(record => ({
        id: record.id, createdAt: record.createdAt, localDate: record.localDate,
        reason: record.reason, data: schemaPolicy.clone(record.data)
      }));
    }
    function listSnapshotMetadata() {
      return listSnapshots().map(({ id, createdAt, localDate, reason }) => ({ id, createdAt, localDate, reason }));
    }
    function restoreSnapshot(id) {
      if (loadState === 'unloaded') load();
      if (typeof id !== 'string' || id.length === 0) throw new StoreError('SNAPSHOT_NOT_FOUND');
      const key = SNAPSHOT_PREFIX + id;
      let record;
      try {
        const raw = read(key, 'SNAPSHOT_READ_FAILED');
        if (raw === null) throw new StoreError('SNAPSHOT_NOT_FOUND');
        const envelope = schemaPolicy.parseSnapshot(raw);
        record = { data: envelope.data };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError('SNAPSHOT_NOT_FOUND');
      }
      if (loadState === 'recovery-required') {
        const canonical = schemaPolicy.migrateActive(record.data);
        const nextRaw = JSON.stringify(canonical);
        write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
        data = canonical; committedRaw = nextRaw; corruptEvidence = null;
        loadState = 'ready'; generation += 1;
        return schemaPolicy.clone(data);
      }
      requireReady();
      return commitCandidate(record.data, {
        snapshotReason: 'pre-import', requiredSnapshot: committedRaw !== null, daily: false
      });
    }
    function startFresh() {
      const candidate = defaultData();
      if (loadState === 'recovery-required') {
        const nextRaw = JSON.stringify(candidate);
        write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
        data = candidate; committedRaw = nextRaw; corruptEvidence = null;
        loadState = 'ready'; generation += 1; pruneSnapshots();
        return schemaPolicy.clone(data);
      }
      requireReady();
      return commitCandidate(candidate, {
        snapshotReason: 'pre-reset', requiredSnapshot: committedRaw !== null, daily: false
      });
    }
    function getCorruptEvidence() { return corruptEvidence; }
    function getStatus() {
      return { state: loadState, generation, hasEvidence: corruptEvidence !== null, warnings: [...warnings] };
    }

    return Object.freeze({
      load, getStatus, getData, getMonth: peekMonth, peekMonth, ensureMonth, getAllMonthKeys,
      getCategories, getCategory, getCategoryItems, getCategoryItem, getEarners, getEarner,
      getIncomeTemplates, getExpenseTemplates, getIncomeTemplate, getExpenseTemplate,
      getStructureUsage, addCategory, renameCategory, setCategoryArchived, reorderCategories,
      addCategoryItem, renameCategoryItem, setCategoryItemArchived, reorderCategoryItems,
      addEarner, renameEarner, setEarnerArchived, reorderEarners,
      addIncomeTemplate, updateIncomeTemplate, archiveIncomeTemplate,
      setIncomeTemplateArchived: archiveIncomeTemplate, reorderIncomeTemplates,
      addExpenseTemplate, updateExpenseTemplate, archiveExpenseTemplate,
      setExpenseTemplateArchived: archiveExpenseTemplate, reorderExpenseTemplates,
      expenseProjected, addPaycheck, updatePaycheck, reassignPaycheckEarner, editPaycheck, deletePaycheck, reorderPaychecks,
      addExpense, updateExpense,
      reassignExpenseStructure, editExpense,
      updateExpensePaycheckAmount, deleteExpense, undoDeleteExpense, reorderExpenses, updateAllocations, updateAllocation, copyFromMonth,
      clearMonth, previewRecurringMonth, applyRecurringPreview,
      getMonthReview, getPayPeriodPlan, getSuppressedOccurrences, unsuppressOccurrence,
      fundingDirection,
      getDataHealth, getTemplateReadiness, previewActualResolutions, applyActualResolutions, previewDefaultDateResolutions, applyDefaultDateResolutions, compareAdditiveBackup,
      calcMonthSummary, calcPaycheckRemaining, calcCategoryTotals, calcPaymentMethodTotals,
      buildExport, exportData, previewImport, commitImport, importData, listSnapshots,
      listSnapshotMetadata, restoreSnapshot, startFresh, getCorruptEvidence
    });
  }

  return Object.freeze({
    STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, SNAPSHOT_LIMIT,
    ALLOCATION_TYPES, StoreError, createStore
  });
});
