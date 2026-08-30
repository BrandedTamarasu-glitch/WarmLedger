# Warm Ledger

<p align="center"><img src="warm-ledger-icon.png" alt="Warm Ledger open-book sunrise icon" width="128" height="128"></p>
<p align="center"><em>A calmer way to plan every dollar.</em></p>

Warm Ledger is a calm, local, dependency-free budgeting application. It runs directly in a browser and stores budget records in that browser's site-specific storage.

See [ROADMAP.md](ROADMAP.md) for planned work and the boundaries of future phases.

## Current features

- Monthly paychecks, expenses, allocations, paycheck funding plans, and dashboard summaries.
- Add and edit paycheck and expense records.
- Reorder monthly paychecks and reorder expenses within their displayed category using keyboard-accessible controls.
- A **Structure** view for adding, renaming, archiving, restoring, and reordering categories, preset expense items, and earners.
- A **Templates** view for recurring income and expenses with monthly, twice-monthly, weekly, and biweekly schedules.
- Preview-first recurring generation that shows additions and skips before making one atomic change.
- A write-free **Monthly Review** showing recurring work, missing actuals, expense funding, planned balance, and paycheck-assignment notes.
- A write-free **Data Health** view for incomplete or unusual ledger records and compare-only backup analysis.
- Reversible recurring exceptions for deliberately removed generated occurrences.
- Stable structural IDs with historical labels preserved in existing monthly records.
- Versioned JSON backup and restore with validation and preview.
- Local safety snapshots and a startup recovery workflow.

Archived Structure choices remain visible in historical records and totals but are hidden when creating new records. Archiving does not delete or rewrite prior months. Warm Ledger prevents archiving the last active category or earner so new expenses and paychecks can still be created.

Paycheck and expense order is stored as part of each month and survives reload, backup/restore, and copying a month. Expense movement stays within its displayed historical category group and does not change its category or any financial values.

**Copy from Previous Month** copies the plan but clears every copied paycheck and expense actual to **Not entered**, including source actuals that were entered as zero. Deleting an expense uses a native Cancel-first confirmation and offers one session-only **Undo**. That Undo is invalidated by the next budget mutation or by reloading the page.

## Warm Ledger interface

Warm Ledger uses a comfortable-density, warm-dark interface designed to keep the current month and its next actions easy to scan. The clay accent marks primary actions, while sage, gold, blue, and red support the existing positive, warning, informational, and destructive text labels; color is never the only indication of meaning.

All six views remain available at narrow widths. Cards and controls reflow for phone-sized screens, while wide financial tables scroll inside their own bounded regions instead of making the whole page overflow. Keyboard focus is visible, narrow-screen controls have touch-friendly targets, native dialog action order matches keyboard order, reduced-motion preferences are respected, and high-contrast/forced-colors modes retain borders and focus indicators.

The interface currently has one built-in warm-dark appearance rather than a theme selector. Dashboard canvas charts are supplementary visual summaries: their accompanying labels, filters, and summary table remain the authoritative accessible content, but per-chart data-table equivalents are not yet provided.

## Run locally

Open `index.html` in a modern browser. From this directory on Linux, for example:

```bash
chromium "file://$PWD/index.html"
```

Continue opening the same absolute file path in the same browser profile. Browser storage for a `file://` page can be path- and browser-specific, so moving the project or changing profiles may present a separate empty budget.

The product was previously named ZeroBudget. Existing installations should keep using the same local project path: the legacy storage keys and backup/snapshot format identifiers are intentionally unchanged so current budgets, snapshots, and JSON backups remain compatible after the rebrand.

No install or dependency download is required. To run the automated data-safety tests, install Node.js and run:

```bash
npm test
```

The test suite uses Node's built-in test runner and synthetic records only.

An optional browser evidence run requires Chromium:

```bash
npm run test:browser
```

It uses synthetic data in a disposable browser profile and writes JSON evidence to the operating system's temporary directory by default. To keep the evidence at a specific path, run:

```bash
npm run test:browser -- --output PATH
```

## Monthly Review

Monthly Review summarizes the selected month without changing it. Several needs can appear at the same time: recurring items may need review, actual amounts may be missing, and planned expenses may need paycheck funding. An empty month is never described as ready.

An actual amount of **Not entered** means no value has been recorded (`null`). An entered `$0.00` is a real, complete value and is not treated as missing. While any actual is missing, the displayed entered-actual total is explicitly partial and the complete total and actual cash flow remain **Incomplete**. Planned totals and planned remainder remain available independently of actual entry.

“Complete” means the required actual amounts have been entered. It does not mean the month was matched to a bank statement, cleared, closed, or otherwise reconciled with a financial institution. Actual cash flow is entered income minus entered expenses only after both are complete; it is not a bank balance.

## Pay periods

Pay periods is a passive, read-only view of the selected month's paycheck funding plan. Each paycheck is a month-scoped funding envelope containing only the bills explicitly assigned to it in **Budget**. Warm Ledger supports any number of paychecks and earners in a month; it does not assume exactly two checks or one earner. Add or change assignments in Budget, including splitting a bill across multiple paychecks. Pay periods then shows the funded, partially funded, and unfunded results without changing the ledger.

Planned paycheck income drives the funding plan. Actual income is displayed separately: **Not entered** means `null`, while an entered `$0.00` is a real actual value. Monthly remaining-funds allocations remain separate from paycheck-to-bill assignments and are summarized only at the month level. Recurring templates can create records through their explicit Preview and Apply workflow, but they do not automatically assign generated bills to a paycheck.

