# P0 synthetic browser baseline

Application source: `865b22ec1a9e3d64e28e9635df6310fae490b8b2`, unchanged by P0.
Built with Node 24.4.1; initial JavaScript 282154 bytes. The original and isolated
integration build manifests matched SHA256
`95f194d2a0dced5e87f0f575e14e9cb47b392b017a74bba63a604e1f6d3101ce`.

Terra fixture implementation ran the Playwright 1.63.0 harness (bundled Chromium
153.0.8010.12) against these production assets on Windows. This is synthetic browser evidence, not live provider data or
physical-device testing. Root visually inspected all three successful viewport
captures. At 390×844, the first candidate remains below the fold; that is a P2
baseline defect, not a P0 regression. Test-only labels overlay a small part of the
bottom edge and are not application UI.

| Scenario | 390×844 | 768×1024 | 1440×1000 | Assertion |
|---|---|---|---|---|
| Success | [PNG](success-390x844.png) | [PNG](success-768x1024.png) | [PNG](success-1440x1000.png) | 40 rendered aggregate candidates / 48 provider appearances |
| Empty | [PNG](empty-390x844.png) | [PNG](empty-768x1024.png) | [PNG](empty-1440x1000.png) | Successful empty-state copy |
| HTTP 503 | [PNG](error-390x844.png) | [PNG](error-768x1024.png) | [PNG](error-1440x1000.png) | Endpoint error alert |
| HTTP 200, success:false | [PNG](success-false-200-390x844.png) | [PNG](success-false-200-768x1024.png) | [PNG](success-false-200-1440x1000.png) | Existing misleading empty state, retained for P3 regression evidence |

[Mobile full-page capture](success-390x844-full-page.png) records the full list.
Each viewport PNG has a sibling `.evidence.json` with intercepted request evidence.
All API responses are synthetic; WebSockets and outside requests are blocked,
service workers disabled, and non-GET requests refused. No backend starts.

Reproduce with [fixture instructions](../../../scripts/fixtures/ui-simplification/README.md)
and `scripts/ui-baseline-browser.mjs`. Generated captures default to ignored `temp/`;
the selected evidence here is explicitly versioned for comparison in later phases.
