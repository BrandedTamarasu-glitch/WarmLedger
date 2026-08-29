(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetRecurrence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (!Number.isInteger(year) || year < 0 || year > 9999) throw new RangeError('Invalid year');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Invalid month');
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function parseCivil(value) {
    if (typeof value !== 'string') throw new TypeError('Civil date must be a string');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new RangeError('Invalid civil date');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new RangeError('Invalid civil date');
    }
    return { year, month, day };
  }

  function formatCivil(parts) {
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  function compareCivilDates(left, right) {
    const a = parseCivil(left);
    const b = parseCivil(right);
    if (a.year !== b.year) return a.year < b.year ? -1 : 1;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return 0;
  }

  function civilToNumber(parts) {
    let year = parts.year;
    const month = parts.month;
    year -= month <= 2 ? 1 : 0;
    const era = Math.floor(year / 400);
    const yearOfEra = year - era * 400;
    const shiftedMonth = month + (month > 2 ? -3 : 9);
    const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + parts.day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
    return era * 146097 + dayOfEra;
  }

  function numberToCivil(value) {
    const era = Math.floor(value / 146097);
    const dayOfEra = value - era * 146097;
    const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
    let year = yearOfEra + era * 400;
    const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
    const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
    const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
    const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
    year += month <= 2 ? 1 : 0;
    return { year, month, day };
  }

  function addCivilDays(value, amount) {
    const parts = parseCivil(value);
    if (!Number.isSafeInteger(amount)) throw new RangeError('Day offset must be a safe integer');
    const result = numberToCivil(civilToNumber(parts) + amount);
    if (result.year < 0 || result.year > 9999) throw new RangeError('Civil date is outside the supported range');
    return formatCivil(result);
  }

  function parseMonth(value) {
    if (typeof value !== 'string') throw new TypeError('Month must be a string');
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) throw new RangeError('Invalid month');
    const year = Number(match[1]);
    const month = Number(match[2]);
    daysInMonth(year, month);
    return { year, month };
  }

  function validateTemplate(template) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) throw new TypeError('Template must be an object');
    if (typeof template.enabled !== 'boolean' || typeof template.archived !== 'boolean') throw new TypeError('Template state must be boolean');
    parseCivil(template.startDate);
    if (template.endDate !== null) parseCivil(template.endDate);
    if (template.endDate !== null && compareCivilDates(template.endDate, template.startDate) < 0) {
      throw new RangeError('Template end date precedes start date');
    }
    const recurrence = template.recurrence;
    if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) throw new TypeError('Recurrence must be an object');
    if (recurrence.cadence === 'monthly') {
      if (!Number.isInteger(recurrence.day) || recurrence.day < 1 || recurrence.day > 31) throw new RangeError('Invalid recurrence day');
    } else if (recurrence.cadence === 'twice-monthly') {
      if (!Array.isArray(recurrence.days) || recurrence.days.length !== 2 ||
          !recurrence.days.every(day => Number.isInteger(day) && day >= 1 && day <= 31) ||
          recurrence.days[0] >= recurrence.days[1]) throw new RangeError('Invalid recurrence days');
    } else if (recurrence.cadence === 'weekly' || recurrence.cadence === 'biweekly') {
      parseCivil(recurrence.anchorDate);
    } else {
      throw new RangeError('Invalid recurrence cadence');
    }
  }

  function occurrencesForMonth(template, monthKey) {
    validateTemplate(template);
    const target = parseMonth(monthKey);
    if (!template.enabled || template.archived) return [];

    const lastDay = daysInMonth(target.year, target.month);
    const monthStart = `${monthKey}-01`;
    const monthEnd = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
    const lower = compareCivilDates(template.startDate, monthStart) > 0 ? template.startDate : monthStart;
    const upper = template.endDate !== null && compareCivilDates(template.endDate, monthEnd) < 0 ? template.endDate : monthEnd;
    if (compareCivilDates(lower, upper) > 0) return [];

    const candidates = [];
    const recurrence = template.recurrence;
    if (recurrence.cadence === 'monthly' || recurrence.cadence === 'twice-monthly') {
      const requestedDays = recurrence.cadence === 'monthly' ? [recurrence.day] : recurrence.days;
      for (const requestedDay of requestedDays) {
        const scheduled = `${monthKey}-${String(Math.min(requestedDay, lastDay)).padStart(2, '0')}`;
        if (compareCivilDates(scheduled, lower) >= 0 && compareCivilDates(scheduled, upper) <= 0) candidates.push(scheduled);
      }
    } else {
      const interval = recurrence.cadence === 'weekly' ? 7 : 14;
      const anchorNumber = civilToNumber(parseCivil(recurrence.anchorDate));
      let scheduled = lower;
      while (compareCivilDates(scheduled, upper) <= 0) {
        const delta = civilToNumber(parseCivil(scheduled)) - anchorNumber;
        if (delta % interval === 0) candidates.push(scheduled);
        scheduled = addCivilDays(scheduled, 1);
      }
    }

    candidates.sort(compareCivilDates);
    let previous = null;
    let ordinal = 0;
    return candidates.map(scheduledDate => {
      ordinal = scheduledDate === previous ? ordinal + 1 : 1;
      previous = scheduledDate;
      return {
        scheduledDate,
        ordinal,
        occurrenceKey: `${scheduledDate}#${String(ordinal).padStart(4, '0')}`
      };
    });
  }

  return Object.freeze({ daysInMonth, compareCivilDates, addCivilDays, occurrencesForMonth });
});
