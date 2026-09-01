# Warm Ledger Roadmap

This roadmap turns the August 2026 ForgeFlow product audit into sequenced, testable releases. Warm Ledger remains local-only, dependency-free, compatible with direct `file://` startup, resident schema versions 3, 4, and 5, and backup/snapshot envelope format version 1 unless a later phase explicitly authorizes a migration.

## Phase 1 — Data safety fixes

Status: published.

- Reset copied paycheck actual amounts to **Not entered**, matching copied expenses.
- Require accessible confirmation before deleting an expense.
- Offer one exact, session-only Undo after confirmed expense deletion.
- Preserve generated-occurrence exceptions, ordering, focus, snapshots, and atomic failure behavior.
- Add Store, UI, focus, and disposable-browser regression coverage.

Success means Copy from Previous Month never carries financial outcomes into a new month, and an expense cannot be lost through one unconfirmed click.

## Phase 2 — Data Health center

Status: published.

- Add deterministic, write-free whole-ledger checks for missing actuals, dates not entered, funding mismatches, interior month gaps, and conservative repeated patterns.
- Add an accessible Data Health view with overview counts and routes to the existing Budget and Templates workflows.
- Add explicit selected-record actual cleanup with preview, Cancel-first confirmation, atomic apply, stale-preview rejection, and correct `null` versus entered-zero behavior.
- Add validated, write-free backup comparison that classifies identical, addable, and conflicting months and structures.
- Keep comparison separate from Restore and state clearly that comparison imports nothing.
- Preserve passive-navigation byte equality and recovery gating.

Deferred within this phase: automatic date inference, automatic template creation, record-level merge, conflict remapping, and applying additive imports. Those require a separately reviewed conflict and rollback contract.

## Phase 3 — Template readiness

Status: readiness and selected enable-only activation published.

- Review disabled templates and conservative repeated-manual-record suggestions in separate, clearly labeled lists.
- Use an explicit local civil reference date, a three-calendar-month horizon, and at most three upcoming occurrences per disabled template.
- Treat blank-date repeated records as schedule unknown and require an explicit schedule before Save.
- Suppress suggestions only for exact same-kind semantic duplicates across every existing template state; retain near matches.
- Keep queue rendering and Review actions write-free; Review opens the existing Add or Edit form without enabling or saving anything.
- Allow only saved disabled templates to be selected for an explicit target-month activation preview; suggestions remain Review-only.
- Enable the complete selection atomically only after a Cancel-first preview; conflicts block confirmation and no Budget records are generated.
- Never silently enable or generate recurring records.

Deferred: automatic suggestion creation, select-all, persisted selections or target month, activation coupled to generation, and automatic recurring generation. Budget's existing Preview recurring items → Apply workflow remains the only record generator.

## Phase 4 — Exact-money foundation

Status: Phase 4B explicit exact-money migration published.

- Audit only the approved stored money families and report aggregate exact-cent and sub-cent counts without exposing ledger details.
- Keep compatible schema-version-3 ledgers valid and editable; the audit never rounds, repairs, rejects, or writes data.
- Persist migrated ledgers as schema-version-4 integer cents while keeping runtime and interface values decimal-facing.
- Require an eligible, generation-bound preview, verified safety snapshot, and one active-data write; failures leave active bytes and live state unchanged.
- Keep ordinary schema-version-3 edits on version 3, preserve `null` separately from entered zero, and block rather than round sub-cent ledgers.
- Keep backup and snapshot envelope format version 1 compatible with both schema versions 3 and 4.

## Phase 5 — Manual clearing and month review

### Phase 5A — Manual cleared-record checklist

Status: published.

- Add an explicit per-record manual cleared mark only for saved records with an entered actual and date; entered zero remains eligible.
- Keep the checklist separate from paid, bank-verified, reconciled, matched, settled, balance-confirmed, and month-closed claims, with no bulk or automatic clearing.

### Phase 5B — Month Checklist Readiness

Status: published.

- Add one deterministic, detached, read-only Store projection and one compact summary at the top of the existing, initially closed Manual cleared checklist.
- Check exactly three facts across saved paychecks and expenses: all actuals entered (`null` is missing and entered zero is entered), all saved dates nonblank, and every record manually marked cleared.
- Preserve overlapping missing counts without deduplication, scoring, or percentages.
- Keep **Month state — Open for editing** constant; use **Checklist complete** only when all three checks pass.
- Distinguish a valid absent month from a saved empty month and treat neither as checklist-complete.
- Make the projection available for resident schema-version-5 data; return an explicit unavailable result for schema versions 3 and 4 without migrating, snapshotting, or writing.
- Preserve invalid-month handling, recovery gating, existing cleared-record facts, and a strictly passive interface with no controls or lifecycle transitions.
- Exclude funding, allocations, recurring templates, planned balances, Data Health, accounts, statements, payment status, bank verification, reconciliation, and month-close claims.

