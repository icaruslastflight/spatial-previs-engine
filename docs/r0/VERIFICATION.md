# R0 verification record

Date: 17 September 2026. Web implementation: `r0-web-preview.2` at `77a69c0`.
Native continuation: `codex/ue5-r0-native`, CORE-01 source milestone.

| Gate | Executed evidence |
| --- | --- |
| Foundation structure/invariants | `npm run verify`: passed. |
| Strict TypeScript | Passed as part of verification. |
| Unit/domain/scene tests | 659 passed across 17 files. Includes 324 shared corpus/reproducibility tests, plus existing commands, socket integration, evidence and recovery coverage. |
| Production build/PWA | Passed; both entrypoints, service worker and Cesium runtime assets emitted. |
| Browser test syntax | `node --check scripts/test-r0-browser.mjs`: passed. |
| Production browser workflows | 23 scenarios passed on remote Windows Chrome 153.0.8010.48. Real desktop and phone-width screenshots captured and inspected; results retained with this record. |
| Native coordinate boundary | 358 portable C++ assertions passed with Linux GCC and remote Windows MSVC. Same header feeds the UE transform adapter. |
| Native report comparator | 34 synthetic corruption tests passed. Synthetic reports are not native execution evidence. |
| Native UE5 | Source project, codec, record inspector and commandlet implemented. UE5.8.2 files downloaded. Initial build blocked by absent TMP in the remote process environment; preflight now restores Windows temp paths. Owner restart interrupted the next attempt; native compilation/UI/conformance not run. |
| Actual Android / visual approval | Not run / not approved. |

The previous web milestone had 335 passing tests. The shared corpus adds 324 tests
for 292 semantic cases, 26 malformed JSON strings and corpus integrity/reproducibility.
The 292 semantic cases contain 25 valid projects and 267 rejection cases.

The Windows coordinate check ran at
`test-results/native/20260917-001258-985/coordinates.log` on the remote checkout.
The test compiles C++ without Unreal headers; it does not close the engine gate.
Web browser output is retained at `docs/r0/evidence/web-browser-results.json`.

Browser results belong in `test-results/r0/` or the CI artifact named
`r0-browser-evidence`; an authored test script is not a recorded pass.
The unit tests exercise Three.js socket transforms without a GPU, so they are not
visual quality or real-device interaction evidence.
