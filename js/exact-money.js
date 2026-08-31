(function(root, factory) {
  'use strict';
  const Schema = root && root.ZeroBudgetSchema ? root.ZeroBudgetSchema
    : (typeof require === 'function' ? require('./data-schema.js') : null);
  const api = factory(Schema);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetExactMoney = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Schema) {
  'use strict';
  if (!Schema || typeof Schema.validateV3 !== 'function') throw new Error('ZeroBudgetSchema is required');

  const FAMILY_NAMES = Object.freeze([
    'templatePlanned', 'paycheckPlanned', 'paycheckActual', 'expensePlanned',
    'expenseActual', 'paycheckFunding', 'allocations'
  ]);
  const MAX_MONEY = 1_000_000_000_000;

  function classify(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (value < 0 && !Object.is(value, -0)) || value > MAX_MONEY) {
      throw new TypeError('Money value is outside the schema-v3 domain');
    }
    const text = String(value);
    const match = /^-?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
    if (!match) throw new TypeError('Money value has no canonical decimal representation');
    const fraction = match[2] || '';
    const exponent = match[3] === undefined ? 0 : Number(match[3]);
    if (!Number.isSafeInteger(exponent)) throw new TypeError('Money exponent is outside the supported range');
    const scale = fraction.length - exponent;
    if (scale <= 2) return 'exact-cent';
    const coefficient = BigInt(`${match[1]}${fraction}`);
    const divisor = 10n ** BigInt(scale - 2);
    return coefficient % divisor === 0n ? 'exact-cent' : 'sub-cent';
  }

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  function emptyCount() { return { scannedValueCount: 0, exactCentValueCount: 0, subCentValueCount: 0 }; }

  function audit(data) {
    Schema.validateV3(data);
    const groups = {};
    for (const name of FAMILY_NAMES) groups[name] = emptyCount();
    let scannedValueCount = 0; let exactCentValueCount = 0; let subCentValueCount = 0;
    const affectedMonths = new Set(); const affectedTemplates = new Set();

    function scan(value, family, affectedSet, affectedKey) {
      const status = classify(value); const bucket = groups[family];
      scannedValueCount++; bucket.scannedValueCount++;
      if (status === 'exact-cent') { exactCentValueCount++; bucket.exactCentValueCount++; return; }
      subCentValueCount++; bucket.subCentValueCount++;
      if (affectedSet) affectedSet.add(affectedKey);
    }

    for (const template of data.templates.income) {
      scan(template.plannedAmount, 'templatePlanned', affectedTemplates, `income\u0000${template.id}`);
    }
    for (const template of data.templates.expenses) {
      scan(template.plannedAmount, 'templatePlanned', affectedTemplates, `expense\u0000${template.id}`);
    }
    for (const [monthKey, month] of Object.entries(data.months)) {
      for (const paycheck of month.paychecks) {
        scan(paycheck.plannedAmount, 'paycheckPlanned', affectedMonths, monthKey);
        if (paycheck.actualAmount !== null) scan(paycheck.actualAmount, 'paycheckActual', affectedMonths, monthKey);
      }
      for (const expense of month.expenses) {
        scan(expense.plannedAmount, 'expensePlanned', affectedMonths, monthKey);
        if (expense.actualAmount !== null) scan(expense.actualAmount, 'expenseActual', affectedMonths, monthKey);
        for (const paycheckId of Object.keys(expense.paycheckAmounts)) {
          scan(expense.paycheckAmounts[paycheckId], 'paycheckFunding', affectedMonths, monthKey);
        }
      }
      scan(month.allocations.savings, 'allocations', affectedMonths, monthKey);
      scan(month.allocations.credit_card_debt, 'allocations', affectedMonths, monthKey);
      scan(month.allocations.investments, 'allocations', affectedMonths, monthKey);
    }
    return deepFreeze({
      scannedValueCount, exactCentValueCount, subCentValueCount,
      affectedMonthCount: affectedMonths.size,
      affectedTemplateCount: affectedTemplates.size,
      groups
    });
  }

  return Object.freeze({ classify, audit });
});