The lean ceiling for Phase 5B is the pure three-check projection plus the existing-checklist summary. Upgrade only when separately authorized account or statement evidence, reconciliation rules, close prerequisites, locks, rollback/reopen behavior, and audit history require a persisted lifecycle contract.

### Later phase — Reconciliation and month lifecycle

Status: explicitly deferred and not part of Phase 5B.

- Define statement and account evidence, reconciliation rules, clearing timestamps, and audit history before adding lifecycle state.
- Introduce **Open**, **Ready to Reconcile**, **Reconciled**, and **Closed** only through a separately reviewed contract.
- Define completion and mismatch prerequisites before allowing month close.
- Lock closed months only with explicit, snapshotted rollback and reopen behavior.

## Phase 6 — Honest paycheck funding and transfers

### Phase 6A — Paycheck funding plan

Status: published on 2026-08-30.

- Present the compatibility-preserved Transfers route as **Pay periods**, a passive, read-only projection of explicit month-scoped paycheck funding.
- Show planned income separately from actual income, preserving **Not entered** (`null`) versus an entered zero.
- Support any number of paychecks and earners, bills split across paychecks, and clear fully funded, partially funded, unfunded, remaining, balanced, and over-assigned states.
- Keep assignments explicit and editable only in Budget; recurring templates do not auto-assign generated bills.
- Keep monthly remaining-funds allocations separate from paycheck funding envelopes.
- Make no claims about calendar pay-period boundaries, cross-month funding, paid status, bank activity, reconciliation, or actual transfers.
- Operate schema-neutrally over normalized resident schema-version-3, schema-version-4, and schema-version-5 runtime data; preserve backup/snapshot envelope format version 1.

### Phase 6B — Honest actual transfers and accounts

- Add an Actual mode only after actuals and reconciliation are sufficiently complete.
- Model accounts and account-to-account transfers explicitly if required.
- Distinguish planned funding from received money, paid bills, and verified transfers without inferring financial activity.

## Phase 7 — Dashboard truth, accessibility, and reporting

Status: published, including spending basis, CSV, print, saved-month forecasting, and Upcoming bills & paydays through 2026-08-31.

- Published: honest incomplete-state handling plus corrected Savings Rate, Income, and Payment Method labeling and coverage.
- Published: an accessible table equivalent for every chart.
- Published: strict date-range validation, stale-visualization clearing, and Current month, Last 3 months, Last 6 months, and Year to date shortcuts.
- Published: an explicit Planned/Actual basis control for spending reports, with incomplete actuals preserved and planned-only reports clearly bounded.
- Published: range- and basis-aware CSV export with explicit completeness and spreadsheet-formula protection.
- Published: printable dashboard reports with explicit range and basis context, expanded data tables, and paper-safe presentation.
- Published: planned-only saved-future-month forecasting for the next 3, 6, or 12 months, with explicit gaps, accessible table, CSV, print support, and no recurring-template inference.
- Published: a closed Upcoming bills & paydays projection for saved records across explicit 30-, 60-, or 90-day local civil windows, with missing-plan gaps, Date needed records, truthful actual/funding states, and print support; reminders, calendar integration, inference, and account claims remain deferred.

### Saved-Record Finder

Status: published on 2026-09-01.

- Add one bounded, deterministic, detached Store scan over saved monthly paychecks and expenses and one initially closed Dashboard disclosure.
- Use submit-only literal, case-insensitive substring matching over saved income earner labels and saved expense names and categories, with optional kind and inclusive month filters.
- Keep canonical month/paycheck/expense/saved-array ordering, a 200-result return cap, and truthful full-count and truncation reporting.
- Keep queries and results local and transient with no persistence, URLs, history, logs, exports, reports, evidence, analytics, snapshots, clocks, identifiers, generation changes, migrations, or memory mutation.
- Return presentation-safe saved-record facts only, preserving decimal-facing values, `actualAmount:null`, and entered zero across resident schema versions 3, 4, and 5 without exposing cents or internal structure, template, clearing, funding, or recurrence fields.
- Revalidate the exact current result before routing to its existing Budget Edit control; a route never opens an editor or writes.
- Make no payment, due-date, cleared, funding, account, balance, reconciliation, or lifecycle claim.

The lean ceiling is a bounded scan, one closed disclosure, and one existing-control focus route. Consider a rebuildable in-memory index only if measured ledger performance requires it; richer filters or saved queries require explicit user demand, and persistence requires a separate privacy and invalidation contract.

### Months needing attention

Status: published on 2026-09-01.

