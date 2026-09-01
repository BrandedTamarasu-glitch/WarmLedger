# Warm Ledger

<p align="center"><img src="warm-ledger-icon.png" alt="Warm Ledger open-book sunrise icon" width="128" height="128"></p>
<p align="center"><em>A calmer way to plan every dollar.</em></p>

Warm Ledger is a calm, local, dependency-free budgeting application. It runs directly in a browser and stores budget records in that browser's site-specific storage.

See [ROADMAP.md](ROADMAP.md) for planned work and the boundaries of future phases.

## Current features

- Monthly paychecks, expenses, allocations, paycheck funding plans, and range-aware dashboard reporting with accessible tables, CSV, and print output.
- Add and edit paycheck and expense records.
- Reorder monthly paychecks and reorder expenses within their displayed category using keyboard-accessible controls.
- A **Structure** view for adding, renaming, archiving, restoring, and reordering categories, preset expense items, earners, and schema-version-6 local accounts.
- A **Templates** view for recurring income and expenses with monthly, twice-monthly, weekly, and biweekly schedules.
- Preview-first recurring generation that shows additions and skips before making one atomic change.
- A compact, write-free **Monthly Review** dashboard showing recurring work, missing actuals, expense funding, checklist readiness, and balance at a glance, with details available on demand.
- Manual cleared-record marks for eligible saved records, kept explicitly separate from payment confirmation, bank verification, reconciliation, and month close.
- Saved-only future-month forecasting, upcoming bills and paydays, a transient Saved-Record Finder, a bounded saved-month review queue, and two-month comparison with on-demand expense contributors.
- A write-free **Data Health** view for incomplete or unusual ledger records, compare-only backup analysis, explicit preview-first month-sharded persistence migration for eligible ledgers, and the schema-version-5 to schema-version-6 account migration workflow.
- Explicit, preview-first migration of eligible ledgers to exact integer-cent persistence, protected by a verified safety snapshot.
- Explicit, preview-first migration of eligible schema-version-5 ledgers to schema-version-6 local accounts, protected by a verified safety snapshot.
- Internal recurrence safeguards that keep deliberately removed generated occurrences from returning unexpectedly.
- Stable structural IDs with historical labels preserved in existing monthly records.
- Versioned JSON backup and restore with validation and preview.
- Local safety snapshots and a startup recovery workflow.
- Fail-closed multi-tab write protection: a stale tab cannot silently overwrite newer saved data, and reload recovery remains write-free.
- A strict static-compatible Content Security Policy and node-only modal rendering with no dynamic HTML injection path.
- Render-scoped Dashboard preparation that shares one detached monthly projection across reports, tables, charts, and CSV generation instead of repeatedly scanning the same range.

Archived Structure choices remain visible in historical records and totals but are hidden when creating new records. Archiving does not delete or rewrite prior months. Warm Ledger prevents archiving the last active category or earner so new expenses and paychecks can still be created.

For schema-version-6 ledgers, **Structure** also manages an optional ordered account catalog. Paycheck and recurring-income forms offer a compatible **Deposit account**, while expense and recurring-expense forms offer a **Payment account** compatible with the saved payment method. New-record forms show **No account selected** plus only compatible active accounts, and no account—including cash—is selected automatically. An archived account remains visible when editing a record or template that already references it, but it cannot be newly assigned. Account names are local planning labels only; they do not connect to a bank, prove payment, track balances, or reconcile activity.

Paycheck and expense order is stored as part of each month and survives reload, backup/restore, and copying a month. Expense movement stays within its displayed historical category group and does not change its category or any financial values.

**Copy from Previous Month** copies the plan but clears every copied paycheck and expense actual to **Not entered**, including source actuals that were entered as zero. Deleting an expense uses a native Cancel-first confirmation and offers one session-only **Undo**. That Undo is invalidated by the next budget mutation or by reloading the page.

## Warm Ledger interface

Warm Ledger uses a comfortable-density, warm-dark interface designed to keep the current month and its next actions easy to scan. The clay accent marks primary actions, while sage, gold, blue, and red support the existing positive, warning, informational, and destructive text labels; color is never the only indication of meaning.

All six views remain available at narrow widths. Cards and controls reflow for phone-sized screens, while wide financial tables scroll inside their own bounded regions instead of making the whole page overflow. Keyboard focus is visible, narrow-screen controls have touch-friendly targets, native dialog action order matches keyboard order, reduced-motion preferences are respected, and high-contrast/forced-colors modes retain borders and focus indicators.