The view is not a calendar pay-period calculator, does not infer boundaries around paycheck dates, and does not move funding across months. A funding assignment is not evidence that a bill was paid, an account was reconciled, money reached a bank, or an account-to-account transfer occurred. This feature keeps data schema version 3 and backup/snapshot envelope version 1 unchanged.

## Data Health

Data Health checks the ledger without writing to it. It reports actual amounts not entered (`null`), dates not entered (an empty string), expense-funding mismatches, absent months inside the earliest-to-latest nonempty ledger range, and conservative manual-record patterns repeated across at least three months. These are review prompts, not proof that a record is wrong.

For missing actuals, select only the records to resolve, enter each amount, and review the preview before confirming one atomic change. An entered zero is a completed value and remains distinct from **Not entered**. Cancelling the preview changes nothing.

**Compare a backup** validates and analyzes a selected backup without importing, restoring, or otherwise changing the ledger. The interface accepts files up to 5 MB and classifies months and structure for comparison. Comparison imports nothing. **Restore backup** is a separate, destructive workflow that previews and then replaces the active budget only after explicit confirmation.

## Recurring templates

Use **Templates** to add recurring income and expense plans, pause or archive them, and control their order. From the Budget view, choose **Preview recurring items** to review a month's additions and skips before confirming. Previewing and cancelling write nothing; confirmation adds the complete preview atomically.

Generation is idempotent: rerunning a month does not duplicate existing occurrences or overwrite edited generated records. Dates use timezone-independent calendar arithmetic, including short-month clamping and two distinct occurrences when twice-monthly dates clamp to the same final day.

Deleting a generated record creates a recurring exception (a tombstone) so that exact template occurrence does not unexpectedly return. Clearing a month and replacing a target month with **Copy from Previous Month** also preserve existing exceptions and add exceptions for generated records they remove. Copied records become manual records; Copy remains separate from recurring Preview.

Monthly Review lists these exceptions. **Allow again** removes only the exact selected exception, including its occurrence ordinal when two occurrences share a date. It does not restore the deleted record, create a new record, or silently copy current template values. Cancelling the Allow confirmation leaves the exception unchanged. After allowing an occurrence again, use the normal **Preview recurring items** dialog to inspect current values and then choose **Add recurring items** to generate it. Cancelling that preview creates no record; the occurrence remains eligible for a later preview.

An exception can be allowed again only while its template occurrence is currently eligible. Enable a disabled template, restore an archived template, adjust an out-of-range date range, or restore a changed schedule before retrying when Monthly Review identifies one of those states.

## Local and manual behavior

Warm Ledger does not automatically generate recurring records, close months, reconcile accounts, or contact a bank or other service. Template generation and recurring-exception recovery always require explicit confirmation through the visible Preview and Apply flow. Passive navigation, Monthly Review, Data Health checks, and backup comparison do not write budget data.

The application has no server component and makes no account or financial-data network connection. Active data, templates, exceptions, and safety snapshots remain in this browser's site-specific storage. Downloads occur only when you request a JSON backup or preserved recovery data.

## Data format compatibility

The active data model is schema version 3. Existing unversioned, schema-version-1, and schema-version-2 data is migrated deterministically in memory when opened; loading alone does not rewrite browser storage. The first later successful edit persists schema version 3 atomically. If that write fails, the original stored bytes and the last committed in-memory budget remain unchanged.

Backup and snapshot envelopes remain format version 1 and can contain older ZeroBudget data that Warm Ledger migrates during validation. Backups created by the current application contain schema-version-3 data and may be rejected by older application versions, so download and retain a backup before intentionally downgrading.

## Back up and restore

Use **Download backup** to save one timestamped, versioned JSON file. Keep downloaded backups somewhere durable; they are the portable way to retain or move a budget.

Use **Restore backup** to select a Warm Ledger or legacy ZeroBudget JSON backup. The app validates and previews the file before asking for confirmation. Restoring replaces the current budget, so Warm Ledger first creates a local safety snapshot when valid saved data exists. Invalid or cancelled restores do not replace the active budget.

Do not rename JavaScript files to use them as backups and do not paste budget data into the source tree. Executable seed-data backups are intentionally unsupported.

## Local snapshots and recovery

Warm Ledger keeps a logical list of the seven newest valid safety snapshots. These snapshots are stored in the same browser, for the same site or file origin, as the active budget. They are useful for recovering from a damaged active record, but they are not durable backups.

Browser storage limits or cleanup failures can temporarily leave more than seven physical snapshot entries; the app still exposes only the newest seven valid snapshots and retries valid-snapshot cleanup during later saves. Malformed or unreadable snapshot entries are retained rather than deleted automatically, so they may remain physically present and contribute to browser storage quota until site data is cleared.

If active data cannot be validated, Warm Ledger blocks ordinary editing and displays recovery actions:

- Restore a validated local snapshot.
- Download the preserved corrupt bytes for diagnosis or manual recovery.
- Explicitly start fresh with an empty generic budget.

Clearing browser/site data, deleting a browser profile, changing the page's path/origin, or browser storage eviction can remove the active budget and every local snapshot together. Downloaded JSON backups are not affected by clearing site data.

## Privacy and repository history

Budget data remains local unless you download, copy, or otherwise share it. JSON backups contain financial records in readable form and should be stored accordingly; they are not encrypted.

This repository must remain private. Earlier Git history contains prior sensitive budget seed data even though those artifacts have been removed from the current tree. No Git-history rewrite was performed as part of this work.
