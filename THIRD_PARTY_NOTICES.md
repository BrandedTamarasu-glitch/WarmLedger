# Third-Party Notices

Warm Ledger vendors Chart.js in `js/chart.min.js`.

## Chart.js

- Version: 4.4.7
- Upstream project: https://github.com/chartjs/Chart.js
- Upstream release: https://github.com/chartjs/Chart.js/releases/tag/v4.4.7
- Original bundle source: `/npm/chart.js@4.4.7/dist/chart.umd.js`
- License: MIT
- Bundled artifact: `js/chart.min.js`
- SHA-256: 206b6e8bb00fc7bba2c7ee80ca41db3e9e05ba7be0aa35abeba9cfd5357f5d0e

Manual update procedure:

1. Download the Chart.js 4.4.7 UMD bundle from the upstream release or npm package source.
2. Replace `js/chart.min.js` with the new already-minified bundle or re-minify the upstream UMD file without changing its runtime behavior.
3. Recompute the SHA-256 for `js/chart.min.js` and update this notice if the file changes.
4. Run `npm test`.
5. If Chromium is available, run `npm run test:browser` and confirm the evidence run still passes with a disposable profile.