The interface currently has one built-in warm-dark appearance rather than a theme selector. Dashboard canvas charts are supplementary visual summaries; every chart has an accompanying accessible data table. The dashboard's explicit Planned and Actual spending basis applies to category, payment-method, year-comparison, and summary reports. Projected vs Actual remains a comparison, while composition and allocation-rate reports remain explicitly planned-only. Missing actuals are shown as **Incomplete**, never silently treated as zero.

Dashboard CSV export uses the selected range and spending basis. It is generated locally and contains normalized monthly income, expense totals, category spending, and payment-method rows with explicit Complete or Incomplete status. Missing actual values remain blank rather than becoming zero, and text fields are protected from spreadsheet formula interpretation.

Printable dashboard reports use the same validated range and spending basis. Printing hides application controls and charts, expands the authoritative data tables, includes the range and basis in the report, and uses a high-contrast paper layout. The browser's print destination can produce paper or PDF; Warm Ledger does not upload or persist the report.

The Dashboard's **Planned forecast** is a read-only view of saved future months beginning with the next local calendar month. Choose a three-, six-, or twelve-month horizon to compare planned income, expenses, allocations, and month-local remainder. Months without a saved plan are shown as **No saved plan** and are never estimated. The forecast does not inspect or generate recurring-template occurrences, carry a remainder between months, or predict bank balances, payments, transfers, or reconciled cash. Its table, CSV export, and print presentation use the same saved-only contract.

The initially closed **Upcoming bills & paydays** disclosure shows only saved paycheck and expense records in an explicit 30-, 60-, or 90-day window anchored to the device's local civil date. Missing months are **No saved plan**, saved empty months remain saved plans, and blank record dates appear separately under **Date needed** instead of being placed on the timeline. Actual **Not entered**, entered zero, and entered values remain distinct; bill funding text comes only from saved paycheck assignments. Dates are neutral scheduled or recorded dates—not due, paid, cleared, settlement, or reconciliation claims. This local planning view does not inspect templates, generate records, infer dates or funding, send reminders, or estimate balances. Print includes the currently selected range, content, and disclaimer while omitting the window controls.

### Find a saved record

The Saved-Record Finder is an initially closed Dashboard disclosure with a submit-only search form and a transient **Clear search** action. Search scans only saved paychecks and expenses across saved months. A trimmed query must contain 1–120 characters. Matching is a literal, case-insensitive substring check: income searches saved earner labels, while expenses search saved names and categories. Optional kind and strict inclusive `YYYY-MM` bounds narrow the scan. Results remain in canonical month order, with paychecks before expenses and each kind in saved array order; at most 200 presentation-safe results are returned, with a truthful full count and truncation notice.

The query and results stay local and transient. They are not placed in storage, the URL, history, logs, errors, exports, reports, screenshots, browser-evidence artifacts, analytics, snapshots, or backups, and searching does not write, migrate, generate identifiers, advance Store generations, or alter live data. The finder does not search IDs, amounts, dates, payment methods, templates, notes, occurrence keys, funding, archived catalog labels, recurring exceptions, snapshots, or backups. It uses literal matching only—no regular expressions, fuzzy matching, stemming, scoring, ranking, suggestions, saved queries, or search history.

Each result shows only its saved identity, kind, month, neutral saved date or **Date needed**, planned amount, and actual amount or **Not entered**. **Open** revalidates the exact current result before routing to that record's existing Budget **Edit** control; it does not open an editor or change the ledger. Finding or opening a result makes no claim about payment, due dates, cleared state, funding, accounts, balances, reconciliation, or month lifecycle.

### Months needing attention

The initially closed Dashboard **Months needing attention** disclosure is a bounded, read-only review aid over saved months only. Choose an exact lookback of 6, 12, or 24 months to see saved-month facts that may be useful to review. Opening the disclosure, changing its lookback, and following its actions are passive: they do not create, edit, save, migrate, snapshot, generate identifiers, or otherwise change the ledger.

Before routing, an action revalidates its exact current item. A current item can focus only its existing Budget or Monthly Review control; a stale item refreshes safely instead of routing to an outdated target. The queue does not assign priority, prove completion or payment, verify a bank, reconcile an account, or close a month.

### Compare saved months

