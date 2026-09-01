(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const SCHEMA_VERSION = 3;
  const V2_SCHEMA_VERSION = 2;
  const V3_SCHEMA_VERSION = 3;
  const V4_SCHEMA_VERSION = 4;
  const V5_SCHEMA_VERSION = 5;
  const LEGACY_SCHEMA_VERSION = 1;
  const BACKUP_FORMAT = 'zerobudget-backup';
  const BACKUP_FORMAT_VERSION = 1;
  const SNAPSHOT_FORMAT = 'zerobudget-snapshot';
  const SNAPSHOT_FORMAT_VERSION = 1;
  const MAX_MONEY = 1_000_000_000_000;
  const MAX_MONEY_CENTS = MAX_MONEY * 100;
  const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const PAYMENT_METHODS = new Set(['bank', 'credit_card', 'savings', 'investments']);
  const ALLOCATION_KEYS = ['savings', 'credit_card_debt', 'investments'];
  const V3_PAYCHECK_KEYS = ['id', 'earnerId', 'earner', 'plannedAmount', 'actualAmount', 'date', 'sourceTemplateId', 'occurrenceKey'];
  const V3_EXPENSE_KEYS = ['id', 'categoryId', 'category', 'categoryItemId', 'name', 'date', 'paycheckAmounts', 'plannedAmount', 'actualAmount', 'paymentMethod', 'sourceTemplateId', 'occurrenceKey'];
  const SNAPSHOT_REASONS = new Set(['daily', 'pre-import', 'pre-sharding', 'pre-reset']);
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

  function expectMoneyCents(value, path, positive = false) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('INVALID_CENTS', path);
    if (value < 0 || value > MAX_MONEY_CENTS || (positive && value === 0)) fail('CENTS_OUT_OF_RANGE', path);
  }

  function decimalMoneyToCents(value, path = '$') {
    expectMoney(value, path);
    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
    if (!match) fail('INVALID_AMOUNT', path);
    const fraction = match[2] || '';
    const exponent = match[3] === undefined ? 0 : Number(match[3]);
    if (!Number.isSafeInteger(exponent)) fail('INVALID_AMOUNT', path);
    const coefficient = BigInt(`${match[1]}${fraction}`);
    const centsScale = fraction.length - exponent - 2;
    let cents;
    if (centsScale <= 0) {
      cents = coefficient * (10n ** BigInt(-centsScale));
    } else {
      const divisor = 10n ** BigInt(centsScale);
      if (coefficient % divisor !== 0n) fail('SUB_CENT_AMOUNT', path);
      cents = coefficient / divisor;
    }
    if (cents > BigInt(MAX_MONEY_CENTS)) fail('CENTS_OUT_OF_RANGE', path);
    return Number(cents);
  }

  function centsToDecimalMoney(value, path = '$') {
    expectMoneyCents(value, path);
    return value / 100;
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

  function validateV1(input) {
    clone(input);
    expectExactKeys(input, ['schemaVersion', 'categories', 'settings', 'months'], '$');
    if (input.schemaVersion !== LEGACY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');

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

  function expectBoolean(value, path) {
    if (typeof value !== 'boolean') fail('EXPECTED_BOOLEAN', path);
  }

  function expectOccurrenceKey(value, path) {
    expectString(value, path, 15);
    const match = /^(\d{4}-\d{2}-\d{2})#(\d{4})$/.exec(value);
    if (!match || Number(match[2]) < 1) fail('INVALID_OCCURRENCE_KEY', path);
    expectDate(match[1], path);
  }

  function validateRecurrence(recurrence, path) {
    expectObject(recurrence, path);
    if (recurrence.cadence === 'monthly') {
      expectExactKeys(recurrence, ['cadence', 'day'], path);
      if (!Number.isInteger(recurrence.day) || recurrence.day < 1 || recurrence.day > 31) fail('INVALID_RECURRENCE_DAY', `${path}.day`);
      return;
    }
    if (recurrence.cadence === 'twice-monthly') {
      expectExactKeys(recurrence, ['cadence', 'days'], path);
      expectArray(recurrence.days, `${path}.days`, 2);
      if (recurrence.days.length !== 2 || !recurrence.days.every(day => Number.isInteger(day) && day >= 1 && day <= 31) ||
          recurrence.days[0] >= recurrence.days[1]) fail('INVALID_RECURRENCE_DAYS', `${path}.days`);
      return;
    }
    if (recurrence.cadence === 'weekly' || recurrence.cadence === 'biweekly') {
      expectExactKeys(recurrence, ['cadence', 'anchorDate'], path);
      if (typeof recurrence.anchorDate !== 'string') fail('INVALID_DATE', `${path}.anchorDate`);
      expectDate(recurrence.anchorDate, `${path}.anchorDate`);
      return;
    }
    fail('INVALID_RECURRENCE_CADENCE', `${path}.cadence`);
  }

  function validateTemplateDates(template, path) {
    if (typeof template.startDate !== 'string') fail('INVALID_DATE', `${path}.startDate`);
    expectDate(template.startDate, `${path}.startDate`);
    if (template.endDate !== null) {
      if (typeof template.endDate !== 'string') fail('INVALID_DATE', `${path}.endDate`);
      expectDate(template.endDate, `${path}.endDate`);
      if (template.endDate < template.startDate) fail('INVALID_DATE_RANGE', `${path}.endDate`);
    }
  }

  function validateV3(input) {
    clone(input);
    expectExactKeys(input, ['schemaVersion', 'categories', 'settings', 'templates', 'months'], '$');
    if (input.schemaVersion !== V3_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    validateV2({ schemaVersion: V2_SCHEMA_VERSION, categories: input.categories, settings: input.settings, months: {} });

    const earners = new Set(input.settings.earners.map(earner => earner.id));
    const categories = new Map(input.categories.map(category => [category.id, new Set(category.items.map(item => item.id))]));
    expectExactKeys(input.templates, ['income', 'expenses'], '$.templates');
    expectArray(input.templates.income, '$.templates.income', 500);
    expectArray(input.templates.expenses, '$.templates.expenses', 5000);
    const templateIds = new Set();
    const incomeTemplateIds = new Set();
    const expenseTemplateIds = new Set();
    input.templates.income.forEach((template, index) => {
      const path = `$.templates.income[${index}]`;
      expectExactKeys(template, ['id', 'name', 'earnerId', 'plannedAmount', 'enabled', 'archived', 'startDate', 'endDate', 'recurrence'], path);
      expectIdentifier(template.id, `${path}.id`);
      if (templateIds.has(template.id)) fail('DUPLICATE_ID', `${path}.id`);
      templateIds.add(template.id); incomeTemplateIds.add(template.id);
      expectString(template.name, `${path}.name`, 120);
      expectIdentifier(template.earnerId, `${path}.earnerId`);
      if (!earners.has(template.earnerId)) fail('DANGLING_EARNER_REFERENCE', `${path}.earnerId`);
      expectMoney(template.plannedAmount, `${path}.plannedAmount`);
      expectBoolean(template.enabled, `${path}.enabled`); expectBoolean(template.archived, `${path}.archived`);
      validateTemplateDates(template, path); validateRecurrence(template.recurrence, `${path}.recurrence`);
    });
    input.templates.expenses.forEach((template, index) => {
      const path = `$.templates.expenses[${index}]`;
      expectExactKeys(template, ['id', 'name', 'categoryId', 'categoryItemId', 'plannedAmount', 'paymentMethod', 'enabled', 'archived', 'startDate', 'endDate', 'recurrence'], path);
      expectIdentifier(template.id, `${path}.id`);
      if (templateIds.has(template.id)) fail('DUPLICATE_ID', `${path}.id`);
      templateIds.add(template.id); expenseTemplateIds.add(template.id);
      expectString(template.name, `${path}.name`, 120);
      expectIdentifier(template.categoryId, `${path}.categoryId`);
      const itemIds = categories.get(template.categoryId);
      if (!itemIds) fail('DANGLING_CATEGORY_REFERENCE', `${path}.categoryId`);
      if (template.categoryItemId !== null) {
        expectIdentifier(template.categoryItemId, `${path}.categoryItemId`);
        if (!itemIds.has(template.categoryItemId)) fail('DANGLING_CATEGORY_ITEM_REFERENCE', `${path}.categoryItemId`);
      }
      expectMoney(template.plannedAmount, `${path}.plannedAmount`);
      if (!PAYMENT_METHODS.has(template.paymentMethod)) fail('INVALID_PAYMENT_METHOD', `${path}.paymentMethod`);
      expectBoolean(template.enabled, `${path}.enabled`); expectBoolean(template.archived, `${path}.archived`);
      validateTemplateDates(template, path); validateRecurrence(template.recurrence, `${path}.recurrence`);
    });

    expectObject(input.months, '$.months');
    const monthKeys = Object.keys(input.months);
    if (monthKeys.length > 600) fail('TOO_MANY_ITEMS', '$.months');
    for (const monthKey of monthKeys) {
      const path = childPath('$.months', monthKey);
      if (BLOCKED_KEYS.has(monthKey)) fail('UNSAFE_KEY', path);
      expectMonth(monthKey, path);
      const month = input.months[monthKey];
      expectExactKeys(month, ['paychecks', 'expenses', 'allocations', 'suppressedOccurrences'], path);
      expectArray(month.paychecks, `${path}.paychecks`, 500);
      expectArray(month.expenses, `${path}.expenses`, 5000);
      expectArray(month.suppressedOccurrences, `${path}.suppressedOccurrences`, 5000);
      const paycheckIds = new Set(); const monthlyIds = new Set(); const occurrencePairs = new Set();
      let incomePlanned = 0; let incomeActual = 0;
      const validateProvenance = (record, recordPath, matchingTemplates) => {
        const bothNull = record.sourceTemplateId === null && record.occurrenceKey === null;
        const bothStrings = typeof record.sourceTemplateId === 'string' && typeof record.occurrenceKey === 'string';
        if (!bothNull && !bothStrings) fail('INVALID_PROVENANCE_PAIR', `${recordPath}.sourceTemplateId`);
        if (bothNull) return;
        expectIdentifier(record.sourceTemplateId, `${recordPath}.sourceTemplateId`);
        if (!matchingTemplates.has(record.sourceTemplateId)) fail('DANGLING_TEMPLATE_REFERENCE', `${recordPath}.sourceTemplateId`);
        expectOccurrenceKey(record.occurrenceKey, `${recordPath}.occurrenceKey`);
        if (record.occurrenceKey.slice(0, 7) !== monthKey) fail('OCCURRENCE_MONTH_MISMATCH', `${recordPath}.occurrenceKey`);
        if (record.date !== record.occurrenceKey.slice(0, 10)) fail('GENERATED_DATE_MISMATCH', `${recordPath}.date`);
        const pair = `${record.sourceTemplateId}\u0000${record.occurrenceKey}`;
        if (occurrencePairs.has(pair)) fail('DUPLICATE_OCCURRENCE', `${recordPath}.occurrenceKey`);
        occurrencePairs.add(pair);
      };
      month.paychecks.forEach((paycheck, index) => {
        const itemPath = `${path}.paychecks[${index}]`;
        expectExactKeys(paycheck, ['id', 'earnerId', 'earner', 'plannedAmount', 'actualAmount', 'date', 'sourceTemplateId', 'occurrenceKey'], itemPath);
        expectIdentifier(paycheck.id, `${itemPath}.id`); expectIdentifier(paycheck.earnerId, `${itemPath}.earnerId`);
        if (!earners.has(paycheck.earnerId)) fail('DANGLING_EARNER_REFERENCE', `${itemPath}.earnerId`);
        expectString(paycheck.earner, `${itemPath}.earner`, 120);
        expectMoney(paycheck.plannedAmount, `${itemPath}.plannedAmount`);
        if (paycheck.actualAmount !== null) expectMoney(paycheck.actualAmount, `${itemPath}.actualAmount`);
        if (typeof paycheck.date !== 'string') fail('INVALID_DATE', `${itemPath}.date`);
        expectDate(paycheck.date, `${itemPath}.date`, true);
        if (paycheck.date !== '' && paycheck.date.slice(0, 7) !== monthKey) fail('RECORD_MONTH_MISMATCH', `${itemPath}.date`);
        if (monthlyIds.has(paycheck.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        monthlyIds.add(paycheck.id); paycheckIds.add(paycheck.id);
        incomePlanned += paycheck.plannedAmount; incomeActual += paycheck.actualAmount || 0;
        if (incomePlanned > MAX_MONEY || incomeActual > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.paychecks`);
        validateProvenance(paycheck, itemPath, incomeTemplateIds);
      });
      let expensePlanned = 0; let expenseActual = 0;
      month.expenses.forEach((expense, index) => {
        const itemPath = `${path}.expenses[${index}]`;
        expectExactKeys(expense, ['id', 'categoryId', 'category', 'categoryItemId', 'name', 'date', 'paycheckAmounts', 'plannedAmount', 'actualAmount', 'paymentMethod', 'sourceTemplateId', 'occurrenceKey'], itemPath);
        expectIdentifier(expense.id, `${itemPath}.id`); expectIdentifier(expense.categoryId, `${itemPath}.categoryId`);
        const itemIds = categories.get(expense.categoryId);
        if (!itemIds) fail('DANGLING_CATEGORY_REFERENCE', `${itemPath}.categoryId`);
        expectString(expense.category, `${itemPath}.category`, 120);
        if (expense.categoryItemId !== null) {
          expectIdentifier(expense.categoryItemId, `${itemPath}.categoryItemId`);
          if (!itemIds.has(expense.categoryItemId)) fail('DANGLING_CATEGORY_ITEM_REFERENCE', `${itemPath}.categoryItemId`);
        }
        expectString(expense.name, `${itemPath}.name`, 120);
        if (typeof expense.date !== 'string') fail('INVALID_DATE', `${itemPath}.date`);
        expectDate(expense.date, `${itemPath}.date`, true);
        if (expense.date !== '' && expense.date.slice(0, 7) !== monthKey) fail('RECORD_MONTH_MISMATCH', `${itemPath}.date`);
        if (monthlyIds.has(expense.id)) fail('DUPLICATE_ID', `${itemPath}.id`);
        monthlyIds.add(expense.id); expectObject(expense.paycheckAmounts, `${itemPath}.paycheckAmounts`);
        let allocated = 0;
        for (const paycheckId of Object.keys(expense.paycheckAmounts)) {
          const amountPath = childPath(`${itemPath}.paycheckAmounts`, paycheckId);
          if (BLOCKED_KEYS.has(paycheckId)) fail('UNSAFE_KEY', amountPath);
          if (!paycheckIds.has(paycheckId)) fail('DANGLING_PAYCHECK_REFERENCE', amountPath);
          expectMoney(expense.paycheckAmounts[paycheckId], amountPath); allocated += expense.paycheckAmounts[paycheckId];
          if (allocated > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${itemPath}.paycheckAmounts`);
        }
        expectMoney(expense.plannedAmount, `${itemPath}.plannedAmount`);
        if (allocated > expense.plannedAmount) fail('ALLOCATION_EXCEEDS_PLANNED', `${itemPath}.paycheckAmounts`);
        if (expense.actualAmount !== null) expectMoney(expense.actualAmount, `${itemPath}.actualAmount`);
        if (!PAYMENT_METHODS.has(expense.paymentMethod)) fail('INVALID_PAYMENT_METHOD', `${itemPath}.paymentMethod`);
        expensePlanned += expense.plannedAmount; expenseActual += expense.actualAmount || 0;
        if (expensePlanned > MAX_MONEY || expenseActual > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.expenses`);
        validateProvenance(expense, itemPath, expenseTemplateIds);
      });
      month.suppressedOccurrences.forEach((entry, index) => {
        const itemPath = `${path}.suppressedOccurrences[${index}]`;
        expectExactKeys(entry, ['sourceTemplateId', 'occurrenceKey'], itemPath);
        expectIdentifier(entry.sourceTemplateId, `${itemPath}.sourceTemplateId`);
        if (!templateIds.has(entry.sourceTemplateId)) fail('DANGLING_TEMPLATE_REFERENCE', `${itemPath}.sourceTemplateId`);
        expectOccurrenceKey(entry.occurrenceKey, `${itemPath}.occurrenceKey`);
        if (entry.occurrenceKey.slice(0, 7) !== monthKey) fail('OCCURRENCE_MONTH_MISMATCH', `${itemPath}.occurrenceKey`);
        const pair = `${entry.sourceTemplateId}\u0000${entry.occurrenceKey}`;
        if (occurrencePairs.has(pair)) fail('DUPLICATE_OCCURRENCE', `${itemPath}.occurrenceKey`);
        occurrencePairs.add(pair);
      });
      expectExactKeys(month.allocations, ALLOCATION_KEYS, `${path}.allocations`);
      let allocationTotal = 0;
      for (const key of ALLOCATION_KEYS) {
        expectMoney(month.allocations[key], `${path}.allocations.${key}`); allocationTotal += month.allocations[key];
        if (allocationTotal > MAX_MONEY) fail('AGGREGATE_OUT_OF_RANGE', `${path}.allocations`);
      }
    }
    return true;
  }

  function transformV3Money(input, transform, schemaVersion) {
    const output = clone(input);
    expectExactKeys(output, ['schemaVersion', 'categories', 'settings', 'templates', 'months'], '$');
    expectObject(output.templates, '$.templates');
    expectArray(output.templates.income, '$.templates.income', 500);
    expectArray(output.templates.expenses, '$.templates.expenses', 5000);
    expectObject(output.months, '$.months');
    output.schemaVersion = schemaVersion;
    output.templates.income.forEach((template, index) => {
      template.plannedAmount = transform(template.plannedAmount, `$.templates.income[${index}].plannedAmount`);
    });
    output.templates.expenses.forEach((template, index) => {
      template.plannedAmount = transform(template.plannedAmount, `$.templates.expenses[${index}].plannedAmount`);
    });
    for (const [monthKey, month] of Object.entries(output.months)) {
      const monthPath = childPath('$.months', monthKey);
      expectObject(month, monthPath);
      expectArray(month.paychecks, `${monthPath}.paychecks`, 500);
      expectArray(month.expenses, `${monthPath}.expenses`, 5000);
      expectObject(month.allocations, `${monthPath}.allocations`);
      month.paychecks.forEach((paycheck, index) => {
        const path = `${monthPath}.paychecks[${index}]`;
        paycheck.plannedAmount = transform(paycheck.plannedAmount, `${path}.plannedAmount`);
        if (paycheck.actualAmount !== null) {
          paycheck.actualAmount = transform(paycheck.actualAmount, `${path}.actualAmount`);
        }
      });
      month.expenses.forEach((expense, index) => {
        const path = `${monthPath}.expenses[${index}]`;
        for (const paycheckId of Object.keys(expense.paycheckAmounts)) {
          const amountPath = childPath(`${path}.paycheckAmounts`, paycheckId);
          expense.paycheckAmounts[paycheckId] = transform(expense.paycheckAmounts[paycheckId], amountPath);
        }
        expense.plannedAmount = transform(expense.plannedAmount, `${path}.plannedAmount`);
        if (expense.actualAmount !== null) {
          expense.actualAmount = transform(expense.actualAmount, `${path}.actualAmount`);
        }
      });
      for (const key of ALLOCATION_KEYS) {
        month.allocations[key] = transform(month.allocations[key], `${monthPath}.allocations.${key}`);
      }
    }
    return output;
  }

  function hydrateV4ExactMoney(input) {
    clone(input);
    if (!isPlainObject(input) || input.schemaVersion !== V4_SCHEMA_VERSION) {
      fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    }
    const hydrated = transformV3Money(input, centsToDecimalMoney, V3_SCHEMA_VERSION);
    validateV3(hydrated);
    return clone(hydrated);
  }

  function validateV4(input) {
    hydrateV4ExactMoney(input);
    return true;
  }

  function dehydrateV4ExactMoney(input) {
    validateV3(input);
    const persisted = transformV3Money(input, decimalMoneyToCents, V4_SCHEMA_VERSION);
    validateV4(persisted);
    return clone(persisted);
  }

  function migrateV3ToV4ExactMoney(input) {
    return dehydrateV4ExactMoney(input);
  }

  function validateV5Shape(input, persisted) {
    clone(input);
    const expectedVersion = persisted ? V5_SCHEMA_VERSION : V3_SCHEMA_VERSION;
    if (!isPlainObject(input) || input.schemaVersion !== expectedVersion) {
      fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    }
    expectExactKeys(input, ['schemaVersion', 'categories', 'settings', 'templates', 'months'], '$');
    expectObject(input.months, '$.months');
    for (const [monthKey, month] of Object.entries(input.months)) {
      const monthPath = childPath('$.months', monthKey);
      expectObject(month, monthPath);
      expectArray(month.paychecks, `${monthPath}.paychecks`, 500);
      expectArray(month.expenses, `${monthPath}.expenses`, 5000);
      month.paychecks.forEach((paycheck, index) => {
        const path = `${monthPath}.paychecks[${index}]`;
        expectExactKeys(paycheck, [...V3_PAYCHECK_KEYS, 'cleared'], path);
        expectBoolean(paycheck.cleared, `${path}.cleared`);
      });
      month.expenses.forEach((expense, index) => {
        const path = `${monthPath}.expenses[${index}]`;
        expectExactKeys(expense, [...V3_EXPENSE_KEYS, 'cleared'], path);
        expectBoolean(expense.cleared, `${path}.cleared`);
      });
    }
    const base = clone(input);
    base.schemaVersion = persisted ? V4_SCHEMA_VERSION : V3_SCHEMA_VERSION;
    for (const month of Object.values(base.months)) {
      month.paychecks.forEach(paycheck => { delete paycheck.cleared; });
      month.expenses.forEach(expense => { delete expense.cleared; });
    }
    if (persisted) validateV4(base); else validateV3(base);
    return true;
  }

  function validateV5(input) {
    return validateV5Shape(input, true);
  }

  function migrateV4ToV5(input) {
    validateV4(input);
    const migrated = clone(input);
    migrated.schemaVersion = V5_SCHEMA_VERSION;
    for (const month of Object.values(migrated.months)) {
      month.paychecks.forEach(paycheck => { paycheck.cleared = false; });
      month.expenses.forEach(expense => { expense.cleared = false; });
    }
    validateV5(migrated);
    return clone(migrated);
  }

  function hydrateV5ExactMoney(input) {
    validateV5(input);
    const hydrated = transformV3Money(input, centsToDecimalMoney, V3_SCHEMA_VERSION);
    validateV5Shape(hydrated, false);
    return clone(hydrated);
  }

  function dehydrateV5ExactMoney(input) {
    validateV5Shape(input, false);
    const persisted = transformV3Money(input, decimalMoneyToCents, V5_SCHEMA_VERSION);
    validateV5(persisted);
    return clone(persisted);
  }

  function migrateToV1(input) {
    const migrated = clone(input);
    if (!isPlainObject(migrated)) fail('EXPECTED_OBJECT', '$');
    if (Object.hasOwn(migrated, 'schemaVersion')) {
      if (migrated.schemaVersion !== LEGACY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
      validateV1(migrated);
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
    migrated.schemaVersion = LEGACY_SCHEMA_VERSION;
    validateV1(migrated);
    return clone(migrated);
  }

  function migrateToV2(input) {
    const source = clone(input);
    if (!isPlainObject(source)) fail('EXPECTED_OBJECT', '$');
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion === V2_SCHEMA_VERSION) {
      validateV2(source);
      return clone(source);
    }
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion !== LEGACY_SCHEMA_VERSION) {
      fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    }
    const active = migrateToV1(source);
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

  function migrateToV3(input) {
    const source = clone(input);
    if (!isPlainObject(source)) fail('EXPECTED_OBJECT', '$');
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion === V3_SCHEMA_VERSION) {
      validateV3(source);
      return clone(source);
    }
    if (Object.hasOwn(source, 'schemaVersion') && source.schemaVersion !== V2_SCHEMA_VERSION &&
        source.schemaVersion !== LEGACY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
    const v2 = migrateToV2(source);
    const months = {};
    for (const [monthKey, month] of Object.entries(v2.months)) {
      months[monthKey] = {
        paychecks: month.paychecks.map(paycheck => ({
          id: paycheck.id,
          earnerId: paycheck.earnerId,
          earner: paycheck.earner,
          plannedAmount: paycheck.amount,
          actualAmount: paycheck.amount,
          date: paycheck.date === '' || paycheck.date.slice(0, 7) === monthKey ? paycheck.date : '',
          sourceTemplateId: null,
          occurrenceKey: null
        })),
        expenses: month.expenses.map(expense => ({
          id: expense.id,
          categoryId: expense.categoryId,
          category: expense.category,
          categoryItemId: expense.categoryItemId,
          name: expense.name,
          date: '',
          paycheckAmounts: clone(expense.paycheckAmounts),
          plannedAmount: Object.values(expense.paycheckAmounts).reduce((sum, amount) => sum + amount, 0),
          actualAmount: expense.actual === 0 ? null : expense.actual,
          paymentMethod: expense.paymentMethod,
          sourceTemplateId: null,
          occurrenceKey: null
        })),
        allocations: clone(month.allocations),
        suppressedOccurrences: []
      };
    }
    const migrated = {
      schemaVersion: V3_SCHEMA_VERSION,
      categories: clone(v2.categories),
      settings: clone(v2.settings),
      templates: { income: [], expenses: [] },
      months
    };
    validateV3(migrated);
    return clone(migrated);
  }

  function validateActive(input) {
    return validateV3(input);
  }

  function migrateActive(input) {
    return migrateToV3(input);
  }

  function parseJson(text, path) {
    if (typeof text !== 'string') fail('EXPECTED_JSON_TEXT', path);
    try {
      return JSON.parse(text);
    } catch (error) {
      fail('INVALID_JSON', path, error);
    }
  }

  function parseCanonical(text, migrate) {
    return migrate(parseJson(text, '$'));
  }

  function buildCanonicalBackup(data, exportedAt, migrate) {
    const canonical = migrate(data);
    expectTimestamp(exportedAt, '$.exportedAt');
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt,
      data: canonical
    };
  }

  function parseCanonicalBackup(text, migrate) {
    const envelope = parseJson(text, '$');
    clone(envelope);
    expectExactKeys(envelope, ['format', 'formatVersion', 'exportedAt', 'data'], '$');
    if (envelope.format !== BACKUP_FORMAT) fail('INVALID_BACKUP_FORMAT', '$.format');
    if (envelope.formatVersion !== BACKUP_FORMAT_VERSION) fail('UNSUPPORTED_BACKUP_VERSION', '$.formatVersion');
    expectTimestamp(envelope.exportedAt, '$.exportedAt');
    const data = migrate(envelope.data);
    return { format: envelope.format, formatVersion: envelope.formatVersion, exportedAt: envelope.exportedAt, data };
  }

  function buildCanonicalSnapshot(data, metadata, migrate) {
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
      data: migrate(data)
    };
  }

  function parseCanonicalSnapshot(text, migrate) {
    const envelope = parseJson(text, '$');
    clone(envelope);
    expectExactKeys(envelope, ['format', 'formatVersion', 'createdAt', 'localDate', 'reason', 'data'], '$');
    if (envelope.format !== SNAPSHOT_FORMAT) fail('INVALID_SNAPSHOT_FORMAT', '$.format');
    if (envelope.formatVersion !== SNAPSHOT_FORMAT_VERSION) fail('UNSUPPORTED_SNAPSHOT_VERSION', '$.formatVersion');
    expectTimestamp(envelope.createdAt, '$.createdAt');
    if (typeof envelope.localDate !== 'string') fail('INVALID_DATE', '$.localDate');
    expectDate(envelope.localDate, '$.localDate');
    if (!SNAPSHOT_REASONS.has(envelope.reason)) fail('INVALID_SNAPSHOT_REASON', '$.reason');
    const data = migrate(envelope.data);
    return {
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      createdAt: envelope.createdAt,
      localDate: envelope.localDate,
      reason: envelope.reason,
      data
    };
  }

  function parseActive(text) { return parseCanonical(text, migrateActive); }
  function buildBackup(data, exportedAt) { return buildCanonicalBackup(data, exportedAt, migrateActive); }
  function parseBackup(text) { return parseCanonicalBackup(text, migrateActive); }
  function buildSnapshot(data, metadata) { return buildCanonicalSnapshot(data, metadata, migrateActive); }
  function parseSnapshot(text) { return parseCanonicalSnapshot(text, migrateActive); }

  function parseV3Active(text) { return parseCanonical(text, migrateToV3); }
  function buildV3Backup(data, exportedAt) { return buildCanonicalBackup(data, exportedAt, migrateToV3); }
  function parseV3Backup(text) { return parseCanonicalBackup(text, migrateToV3); }
  function buildV3Snapshot(data, metadata) { return buildCanonicalSnapshot(data, metadata, migrateToV3); }
  function parseV3Snapshot(text) { return parseCanonicalSnapshot(text, migrateToV3); }

  function canonicalizeV4(input) {
    if (isPlainObject(input) && input.schemaVersion === V4_SCHEMA_VERSION) {
      validateV4(input);
      return clone(input);
    }
    return dehydrateV4ExactMoney(input);
  }

  function parseV4Active(text) {
    const persisted = parseJson(text, '$');
    validateV4(persisted);
    return hydrateV4ExactMoney(persisted);
  }

  function buildV4Backup(data, exportedAt) {
    return buildCanonicalBackup(data, exportedAt, canonicalizeV4);
  }

  function parseV4Backup(text) {
    const envelope = parseCanonicalBackup(text, canonicalizeV4);
    return { ...envelope, data: hydrateV4ExactMoney(envelope.data) };
  }

  function buildV4Snapshot(data, metadata) {
    return buildCanonicalSnapshot(data, metadata, canonicalizeV4);
  }

  function parseV4Snapshot(text) {
    const envelope = parseCanonicalSnapshot(text, canonicalizeV4);
    return { ...envelope, data: hydrateV4ExactMoney(envelope.data) };
  }

  function canonicalizeV5(input) {
    if (isPlainObject(input) && input.schemaVersion === V5_SCHEMA_VERSION) {
      validateV5(input);
      return clone(input);
    }
    return dehydrateV5ExactMoney(input);
  }

  function parseV5Active(text) {
    const persisted = parseJson(text, '$');
    validateV5(persisted);
    return hydrateV5ExactMoney(persisted);
  }

  function buildV5Backup(data, exportedAt) {
    return buildCanonicalBackup(data, exportedAt, canonicalizeV5);
  }

  function parseV5Backup(text) {
    const envelope = parseCanonicalBackup(text, canonicalizeV5);
    return { ...envelope, data: hydrateV5ExactMoney(envelope.data) };
  }

  function buildV5Snapshot(data, metadata) {
    return buildCanonicalSnapshot(data, metadata, canonicalizeV5);
  }

  function parseV5Snapshot(text) {
    const envelope = parseCanonicalSnapshot(text, canonicalizeV5);
    return { ...envelope, data: hydrateV5ExactMoney(envelope.data) };
  }

  function parseActiveData(text) {
    const parsed = parseJson(text, '$');
    if (isPlainObject(parsed) && parsed.schemaVersion === V5_SCHEMA_VERSION) {
      validateV5(parsed);
      return hydrateV5ExactMoney(parsed);
    }
    if (isPlainObject(parsed) && parsed.schemaVersion === V4_SCHEMA_VERSION) {
      validateV4(parsed);
      return hydrateV4ExactMoney(parsed);
    }
    return migrateToV3(parsed);
  }

  function buildActiveData(data, residentSchemaVersion) {
    if (residentSchemaVersion === V3_SCHEMA_VERSION) return migrateToV3(data);
    if (residentSchemaVersion === V4_SCHEMA_VERSION) return canonicalizeV4(data);
    if (residentSchemaVersion === V5_SCHEMA_VERSION) return canonicalizeV5(data);
    fail('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion');
  }

  // Sharded persistence keeps the resident schema unchanged and merely splits
  // the canonical persisted record at its existing `months` boundary.
  function buildShardedFragments(data, residentSchemaVersion) {
    const persisted = buildActiveData(data, residentSchemaVersion);
    const monthOrder = Object.keys(persisted.months).sort();
    const global = clone({
      schemaVersion: persisted.schemaVersion,
      categories: persisted.categories,
      settings: persisted.settings,
      templates: persisted.templates
    });
    const months = Object.create(null);
    monthOrder.forEach(monthKey => { months[monthKey] = clone(persisted.months[monthKey]); });
    return Object.freeze({ global: Object.freeze(global), monthOrder: Object.freeze(monthOrder), months: Object.freeze(months) });
  }

  function validateShardedFragments(globalFragment, monthFragments, residentSchemaVersion) {
    clone(globalFragment);
    expectExactKeys(globalFragment, ['schemaVersion', 'categories', 'settings', 'templates'], '$.global');
    if (globalFragment.schemaVersion !== residentSchemaVersion || ![V3_SCHEMA_VERSION, V4_SCHEMA_VERSION, V5_SCHEMA_VERSION].includes(residentSchemaVersion)) {
      fail('UNSUPPORTED_SCHEMA_VERSION', '$.global.schemaVersion');
    }
    expectObject(monthFragments, '$.months');
    const monthKeys = Object.keys(monthFragments);
    if (monthKeys.length > 600) fail('TOO_MANY_ITEMS', '$.months');
    monthKeys.forEach(monthKey => {
      if (BLOCKED_KEYS.has(monthKey)) fail('UNSAFE_KEY', childPath('$.months', monthKey));
      expectMonth(monthKey, childPath('$.months', monthKey));
    });
    const persisted = clone({ ...globalFragment, months: monthFragments });
    // buildActiveData is the single resident-schema validator/canonicalizer.
    const canonical = buildActiveData(persisted, residentSchemaVersion);
    const canonicalKeys = Object.keys(canonical.months).sort();
    if (canonicalKeys.some((key, index) => key !== monthKeys.sort()[index])) fail('MONTH_REFERENCE_MISMATCH', '$.months');
    return buildShardedFragments(canonical, residentSchemaVersion);
  }

  function validateGlobalFragment(globalFragment, residentSchemaVersion) {
    return validateShardedFragments(globalFragment, {}, residentSchemaVersion).global;
  }

  function validateMonthFragment(globalFragment, monthKey, monthFragment, residentSchemaVersion) {
    expectMonth(monthKey, '$.monthKey');
    const months = Object.create(null);
    months[monthKey] = monthFragment;
    return validateShardedFragments(globalFragment, months, residentSchemaVersion).months[monthKey];
  }

  function assembleShardedActiveData(globalFragment, monthFragments, residentSchemaVersion) {
    const validated = validateShardedFragments(globalFragment, monthFragments, residentSchemaVersion);
    const persisted = { ...validated.global, months: validated.months };
    return parseActiveData(JSON.stringify(persisted));
  }

  const ACTIVE_SCHEMA_POLICY = Object.freeze({
    SCHEMA_VERSION,
    clone,
    DataError,
    migrateActive,
    validateActive,
    parseActive,
    buildBackup,
    parseBackup,
    buildSnapshot,
    parseSnapshot
  });
  const V3_SCHEMA_POLICY = Object.freeze({
    SCHEMA_VERSION: V3_SCHEMA_VERSION,
    clone,
    DataError,
    migrateActive: migrateToV3,
    validateActive: validateV3,
    parseActive: parseV3Active,
    buildBackup: buildV3Backup,
    parseBackup: parseV3Backup,
    buildSnapshot: buildV3Snapshot,
    parseSnapshot: parseV3Snapshot
  });
  const V4_SCHEMA_POLICY = Object.freeze({
    SCHEMA_VERSION: V4_SCHEMA_VERSION,
    clone,
    DataError,
    migrateActive: canonicalizeV4,
    validateActive: validateV4,
    parseActive: parseV4Active,
    buildBackup: buildV4Backup,
    parseBackup: parseV4Backup,
    buildSnapshot: buildV4Snapshot,
    parseSnapshot: parseV4Snapshot
  });
  const V5_SCHEMA_POLICY = Object.freeze({
    SCHEMA_VERSION: V5_SCHEMA_VERSION,
    clone,
    DataError,
    migrateActive: canonicalizeV5,
    validateActive: validateV5,
    parseActive: parseV5Active,
    buildBackup: buildV5Backup,
    parseBackup: parseV5Backup,
    buildSnapshot: buildV5Snapshot,
    parseSnapshot: parseV5Snapshot
  });

  return Object.freeze({
    SCHEMA_VERSION,
    V2_SCHEMA_VERSION,
    V3_SCHEMA_VERSION,
    V4_SCHEMA_VERSION,
    V5_SCHEMA_VERSION,
    BACKUP_FORMAT,
    BACKUP_FORMAT_VERSION,
    SNAPSHOT_FORMAT,
    SNAPSHOT_FORMAT_VERSION,
    ACTIVE_SCHEMA_POLICY,
    V3_SCHEMA_POLICY,
    V4_SCHEMA_POLICY,
    V5_SCHEMA_POLICY,
    DataError,
    clone,
    migrateActive,
    migrateToV2,
    migrateToV3,
    migrateV3ToV4ExactMoney,
    migrateV4ToV5,
    hydrateV4ExactMoney,
    dehydrateV4ExactMoney,
    hydrateV5ExactMoney,
    dehydrateV5ExactMoney,
    decimalMoneyToCents,
    centsToDecimalMoney,
    validateActive,
    validateV2,
    validateV3,
    validateV4,
    validateV5,
    parseActiveData,
    buildActiveData,
    buildShardedFragments,
    validateShardedFragments,
    validateGlobalFragment,
    validateMonthFragment,
    assembleShardedActiveData,
    parseV4Active,
    buildV4Backup,
    parseV4Backup,
    buildV4Snapshot,
    parseV4Snapshot,
    parseV5Active,
    buildV5Backup,
    parseV5Backup,
    buildV5Snapshot,
    parseV5Snapshot,
    parseActive,
    buildBackup,
    parseBackup,
    buildSnapshot,
    parseSnapshot
  });
});
