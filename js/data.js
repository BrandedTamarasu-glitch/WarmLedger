(function(root, factory) {
  'use strict';
  const Schema = root && root.ZeroBudgetSchema ? root.ZeroBudgetSchema
    : (typeof require === 'function' ? require('./data-schema.js') : null);
  const api = factory(Schema);
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
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Schema) {
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
    return { paychecks: [], expenses: [], allocations: { ...EMPTY_ALLOCATIONS } };
  }

  function defaultData() {
    return {
      schemaVersion: Schema.SCHEMA_VERSION,
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
      months: {}
    };
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

  function localDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function createStore({ storage, now = () => new Date(), uuid = () => crypto.randomUUID() } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new StoreError('STORAGE_UNAVAILABLE');
    }
    if (typeof now !== 'function' || typeof uuid !== 'function') throw new StoreError('INVALID_ADAPTER');

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
          const envelope = Schema.parseSnapshot(raw);
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
        envelope = Schema.buildSnapshot(priorData, {
          createdAt: instant.toISOString(), localDate: localDate(instant), reason
        });
      } catch (error) {
        if (error instanceof Schema.DataError) throw error;
        throw storageError('CLOCK_FAILED', error);
      }
      const key = SNAPSHOT_PREFIX + safeSnapshotId();
      try {
        write(key, JSON.stringify(envelope), 'SNAPSHOT_WRITE_FAILED');
        Schema.parseSnapshot(read(key, 'SNAPSHOT_READ_FAILED'));
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
      const canonical = Schema.migrateActive(candidate);
      const nextRaw = JSON.stringify(canonical);
      const priorData = Schema.clone(data);
      if (nextRaw === JSON.stringify(data)) return Schema.clone(data);
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
      return Schema.clone(data);
    }

    function transact(mutator, options) {
      requireReady();
      const candidate = Schema.clone(data);
      const result = mutator(candidate);
      commitCandidate(candidate, options);
      return result === undefined ? undefined : Schema.clone(result);
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
        const parsed = Schema.parseActive(raw);
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

    function getData() { requireReady(); return Schema.clone(data); }
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
    function peekMonth(monthKey) { requireReady(); return Schema.clone(data.months[monthKey] || emptyMonth()); }
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
      const patch = Schema.clone(value);
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
      const orderedIds = Schema.clone(input);
      if (!Array.isArray(orderedIds) || orderedIds.length !== items.length) throw new StoreError('INVALID_PERMUTATION');
      const expected = new Set(items.map(item => item.id));
      const received = new Set(orderedIds);
      if (received.size !== orderedIds.length || received.size !== expected.size ||
          orderedIds.some(id => !expected.has(id))) throw new StoreError('INVALID_PERMUTATION');
      const byId = new Map(items.map(item => [item.id, item]));
      return orderedIds.map(id => byId.get(id));
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
      const nextName = Schema.clone(name);
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
      const nextName = Schema.clone(name);
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
      const nextName = Schema.clone(name);
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

    function addPaycheck(monthKey, input) {
      const paycheck = patchOf(input, ['earnerId', 'amount', 'date']);
      if (!Object.hasOwn(paycheck, 'earnerId') || !Object.hasOwn(paycheck, 'amount') || !Object.hasOwn(paycheck, 'date')) {
        throw new StoreError('MISSING_FIELD');
      }
      return transact(candidate => {
        const earner = activeEarner(candidate, paycheck.earnerId);
        const created = { id: newId(), earnerId: earner.id, earner: earner.name, amount: paycheck.amount, date: paycheck.date };
        requireMonth(candidate, monthKey).paychecks.push(created);
        return created;
      });
    }
    function updatePaycheck(monthKey, id, updates) {
      const patch = patchOf(updates, ['amount', 'date']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const paycheck = findOrThrow(month.paychecks, id, 'PAYCHECK_NOT_FOUND');
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
      const patch = patchOf(updates, ['earnerId', 'amount', 'date']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const paycheck = findOrThrow(month.paychecks, id, 'PAYCHECK_NOT_FOUND');
        if (Object.hasOwn(patch, 'earnerId')) {
          const earner = activeEarner(candidate, patch.earnerId);
          paycheck.earnerId = earner.id; paycheck.earner = earner.name;
        }
        if (Object.hasOwn(patch, 'amount')) paycheck.amount = patch.amount;
        if (Object.hasOwn(patch, 'date')) paycheck.date = patch.date;
        return paycheck;
      });
    }
    function deletePaycheck(monthKey, id) {
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const index = month.paychecks.findIndex(paycheck => paycheck.id === id);
        if (index < 0) throw new StoreError('PAYCHECK_NOT_FOUND');
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
      const expense = patchOf(input, ['categoryId', 'categoryItemId', 'name', 'paycheckAmounts', 'actual', 'paymentMethod']);
      if (!Object.hasOwn(expense, 'categoryId') || !Object.hasOwn(expense, 'categoryItemId') ||
          !Object.hasOwn(expense, 'paymentMethod')) throw new StoreError('MISSING_FIELD');
      return transact(candidate => {
        const category = activeCategory(candidate, expense.categoryId);
        const created = { id: newId() };
        applyExpenseStructure(created, category, expense.categoryItemId, expense.name);
        created.paycheckAmounts = expense.paycheckAmounts || {};
        created.actual = Object.hasOwn(expense, 'actual') ? expense.actual : 0;
        created.paymentMethod = expense.paymentMethod;
        requireMonth(candidate, monthKey).expenses.push(created);
        return created;
      });
    }
    function updateExpense(monthKey, id, updates) {
      const patch = patchOf(updates, ['name', 'actual', 'paymentMethod']);
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const expense = findOrThrow(month.expenses, id, 'EXPENSE_NOT_FOUND');
        if (Object.hasOwn(patch, 'name') && patch.name !== expense.name) {
          expense.name = patch.name;
          expense.categoryItemId = null;
        }
        if (Object.hasOwn(patch, 'actual')) expense.actual = patch.actual;
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
      const patch = patchOf(updates, ['categoryId', 'categoryItemId', 'name', 'actual', 'paymentMethod']);
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
        if (Object.hasOwn(patch, 'actual')) expense.actual = patch.actual;
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
      return transact(candidate => {
        const month = candidate.months[monthKey];
        if (!month) throw new StoreError('MONTH_NOT_FOUND');
        const index = month.expenses.findIndex(expense => expense.id === id);
        if (index < 0) throw new StoreError('EXPENSE_NOT_FOUND');
        month.expenses.splice(index, 1);
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
        month.allocations = Schema.clone(allocations);
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
        const idMap = Object.create(null);
        const paychecks = source.paychecks.map(paycheck => {
          const id = newId(); idMap[paycheck.id] = id;
          return { ...paycheck, id };
        });
        const expenses = source.expenses.map(expense => {
          const paycheckAmounts = {};
          for (const [paycheckId, amount] of Object.entries(expense.paycheckAmounts)) {
            if (idMap[paycheckId]) paycheckAmounts[idMap[paycheckId]] = amount;
          }
          return { ...expense, id: newId(), actual: 0, paycheckAmounts };
        });
        candidate.months[targetKey] = { paychecks, expenses, allocations: { ...EMPTY_ALLOCATIONS } };
        return candidate.months[targetKey];
      }, { snapshotReason: 'pre-reset', requiredSnapshot: committedRaw !== null, daily: false });
    }
    function clearMonth(monthKey) {
      return transact(candidate => {
        candidate.months[monthKey] = emptyMonth();
        return candidate.months[monthKey];
      }, { snapshotReason: 'pre-reset', requiredSnapshot: committedRaw !== null, daily: false });
    }

    function expenseProjected(expense) {
      return Object.values(expense.paycheckAmounts || {}).reduce((sum, value) => sum + value, 0);
    }
    function calcMonthSummary(monthKey) {
      const month = peekMonth(monthKey);
      const totalIncome = month.paychecks.reduce((sum, paycheck) => sum + paycheck.amount, 0);
      const totalProjected = month.expenses.reduce((sum, expense) => sum + expenseProjected(expense), 0);
      const totalActual = month.expenses.reduce((sum, expense) => sum + expense.actual, 0);
      const totalAllocated = Object.values(month.allocations).reduce((sum, value) => sum + value, 0);
      const totalBudgeted = totalProjected + totalAllocated;
      return { totalIncome, totalProjected, totalActual, totalAllocated, totalBudgeted, remaining: totalIncome - totalBudgeted };
    }
    function calcPaycheckRemaining(monthKey, paycheckId) {
      const month = peekMonth(monthKey);
      const paycheck = month.paychecks.find(item => item.id === paycheckId);
      if (!paycheck) return 0;
      const assigned = month.expenses.reduce((sum, expense) => sum + (expense.paycheckAmounts[paycheckId] || 0), 0);
      return paycheck.amount - assigned;
    }
    function calcCategoryTotals(monthKey) {
      const totals = Object.create(null);
      for (const expense of peekMonth(monthKey).expenses) {
        if (!Object.hasOwn(totals, expense.category)) totals[expense.category] = { projected: 0, actual: 0 };
        totals[expense.category].projected += expenseProjected(expense);
        totals[expense.category].actual += expense.actual;
      }
      return totals;
    }
    function calcPaymentMethodTotals(monthKey) {
      const totals = { bank: 0, credit_card: 0, savings: 0, investments: 0 };
      for (const expense of peekMonth(monthKey).expenses) {
        totals[expense.paymentMethod] += expense.actual || expenseProjected(expense);
      }
      return totals;
    }
    function getAllMonthKeys() { requireReady(); return Object.keys(data.months).sort(); }

    function buildExport() { requireReady(); return Schema.buildBackup(data, instantNow().toISOString()); }
    function exportData() { return JSON.stringify(buildExport(), null, 2); }
    function previewImport(text) {
      requireReady();
      let envelope;
      try { envelope = Schema.parseBackup(text); }
      catch { throw new StoreError('INVALID_IMPORT'); }
      const monthKeys = Object.keys(envelope.data.months).sort();
      return {
        generation, exportedAt: envelope.exportedAt, formatVersion: envelope.formatVersion,
        monthCount: monthKeys.length, firstMonth: monthKeys[0] || null,
        lastMonth: monthKeys.at(-1) || null, data: Schema.clone(envelope.data)
      };
    }
    function commitImport(preview) {
      requireReady();
      if (!preview || preview.generation !== generation) throw new StoreError('STALE_IMPORT_PREVIEW');
      let candidate;
      try { candidate = Schema.migrateActive(preview.data); }
      catch { throw new StoreError('INVALID_IMPORT'); }
      return commitCandidate(candidate, {
        snapshotReason: 'pre-import', requiredSnapshot: committedRaw !== null, daily: false
      });
    }
    function importData(text) { return commitImport(previewImport(text)); }
    function listSnapshots() {
      return snapshotRecords().slice(0, SNAPSHOT_LIMIT).map(record => ({
        id: record.id, createdAt: record.createdAt, localDate: record.localDate,
        reason: record.reason, data: Schema.clone(record.data)
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
        const envelope = Schema.parseSnapshot(raw);
        record = { data: envelope.data };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError('SNAPSHOT_NOT_FOUND');
      }
      if (loadState === 'recovery-required') {
        const canonical = Schema.migrateActive(record.data);
        const nextRaw = JSON.stringify(canonical);
        write(STORAGE_KEY, nextRaw, 'PRIMARY_WRITE_FAILED');
        data = canonical; committedRaw = nextRaw; corruptEvidence = null;
        loadState = 'ready'; generation += 1;
        return Schema.clone(data);
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
        return Schema.clone(data);
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
      getStructureUsage, addCategory, renameCategory, setCategoryArchived, reorderCategories,
      addCategoryItem, renameCategoryItem, setCategoryItemArchived, reorderCategoryItems,
      addEarner, renameEarner, setEarnerArchived, reorderEarners,
      expenseProjected, addPaycheck, updatePaycheck, reassignPaycheckEarner, editPaycheck, deletePaycheck, reorderPaychecks,
      addExpense, updateExpense,
      reassignExpenseStructure, editExpense,
      updateExpensePaycheckAmount, deleteExpense, reorderExpenses, updateAllocations, updateAllocation, copyFromMonth,
      clearMonth, calcMonthSummary, calcPaycheckRemaining, calcCategoryTotals, calcPaymentMethodTotals,
      buildExport, exportData, previewImport, commitImport, importData, listSnapshots,
      listSnapshotMetadata, restoreSnapshot, startFresh, getCorruptEvidence
    });
  }

  return Object.freeze({
    STORAGE_KEY, CORRUPT_KEY, SNAPSHOT_PREFIX, SNAPSHOT_LIMIT,
    ALLOCATION_TYPES, StoreError, createStore
  });
});
