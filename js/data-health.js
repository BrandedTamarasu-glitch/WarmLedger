(function(root, factory) {
  'use strict';
  const Recurrence = root && root.ZeroBudgetRecurrence ? root.ZeroBudgetRecurrence
    : (typeof require === 'function' ? require('./recurrence.js') : null);
  const api = factory(Recurrence);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetDataHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Recurrence) {
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
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function shortKey(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
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

  function validateReferenceDate(value) {
    if (!Recurrence || typeof value !== 'string') throw new TypeError('Invalid reference date');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new RangeError('Invalid reference date');
    const month = Number(match[2]); const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > Recurrence.daysInMonth(Number(match[1]), month)) {
      throw new RangeError('Invalid reference date');
    }
    return value;
  }

  function sameRecurrence(left, right) { return stable(left) === stable(right); }

  function buildTemplateReadiness(data, referenceDate) {
    validateReferenceDate(referenceDate);
    const startMonth = referenceDate.slice(0, 7);
    const monthKeys = [startMonth, nextMonth(startMonth), nextMonth(nextMonth(startMonth))];
    const disabledTemplates = [];
    for (const [kind, templates] of [['income', data.templates.income], ['expense', data.templates.expenses]]) {
      for (const template of templates) {
        if (template.enabled || template.archived) continue;
        const hypothetical = { ...clone(template), enabled: true, archived: false };
        const dates = monthKeys.flatMap(monthKey => Recurrence.occurrencesForMonth(hypothetical, monthKey)
          .map(occurrence => occurrence.scheduledDate))
          .filter(date => date >= referenceDate).sort().slice(0, 3);
        const structure = kind === 'income' ? { earnerId: template.earnerId }
          : { categoryId: template.categoryId, categoryItemId: template.categoryItemId,
            paymentMethod: template.paymentMethod };
        const fingerprint = stable({ kind, template });
        disabledTemplates.push({
          kind, id: template.id, fingerprint, name: template.name, plannedAmount: template.plannedAmount,
          flags: { saved: true, disabled: true, archived: false },
          structure, schedule: { known: true, recurrence: clone(template.recurrence) },
          activeDates: { startDate: template.startDate, endDate: template.endDate },
          upcoming: { dates, reason: dates.length ? null : 'No occurrences in the three-month horizon.' }
        });
      }
    }

    const health = analyze(data); const suggestions = [];
    for (const pattern of health.repeatedManualPatterns) {
      const references = pattern.occurrences;
      const latest = references.reduce((selected, reference) =>
        !selected || reference.monthKey > selected.monthKey ? reference : selected, null);
      const month = data.months[latest.monthKey];
      const records = pattern.kind === 'income' ? month.paychecks : month.expenses;
      const record = records.find(item => item.id === latest.recordId);
      const dateKnown = record.date !== '';
      const recurrence = dateKnown ? { cadence: 'monthly', day: Number(record.date.slice(8)) } : null;
      const structure = pattern.kind === 'income' ? { earnerId: record.earnerId }
        : { categoryId: record.categoryId, categoryItemId: record.categoryItemId,
          paymentMethod: record.paymentMethod };
      const semantic = { kind: pattern.kind, name: pattern.kind === 'income' ? record.earner : record.name,
        structure, plannedAmount: record.plannedAmount, recurrence };
      const templates = pattern.kind === 'income' ? data.templates.income : data.templates.expenses;
      const duplicate = dateKnown && templates.some(template => template.name === semantic.name &&
        template.plannedAmount === semantic.plannedAmount && sameRecurrence(template.recurrence, recurrence) &&
        (pattern.kind === 'income' ? template.earnerId === structure.earnerId
          : template.categoryId === structure.categoryId && template.categoryItemId === structure.categoryItemId &&
            template.paymentMethod === structure.paymentMethod));
      if (duplicate) continue;
      const latestEvidenceMonth = pattern.monthKeys.at(-1);
      const startDate = dateKnown ? `${nextMonth(latestEvidenceMonth)}-01` : null;
      const upcomingDates = dateKnown ? monthKeys.flatMap(monthKey => Recurrence.occurrencesForMonth({
        enabled: true, archived: false, startDate, endDate: null, recurrence
      }, monthKey).map(occurrence => occurrence.scheduledDate))
        .filter(date => date >= referenceDate).sort().slice(0, 3) : [];
      const draft = pattern.kind === 'income'
        ? { name: semantic.name, earnerId: structure.earnerId, plannedAmount: record.plannedAmount,
          enabled: false, startDate, endDate: null, recurrence: clone(recurrence) }
        : { name: semantic.name, categoryId: structure.categoryId, categoryItemId: structure.categoryItemId,
          plannedAmount: record.plannedAmount, paymentMethod: structure.paymentMethod, enabled: false,
          startDate, endDate: null, recurrence: clone(recurrence) };
      const fingerprint = stable({ semantic, evidenceMonths: pattern.monthKeys, evidence: references });
      suggestions.push({
        kind: pattern.kind, key: `suggestion-${pattern.kind}-${shortKey(fingerprint)}`, fingerprint,
        name: semantic.name, plannedAmount: record.plannedAmount, structure,
        flags: { saved: false, disabled: true, scheduleKnown: dateKnown },
        evidence: { count: references.length, monthKeys: [...pattern.monthKeys], occurrences: clone(references) },
        schedule: { known: dateKnown, recurrence: clone(recurrence),
          reason: dateKnown ? null : 'Schedule unknown — choose a schedule before saving.' },
        upcoming: { dates: upcomingDates, reason: dateKnown
          ? (upcomingDates.length ? null : 'No occurrences in the three-month horizon.') : 'Schedule unknown.' },
        draft
      });
    }
    return result({ referenceDate, horizon: { startMonth, endMonth: monthKeys.at(-1), monthKeys },
      disabledTemplates, suggestions,
      counts: { disabledTemplates: disabledTemplates.length, suggestions: suggestions.length } });
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

  function buildExactMoneyMigration(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
        !['eligible', 'blocked', 'already-migrated'].includes(summary.state)) {
      throw new TypeError('Invalid exact-money migration summary');
    }
    if (summary.state === 'eligible') return result({
      state: 'eligible', title: 'Exact-money storage is ready',
      description: 'This ledger uses whole-cent precision and can move to integer-cent storage without changing its values.',
      canPreview: true
    });
    if (summary.state === 'blocked') return result({
      state: 'blocked', title: 'Exact-money storage is unavailable for this ledger',
      description: `${summary.subCentValueCount} stored money values include digits smaller than one cent across ${summary.affectedMonthCount} months and ${summary.affectedTemplateCount} templates. They remain unchanged and the ledger remains usable.`,
      canPreview: false
    });
    return result({
      state: 'already-migrated', title: 'Exact-money storage is active',
      description: 'This ledger already stores money as integer cents. No migration action is needed.',
      canPreview: false
    });
  }

  function buildShardedPersistenceMigration(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
        !['available', 'already-sharded', 'empty'].includes(summary.state)) {
      throw new TypeError('Invalid month-sharded migration summary');
    }
    if (summary.state === 'available') return result({
      state: 'available',
      title: 'Month-sharded local storage is ready',
      description: 'This ledger can move active browser storage from one large local record to month-sharded local storage. Budget values and behavior stay the same. Warm Ledger creates a local safety snapshot before saving. Older app versions may require restoring a backup made before this migration.',
      buttonLabel: 'Preview month-sharded storage',
      canPreview: true
    });
    if (summary.state === 'already-sharded') return result({
      state: 'already-sharded',
      title: 'Month-sharded local storage is active',
      description: 'This ledger already saves active local data by month. No migration action is needed.',
      buttonLabel: null,
      canPreview: false
    });
    return result({
      state: 'empty',
      title: 'Month-sharded local storage is unavailable',
      description: 'No saved local data is present yet. Month-sharded local storage becomes relevant after this ledger contains saved months.',
      buttonLabel: null,
      canPreview: false
    });
  }

  return Object.freeze({ analyze, buildTemplateReadiness, buildExactMoneyMigration, buildShardedPersistenceMigration });
});
