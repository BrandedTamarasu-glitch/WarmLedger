(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetDataHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function result(value) { return freeze(clone(value)); }
  function nextMonth(monthKey) {
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5));
    return `${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
  }
  function manualPattern(kind, record) {
    const datePattern = record.date === '' ? '' : record.date.slice(8);
    if (kind === 'income') return JSON.stringify({ earnerId: record.earnerId,
      plannedAmount: record.plannedAmount, datePattern });
    return JSON.stringify({ categoryId: record.categoryId, categoryItemId: record.categoryItemId,
      name: record.name, plannedAmount: record.plannedAmount, paymentMethod: record.paymentMethod, datePattern });
  }

  function analyze(data) {
    const missingActuals = [];
    const missingDates = [];
    const fundingMismatches = [];
    const patterns = new Map();
    const monthKeys = Object.keys(data.months).sort();
    const nonempty = [];
    for (const monthKey of monthKeys) {
      const month = data.months[monthKey];
      if (month.paychecks.length || month.expenses.length) nonempty.push(monthKey);
      for (const [kind, records] of [['income', month.paychecks], ['expense', month.expenses]]) {
        for (const record of records) {
          const reference = { kind, monthKey, recordId: record.id };
          if (record.actualAmount === null) missingActuals.push(reference);
          if (record.date === '') missingDates.push(reference);
          if (kind === 'expense') {
            const fundedAmount = Object.values(record.paycheckAmounts).reduce((sum, amount) => sum + amount, 0);
            const difference = fundedAmount - record.plannedAmount;
            if (Math.abs(difference) > 0.009 + (Number.EPSILON * 64)) {
              fundingMismatches.push({ ...reference, fundedAmount, plannedAmount: record.plannedAmount, difference });
            }
          }
          if (record.sourceTemplateId === null && record.occurrenceKey === null) {
            const signature = manualPattern(kind, record);
            const key = `${kind}\u0000${signature}`;
            if (!patterns.has(key)) patterns.set(key, { kind, signature, months: new Set(), occurrences: [] });
            const pattern = patterns.get(key);
            pattern.months.add(monthKey);
            pattern.occurrences.push(reference);
          }
        }
      }
    }
    const absentMonths = [];
    if (nonempty.length > 1) {
      let cursor = nonempty[0];
      while ((cursor = nextMonth(cursor)) < nonempty.at(-1)) {
        if (!Object.hasOwn(data.months, cursor)) absentMonths.push(cursor);
      }
    }
    const repeatedManualPatterns = [...patterns.values()]
      .filter(pattern => pattern.months.size >= 3)
      .map(pattern => ({ kind: pattern.kind, signature: pattern.signature,
        monthKeys: [...pattern.months].sort(), occurrences: pattern.occurrences }));
    return result({ missingActuals, missingDates, fundingMismatches, absentMonths, repeatedManualPatterns,
      counts: { missingActuals: missingActuals.length, missingDates: missingDates.length,
        fundingMismatches: fundingMismatches.length, absentMonths: absentMonths.length,
        repeatedManualPatterns: repeatedManualPatterns.length } });
  }

  return Object.freeze({ analyze });
});
