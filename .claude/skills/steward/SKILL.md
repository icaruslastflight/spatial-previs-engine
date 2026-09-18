---
name: steward
description: Repo-specific conventions for autonomously driving a spatial-previs-engine PR to green (CI failure, review comment, or check-suite event). Load this before acting on any such event on a PR you opened or were asked to drive to mergeable.
---

# Stewarding a spatial-previs-engine PR

This skill supplies facts specific to this repository that the general
PR-driving rules in the system prompt don't know on their own. Read it before
reacting to a CI failure, a review comment, or a check-suite event on a PR you
own or were asked to drive.

## What CI actually covers — and what it doesn't

`.github/workflows/ci.yml` runs, on every push/PR:

- **Foundation verify (typecheck, test, build)** — `npm run verify`.
- **Native coordinate boundary without engine** — compiles
  `native/tests/coordinates.cpp` with a stock C++ toolchain, Linux-only. This
  is *not* a UE5 build.
- **Native evidence comparator corruption tests** — unit tests on
  `compare-r0-native.mjs`/`compare-r0-native-workspace.mjs` themselves.
- **R0 production browser workflows** — Playwright/Chromium acceptance.
- **Splat pipeline scripts** — Python byte-compile + `cleanup_splat.py --self-test`.

None of these run the actual **Windows-only UE5 build and conformance
commandlet chain** (`scripts/verify-r0-native.ps1`, which compiles the editor
and runs `SpatialPrevisConformance` / `SpatialPrevisWorkspaceConformance`
in-engine). **A green CI run is not native-conformance evidence.** Never
report or imply otherwise when closing out a PR event — if native code is
touched, say plainly that CI doesn't cover it and that
`scripts/workflows/run_native_r0_conformance.ps1` still needs a human on a
Windows box with UE5.8 installed.

## Known-intentional gaps — not yours to opportunistically "fix"

A CI failure or review comment that happens to touch either of these is a
real finding to act on; proactively "cleaning them up" as a drive-by while
stewarding something unrelated is not:

- The GDTF converter trio's `TODO(reverse-engineer)` markers
  (`scripts/onyx_to_gdtf.py:85,180`, `scripts/capture_to_gdtf.py:79,237`).
  Each file's own docstring (`onyx_to_gdtf.py:25`, `capture_to_gdtf.py:27`)
  states these are best guesses against an undocumented proprietary schema —
  resolving them needs real sample files, not a guess from this session.
- `docs/r0/UE5_CONFORMANCE.md`'s status line: "native CORE-01 source
  implemented; Unreal build and runtime conformance pending." That's an
  accurate, deliberate statement, not stale documentation to "complete."

## Anything beyond a one-line fix

Load the `phased-plan` skill and write the plan before pushing — this repo's
own CLAUDE.md §13 requires it for any change spanning three-plus steps or
multiple modules, and a steward's own fixes are not exempt from that rule
just because they're reactive.
