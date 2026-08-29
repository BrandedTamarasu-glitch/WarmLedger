# ZeroBudget

ZeroBudget is a local, dependency-free budgeting application. It runs directly in a browser and stores budget records in that browser's site-specific storage.

## Run locally

Open `index.html` in a modern browser. From this directory on Linux, for example:

```bash
chromium "file://$PWD/index.html"
```

Continue opening the same absolute file path in the same browser profile. Browser storage for a `file://` page can be path- and browser-specific, so moving the project or changing profiles may present a separate empty budget.

No install or dependency download is required. To run the automated data-safety tests, install Node.js and run:

```bash
npm test
```

The test suite uses Node's built-in test runner and synthetic records only.

## Back up and restore

Use **Download backup** to save one timestamped, versioned JSON file. Keep downloaded backups somewhere durable; they are the portable way to retain or move a budget.

Use **Restore backup** to select a ZeroBudget JSON backup. The app validates and previews the file before asking for confirmation. Restoring replaces the current budget, so ZeroBudget first creates a local safety snapshot when valid saved data exists. Invalid or cancelled restores do not replace the active budget.

Do not rename JavaScript files to use them as backups and do not paste budget data into the source tree. Executable seed-data backups are intentionally unsupported.

## Local snapshots and recovery

ZeroBudget keeps a logical list of the seven newest valid safety snapshots. These snapshots are stored in the same browser, for the same site or file origin, as the active budget. They are useful for recovering from a damaged active record, but they are not durable backups.

Browser storage limits or cleanup failures can temporarily leave more than seven physical snapshot entries; the app still exposes only the newest seven valid snapshots and retries valid-snapshot cleanup during later saves. Malformed or unreadable snapshot entries are retained rather than deleted automatically, so they may remain physically present and contribute to browser storage quota until site data is cleared.

If active data cannot be validated, ZeroBudget blocks ordinary editing and displays recovery actions:

- Restore a validated local snapshot.
- Download the preserved corrupt bytes for diagnosis or manual recovery.
- Explicitly start fresh with an empty generic budget.

Clearing browser/site data, deleting a browser profile, changing the page's path/origin, or browser storage eviction can remove the active budget and every local snapshot together. Downloaded JSON backups are not affected by clearing site data.

## Privacy and repository history

Budget data remains local unless you download, copy, or otherwise share it. JSON backups contain financial records in readable form and should be stored accordingly; they are not encrypted.

This repository must remain private. Earlier Git history contains prior sensitive budget seed data even though those artifacts have been removed from the current tree. No Git-history rewrite was performed as part of this work.
