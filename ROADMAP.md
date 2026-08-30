# Warm Ledger Roadmap

This roadmap turns the August 2026 ForgeFlow product audit into sequenced, testable releases. Warm Ledger remains local-only, dependency-free, compatible with direct `file://` startup, schema version 3, and backup envelope version 1 unless a later phase explicitly authorizes a migration.

## Phase 1 — Data safety fixes

Status: complete locally; awaiting publication.

- Reset copied paycheck actual amounts to **Not entered**, matching copied expenses.
- Require accessible confirmation before deleting an expense.
- Offer one exact, session-only Undo after confirmed expense deletion.
- Preserve generated-occurrence exceptions, ordering, focus, snapshots, and atomic failure behavior.
- Add Store, UI, focus, and disposable-browser regression coverage.

Success means Copy from Previous Month never carries financial outcomes into a new month, and an expense cannot be lost through one unconfirmed click.

## Phase 2 — Data Health center

Status: complete locally; awaiting publication.

- Add deterministic, write-free whole-ledger checks for missing actuals, dates not entered, funding mismatches, interior month gaps, and conservative repeated patterns.
- Add an accessible Data Health view with overview counts and routes to the existing Budget and Templates workflows.
- Add explicit selected-record actual cleanup with preview, Cancel-first confirmation, atomic apply, stale-preview rejection, and correct `null` versus entered-zero behavior.
- Add validated, write-free backup comparison that classifies identical, addable, and conflicting months and structures.
- Keep comparison separate from Restore and state clearly that comparison imports nothing.
- Preserve passive-navigation byte equality and recovery gating.

Deferred within this phase: automatic date inference, automatic template creation, record-level merge, conflict remapping, and applying additive imports. Those require a separately reviewed conflict and rollback contract.

## Phase 3 — Template readiness

- Review imported and suggested templates in one queue.
- Show uncertain dates, amounts, and next occurrences.
- Support selected activation only after a combined next-month preview.
- Never silently enable or generate recurring records.

## Phase 4 — Exact-money foundation

- Establish integer cents or an equivalent exact two-decimal persistence contract.
- Migrate historical records atomically with before/after aggregate equality.
- Cover allocations, templates, imports, backups, charts, and formatting.

## Phase 5 — Reconciliation and month close

- Add cleared and reconciled state plus statement comparison.
- Introduce Open, Ready to Reconcile, Reconciled, and Closed month states.
- Prevent closing incomplete or mismatched months.
- Lock closed months and require an explicit snapshotted reopen flow.

## Phase 6 — Honest paycheck funding and transfers

### Phase 6A — Paycheck funding plan

Status: validated locally; awaiting publication.

- Present the compatibility-preserved Transfers route as **Pay periods**, a passive, read-only projection of explicit month-scoped paycheck funding.
- Show planned income separately from actual income, preserving **Not entered** (`null`) versus an entered zero.
- Support any number of paychecks and earners, bills split across paychecks, and clear fully funded, partially funded, unfunded, remaining, balanced, and over-assigned states.
- Keep assignments explicit and editable only in Budget; recurring templates do not auto-assign generated bills.
- Keep monthly remaining-funds allocations separate from paycheck funding envelopes.
- Make no claims about calendar pay-period boundaries, cross-month funding, paid status, bank activity, reconciliation, or actual transfers.
- Preserve data schema version 3 and backup/snapshot envelope version 1.

### Phase 6B — Honest actual transfers and accounts

- Add an Actual mode only after actuals and reconciliation are sufficiently complete.
- Model accounts and account-to-account transfers explicitly if required.
- Distinguish planned funding from received money, paid bills, and verified transfers without inferring financial activity.

## Phase 7 — Dashboard truth, accessibility, and reporting

- Add an explicit Planned/Actual basis and honest incomplete-state handling.
- Correct Savings Rate, Income, and Payment Method labeling and coverage.
- Add an accessible table equivalent for every chart.
- Validate date ranges and clear stale visualizations.
- Add forecasting, CSV export, and printable reports in later slices.

## Global release gates

- No financial data, labels, amounts, or raw backups enter tests, logs, screenshots, or Git.
- Every mutation remains detached, validated, atomic, and failure-safe.
- Preview and Cancel paths write nothing.
- Existing backups, snapshots, recovery, recurrence, and direct local startup remain compatible.
- Keyboard, focus, 320px reflow, forced-colors, reduced-motion, and hostile-label rendering are validated.
- Unit tests, disposable-browser evidence, syntax checks, `git diff --check`, privacy scans, Compass validation, and Arbiter review pass before publication.