The initially closed Dashboard **Compare saved months** disclosure compares exactly two distinct saved months without changing the ledger. Its separate baseline and comparison pickers passively default to the two most recent saved months when available; changing either picker clears stale output until **Compare** is chosen. The Dashboard's global Planned or Actual spending basis applies to the comparison, and every absolute delta is calculated as comparison minus baseline.

The accessible table includes summary, allocation, category, and payment-method rows. Allocations remain explicitly planned-only even when the global basis is Actual. A missing actual makes only the affected result and delta **Incomplete**—it is never treated as zero—while an entered zero remains a complete value. The current result can be downloaded as a local CSV or printed with the selected months, basis, delta direction, and incomplete states intact.

Category and payment-method rows offer an inline **Explain change** action. Contributor details are computed only when requested and group the matching saved expense records under baseline and comparison. They use the comparison's Planned or Actual basis, preserving **Not entered** separately from an entered zero, and show at most 200 records across both sides with truthful full and per-side counts plus a truncation notice. A contributor's **Edit** action revalidates that exact saved record before routing to its existing Budget Edit control; stale records refresh safely without opening an editor or changing the ledger.

Contributor detail is interactive context only, so it is intentionally excluded from comparison CSV and print output. Explain change scans only the two selected saved months and adds no persistence, index, cache, background work, schema changes, charts, ranking, recommendations, or financial-activity claims.

Comparison reads only the two explicitly selected saved months and remains transient and write-free. It adds no charts, persistence, history, cache, index, background processing, schema changes, account activity, payment claims, or reconciliation behavior.

## Run locally

Open `index.html` in a modern browser. From this directory on Linux, for example:

```bash
chromium "file://$PWD/index.html"
```

Continue opening the same absolute file path in the same browser profile. Browser storage for a `file://` page can be path- and browser-specific, so moving the project or changing profiles may present a separate empty budget.

The product was previously named ZeroBudget. Existing installations should keep using the same local project path: the legacy storage keys and backup/snapshot format identifiers are intentionally unchanged so current budgets, snapshots, and JSON backups remain compatible after the rebrand.

Warm Ledger keeps those compatible storage and backup formats while coordinating real writes through one fail-closed commit path. Semantic no-op updates do not lock, snapshot, or rewrite the ledger. If another tab is actively saving or has already changed the budget, the older action stops without overwriting data and asks you to review the latest saved state.

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

The browser suite exercises the explicit month-sharded migration, verifies byte-exact and value-preserving reloads, validates every referenced shard, tests corrupt-shard snapshot recovery, and confirms that local-data purge removes active and orphaned storage keys. Its published scenario and check maps contain boolean results only; the disposable synthetic ledger is not written to the evidence file.

### Large-ledger performance profiling

The dependency-free benchmark harness builds deterministic, generic synthetic ledgers and measures startup/load, the same ordinary expense edit and commit in both legacy and month-sharded active storage, prepared Dashboard range generation, saved-record search, saved-month comparison, and Explain change:

```bash
npm run benchmark:ledger
```

It writes machine-readable JSON to standard output and a concise human summary to standard error. Save an additional JSON copy outside the repository, or use an ignored `benchmark-results*.json` filename, with:

```bash
npm run benchmark:ledger -- --sizes 12x50,36x100,60x200 --iterations 3 --output benchmark-results-local.json
```

Sizes use `months x expenses-per-month`. Defaults and accepted overrides are bounded to protect local machines; run `npm run benchmark:ledger -- --help` for the current limits. Schema-version-2 reports contain aggregate fixture counts, serialized byte counts, duration distributions, operation result counts, total edit write-byte counts, active-layout write bytes, and shard/reference reuse counts—never synthetic record labels or identifiers.

Benchmark durations are measurements, not test assertions: normal tests intentionally have no wall-clock thresholds. Compare repeated legacy and month-sharded runs on the same machine and runtime. Use the write-byte and shard-reuse measurements to verify that ordinary sharded edits remain narrowly scoped; if a read-only operation becomes dominant instead, optimize that measured scanner or projection rather than adding broader persistence machinery.

The published 2026-09-01 synthetic baseline found that a 60-month ledger with 200 expenses per month serialized to about 3.44 MB. Median startup was about 123 ms and read-side operations stayed below 5 ms, while a first-daily ordinary legacy edit took about 855 ms and wrote about 6.88 MB across the active ledger and safety snapshot. A same-harness month-sharded candidate run wrote about 3.52 MB total, including that first-daily full safety snapshot; its active layout changed exactly one month shard, one manifest, and the root pointer while reusing the global shard and 59 unaffected month references. The measured total-write reduction was about 49%. These figures are directional measurements from one machine, not pass/fail thresholds or universal performance guarantees.

