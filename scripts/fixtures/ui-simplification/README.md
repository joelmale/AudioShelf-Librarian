# UI simplification browser fixtures

`bestsellers.mjs` contains labelled, synthetic data for P0 browser baselines.
It has forty distinct aggregated candidates across all five response keys, plus
empty, HTTP-error, and `200 { success: false }` cases. It deliberately includes
duplicate appearances, missing covers/descriptions, long text and punctuation,
and non-Latin text. It is not provider data and must not be used for acquisition.

Capture the deterministic P0 baseline from a prebuilt frontend without starting
the backend. Supply `--dist` when the build is in another checkout:

```powershell
npm install --prefix $env:TEMP\audioshelf-ui-playwright playwright
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:TEMP\audioshelf-ui-playwright\browsers"
npx --prefix $env:TEMP\audioshelf-ui-playwright playwright install chromium
node scripts/ui-baseline-browser.mjs --dist C:\path\to\AudioShelf-Librarian\apps\frontend\dist
```

The script serves the current checkout's `apps/frontend/dist` by default,
intercepts each API request and WebSocket, and aborts every external request.
It writes initial-viewport and full-page PNGs plus per-capture request evidence
JSON to the ignored `temp/ui-baseline-browser` directory by default. Pass
`--help` for options.
