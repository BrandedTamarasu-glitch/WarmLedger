(function(root, factory) {
  'use strict';
  const Schema = root && root.ZeroBudgetSchema ? root.ZeroBudgetSchema
    : (typeof require === 'function' ? require('./data-schema.js') : null);
  const Recurrence = root && root.ZeroBudgetRecurrence ? root.ZeroBudgetRecurrence
    : (typeof require === 'function' ? require('./recurrence.js') : null);
  const DataHealth = root && root.ZeroBudgetDataHealth ? root.ZeroBudgetDataHealth
    : (typeof require === 'function' ? require('./data-health.js') : null);
  const ExactMoney = root && root.ZeroBudgetExactMoney ? root.ZeroBudgetExactMoney
    : (typeof require === 'function' ? require('./exact-money.js') : null);
  const api = factory(Schema, Recurrence, DataHealth, ExactMoney);
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
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Schema, Recurrence, DataHealth, ExactMoney) {
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
  const TEMPLATE_ACTIVATION_SELECTION_LIMIT = 500;

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
    if (schemaPolicy !== Schema.ACTIVE_SCHEMA_POLICY && schemaPolicy !== Schema.V3_SCHEMA_POLICY &&
        schemaPolicy !== Schema.V4_SCHEMA_POLICY && schemaPolicy !== Schema.V5_SCHEMA_POLICY) {
      throw new StoreError('INVALID_SCHEMA_POLICY');
    }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new StoreError('STORAGE_UNAVAILABLE');
    }
    if (typeof now !== 'function' || typeof uuid !== 'function') throw new StoreError('INVALID_ADAPTER');
    const previewCapabilities = new WeakMap();
    const templateActivationCapabilities = new WeakMap();
    const deleteReceipts = new WeakMap();
    const actualResolutionCapabilities = new WeakMap();
    const defaultDateResolutionCapabilities = new WeakMap();
    const exactMoneyMigrationCapabilities = new WeakMap();

    let data = null;
    let committedRaw = null;
    let loadState = 'unloaded';
    let corruptEvidence = null;
    let generation = 0;
    let snapshotSequence = 0;
    let warnings = [];
    let residentSchemaVersion = schemaPolicy === Schema.ACTIVE_SCHEMA_POLICY
      ? Schema.V3_SCHEMA_VERSION : schemaPolicy.SCHEMA_VERSION;

    function policyForVersion(version) {
      if (schemaPolicy !== Schema.ACTIVE_SCHEMA_POLICY) return schemaPolicy;
      if (version === Schema.V5_SCHEMA_VERSION) return Schema.V5_SCHEMA_POLICY;
      if (version === Schema.V4_SCHEMA_VERSION) return Schema.V4_SCHEMA_POLICY;
      return Schema.V3_SCHEMA_POLICY;
    }

    function versionFromJson(text, fallback = Schema.V3_SCHEMA_VERSION) {
      try {
        const parsed = JSON.parse(text);
        const embedded = parsed && parsed.data ? parsed.data.schemaVersion : parsed && parsed.schemaVersion;
        if (embedded === Schema.V5_SCHEMA_VERSION) return Schema.V5_SCHEMA_VERSION;
        if (embedded === Schema.V4_SCHEMA_VERSION) return Schema.V4_SCHEMA_VERSION;
        return fallback;
      } catch { return fallback; }
    }

    function canonicalizeForWrite(version, runtimeData) { return Schema.buildActiveData(runtimeData, version); }

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
          const version = versionFromJson(raw);
          const envelope = policyForVersion(version).parseSnapshot(raw);
          records.push({
            id: key.slice(SNAPSHOT_PREFIX.length), key,
            createdAt: envelope.createdAt, localDate: envelope.localDate,
            reason: envelope.reason, data: envelope.data, residentSchemaVersion: version
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
        envelope = policyForVersion(residentSchemaVersion).buildSnapshot(priorData, {
          createdAt: instant.toISOString(), localDate: localDate(instant), reason
        });
      } catch (error) {
        if (error instanceof Schema.DataError) throw error;
        throw storageError('CLOCK_FAILED', error);
      }
      const key = SNAPSHOT_PREFIX + safeSnapshotId();
      try {
        write(key, JSON.stringify(envelope), 'SNAPSHOT_WRITE_FAILED');
        policyForVersion(residentSchemaVersion).parseSnapshot(read(key, 'SNAPSHOT_READ_FAILED'));
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

    function commitCandidate(candidate, { snapshotReason = null, requiredSnapshot = false, daily = true, prune = true,
      targetSchemaVersion = residentSchemaVersion } = {}) {
      requireReady();
      const persisted = canonicalizeForWrite(targetSchemaVersion, candidate);
      const canonical = targetSchemaVersion === Schema.V5_SCHEMA_VERSION
        ? Schema.hydrateV5ExactMoney(persisted)
        : targetSchemaVersion === Schema.V4_SCHEMA_VERSION
          ? Schema.hydrateV4ExactMoney(persisted) : policyForVersion(targetSchemaVersion).migrateActive(candidate);
      const nextRaw = JSON.stringify(persisted);
      const priorData = schemaPolicy.clone(data);
      if (nextRaw === committedRaw) return schemaPolicy.clone(data);
      if (snapshotReason && committedRaw !== null) {
        createSnapshot(priorData, snapshotReason, { required: requiredSnapshot });
      } else if (daily) {
        maybeDailySnapshot(priorData);
      }
      write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
      data = canonical;
      residentSchemaVersion = targetSchemaVersion;
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
        residentSchemaVersion = schemaPolicy === Schema.ACTIVE_SCHEMA_POLICY
          ? Schema.V3_SCHEMA_VERSION : schemaPolicy.SCHEMA_VERSION;
        loadState = 'empty'; generation += 1;
        return { state: loadState, warnings: [], migrated: false };
      }
      try {
        residentSchemaVersion = versionFromJson(raw);
        const parsed = policyForVersion(residentSchemaVersion).parseActive(raw);
        data = parsed; committedRaw = raw; corruptEvidence = null;
        loadState = 'ready'; generation += 1;
        const sourceSchemaVersion = JSON.parse(raw).schemaVersion;
        return { state: loadState, warnings: [],
          migrated: !Number.isInteger(sourceSchemaVersion) || sourceSchemaVersion < Schema.V3_SCHEMA_VERSION };
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
        if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) created.cleared = false;
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
        const resetCleared = residentSchemaVersion === Schema.V5_SCHEMA_VERSION &&
          ((Object.hasOwn(patch, 'actualAmount') && patch.actualAmount !== paycheck.actualAmount) ||
           (Object.hasOwn(patch, 'date') && patch.date !== paycheck.date));
        Object.assign(paycheck, patch);
        if (resetCleared) paycheck.cleared = false;
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
        if (Object.hasOwn(patch, 'actualAmount') && patch.actualAmount !== paycheck.actualAmount) {
          paycheck.actualAmount = patch.actualAmount;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) paycheck.cleared = false;
        }
        if (Object.hasOwn(patch, 'date')) {
          const date = normalizeMonthlyDate(monthKey, patch.date);
          if (date !== paycheck.date) {
            paycheck.date = date;
            if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) paycheck.cleared = false;
          }
        }
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
        if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) created.cleared = false;
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
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
        if (Object.hasOwn(patch, 'date')) {
          const date = normalizeMonthlyDate(monthKey, patch.date);
          if (date !== expense.date) {
            expense.date = date;
            if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
          }
        }
        if (Object.hasOwn(patch, 'plannedAmount')) expense.plannedAmount = patch.plannedAmount;
        if (Object.hasOwn(patch, 'actualAmount') && patch.actualAmount !== expense.actualAmount) {
          expense.actualAmount = patch.actualAmount;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
        if (Object.hasOwn(patch, 'paymentMethod') && patch.paymentMethod !== expense.paymentMethod) {
          expense.paymentMethod = patch.paymentMethod;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
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
        const priorName = expense.name;
        applyExpenseStructure(expense, activeCategory(candidate, patch.categoryId), patch.categoryItemId, patch.name);
        if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION && expense.name !== priorName) expense.cleared = false;
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
        if (structural) {
          const priorName = expense.name;
          applyExpenseStructure(expense, activeCategory(candidate, patch.categoryId), patch.categoryItemId, patch.name);
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION && expense.name !== priorName) expense.cleared = false;
        }
        else if (Object.hasOwn(patch, 'name') && patch.name !== expense.name) {
          expense.name = patch.name; expense.categoryItemId = null;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
        if (Object.hasOwn(patch, 'date')) {
          const date = normalizeMonthlyDate(monthKey, patch.date);
          if (date !== expense.date) {
            expense.date = date;
            if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
          }
        }
        if (Object.hasOwn(patch, 'plannedAmount')) expense.plannedAmount = patch.plannedAmount;
        if (Object.hasOwn(patch, 'actualAmount') && patch.actualAmount !== expense.actualAmount) {
          expense.actualAmount = patch.actualAmount;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
        if (Object.hasOwn(patch, 'paymentMethod') && patch.paymentMethod !== expense.paymentMethod) {
          expense.paymentMethod = patch.paymentMethod;
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) expense.cleared = false;
        }
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
            actualAmount: null, sourceTemplateId: null, occurrenceKey: null,
            ...(residentSchemaVersion === Schema.V5_SCHEMA_VERSION ? { cleared: false } : {}) };
        });
        const expenses = source.expenses.map(expense => {
          const paycheckAmounts = {};
          for (const [paycheckId, amount] of Object.entries(expense.paycheckAmounts)) {
            if (idMap[paycheckId]) paycheckAmounts[idMap[paycheckId]] = amount;
          }
          return { ...expense, id: newId(), date: expense.date.startsWith(`${targetKey}-`) ? expense.date : firstDayOfMonth(targetKey),
            actualAmount: null, sourceTemplateId: null, occurrenceKey: null, paycheckAmounts,
            ...(residentSchemaVersion === Schema.V5_SCHEMA_VERSION ? { cleared: false } : {}) };
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
            sourceTemplateId: source.id, occurrenceKey: item.occurrenceKey,
            ...(residentSchemaVersion === Schema.V5_SCHEMA_VERSION ? { cleared: false } : {})
          });
        }
        for (const item of current.additions.expenses) {
          const source = findOrThrow(candidate.templates.expenses, item.templateId, 'EXPENSE_TEMPLATE_NOT_FOUND');
          const category = candidate.categories.find(entry => entry.id === source.categoryId);
          month.expenses.push({
            id: newId(), categoryId: category.id, category: category.name,
            categoryItemId: source.categoryItemId, name: source.name, date: item.scheduledDate,
            paycheckAmounts: {}, plannedAmount: source.plannedAmount, actualAmount: null,
            paymentMethod: source.paymentMethod, sourceTemplateId: source.id, occurrenceKey: item.occurrenceKey,
            ...(residentSchemaVersion === Schema.V5_SCHEMA_VERSION ? { cleared: false } : {})
          });
        }
        return { addedIncome: current.additions.income.length, addedExpenses: current.additions.expenses.length };
      });
      return result;
    }

    function exactObject(value, keys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...keys].sort();
      return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
    }

    function activationSelections(request) {
      if (!exactObject(request, ['targetMonth', 'selections']) || typeof request.targetMonth !== 'string' ||
          !Array.isArray(request.selections) || request.selections.length === 0 ||
          request.selections.length > TEMPLATE_ACTIVATION_SELECTION_LIMIT) {
        throw new StoreError('INVALID_TEMPLATE_ACTIVATION_REQUEST');
      }
      const seen = new Set();
      const selections = request.selections.map(selection => {
        if (!exactObject(selection, ['kind', 'templateId']) ||
            (selection.kind !== 'income' && selection.kind !== 'expense') ||
            typeof selection.templateId !== 'string' || selection.templateId.length === 0) {
          throw new StoreError('INVALID_TEMPLATE_ACTIVATION_REQUEST');
        }
        const key = `${selection.kind}\u0000${selection.templateId}`;
        if (seen.has(key)) throw new StoreError('DUPLICATE_TEMPLATE_ACTIVATION_SELECTION');
        seen.add(key);
        return { kind: selection.kind, templateId: selection.templateId };
      });
      return { targetMonth: request.targetMonth, selections };
    }

    function selectedTemplate(canonical, selection) {
      const list = selection.kind === 'income' ? canonical.templates.income : canonical.templates.expenses;
      const template = list.find(item => item.id === selection.templateId);
      if (!template) throw new StoreError(selection.kind === 'income' ? 'INCOME_TEMPLATE_NOT_FOUND' : 'EXPENSE_TEMPLATE_NOT_FOUND');
      if (template.archived) throw new StoreError('TEMPLATE_ARCHIVED');
      if (template.enabled) throw new StoreError('TEMPLATE_ALREADY_ENABLED');
      return template;
    }

    function templateActivationModel(canonical, targetMonth, selections) {
      const hypothetical = schemaPolicy.clone(canonical);
      const selectedIds = new Set();
      const selected = selections.map(selection => {
        const template = selectedTemplate(hypothetical, selection);
        template.enabled = true;
        selectedIds.add(`${selection.kind === 'expense' ? 'expenses' : 'income'}\u0000${selection.templateId}`);
        return { kind: selection.kind, templateId: selection.templateId, name: template.name };
      });
      const recurring = classifyRecurring(hypothetical, targetMonth);
      const additions = {
        income: recurring.additions.income.filter(item => selectedIds.has(`income\u0000${item.templateId}`)),
        expenses: recurring.additions.expenses.filter(item => selectedIds.has(`expenses\u0000${item.templateId}`))
      };
      const skips = recurring.skips.filter(item => selectedIds.has(`${item.kind}\u0000${item.templateId}`));
      const templateIds = new Set(selections.map(item => item.templateId));
      const conflicts = recurring.conflicts.filter(item => templateIds.has(item.templateId));
      return freezeDetached({
        targetMonth, selected, additions, skips, conflicts,
        counts: {
          selected: selected.length,
          additions: additions.income.length + additions.expenses.length,
          skips: skips.length,
          conflicts: conflicts.length
        }
      });
    }

    function previewTemplateActivation(request) {
      requireReady();
      const parsed = activationSelections(request);
      const preview = templateActivationModel(data, parsed.targetMonth, parsed.selections);
      templateActivationCapabilities.set(preview, {
        generation,
        targetMonth: parsed.targetMonth,
        selections: parsed.selections,
        fingerprint: JSON.stringify(preview)
      });
      return preview;
    }

    function applyTemplateActivationPreview(preview) {
      requireReady();
      const capability = preview && typeof preview === 'object' ? templateActivationCapabilities.get(preview) : null;
      if (preview && typeof preview === 'object') templateActivationCapabilities.delete(preview);
      if (!capability) throw new StoreError('INVALID_TEMPLATE_ACTIVATION_PREVIEW');
      if (capability.generation !== generation) throw new StoreError('STALE_TEMPLATE_ACTIVATION_PREVIEW');
      const current = templateActivationModel(data, capability.targetMonth, capability.selections);
      if (JSON.stringify(current) !== capability.fingerprint) throw new StoreError('STALE_TEMPLATE_ACTIVATION_PREVIEW');
      if (current.conflicts.length > 0) throw new StoreError('TEMPLATE_ACTIVATION_CONFLICT');
      return transact(candidate => {
        for (const selection of capability.selections) selectedTemplate(candidate, selection).enabled = true;
        return { enabledIncome: capability.selections.filter(item => item.kind === 'income').length,
          enabledExpenses: capability.selections.filter(item => item.kind === 'expense').length };
      }, { daily: false, prune: false });
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

    function upcomingCivilWindow(anchorDate, dayCount) {
      if (typeof anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
        throw new StoreError('INVALID_ANCHOR_DATE');
      }
      if (![30, 60, 90].includes(dayCount)) throw new StoreError('INVALID_DAY_COUNT');
      const dates = [];
      try {
        for (let index = 0; index < dayCount; index++) dates.push(Recurrence.addCivilDays(anchorDate, index));
      } catch { throw new StoreError('INVALID_ANCHOR_DATE'); }
      return dates;
    }

    function getUpcomingBillsAndPaydays(request = {}) {
      requireReady();
      const anchorDate = request && typeof request === 'object' ? request.anchorDate : undefined;
      const dayCount = request && typeof request === 'object' ? request.dayCount : undefined;
      const dates = upcomingCivilWindow(anchorDate, dayCount);
      const endDate = dates[dates.length - 1];
      const dateGroupsByDate = new Map(dates.map(date => [date, { date, paydays: [], bills: [] }]));
      const monthKeys = [];
      for (const date of dates) {
        const monthKey = date.slice(0, 7);
        if (monthKeys[monthKeys.length - 1] !== monthKey) monthKeys.push(monthKey);
      }
      const coverage = monthKeys.map(monthKey => ({
        monthKey,
        state: data.months[monthKey] ? 'saved-plan' : 'no-saved-plan'
      }));
      const dateNeeded = [];
      let paydayCount = 0; let billCount = 0;
      let datedPaydayCount = 0; let datedBillCount = 0;
      let dateNeededPaydayCount = 0; let dateNeededBillCount = 0;

      for (const monthKey of monthKeys) {
        const month = data.months[monthKey];
        if (!month) continue;
        const paychecksById = new Map(month.paychecks.map(paycheck => [paycheck.id, paycheck]));
        const needed = { monthKey, paydays: [], bills: [] };
        for (const paycheck of month.paychecks) {
          const item = {
            paycheckId: paycheck.id, earner: paycheck.earner, date: paycheck.date,
            plannedAmount: paycheck.plannedAmount, actualAmount: paycheck.actualAmount,
            actualState: paycheck.actualAmount === null ? 'not-entered' : 'entered'
          };
          if (paycheck.date === '') { needed.paydays.push(item); dateNeededPaydayCount++; paydayCount++; }
          else if (dateGroupsByDate.has(paycheck.date)) {
            dateGroupsByDate.get(paycheck.date).paydays.push(item); datedPaydayCount++; paydayCount++;
          }
        }
        for (const expense of month.expenses) {
          let fundedAcrossPaychecks = 0;
          const fundingSources = [];
          for (const paycheck of month.paychecks) {
            const amount = expense.paycheckAmounts[paycheck.id] || 0;
            fundedAcrossPaychecks += amount;
            if (amount > 0) fundingSources.push({
              paycheckId: paycheck.id, earner: paycheck.earner, paycheckDate: paycheck.date, amount
            });
          }
          for (const [paycheckId, amount] of Object.entries(expense.paycheckAmounts)) {
            if (!paychecksById.has(paycheckId)) fundedAcrossPaychecks += amount;
          }
          const rawRemaining = expense.plannedAmount - fundedAcrossPaychecks;
          const remainingDirection = fundingDirection(rawRemaining);
          const fundingState = remainingDirection > 0
            ? (fundedAcrossPaychecks > 0 ? 'partially-funded' : 'unfunded') : 'fully-funded';
          const item = {
            expenseId: expense.id, name: expense.name, category: expense.category, date: expense.date,
            paymentMethod: expense.paymentMethod, plannedAmount: expense.plannedAmount,
            actualAmount: expense.actualAmount,
            actualState: expense.actualAmount === null ? 'not-entered' : 'entered',
            fundedAcrossPaychecks, remainingToFund: remainingDirection > 0 ? rawRemaining : 0,
            fundedPaycheckCount: fundingSources.length, splitAcrossPaychecks: fundingSources.length > 1,
            fundingState, fundingSources
          };
          if (expense.date === '') { needed.bills.push(item); dateNeededBillCount++; billCount++; }
          else if (dateGroupsByDate.has(expense.date)) {
            dateGroupsByDate.get(expense.date).bills.push(item); datedBillCount++; billCount++;
          }
        }
        if (needed.paydays.length || needed.bills.length) dateNeeded.push(needed);
      }
      return freezeDetached({
        anchorDate, endDate, dayCount, coverage, dateGroups: [...dateGroupsByDate.values()], dateNeeded,
        counts: {
          savedPlanMonthCount: coverage.filter(item => item.state === 'saved-plan').length,
          noSavedPlanMonthCount: coverage.filter(item => item.state === 'no-saved-plan').length,
          paydayCount, billCount, datedPaydayCount, datedBillCount,
          dateNeededPaydayCount, dateNeededBillCount
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

    function validateMonthKey(monthKey) {
      const match = typeof monthKey === 'string' && /^(\d{4})-(\d{2})$/.exec(monthKey);
      if (!match) throw new StoreError('INVALID_MONTH');
      try { Recurrence.daysInMonth(Number(match[1]), Number(match[2])); }
      catch { throw new StoreError('INVALID_MONTH'); }
      return monthKey;
    }

    function analysisData() {
      const result = schemaPolicy.clone(data);
      if (residentSchemaVersion !== Schema.V5_SCHEMA_VERSION) return result;
      for (const month of Object.values(result.months)) {
        month.paychecks.forEach(record => { delete record.cleared; });
        month.expenses.forEach(record => { delete record.cleared; });
      }
      return result;
    }

    function clearedChecklistItem(kind, record) {
      const actualEntered = record.actualAmount !== null;
      const dateEntered = record.date !== '';
      const eligible = actualEntered && dateEntered;
      const eligibilityReason = eligible ? null : !actualEntered && !dateEntered
        ? 'actual-and-date-needed' : !actualEntered ? 'actual-needed' : 'date-needed';
      return kind === 'income' ? {
        kind, recordId: record.id, earner: record.earner, date: record.date,
        actualAmount: record.actualAmount, cleared: record.cleared === true,
        eligible, eligibilityReason
      } : {
        kind, recordId: record.id, name: record.name, category: record.category,
        paymentMethod: record.paymentMethod, date: record.date,
        actualAmount: record.actualAmount, cleared: record.cleared === true,
        eligible, eligibilityReason
      };
    }

    function getClearedChecklist(monthKey) {
      requireReady();
      validateMonthKey(monthKey);
      const emptyCounts = { paycheckCount: 0, expenseCount: 0, eligibleCount: 0,
        ineligibleCount: 0, clearedCount: 0, unclearedCount: 0 };
      if (residentSchemaVersion === Schema.V3_SCHEMA_VERSION) return freezeDetached({
        monthKey, available: false, unavailableReason: 'exact-money-upgrade-required',
        items: { income: [], expenses: [] }, counts: emptyCounts
      });
      const month = data.months[monthKey] || emptyMonth();
      const income = month.paychecks.map(record => clearedChecklistItem('income', record));
      const expenses = month.expenses.map(record => clearedChecklistItem('expense', record));
      const items = [...income, ...expenses];
      const clearedCount = items.filter(item => item.cleared).length;
      const eligibleCount = items.filter(item => item.eligible).length;
      return freezeDetached({
        monthKey, available: true, unavailableReason: null, items: { income, expenses },
        counts: {
          paycheckCount: income.length, expenseCount: expenses.length, eligibleCount,
          ineligibleCount: items.length - eligibleCount, clearedCount,
          unclearedCount: items.length - clearedCount
        }
      });
    }

    function getMonthReadiness(monthKey) {
      requireReady();
      validateMonthKey(monthKey);
      const neutral = {
        monthKey, exists: false, available: false,
        unavailableReason: 'manual-clearing-format-required',
        status: 'unavailable', stateLabel: 'Open for editing',
        counts: { recordCount: 0, actualsMissing: 0, datesMissing: 0, notManuallyCleared: 0 },
        checks: { actualsComplete: false, datesComplete: false,
          manualClearingComplete: false, checklistComplete: false }
      };
      if (residentSchemaVersion !== Schema.V5_SCHEMA_VERSION) return freezeDetached(neutral);

      const exists = Object.hasOwn(data.months, monthKey);
      const month = data.months[monthKey];
      const records = exists ? [...month.paychecks, ...month.expenses] : [];
      const counts = {
        recordCount: records.length,
        actualsMissing: records.filter(record => record.actualAmount === null).length,
        datesMissing: records.filter(record => record.date === '').length,
        notManuallyCleared: records.filter(record => record.cleared !== true).length
      };
      const hasRecords = counts.recordCount > 0;
      const checks = {
        actualsComplete: hasRecords && counts.actualsMissing === 0,
        datesComplete: hasRecords && counts.datesMissing === 0,
        manualClearingComplete: hasRecords && counts.notManuallyCleared === 0,
        checklistComplete: hasRecords && counts.actualsMissing === 0 &&
          counts.datesMissing === 0 && counts.notManuallyCleared === 0
      };
      const status = !exists ? 'no-saved-month' : !hasRecords ? 'empty-month'
        : checks.checklistComplete ? 'checklist-complete' : 'needs-attention';
      return freezeDetached({
        monthKey, exists, available: true, unavailableReason: null,
        status, stateLabel: 'Open for editing', counts, checks
      });
    }

    function projectMonthAttention(monthKey) {
      requireReady();
      validateMonthKey(monthKey);
      const exists = Object.hasOwn(data.months, monthKey);
      const month = data.months[monthKey];
      const records = exists ? [...month.paychecks, ...month.expenses] : [];
      const empty = exists && records.length === 0;
      const manualClearing = residentSchemaVersion === Schema.V5_SCHEMA_VERSION;
      const counts = {
        actualsMissing: records.filter(record => record.actualAmount === null).length,
        datesMissing: records.filter(record => record.date === '').length,
        fundingIssues: exists ? month.expenses.filter(expense => fundingDirection(
          expense.plannedAmount - Object.values(expense.paycheckAmounts)
            .reduce((sum, amount) => sum + amount, 0)
        ) !== 0).length : 0,
        notManuallyCleared: manualClearing
          ? records.filter(record => record.cleared !== true).length : null
      };
      const attentionKinds = [];
      if (counts.actualsMissing > 0) attentionKinds.push('actuals');
      if (counts.datesMissing > 0) attentionKinds.push('dates');
      if (counts.fundingIssues > 0) attentionKinds.push('funding');
      if (manualClearing && counts.notManuallyCleared > 0) attentionKinds.push('manual-clearing');
      return {
        monthKey, exists, empty, counts,
        availability: { manualClearing }, attentionKinds,
        allApplicableFactsClear: exists && !empty && attentionKinds.length === 0
      };
    }

    function getMonthReviewQueue(request) {
      requireReady();
      const prototype = request && typeof request === 'object' && !Array.isArray(request)
        ? Object.getPrototypeOf(request) : undefined;
      const allowedKeys = ['anchorMonth', 'lookbackMonths'];
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          (prototype !== Object.prototype && prototype !== null) || !Object.hasOwn(request, 'anchorMonth') ||
          Reflect.ownKeys(request).some(key => typeof key !== 'string' || !allowedKeys.includes(key))) {
        throw new StoreError('INVALID_MONTH_REVIEW_QUEUE');
      }
      validateMonthKey(request.anchorMonth);
      const lookbackMonths = Object.hasOwn(request, 'lookbackMonths') ? request.lookbackMonths : 12;
      if (![6, 12, 24].includes(lookbackMonths)) throw new StoreError('INVALID_MONTH_REVIEW_LOOKBACK');

      const [anchorYear, anchorMonth] = request.anchorMonth.split('-').map(Number);
      const anchorIndex = anchorYear * 12 + anchorMonth - 1;
      const windowMonths = [];
      for (let offset = 0; offset < lookbackMonths; offset += 1) {
        const index = anchorIndex - offset;
        if (index < 0) continue;
        const year = Math.floor(index / 12);
        const month = index % 12 + 1;
        windowMonths.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
      }
      const saved = windowMonths.filter(monthKey => Object.hasOwn(data.months, monthKey))
        .map(monthKey => projectMonthAttention(monthKey));
      const items = saved.filter(item => !item.empty && item.attentionKinds.length > 0);
      const emptyMonths = saved.filter(item => item.empty).map(item => item.monthKey);
      return freezeDetached({
        anchorMonth: request.anchorMonth, lookbackMonths,
        coverage: {
          savedMonthCount: saved.length,
          emptyMonthCount: emptyMonths.length,
          monthsWithAttentionCount: items.length,
          savedMonthsClearCount: saved.filter(item => !item.empty && item.allApplicableFactsClear).length
        },
        items, emptyMonths
      });
    }

    function getNextReviewSteps(monthKey) {
      const attention = projectMonthAttention(monthKey);
      const review = getMonthReview(monthKey);
      const definitions = {
        actuals: { label: 'Enter actual amounts', routeTarget: 'budget-actuals' },
        dates: { label: 'Add record dates', routeTarget: 'budget-dates' },
        funding: { label: 'Review paycheck funding', routeTarget: 'budget-funding' },
        'manual-clearing': { label: 'Review manual cleared marks', routeTarget: 'manual-cleared-checklist' }
      };
      const countForKind = {
        actuals: attention.counts.actualsMissing,
        dates: attention.counts.datesMissing,
        funding: attention.counts.fundingIssues,
        'manual-clearing': attention.counts.notManuallyCleared
      };
      const stepOrder = ['dates', 'actuals', 'funding', 'manual-clearing'];
      const steps = stepOrder.filter(kind => attention.attentionKinds.includes(kind)).map(kind => ({
        kind, count: countForKind[kind], label: definitions[kind].label,
        routeTarget: definitions[kind].routeTarget
      }));
      if (review.states.needsRecurringReview) steps.unshift({
        kind: 'recurring', count: review.recurring.pendingCount + review.recurring.conflictCount,
        label: 'Preview recurring items', routeTarget: 'recurring-preview'
      });
      const status = !attention.exists ? 'no-saved-month' : attention.empty ? 'empty-month'
        : steps.length > 0 ? 'attention' : 'no-current-attention';
      return freezeDetached({
        monthKey, exists: attention.exists, empty: attention.empty,
        availability: attention.availability, status, steps,
        limitation: 'Local saved-data review aid only—not payment confirmation, bank verification, reconciliation, or month close.'
      });
    }

    function findSavedRecords(request) {
      requireReady();
      const allowedKeys = ['query', 'kind', 'fromMonth', 'toMonth', 'limit'];
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          !Object.hasOwn(request, 'query') ||
          Reflect.ownKeys(request).some(key => typeof key !== 'string' || !allowedKeys.includes(key))) {
        throw new StoreError('INVALID_SAVED_RECORD_SEARCH');
      }
      if (typeof request.query !== 'string') throw new StoreError('INVALID_SAVED_RECORD_QUERY');
      const query = request.query.trim();
      if (query.length < 1 || query.length > 120) throw new StoreError('INVALID_SAVED_RECORD_QUERY');
      const normalizedQuery = query.toLowerCase();
      const kind = Object.hasOwn(request, 'kind') ? request.kind : 'all';
      const fromMonth = Object.hasOwn(request, 'fromMonth') ? request.fromMonth : null;
      const toMonth = Object.hasOwn(request, 'toMonth') ? request.toMonth : null;
      const limit = Object.hasOwn(request, 'limit') ? request.limit : 200;
      if (!['all', 'income', 'expense'].includes(kind)) throw new StoreError('INVALID_SAVED_RECORD_KIND');
      if (fromMonth !== null) validateMonthKey(fromMonth);
      if (toMonth !== null) validateMonthKey(toMonth);
      if (fromMonth !== null && toMonth !== null && fromMonth > toMonth) {
        throw new StoreError('INVALID_MONTH_RANGE');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new StoreError('INVALID_SAVED_RECORD_LIMIT');
      }

      const matches = [];
      const monthKeys = Object.keys(data.months).sort()
        .filter(monthKey => (fromMonth === null || monthKey >= fromMonth) &&
          (toMonth === null || monthKey <= toMonth));
      for (const monthKey of monthKeys) {
        const month = data.months[monthKey];
        if (kind !== 'expense') for (const paycheck of month.paychecks) {
          if (!paycheck.earner.toLowerCase().includes(normalizedQuery)) continue;
          matches.push({
            kind: 'income', monthKey, recordId: paycheck.id,
            primaryLabel: paycheck.earner, secondaryLabel: 'Paycheck', date: paycheck.date,
            plannedAmount: paycheck.plannedAmount, actualAmount: paycheck.actualAmount,
            matchedFields: ['earner']
          });
        }
        if (kind !== 'income') for (const expense of month.expenses) {
          const matchedFields = [];
          if (expense.name.toLowerCase().includes(normalizedQuery)) matchedFields.push('name');
          if (expense.category.toLowerCase().includes(normalizedQuery)) matchedFields.push('category');
          if (matchedFields.length === 0) continue;
          matches.push({
            kind: 'expense', monthKey, recordId: expense.id,
            primaryLabel: expense.name, secondaryLabel: expense.category, date: expense.date,
            plannedAmount: expense.plannedAmount, actualAmount: expense.actualAmount,
            paymentMethod: expense.paymentMethod, matchedFields
          });
        }
      }
      const results = matches.slice(0, limit);
      return freezeDetached({
        query, normalizedQuery, filters: { kind, fromMonth, toMonth },
        totalMatchCount: matches.length, returnedCount: results.length,
        truncated: matches.length > results.length, results
      });
    }

    function setRecordCleared(request) {
      requireReady();
      if (!exactObject(request, ['monthKey', 'kind', 'recordId', 'cleared']) ||
          typeof request.monthKey !== 'string' || !['income', 'expense'].includes(request.kind) ||
          typeof request.recordId !== 'string' || request.recordId.length === 0 ||
          typeof request.cleared !== 'boolean') throw new StoreError('INVALID_CLEARED_REQUEST');
      validateMonthKey(request.monthKey);
      if (residentSchemaVersion === Schema.V3_SCHEMA_VERSION) throw new StoreError('CLEARED_CHECKLIST_UNAVAILABLE');
      const currentMonth = data.months[request.monthKey];
      if (!currentMonth) throw new StoreError('MONTH_NOT_FOUND');
      const currentRecords = request.kind === 'income' ? currentMonth.paychecks : currentMonth.expenses;
      const notFoundCode = request.kind === 'income' ? 'PAYCHECK_NOT_FOUND' : 'EXPENSE_NOT_FOUND';
      const current = findOrThrow(currentRecords, request.recordId, notFoundCode);
      const currentItem = clearedChecklistItem(request.kind, current);
      if (request.cleared && !currentItem.eligible) throw new StoreError('CLEARED_RECORD_INELIGIBLE');
      if (currentItem.cleared === request.cleared) return freezeDetached(currentItem);

      let candidate;
      let migrating = false;
      if (residentSchemaVersion === Schema.V4_SCHEMA_VERSION) {
        try {
          const persistedV4 = Schema.buildActiveData(data, Schema.V4_SCHEMA_VERSION);
          candidate = Schema.hydrateV5ExactMoney(Schema.migrateV4ToV5(persistedV4));
          migrating = true;
        } catch { throw new StoreError('CLEARED_MIGRATION_VALIDATION_FAILED'); }
      } else candidate = schemaPolicy.clone(data);
      const month = candidate.months[request.monthKey];
      const records = request.kind === 'income' ? month.paychecks : month.expenses;
      const record = findOrThrow(records, request.recordId, notFoundCode);
      record.cleared = request.cleared;
      commitCandidate(candidate, migrating ? {
        snapshotReason: 'pre-import', requiredSnapshot: true, daily: false, prune: false,
        targetSchemaVersion: Schema.V5_SCHEMA_VERSION
      } : undefined);
      return freezeDetached(clearedChecklistItem(request.kind, record));
    }

    function getDataHealth() {
      requireReady();
      if (!DataHealth) throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      return DataHealth.analyze(analysisData());
    }

    function getExactMoneyAudit() {
      requireReady();
      if (!ExactMoney || typeof ExactMoney.audit !== 'function') {
        throw new StoreError('EXACT_MONEY_UNAVAILABLE');
      }
      return freezeDetached(ExactMoney.audit(analysisData()));
    }

    function getExactMoneyMigrationSummary() {
      requireReady();
      if (residentSchemaVersion === Schema.V4_SCHEMA_VERSION || residentSchemaVersion === Schema.V5_SCHEMA_VERSION) {
        return freezeDetached({ state: 'already-migrated', subCentValueCount: 0, affectedMonthCount: 0, affectedTemplateCount: 0 });
      }
      const audit = getExactMoneyAudit();
      return freezeDetached({ state: audit.subCentValueCount === 0 ? 'eligible' : 'blocked', subCentValueCount: audit.subCentValueCount,
        affectedMonthCount: audit.affectedMonthCount, affectedTemplateCount: audit.affectedTemplateCount });
    }

    function previewExactMoneyMigration() {
      const summary = getExactMoneyMigrationSummary();
      if (summary.state === 'blocked') throw new StoreError('EXACT_MONEY_MIGRATION_BLOCKED');
      if (summary.state === 'already-migrated') throw new StoreError('EXACT_MONEY_ALREADY_MIGRATED');
      const preview = freezeDetached({ ...summary, generation });
      exactMoneyMigrationCapabilities.set(preview, { generation });
      return preview;
    }

    function commitExactMoneyMigration(preview) {
      requireReady();
      const capability = preview && typeof preview === 'object' ? exactMoneyMigrationCapabilities.get(preview) : null;
      if (preview && typeof preview === 'object') exactMoneyMigrationCapabilities.delete(preview);
      if (!capability) throw new StoreError('INVALID_EXACT_MONEY_MIGRATION_PREVIEW');
      if (capability.generation !== generation) throw new StoreError('STALE_EXACT_MONEY_MIGRATION_PREVIEW');
      if (residentSchemaVersion !== Schema.V3_SCHEMA_VERSION) throw new StoreError('EXACT_MONEY_ALREADY_MIGRATED');
      if (getExactMoneyMigrationSummary().state !== 'eligible') throw new StoreError('EXACT_MONEY_MIGRATION_BLOCKED');
      let hydrated;
      try {
        Schema.validateV3(data);
        const persisted = Schema.migrateV3ToV4ExactMoney(data);
        Schema.validateV4(persisted);
        hydrated = Schema.hydrateV4ExactMoney(persisted);
        if (!semanticEqual(data, hydrated)) throw new Error('aggregate mismatch');
      } catch { throw new StoreError('EXACT_MONEY_MIGRATION_VALIDATION_FAILED'); }
      return commitCandidate(hydrated, { snapshotReason: 'pre-import', requiredSnapshot: true,
        daily: false, prune: false, targetSchemaVersion: Schema.V4_SCHEMA_VERSION });
    }

    function getTemplateReadiness(options) {
      requireReady();
      if (!DataHealth || typeof DataHealth.buildTemplateReadiness !== 'function') {
        throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new StoreError('INVALID_REFERENCE_DATE');
      }
      try { return DataHealth.buildTemplateReadiness(analysisData(), options.referenceDate); }
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
      try { policyForVersion(residentSchemaVersion).migrateActive(staged); }
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
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) record.cleared = false;
        }
        return capability.selections;
      });
    }

    function previewDefaultDateResolutions() {
      requireReady();
      if (!DataHealth) throw new StoreError('DATA_HEALTH_UNAVAILABLE');
      const resolutions = DataHealth.analyze(analysisData()).missingDates.map(reference => ({
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
          if (residentSchemaVersion === Schema.V5_SCHEMA_VERSION) record.cleared = false;
        }
        return capability.resolutions;
      });
    }

    function compareAdditiveBackup(text) {
      requireReady();
      let incoming;
      try { incoming = policyForVersion(versionFromJson(text)).parseBackup(text).data; }
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

    function buildExport() { requireReady(); return policyForVersion(residentSchemaVersion).buildBackup(data, instantNow().toISOString()); }
    function exportData() { return JSON.stringify(buildExport(), null, 2); }
    function previewImport(text) {
      requireReady();
      let envelope;
      const incomingSchemaVersion = versionFromJson(text);
      try { envelope = policyForVersion(incomingSchemaVersion).parseBackup(text); }
      catch { throw new StoreError('INVALID_IMPORT'); }
      const monthKeys = Object.keys(envelope.data.months).sort();
      return {
        generation, exportedAt: envelope.exportedAt, formatVersion: envelope.formatVersion,
        monthCount: monthKeys.length, firstMonth: monthKeys[0] || null,
        lastMonth: monthKeys.at(-1) || null, data: schemaPolicy.clone(envelope.data), residentSchemaVersion: incomingSchemaVersion
      };
    }
    function commitImport(preview) {
      requireReady();
      if (!preview || preview.generation !== generation) throw new StoreError('STALE_IMPORT_PREVIEW');
      let candidate;
      try {
        candidate = policyForVersion(preview.residentSchemaVersion || Schema.V3_SCHEMA_VERSION)
          .parseActive(JSON.stringify(canonicalizeForWrite(preview.residentSchemaVersion || Schema.V3_SCHEMA_VERSION, preview.data)));
      }
      catch { throw new StoreError('INVALID_IMPORT'); }
      return commitCandidate(candidate, {
        snapshotReason: 'pre-import', requiredSnapshot: committedRaw !== null, daily: false,
        targetSchemaVersion: preview.residentSchemaVersion || Schema.V3_SCHEMA_VERSION
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
        const restoredSchemaVersion = versionFromJson(raw);
        const envelope = policyForVersion(restoredSchemaVersion).parseSnapshot(raw);
        record = { data: envelope.data, residentSchemaVersion: restoredSchemaVersion };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError('SNAPSHOT_NOT_FOUND');
      }
      if (loadState === 'recovery-required') {
        const persisted = canonicalizeForWrite(record.residentSchemaVersion, record.data);
        const canonical = record.residentSchemaVersion === Schema.V5_SCHEMA_VERSION
          ? Schema.hydrateV5ExactMoney(persisted)
          : record.residentSchemaVersion === Schema.V4_SCHEMA_VERSION
            ? Schema.hydrateV4ExactMoney(persisted) : policyForVersion(record.residentSchemaVersion).migrateActive(record.data);
        const nextRaw = JSON.stringify(persisted);
        write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
        data = canonical; committedRaw = nextRaw; corruptEvidence = null; residentSchemaVersion = record.residentSchemaVersion;
        loadState = 'ready'; generation += 1;
        return schemaPolicy.clone(data);
      }
      requireReady();
      return commitCandidate(record.data, {
        snapshotReason: 'pre-import', requiredSnapshot: committedRaw !== null, daily: false,
        targetSchemaVersion: record.residentSchemaVersion
      });
    }
    function startFresh() {
      const candidate = defaultData();
      if (loadState === 'recovery-required') {
        const nextRaw = JSON.stringify(candidate);
        write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
        data = candidate; committedRaw = nextRaw; corruptEvidence = null;
        residentSchemaVersion = Schema.V3_SCHEMA_VERSION;
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
      return { state: loadState, generation, residentSchemaVersion, hasEvidence: corruptEvidence !== null, warnings: [...warnings] };
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
      previewTemplateActivation, applyTemplateActivationPreview,
      getMonthReview, getPayPeriodPlan, getUpcomingBillsAndPaydays, getSuppressedOccurrences, unsuppressOccurrence,
      getClearedChecklist, getMonthReadiness, getMonthReviewQueue, getNextReviewSteps,
      findSavedRecords, setRecordCleared,
      fundingDirection,
      getDataHealth, getExactMoneyAudit, getExactMoneyMigrationSummary, previewExactMoneyMigration, commitExactMoneyMigration,
      getTemplateReadiness, previewActualResolutions, applyActualResolutions, previewDefaultDateResolutions, applyDefaultDateResolutions, compareAdditiveBackup,
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