## Monthly Review

Monthly Review summarizes the selected month without changing it. Several needs can appear at the same time: recurring items may need review, actual amounts may be missing, and planned expenses may need paycheck funding. An empty month is never described as ready.

An actual amount of **Not entered** means no value has been recorded (`null`). An entered `$0.00` is a real, complete value and is not treated as missing. While any actual is missing, the displayed entered-actual total is explicitly partial and the complete total and actual cash flow remain **Incomplete**. Planned totals and planned remainder remain available independently of actual entry.

“Complete” means the required actual amounts have been entered. It does not mean the month was matched to a bank statement, cleared, closed, or otherwise reconciled with a financial institution. Actual cash flow is entered income minus entered expenses only after both are complete; it is not a bank balance.

Monthly Review also contains an initially closed **Manual cleared checklist** for budgets using the current cleared-record format. A checkbox records only that you manually marked a saved paycheck or expense cleared. Marking requires an entered actual amount and a saved date; entered zero is eligible, while missing requirements remain visible with an explanation. Changing outcome-defining fields can reset the mark. This state does not mean paid, bank-verified, reconciled, matched, settled, balance-confirmed, or month closed, and there are no bulk or automatic clearing controls. Older schema-version-3 budgets show the checklist as unavailable until the separate exact-money storage upgrade is completed.

### Month Checklist Readiness

Its compact summary appears at the top of the existing, initially closed **Manual cleared checklist** and remains strictly read-only. It evaluates exactly three facts across the selected month's saved paychecks and expenses: whether every actual amount has been entered, whether every record has a nonblank saved date, and whether every record has been manually marked cleared. Missing requirements can overlap, so their counts are not deduplicated or converted into a score or percentage. An actual of `null` is missing; an entered zero is complete for the actuals check.

The displayed state will always be **Month state — Open for editing**. Its permanent limitation will state: “This month remains editable. These checks are a manual review aid—not bank verification, reconciliation, payment confirmation, or month close.” **Checklist complete** will mean only that those three bounded checks pass. A valid month with no saved month and a saved-but-empty month will be reported separately, and neither will be checklist-complete. Schema-version-5 budgets can provide the summary from their resident saved records; schema-version-3 and schema-version-4 budgets will show it as unavailable until the manual-clearing format is present. Invalid month keys remain invalid, and startup recovery continues to gate ordinary ledger reads.

Reading the summary will not save, migrate, snapshot, generate identifiers, advance Store generations, or alter live data. Funding, allocations, recurring templates, planned balances, Data Health findings, accounts, statements, and payment status are not readiness checks. The summary will not verify a bank, reconcile an account, confirm payment, close or lock a month, or introduce a month-lifecycle transition.

## Pay periods

Pay periods is a passive, read-only view of the selected month's paycheck funding plan. Each paycheck is a month-scoped funding envelope containing only the bills explicitly assigned to it in **Budget**. Warm Ledger supports any number of paychecks and earners in a month; it does not assume exactly two checks or one earner. Add or change assignments in Budget, including splitting a bill across multiple paychecks. Pay periods then shows the funded, partially funded, and unfunded results without changing the ledger.

Planned paycheck income drives the funding plan. Actual income is displayed separately: **Not entered** means `null`, while an entered `$0.00` is a real actual value. Monthly remaining-funds allocations remain separate from paycheck-to-bill assignments and are summarized only at the month level. Recurring templates can create records through their explicit Preview and Apply workflow, but they do not automatically assign generated bills to a paycheck.

**Planned payment guidance** shows how explicitly assigned bills are divided between keeping money in the bank and planning for credit card, savings, or investment-funded bills. It appears as a compact tile in Monthly Review and as a month total in Pay periods; the paycheck cards show when each portion is planned. These are planning totals only: they do not send money, pay a bill, or verify an account transfer.

The view is not a calendar pay-period calculator, does not infer boundaries around paycheck dates, and does not move funding across months. A funding assignment is not evidence that a bill was paid, an account was reconciled, money reached a bank, or an account-to-account transfer occurred. Pay periods operates schema-neutrally over normalized resident schema-version-3 through schema-version-6 data without changing the resident version; backup/snapshot envelope format version 1 remains unchanged.

