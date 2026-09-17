# R0 verification record

Date: 17 September 2026. Implementation: `r0-web-preview.2`.

| Gate | Executed evidence |
| --- | --- |
| Foundation structure/invariants | `npm run verify`: passed. |
| Strict TypeScript | Passed as part of verification. |
| Unit/domain/scene tests | 335 passed across 16 files. Includes real socket-to-command integration, atomic cancellation, unlink/undo, evidence boundaries and diagnostic replay. |
| Production build/PWA | Passed; both entrypoints, service worker and Cesium runtime assets emitted. |
| Browser test syntax | `node --check scripts/test-r0-browser.mjs`: passed. |
| Production browser workflows | Pending. Local Chromium installation timed out; the cloud browser blocked localhost. Remote/CI execution is the next gate. |
| Native UE5 | Not run. Remote workstation investigation in progress; no conformance claim. |
| Actual Android / visual approval | Not run / not approved. |

The recovered baseline had 320 passing tests. Six new scene-integration regressions
and nine new integrity/evidence regressions bring the total to 335.

Browser results belong in `test-results/r0/` or the CI artifact named
`r0-browser-evidence`; an authored test script is not a recorded pass.
The unit tests exercise Three.js socket transforms without a GPU, so they are not
visual quality or real-device interaction evidence.