- Provide one initially closed Dashboard disclosure over saved months only, bounded to an exact 6-, 12-, or 24-month lookback.
- Keep the queue deterministic, read-only, and passive: rendering, lookback changes, stale handling, and routing do not write, migrate, snapshot, generate identifiers, or advance Store generations.
- Revalidate the exact current item before routing, then focus only its existing Budget or Monthly Review target; stale items refresh safely instead of routing to outdated controls.
- Make no priority, completion, payment, bank-verification, reconciliation, or month-close claim.

The lean ceiling is the existing fixed-window scan and passive route to existing controls. Do not add persistence, indexes, caches, durable summaries, or background work without a measured performance need and a separately reviewed contract.

### Saved Month Comparison

Status: published on 2026-09-01.

- Compare exactly two explicit, distinct saved months, passively defaulting to the two most recent saved months when available.
- Apply the Dashboard's global Planned or Actual basis and define every absolute delta as comparison minus baseline.
- Preserve incomplete actuals rather than treating them as zero, while keeping entered zero complete and allocations explicitly planned-only.
- Present summary, allocation, category, and payment-method rows in one accessible table with local CSV export and print output.
- Keep comparison deterministic, transient, read-only, write-free, and limited to the two selected saved months.
- Make no payment, account, bank-activity, reconciliation, or month-lifecycle claim.

The lean ceiling is one chart-free table over two saved months using existing projections and report paths. Do not add persistence, comparison history, caches, indexes, background processing, or schema changes without measured need and a separately reviewed contract.

### Explain change

Status: published on 2026-09-01.

- Add a lazy, inline **Explain change** action only to category and payment-method comparison rows.
- Group matching saved expense contributors under baseline and comparison, using the selected Planned or Actual basis and preserving `null` as **Not entered** separately from entered zero.
- Scan only the two selected saved months and return at most 200 contributors across both sides with truthful full and per-side counts plus explicit truncation.
- Revalidate the exact current contributor before routing to its existing Budget Edit control; stale contributors refresh safely without opening an editor or writing.
- Keep contributor detail transient, write-free, and interactive-only; exclude it from comparison CSV and print output.
- Add no persistence, index, cache, background processing, schema changes, charts, scoring, ranking, recommendations, payment claims, or reconciliation behavior.

The lean ceiling is one on-demand two-month expense scan rendered beneath the selected comparison row. Broader drilldowns, cached aggregates, indexes, or recommendations require measured need and a separately reviewed contract.

### Wave 4 — Audit hardening evidence

Status: published on 2026-09-01.

- Document the local plaintext storage boundary, explicit browser-only purge, and manual deletion of downloaded recovery artifacts.
- Keep the browser-evidence suite boolean-only and disposable, with separate coverage for multi-tab stale/busy fail-closed behavior, reload recovery, purge cancel/confirm/focus and exact key removal, CSP-safe node modals, and prepared-dashboard passive byte invariance.
- Keep vendored Chart.js provenance pinned to the bundled artifact and manual update procedure.

### Large-ledger performance profiling

Status: tooling and representative baseline published on 2026-09-01.

- Generate only deterministic, generic synthetic ledgers at bounded, configurable month and expense counts.
- Measure startup/load, an ordinary edit commit, prepared Dashboard range generation, saved-record search, saved-month comparison, and Explain change with duration distributions and available serialized/write-byte counts.
- Keep machine-readable JSON free of record labels, identifiers, machine details, and ledger contents; keep local result files out of Git.
- Treat timings as measurements rather than test gates, with no flaky wall-clock thresholds in the normal suite.
- Use same-machine repeated baseline and candidate runs to decide the next optimization. Storage sharding is justified only when representative evidence ties user-visible edit latency to full-ledger serialization/write size; scanner or projection costs should receive narrower fixes instead.
- Require a separately reviewed migration contract before changing the compatible monolithic active-storage format.
- Published baseline: the 60-month × 200-expense fixture serialized to about 3.44 MB; median startup was about 123 ms, read-side operations remained below 5 ms, and the first-daily edit took about 855 ms while writing about 6.88 MB across active data and its safety snapshot.
- Result: the evidence isolates monolithic commit amplification rather than Dashboard or saved-record reads, so Forgeflow authorized implementation of an explicit, preview-first month-sharded storage migration with unchanged portable backup and snapshot envelopes.

## Global release gates

- No financial data, labels, amounts, or raw backups enter tests, logs, screenshots, or Git.
- Every mutation remains detached, validated, atomic, and failure-safe.
- Preview and Cancel paths write nothing.
- Existing backups, snapshots, recovery, recurrence, and direct local startup remain compatible.
- Keyboard, focus, 320px reflow, forced-colors, reduced-motion, and hostile-label rendering are validated.
- Unit tests, disposable-browser evidence, syntax checks, `git diff --check`, privacy scans, Compass validation, and Arbiter review pass before publication.