## Data Health

Data Health checks the ledger without writing to it. It reports actual amounts not entered (`null`), dates not entered (an empty string), expense-funding mismatches, absent months inside the earliest-to-latest nonempty ledger range, and conservative manual-record patterns repeated across at least three months. These are review prompts, not proof that a record is wrong.

For missing actuals, select only the records to resolve, enter each amount, and review the preview before confirming one atomic change. An entered zero is a completed value and remains distinct from **Not entered**. Cancelling the preview changes nothing.

**Compare a backup** validates and analyzes a selected backup without importing, restoring, or otherwise changing the ledger. The interface accepts files up to 5 MB and classifies months and structure for comparison. Comparison imports nothing. **Restore backup** is a separate, destructive workflow that previews and then replaces the active budget only after explicit confirmation.

The closed **Money precision** disclosure is a read-only, aggregate-only audit of stored money values. It reports how many stored values were scanned and, when needed, how many include digits smaller than one cent plus affected month and template counts. It never displays amounts, record labels, identifiers, or month keys, and it does not round, repair, or change ledger values.

For an eligible schema-version-3 ledger whose values are all exact to one cent, Data Health offers an explicit preview and confirmation to move persistence to schema version 4 integer cents. Downloading a JSON backup is offered before confirmation, and Warm Ledger must create and verify a local safety snapshot before the single active-data write. A cancelled, stale, blocked, or failed migration leaves the active ledger unchanged. Ordinary edits do not migrate a version-3 ledger automatically. Sub-cent version-3 ledgers remain valid, editable, and exportable, but the migration action stays unavailable; an entered zero remains distinct from an actual amount that was not entered (`null`). Backup and snapshot envelopes remain format version 1 and may contain resident schema version 3 through 6 ledger data.

## Recurring templates

### Template readiness

The top of **Templates** contains a read-only Template readiness queue. It keeps existing **Disabled template** entries separate from **Suggestion — not saved** entries derived from repeated manual records. Reviewing an entry only opens the existing template form; the queue itself does not enable, save, create, or generate anything.

The queue uses the device's explicit local civil date as its reference date and examines that month plus the next two calendar months. A disabled template shows at most its next three hypothetical occurrences. Suggestions are suppressed only by an exact same-kind semantic duplicate across enabled, disabled, or archived templates; near matches remain visible for review. Repeated records with blank dates have an unknown schedule, so their form starts at **Choose a schedule** and cannot be saved until a schedule is explicitly selected.

Template readiness is separate from recurring generation. Existing recurring records are still created only from Budget through the explicit **Preview recurring items** then **Apply** workflow described below.

To activate templates together, select one or more existing saved disabled templates and choose the temporary target month, which defaults to the next local calendar month. Unsaved suggestions cannot be selected. **Preview selected activation** shows the selected templates, possible additions, skips, conflicts, and templates with no occurrence in that month without writing anything. Conflicts block confirmation. **Enable selected templates** atomically changes only those templates to enabled; it does not create a month or any paycheck or expense records.

Activation preview is enable-only. Generating records remains a separate action in Budget through **Preview recurring items** and **Apply**; activation never starts that workflow automatically.

Use **Templates** to add recurring income and expense plans, pause or archive them, and control their order. From the Budget view, choose **Preview recurring items** to review a month's additions and skips before confirming. Previewing and cancelling write nothing; confirmation adds the complete preview atomically.

Generation is idempotent: rerunning a month does not duplicate existing occurrences or overwrite edited generated records. Dates use timezone-independent calendar arithmetic, including short-month clamping and two distinct occurrences when twice-monthly dates clamp to the same final day.

Deleting a generated record creates a recurring exception (a tombstone) so that exact template occurrence does not unexpectedly return. Clearing a month and replacing a target month with **Copy from Previous Month** also preserve existing exceptions and add exceptions for generated records they remove. Copied records become manual records; Copy remains separate from recurring Preview.

These safeguards remain in saved data and backups but are intentionally omitted from the compact Monthly Review interface.

## Local and manual behavior

Warm Ledger does not automatically generate recurring records, close months, reconcile accounts, or contact a bank or other service. Template generation always requires explicit confirmation through the visible Preview and Apply flow. Passive navigation, Monthly Review, Data Health checks, and backup comparison do not write budget data.

