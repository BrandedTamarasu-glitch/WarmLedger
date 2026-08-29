(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const V2_SCHEMA_VERSION = 2;
  const BACKUP_FORMAT = 'zerobudget-backup';
  const BACKUP_FORMAT_VERSION = 1;
  const SNAPSHOT_FORMAT = 'zerobudget-snapshot';
  const SNAPSHOT_FORMAT_VERSION = 1;
  const MAX_MONEY = 1_000_000_000_000;
  const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const PAYMENT_METHODS = new Set(['bank', 'credit_card', 'savings', 'investments']);
  const ALLOCATION_KEYS = ['savings', 'credit_card_debt', 'investments'];
  const SNAPSHOT_REASONS = new Set(['daily', 'pre-import', 'pre-reset']);
  const DEFAULT_CATEGORIES = Object.freeze([
    'Housing', 'Transportation', 'Insurance', 'Food', 'Pets', 'Personal Care',
    'Miscellaneous', 'Debt', 'Taxes', 'Subscriptions', 'Other'
  ].map(name => Object.freeze({ name, items: Object.freeze([]) })));
  const DEFAULT_EARNERS = Object.freeze(['Primary', 'Secondary']);

  class DataError extends Error {
    constructor(code, path = '$', options = {}) {
      super(`Budget data error (${code})`, options.cause ? { cause: options.cause } : undefined);
      this.name = 'DataError';
      this.code = code;
      this.path = path;
    }
  }

  function fail(code, path, cause) {
    throw new DataError(code, path, cause ? { cause } : undefined);
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function childPath(path, key) {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  }

  function preflight(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_FINITE_NUMBER', path);
      return;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', path);
    if (seen.has(value)) fail('CYCLIC_VALUE', path);
    seen.add(value);
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key === 'symbol') fail('SYMBOL_KEY', path);
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) fail('NON_JSON_PROPERTY', childPath(path, key));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('NON_DATA_PROPERTY', childPath(path, key));
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('SPARSE_ARRAY', `${path}[${index}]`);
        preflight(Object.getOwnPropertyDescriptor(value, String(index)).value, `${path}[${index}]`, seen);
      }
    } else {
      if (!isPlainObject(value)) fail('NON_PLAIN_OBJECT', path);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') fail('SYMBOL_KEY', path);
        if (BLOCKED_KEYS.has(key)) fail('UNSAFE_KEY', childPath(path, key));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('NON_DATA_PROPERTY', childPath(path, key));
        preflight(descriptor.value, childPath(path, key), seen);
      }
    }
    seen.delete(value);
  }

  function cloneValue(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_FINITE_NUMBER', path);
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', path);
    if (seen.has(value)) fail('CYCLIC_VALUE', path);
    seen.add(value);

    let result;
    if (Array.isArray(value)) {
      result = [];
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key === 'symbol') fail('SYMBOL_KEY', path);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('NON_DATA_PROPERTY', childPath(path, key));
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('SPARSE_ARRAY', `${path}[${index}]`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        result.push(cloneValue(descriptor.value, `${path}[${index}]`, seen));
      }
    } else {
      if (!isPlainObject(value)) fail('NON_PLAIN_OBJECT', path);
      result = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') fail('SYMBOL_KEY', path);
        if (BLOCKED_KEYS.has(key)) fail('UNSAFE_KEY', childPath(path, key));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('NON_DATA_PROPERTY', childPath(path, key));
        result[key] = cloneValue(descriptor.value, childPath(path, key), seen);
      }
    }
    seen.delete(value);
    return result;
  }

  function clone(value) {
    preflight(value, '$', new Set());
    return cloneValue(value, '$', new Set());
  }

  function expectObject(value, path) {
    if (!isPlainObject(value)) fail('EXPECTED_OBJECT', path);
  }

  function expectExactKeys(value, keys, path) {
    expectObject(value, path);
    const expected = new Set(keys);
    for (const key of Object.keys(value)) {
      if (BLOCKED_KEYS.has(key)) fail('UNSAFE_KEY', childPath(path, key));
      if (!expected.has(key)) fail('UNKNOWN_FIELD', childPath(path, key));
    }
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) fail('MISSING_FIELD', childPath(path, key));
    }
  }

  function expectArray(value, path, max) {
    if (!Array.isArray(value)) fail('EXPECTED_ARRAY', path);
    if (value.length > max) fail('TOO_MANY_ITEMS', path);
  }

  function expectString(value, path, max, allowEmpty = false) {
    if (typeof value !== 'string') fail('EXPECTED_STRING', path);
    if ((!allowEmpty && value.length === 0) || value.length > max || value.trim() !== value) {
      fail('INVALID_STRING', path);
    }
  }

  function expectIdentifier(value, path) {
    expectString(value, path, 128);
    if (BLOCKED_KEYS.has(value)) fail('UNSAFE_IDENTIFIER', path);
  }

  function expectMoney(value, path, positive = false) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_AMOUNT', path);
    if (value < 0 || value > MAX_MONEY || (positive && value === 0)) fail('AMOUNT_OUT_OF_RANGE', path);
  }

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function expectMonth(value, path) {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) fail('INVALID_MONTH', path);
  }

  function expectDate(value, path, allowEmpty = false) {
    if (allowEmpty && value === '') return;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) fail('INVALID_DATE', path);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail('INVALID_DATE', path);
  }

  function expectTimestamp(value, path) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
      fail('INVALID_TIMESTAMP', path);
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const hour = Number(value.slice(11, 13));
    const minute = Number(value.slice(14, 16));
    const second = Number(value.slice(17, 19));
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
        hour > 23 || minute > 59 || second > 59) fail('INVALID_TIMESTAMP', path);
    const time = Date.parse(value);
    if (!Number.isFinite(time)) fail('INVALID_TIMESTAMP', path);
  }

  function assertUnique(values, path) {
    const seen = new Set();
    for (let index = 0; index < values.length; index += 1) {
      if (seen.has(values[index])) fail('DUPLICATE_VALUE', `${path}[${index}]`);
      seen.add(values[index]);
    }
  }

  function validateActive(input) {
    clone(input);
    expectExactKeys(input, ['schemaVersion', 'categories', 'settings', 'months'], '$');
    if (input.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');

    expectArray(input.categories, '$.categories', 100);
    const categoryNames = [];
    input.categories.forEach((category, index) => {
      const path = `$.categories[${index}]`;
      expectExactKeys(category, ['name', 'items'], path);
      expectString(category.name, `${path}.name`, 120);
      expectArray(category.items, `${path}.items`, 200);
      category.items.forEach((item, itemIndex) => expectString(item, `${path}.items[${itemIndex}]`, 120));
      categoryNames.push(category.name);
    });
    assertUnique(categoryNames, '$.categories');
    const categories = new Set(categoryNames);

    expectExactKeys(input.settings, ['earners'], '$.settings');
    expectArray(input.settings.earners, '$.settings.earners', 50);
    input.settings.earners.forEach((earner, index) => expectString(earner, `$.settings.earners[${index}]`, 120));
    assertUnique(input.settings.earners, '$.settings.earners');
    const earners = new Set(input.settings.earners);

    expectObject(input.months, '$.months');
    const monthKeys = Object.keys(input.months);
    if (monthKeys.length > 600) fail('TOO_MANY_ITEMS', '$.months');
    for (const monthKey of monthKeys) {
      const path = childPath('$.months', monthKey);
      if (BLOCKED_KEYS.has(monthKey)) fail('UNSAFE_KEY', path);
      expectMonth(monthKey, path);
      const month = input.months[monthKey];
      expectExactKeys(month, ['paychecks', 'expenses', 'allocations'], path);
      expectArray(month.paychecks, `${path}.paychecks`, 500);
      expectArray(month.expenses, `${path}.expenses`, 5000);

      const paycheckIds = new Set();
      const allIds = new Set();
      let totalIncome = 0;
      month.paychecks.forEach((paycheck, index) => {
        const itemPath = `${path}.paychecks[${index}]`;
        expectExactKeys(paycheck, ['id', 'earner', 'amount', 'date'], itemPath);
        expectIdentifier(paycheck.id, `${itemPath}.id`);
        expectString(paycheck.earner, `${itemPath}.earner`, 120);
        if (!earners.has(paycheck.earner)) fail('UNKNOWN_EARNER', `${itemPath}.earner`);
        expectMoney(paycheck.amount, `${itemPath}.amount`, true);
        totalIncome += paycheck.amount;
        if (!Number.isFinite(totalIncome) || totalIncome > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.paychecks`);
        if (typeof paycheck.date !== 'string') fail('INVALID_DATE', `${itemPath}.date`);
        expectDate(paycheck.date, `${itemPath}.date`, true);
        if (allIds.has(paycheck.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        paycheckIds.add(paycheck.id);
        allIds.add(paycheck.id);
      });

      let totalProjected = 0;
      let totalActual = 0;
      month.expenses.forEach((expense, index) => {
        const itemPath = `${path}.expenses[${index}]`;
        expectExactKeys(expense, ['id', 'category', 'name', 'paycheckAmounts', 'actual', 'paymentMethod'], itemPath);
        expectIdentifier(expense.id, `${itemPath}.id`);
        expectString(expense.category, `${itemPath}.category`, 120);
        if (!categories.has(expense.category)) fail('UNKNOWN_CATEGORY', `${itemPath}.category`);
        expectString(expense.name, `${itemPath}.name`, 120);
        if (allIds.has(expense.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        allIds.add(expense.id);
        expectObject(expense.paycheckAmounts, `${itemPath}.paycheckAmounts`);
        let projectedTotal = 0;
        for (const paycheckId of Object.keys(expense.paycheckAmounts)) {
          const amountPath = childPath(`${itemPath}.paycheckAmounts`, paycheckId);
          if (BLOCKED_KEYS.has(paycheckId)) fail('UNSAFE_KEY', amountPath);
          if (!paycheckIds.has(paycheckId)) fail('DANGLING_PAYCHECK_REFERENCE', amountPath);
          expectMoney(expense.paycheckAmounts[paycheckId], amountPath);
          projectedTotal += expense.paycheckAmounts[paycheckId];
          if (!Number.isFinite(projectedTotal) || projectedTotal > MAX_MONEY) {
            fail('AGGREGATE_OUT_OF_RANGE', `${itemPath}.paycheckAmounts`);
          }
        }
        expectMoney(expense.actual, `${itemPath}.actual`);
        totalProjected += projectedTotal;
        totalActual += expense.actual;
        if (!Number.isFinite(totalProjected) || totalProjected > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.expenses`);
        if (!Number.isFinite(totalActual) || totalActual > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.expenses`);
        if (!PAYMENT_METHODS.has(expense.paymentMethod)) fail('INVALID_PAYMENT_METHOD', `${itemPath}.paymentMethod`);
      });

      expectExactKeys(month.allocations, ALLOCATION_KEYS, `${path}.allocations`);
      let allocationTotal = 0;
      for (const key of ALLOCATION_KEYS) {
        expectMoney(month.allocations[key], `${path}.allocations.${key}`);
        allocationTotal += month.allocations[key];
        if (!Number.isFinite(allocationTotal) || allocationTotal > MAX_MONEY) {
          fail('AGGREGATE_OUT_OF_RANGE', `${path}.allocations`);
        }
      }
    }
    return true;
  }

  function validateV2(input) {
    clone(input);
    expectExactKeys(input, ['schemaVersion', 'categories', 'settings', 'months'], '$');
    if (input.schemaVersion !== V2_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');

    expectArray(input.categories, '$.categories', 100);
    const structuralIds = new Set();
    const categoryNames = [];
    const categoriesById = new Map();
    input.categories.forEach((category, index) => {
      const path = `$.categories[${index}]`;
      expectExactKeys(category, ['id', 'name', 'archived', 'items'], path);
      expectIdentifier(category.id, `${path}.id`);
      if (structuralIds.has(category.id)) fail('DUPLICATE_ID', `${path}.id`);
      structuralIds.add(category.id);
      expectString(category.name, `${path}.name`, 120);
      if (typeof category.archived !== 'boolean') fail('EXPECTED_BOOLEAN', `${path}.archived`);
      expectArray(category.items, `${path}.items`, 200);
      const itemIds = new Set();
      category.items.forEach((item, itemIndex) => {
        const itemPath = `${path}.items[${itemIndex}]`;
        expectExactKeys(item, ['id', 'name', 'archived'], itemPath);
        expectIdentifier(item.id, `${itemPath}.id`);
        if (structuralIds.has(item.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        structuralIds.add(item.id); itemIds.add(item.id);
        expectString(item.name, `${itemPath}.name`, 120);
        if (typeof item.archived !== 'boolean') fail('EXPECTED_BOOLEAN', `${itemPath}.archived`);
      });
      categoryNames.push(category.name);
      categoriesById.set(category.id, itemIds);
    });
    assertUnique(categoryNames, '$.categories');

    expectExactKeys(input.settings, ['earners'], '$.settings');
    expectArray(input.settings.earners, '$.settings.earners', 50);
    const earnerNames = [];
    const earnerIds = new Set();
    input.settings.earners.forEach((earner, index) => {
      const path = `$.settings.earners[${index}]`;
      expectExactKeys(earner, ['id', 'name', 'archived'], path);
      expectIdentifier(earner.id, `${path}.id`);
      if (structuralIds.has(earner.id)) fail('DUPLICATE_ID', `${path}.id`);
      structuralIds.add(earner.id); earnerIds.add(earner.id);
      expectString(earner.name, `${path}.name`, 120);
      if (typeof earner.archived !== 'boolean') fail('EXPECTED_BOOLEAN', `${path}.archived`);
      earnerNames.push(earner.name);
    });
    assertUnique(earnerNames, '$.settings.earners');

    expectObject(input.months, '$.months');
    const monthKeys = Object.keys(input.months);
    if (monthKeys.length > 600) fail('TOO_MANY_ITEMS', '$.months');
    for (const monthKey of monthKeys) {
      const path = childPath('$.months', monthKey);
      if (BLOCKED_KEYS.has(monthKey)) fail('UNSAFE_KEY', path);
      expectMonth(monthKey, path);
      const month = input.months[monthKey];
      expectExactKeys(month, ['paychecks', 'expenses', 'allocations'], path);
      expectArray(month.paychecks, `${path}.paychecks`, 500);
      expectArray(month.expenses, `${path}.expenses`, 5000);
      const paycheckIds = new Set();
      const monthlyIds = new Set();
      let totalIncome = 0;
      month.paychecks.forEach((paycheck, index) => {
        const itemPath = `${path}.paychecks[${index}]`;
        expectExactKeys(paycheck, ['id', 'earnerId', 'earner', 'amount', 'date'], itemPath);
        expectIdentifier(paycheck.id, `${itemPath}.id`);
        expectIdentifier(paycheck.earnerId, `${itemPath}.earnerId`);
        if (!earnerIds.has(paycheck.earnerId)) fail('DANGLING_EARNER_REFERENCE', `${itemPath}.earnerId`);
        expectString(paycheck.earner, `${itemPath}.earner`, 120);
        expectMoney(paycheck.amount, `${itemPath}.amount`, true);
        totalIncome += paycheck.amount;
        if (!Number.isFinite(totalIncome) || totalIncome > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.paychecks`);
        if (typeof paycheck.date !== 'string') fail('INVALID_DATE', `${itemPath}.date`);
        expectDate(paycheck.date, `${itemPath}.date`, true);
        if (monthlyIds.has(paycheck.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        paycheckIds.add(paycheck.id); monthlyIds.add(paycheck.id);
      });

      let totalProjected = 0;
      let totalActual = 0;
      month.expenses.forEach((expense, index) => {
        const itemPath = `${path}.expenses[${index}]`;
        expectExactKeys(expense, ['id', 'categoryId', 'category', 'categoryItemId', 'name', 'paycheckAmounts', 'actual', 'paymentMethod'], itemPath);
        expectIdentifier(expense.id, `${itemPath}.id`);
        expectIdentifier(expense.categoryId, `${itemPath}.categoryId`);
        const ownedItemIds = categoriesById.get(expense.categoryId);
        if (!ownedItemIds) fail('DANGLING_CATEGORY_REFERENCE', `${itemPath}.categoryId`);
        expectString(expense.category, `${itemPath}.category`, 120);
        if (expense.categoryItemId !== null) {
          expectIdentifier(expense.categoryItemId, `${itemPath}.categoryItemId`);
          if (!ownedItemIds.has(expense.categoryItemId)) fail('DANGLING_CATEGORY_ITEM_REFERENCE', `${itemPath}.categoryItemId`);
        }
        expectString(expense.name, `${itemPath}.name`, 120);
        if (monthlyIds.has(expense.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        monthlyIds.add(expense.id);
        expectObject(expense.paycheckAmounts, `${itemPath}.paycheckAmounts`);
        let projectedTotal = 0;
        for (const paycheckId of Object.keys(expense.paycheckAmounts)) {
          const amountPath = childPath(`${itemPath}.paycheckAmounts`, paycheckId);
          if (BLOCKED_KEYS.has(paycheckId)) fail('UNSAFE_KEY', amountPath);
          if (!paycheckIds.has(paycheckId)) fail('DANGLING_PAYCHECK_REFERENCE', amountPath);
          expectMoney(expense.paycheckAmounts[paycheckId], amountPath);
          projectedTotal += expense.paycheckAmounts[paycheckId];
          if (!Number.isFinite(projectedTotal) || projectedTotal > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${itemPath}.paycheckAmounts`);
        }
        expectMoney(expense.actual, `${itemPath}.actual`);
        totalProjected += projectedTotal; totalActual += expense.actual;
        if (!Number.isFinite(totalProjected) || totalProjected > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.expenses`);
        if (!Number.isFinite(totalActual) || totalActual > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.expenses`);
        if (!PAYMENT_METHODS.has(expense.paymentMethod)) fail('INVALID_PAYMENT_METHOD', `${itemPath}.paymentMethod`);
      });

      expectExactKeys(month.allocations, ALLOCATION_KEYS, `${path}.allocations`);
      let allocationTotal = 0;
      for (const key of ALLOCATION_KEYS) {
        expectMoney(month.allocations[key], `${path}.allocations.${key}`);
        allocationTotal += month.allocations[key];
        if (!Number.isFinite(allocationTotal) || allocationTotal > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.allocations`);
      }
    }
    return true;
  }

  function migrateActive(input) {
    const migrated = clone(input);
    if (!isPlainObject(migrated)) fail('EXPECTED_OBJECT', '$');
    if (Object.hasOwn(migrated, 'schemaVersion')) {
      if (migrated.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
      validateActive(migrated);
      return clone(migrated);
    }
    for (const key of Object.keys(migrated)) {
      if (!['categories', 'settings', 'months'].includes(key)) fail('UNKNOWN_FIELD', childPath('$', key));
    }
    if (!isPlainObject(migrated.months)) fail('MISSING_FIELD', '$.months');

    for (const [monthKey, month] of Object.entries(migrated.months)) {
      if (!isPlainObject(month)) fail('EXPECTED_OBJECT', childPath('$.months', monthKey));
      if (!Object.hasOwn(month, 'paychecks')) month.paychecks = [];
      if (!Object.hasOwn(month, 'expenses')) month.expenses = [];
      if (!Object.hasOwn(month, 'allocations')) {
        month.allocations = { savings: 0, credit_card_debt: 0, investments: 0 };
      }
      if (!Array.isArray(month.expenses)) continue;
      for (const expense of month.expenses) {
        if (!isPlainObject(expense)) continue;
        if (!Object.hasOwn(expense, 'paycheckAmounts')) {
          expense.paycheckAmounts = Object.create(null);
          if (Object.hasOwn(expense, 'paycheckId') && expense.paycheckId !== '' && expense.paycheckId !== null &&
              Object.hasOwn(expense, 'projected')) {
            expectIdentifier(expense.paycheckId, '$.months.*.expenses[].paycheckId');
            expense.paycheckAmounts[expense.paycheckId] = expense.projected;
          }
        }
        delete expense.paycheckId;
        delete expense.projected;
        if (!Object.hasOwn(expense, 'paymentMethod')) expense.paymentMethod = 'bank';
      }
    }

    if (!Object.hasOwn(migrated, 'categories')) migrated.categories = clone(DEFAULT_CATEGORIES);
    if (!Object.hasOwn(migrated, 'settings')) migrated.settings = { earners: clone(DEFAULT_EARNERS) };
    migrated.schemaVersion = SCHEMA_VERSION;
    validateActive(migrated);
    return clone(migrated);
  }

  function migrateToV2(input) {
    const source = clone(input);
    if (!isPlainObject(source)) fail('EXPECTED_OBJECT', '$');
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion === V2_SCHEMA_VERSION) {
      validateV2(source);
      return clone(source);
    }
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion !== SCHEMA_VERSION) {
      fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    }
    const active = migrateActive(source);
    const categoryIdsByName = new Map();
    const categories = active.categories.map((category, categoryIndex) => {
      const number = String(categoryIndex + 1).padStart(4, '0');
      const id = `migrated-category-${number}`;
      categoryIdsByName.set(category.name, id);
      return {
        id,
        name: category.name,
        archived: false,
        items: category.items.map((name, itemIndex) => ({
          id: `migrated-item-${number}-${String(itemIndex + 1).padStart(4, '0')}`,
          name,
          archived: false
        }))
      };
    });
    const earnerIdsByName = new Map();
    const earners = active.settings.earners.map((name, index) => {
      const id = `migrated-earner-${String(index + 1).padStart(4, '0')}`;
      earnerIdsByName.set(name, id);
      return { id, name, archived: false };
    });
    const months = {};
    for (const [monthKey, month] of Object.entries(active.months)) {
      months[monthKey] = {
        paychecks: month.paychecks.map(paycheck => ({
          id: paycheck.id,
          earnerId: earnerIdsByName.get(paycheck.earner),
          earner: paycheck.earner,
          amount: paycheck.amount,
          date: paycheck.date
        })),
        expenses: month.expenses.map(expense => ({
          id: expense.id,
          categoryId: categoryIdsByName.get(expense.category),
          category: expense.category,
          categoryItemId: null,
          name: expense.name,
          paycheckAmounts: clone(expense.paycheckAmounts),
          actual: expense.actual,
          paymentMethod: expense.paymentMethod
        })),
        allocations: clone(month.allocations)
      };
    }
    const migrated = { schemaVersion: V2_SCHEMA_VERSION, categories, settings: { earners }, months };
    validateV2(migrated);
    return clone(migrated);
  }

  function parseJson(text, path) {
    if (typeof text !== 'string') fail('EXPECTED_JSON_TEXT', path);
    try {
      return JSON.parse(text);
    } catch (error) {
      fail('INVALID_JSON', path, error);
    }
  }

  function parseActive(text) {
    return migrateActive(parseJson(text, '$'));
  }

  function buildBackup(data, exportedAt) {
    const canonical = migrateActive(data);
    expectTimestamp(exportedAt, '$.exportedAt');
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt,
      data: canonical
    };
  }

  function parseBackup(text) {
    const envelope = parseJson(text, '$');
    clone(envelope);
    expectExactKeys(envelope, ['format', 'formatVersion', 'exportedAt', 'data'], '$');
    if (envelope.format !== BACKUP_FORMAT) fail('INVALID_BACKUP_FORMAT', '$.format');
    if (envelope.formatVersion !== BACKUP_FORMAT_VERSION) fail('UNSUPPORTED_BACKUP_VERSION', '$.formatVersion');
    expectTimestamp(envelope.exportedAt, '$.exportedAt');
    validateActive(envelope.data);
    const data = clone(envelope.data);
    return { format: envelope.format, formatVersion: envelope.formatVersion, exportedAt: envelope.exportedAt, data };
  }

  function buildSnapshot(data, metadata) {
    if (!isPlainObject(metadata)) fail('EXPECTED_OBJECT', '$.metadata');
    expectExactKeys(metadata, ['createdAt', 'localDate', 'reason'], '$.metadata');
    const { createdAt, localDate, reason } = metadata;
    expectTimestamp(createdAt, '$.createdAt');
    if (typeof localDate !== 'string') fail('INVALID_DATE', '$.localDate');
    expectDate(localDate, '$.localDate');
    if (!SNAPSHOT_REASONS.has(reason)) fail('INVALID_SNAPSHOT_REASON', '$.reason');
    return {
      format: SNAPSHOT_FORMAT,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      createdAt,
      localDate,
      reason,
      data: migrateActive(data)
    };
  }

  function parseSnapshot(text) {
    const envelope = parseJson(text, '$');
    clone(envelope);
    expectExactKeys(envelope, ['format', 'formatVersion', 'createdAt', 'localDate', 'reason', 'data'], '$');
    if (envelope.format !== SNAPSHOT_FORMAT) fail('INVALID_SNAPSHOT_FORMAT', '$.format');
    if (envelope.formatVersion !== SNAPSHOT_FORMAT_VERSION) fail('UNSUPPORTED_SNAPSHOT_VERSION', '$.formatVersion');
    expectTimestamp(envelope.createdAt, '$.createdAt');
    if (typeof envelope.localDate !== 'string') fail('INVALID_DATE', '$.localDate');
    expectDate(envelope.localDate, '$.localDate');
    if (!SNAPSHOT_REASONS.has(envelope.reason)) fail('INVALID_SNAPSHOT_REASON', '$.reason');
    validateActive(envelope.data);
    const data = clone(envelope.data);
    return {
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      createdAt: envelope.createdAt,
      localDate: envelope.localDate,
      reason: envelope.reason,
      data
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    V2_SCHEMA_VERSION,
    BACKUP_FORMAT,
    BACKUP_FORMAT_VERSION,
    SNAPSHOT_FORMAT,
    SNAPSHOT_FORMAT_VERSION,
    DataError,
    clone,
    migrateActive,
    migrateToV2,
    validateActive,
    validateV2,
    parseActive,
    buildBackup,
    parseBackup,
    buildSnapshot,
    parseSnapshot
  });
});
