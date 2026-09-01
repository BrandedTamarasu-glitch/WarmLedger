'use strict';

// Pure adapters for the render-scoped Store.prepareDashboardRange snapshot.
const DashboardModels = Object.freeze({
  entries(prepared) {
    return prepared.monthKeys.map(monthKey => ({ monthKey, ...prepared.months[monthKey] }));
  },

  coverage(prepared) {
    let financialActivityMonths = 0; let plannedIncome = 0; let plannedExpenses = 0;
    let actualEnteredCount = 0; let actualMissingCount = 0;
    for (const monthKey of prepared.monthKeys) {
      const entry = prepared.months[monthKey]; const summary = entry.summary;
      if (entry.paycheckCount + entry.expenseCount > 0 || summary.totalAllocated !== 0) financialActivityMonths++;
      plannedIncome += summary.totalPlannedIncome; plannedExpenses += summary.totalPlannedExpenses;
      actualMissingCount += summary.unresolvedIncomeCount + summary.unresolvedExpenseCount;
      actualEnteredCount += entry.paycheckCount + entry.expenseCount -
        summary.unresolvedIncomeCount - summary.unresolvedExpenseCount;
    }
    const overview = {
      coverage: { selectedMonths: prepared.monthKeys.length, financialActivityMonths },
      actualEntries: { enteredCount: actualEnteredCount, missingCount: actualMissingCount, complete: actualMissingCount === 0 },
      plannedTotals: { income: plannedIncome, expenses: plannedExpenses }
    };
    Object.values(overview).forEach(Object.freeze);
    return Object.freeze(overview);
  }
});