The application has no server component and makes no account or financial-data network connection. Active data, templates, exceptions, and safety snapshots remain in this browser's site-specific storage. Downloads occur only when you request a JSON backup or preserved recovery data.

## Data format compatibility

Warm Ledger supports resident data schema versions 3 through 6. All four are normalized to the same decimal-facing runtime money values while retaining their resident persistence contract. Existing unversioned, schema-version-1, and schema-version-2 data is migrated deterministically in memory to version 3 when opened; loading alone does not rewrite browser storage. Ordinary successful edits preserve the resident version. The separately confirmed exact-money upgrade moves an eligible version-3 ledger to version 4, and the first confirmed manual-clearing change to a version-4 ledger moves it atomically to version 5 after a required safety snapshot. Eligible schema-version-5 ledgers can then use Data Health for an explicit, preview-first migration to version 6. Schema version 6 adds an optional ordered catalog of explicit local account records plus optional account references on saved records and recurring templates. Archived accounts remain valid on historical references but cannot be newly assigned, and an empty catalog or `No account selected` remains valid. These are planning labels only: they do not connect to a bank, prove payment, track balances, or reconcile activity. Failed writes leave the original stored bytes and last committed in-memory budget unchanged.

Backup and snapshot envelopes remain format version 1 and can contain resident schema-version-3 through schema-version-6 data, as well as older ZeroBudget data that Warm Ledger migrates during validation. Current backups preserve the active resident version. Newer resident data may be rejected by older application versions, so download and retain a backup before intentionally downgrading.

The month-sharded persistence layout keeps those compatibility rules intact: it stores the same resident schema data in a different local layout, without introducing a new schema version or a new envelope version.

## Back up and restore

Use **Download backup** to save one timestamped, versioned JSON file. Keep downloaded backups somewhere durable; they are the portable way to retain or move a budget.

Use **Restore backup** to select a Warm Ledger or legacy ZeroBudget JSON backup. The app validates and previews the file before asking for confirmation. Restoring replaces the current budget, so Warm Ledger first creates a local safety snapshot when valid saved data exists. Invalid or cancelled restores do not replace the active budget.

Month-sharded local storage is browser-only and changes only how this browser saves active data. It does not change the resident schema version or the version `1` backup/snapshot envelope format. If you migrate to month-sharded storage, the durable downgrade path is to restore a JSON backup or local snapshot made before that migration.

Do not rename JavaScript files to use them as backups and do not paste budget data into the source tree. Executable seed-data backups are intentionally unsupported.

## Local snapshots and recovery

Warm Ledger keeps a logical list of the seven newest valid safety snapshots. These snapshots are stored in the same browser, for the same site or file origin, as the active budget. They are useful for recovering from a damaged active record, but they are not durable backups.

Browser storage limits or cleanup failures can temporarily leave more than seven physical snapshot entries; the app still exposes only the newest seven valid snapshots and retries valid-snapshot cleanup during later saves. Malformed or unreadable snapshot entries are retained rather than deleted automatically, so they may remain physically present and contribute to browser storage quota until site data is cleared.

If active data cannot be validated, Warm Ledger blocks ordinary editing and displays recovery actions:

- Restore a validated local snapshot.
- Download the preserved corrupt bytes for diagnosis or manual recovery.
- Explicitly start fresh with an empty generic budget.

Clearing browser/site data, deleting a browser profile, changing the page's path/origin, or browser storage eviction can remove the active budget and every local snapshot together. Downloaded JSON backups are not affected by clearing site data.

## Local storage & privacy

Warm Ledger stores active data, local safety snapshots, and preserved corrupt bytes as readable local browser data. Downloaded JSON backups and browser-evidence files are also readable unless manually deleted.

Use Data Health's local-data purge to remove the active budget, local safety snapshots, and preserved recovery bytes from this browser only. That purge does not delete downloaded backups or browser-evidence files, so delete those manually if you no longer want them.

The purge success message is: "Local Warm Ledger data was removed from this browser. Restore a backup or start fresh to continue."

## Privacy and repository history

Budget data remains local unless you download, copy, or otherwise share it. JSON backups contain financial records in readable form and should be stored accordingly; they are not encrypted.

This repository must remain private. Earlier Git history contains prior sensitive budget seed data even though those artifacts have been removed from the current tree. No Git-history rewrite was performed as part of this work.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for vendored Chart.js provenance and update details.
