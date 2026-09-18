---
name: babysit
description: Repo-specific facts for watching/monitoring a spatial-previs-engine PR without necessarily driving it — what CI job names to expect, and what CI can never confirm on its own. Load this when asked to watch, monitor, or babysit a PR here.
---

# Watching a spatial-previs-engine PR

Same underlying facts as the `steward` skill, framed for reporting rather than
autonomous fixing.

## CI job names to watch for

`.github/workflows/ci.yml` runs two jobs per push/PR:

- **Foundation verify (typecheck, test, build)** — with four named steps:
  "Foundation verify", "Native coordinate boundary without engine", "Native
  evidence comparator corruption tests", "R0 production browser workflows"
  (plus an evidence-artifact upload step, not a pass/fail check).
- **Splat pipeline scripts** — Python byte-compile + the splat clean-up
  self-test.

A red run in "Native coordinate boundary without engine" or "Native evidence
comparator corruption tests" is real Linux-side breakage in shared native
contract code — report it as such.

## What green CI does not prove

CI never runs the Windows-only UE5 editor build or the
`SpatialPrevisConformance` / `SpatialPrevisWorkspaceConformance` commandlets
(that's `scripts/verify-r0-native.ps1`, Windows-only, not in any workflow).
If the PR under watch touches native-adjacent code —
`src/domain/ProductionProject.ts`, `src/domain/WorkspaceState.ts`, anything
under `native/`, or the `extras.sockets`/GDTF contract shape — **say plainly
that native conformance is unverified by CI** and that a human still needs to
run `scripts/workflows/run_native_r0_conformance.ps1` on a workstation with
UE5.8 installed before treating the change as proven on both platforms. Do
not report the PR as fully verified on the strength of a green GitHub check
alone in that case.

## Escalation

This skill is about reporting, not fixing. When something is confidently
small and in scope, say so and offer to push a fix (or push it, per the
posture the system prompt sets for this PR); when it's ambiguous or
touches the native/web parity contract, surface it to the user rather than
guessing.
