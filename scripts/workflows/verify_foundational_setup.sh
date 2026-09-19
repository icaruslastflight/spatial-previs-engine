#!/usr/bin/env bash
#
# Phase 1 foundation health check.
#
# Confirms that the repository architecture is intact and that the three
# terminal gates still pass:
#
#   1. Layer directories exist and carry the modules that define them.
#   2. npx tsc --noEmit          -> 0 errors
#   3. npm test                  -> all suites green
#   4. npm run build             -> a dist/ bundle, with the PWA artifacts
#
# Run it before committing anything that touches the core, and in CI.
#
#   scripts/workflows/verify_foundational_setup.sh
#   scripts/workflows/verify_foundational_setup.sh --skip-build

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SKIP_BUILD=0
SKIP_TESTS=0

usage() {
  cat <<'USAGE'
Phase 1 foundation health check.

Usage:
  scripts/workflows/verify_foundational_setup.sh [--skip-tests] [--skip-build]

Options:
  --skip-tests   Structure and typecheck only. For a fast inner loop.
  --skip-build   Skip the production build gate. The build is the slow one
                 (Cesium's runtime trees are copied into dist/).
  -h, --help     This text.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ANSI only when attached to a terminal, so CI logs stay readable.
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; DIM=""; RESET=""
fi

FAILURES=0
WARNINGS=0

pass()  { printf '  %sPASS%s  %s\n' "$GREEN" "$RESET" "$1"; }
fail()  { printf '  %sFAIL%s  %s\n' "$RED" "$RESET" "$1"; FAILURES=$((FAILURES + 1)); }
warn()  { printf '  %sWARN%s  %s\n' "$YELLOW" "$RESET" "$1"; WARNINGS=$((WARNINGS + 1)); }
note()  { printf '        %s%s%s\n' "$DIM" "$1" "$RESET"; }
section() { printf '\n%s\n' "$1"; }

require_dir() {
  local dir="$1" purpose="$2"
  if [[ -d "$dir" ]]; then
    pass "$dir/ ${DIM}-- ${purpose}${RESET}"
  else
    fail "$dir/ is missing ${DIM}-- ${purpose}${RESET}"
  fi
}

require_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    pass "$file"
  else
    fail "$file is missing"
  fi
}

# ------------------------------------------------------- [1] architecture ---
section "[1] Layer directories"
require_dir src/core       "frame clock, event bus, memory pool"
require_dir src/geospatial "WGS84 anchor and CP-1 checkpoint"
require_dir src/engine     "socket snapping and DMX matrix"
require_dir src/render     "WebGPU beam and laser renderers"
require_dir src/network    "Art-Net 4 / sACN telemetry ingest"
require_dir src/ui         "operator HUD and inspectors"

section "[2] Core engine modules"
require_file src/core/EventBus.ts
require_file src/core/MemoryPool.ts
require_file src/core/EngineLoop.ts

section "[3] Root configuration"
require_file package.json
require_file tsconfig.json
require_file vite.config.ts
require_file vitest.config.ts
require_file index.html
require_file .github/workflows/ci.yml
require_file .github/workflows/deploy.yml

# ---------------------------------------------------------- [4] invariants ---
section "[4] Cross-platform invariants"

# The anchor is declared exactly once. A second declaration is how the web and
# the UE5 build silently drift apart -- see CLAUDE.md section 2.
#
# Keyed on the LONGITUDE, not the latitude: the fountain landmark in
# PointStateParkAnchor.ts sits at the same 40.4417 latitude as the site origin
# (it is due west of it, at -80.0098), so a latitude match is not evidence of a
# re-declared anchor. The signed longitude -80.0075 is unique to the origin.
anchor_decls=$(grep -REl 'longitude:[[:space:]]*-80\.0075' src --include='*.ts' \
  | grep -cv '\.test\.ts$' || true)
if [[ "$anchor_decls" == "1" ]]; then
  pass "Point State Park anchor declared in exactly one module"
else
  fail "Point State Park anchor appears in $anchor_decls modules (expected 1)"
  note "Import POINT_STATE_PARK from src/geo/GeoAnchor.ts instead of re-declaring it."
fi

# Longitude must be stored signed. A positive 80.0075 puts the site in Kazakhstan.
if grep -RInE 'longitude:[[:space:]]*80\.0075' src --include='*.ts' >/dev/null 2>&1; then
  fail "unsigned longitude 80.0075 found -- Pittsburgh is NEGATIVE (-80.0075)"
else
  pass "longitude is stored signed west"
fi

# The snapping tolerances are mirrored verbatim in UE5.
if grep -q 'SNAP_THRESHOLD_METERS = 0.15' src/engine/SocketSnappingEngine.ts; then
  pass "SNAP_THRESHOLD_METERS is 0.15 m"
else
  fail "SNAP_THRESHOLD_METERS has drifted from 0.15 m (mirrored in UE5)"
fi
if grep -q 'DETENT_STEP_RADIANS = Math.PI / 2' src/engine/SocketSnappingEngine.ts; then
  pass "DETENT_STEP_RADIANS is pi/2 (90 deg detents)"
else
  fail "DETENT_STEP_RADIANS has drifted from pi/2 (mirrored in UE5)"
fi

# Static free hosting cannot set COOP/COEP, so shared memory must stay off.
if grep -RIn 'sharedMemoryForWorkers:[[:space:]]*true' src --include='*.ts' >/dev/null 2>&1; then
  fail "sharedMemoryForWorkers is enabled -- needs a host that can serve COOP/COEP"
else
  pass "no cross-origin isolation assumed"
fi

# A committed API key is unrecoverable once pushed.
if [[ -f .env.local ]] && git ls-files --error-unmatch .env.local >/dev/null 2>&1; then
  fail ".env.local is tracked by git -- it holds API keys"
else
  pass "no tracked .env.local"
fi

# ------------------------------------------------------------ [5] toolchain ---
section "[5] Toolchain"
if [[ -d node_modules ]]; then
  pass "node_modules present"
else
  fail "node_modules missing -- run: npm install"
  note "The gates below cannot run without it."
fi

# `npm run bridge` targets a Phase 4 deliverable. Report it honestly rather
# than letting a contributor discover the gap by running it.
if [[ -f scripts/foh_bridge_daemon.js ]]; then
  pass "scripts/foh_bridge_daemon.js present (npm run bridge)"
else
  warn "scripts/foh_bridge_daemon.js not yet authored -- lands in Phase 4"
  note "'npm run bridge' is declared in package.json but will not run until then."
fi

# ---------------------------------------------------------------- [6] gates ---
run_gate() {
  local label="$1"; shift
  section "$label"
  if "$@"; then
    pass "$label"
  else
    fail "$label"
  fi
}

if [[ ! -d node_modules ]]; then
  printf '\n%sSkipping the verification gates: dependencies are not installed.%s\n' "$YELLOW" "$RESET"
else
  run_gate "[6] npx tsc --noEmit" npx tsc --noEmit

  if [[ "$SKIP_TESTS" == "1" ]]; then
    section "[7] npm test"
    warn "skipped (--skip-tests)"
  else
    run_gate "[7] npm test" npm test --silent
  fi

  if [[ "$SKIP_BUILD" == "1" ]]; then
    section "[8] npm run build"
    warn "skipped (--skip-build)"
  else
    run_gate "[8] npm run build" npm run build
    if [[ -f dist/index.html ]]; then
      pass "dist/index.html emitted"
    else
      fail "dist/index.html was not emitted"
    fi
    # The PWA is what makes the client installable on a phone at the site.
    if [[ -f dist/manifest.webmanifest ]]; then
      pass "dist/manifest.webmanifest emitted"
    else
      fail "dist/manifest.webmanifest was not emitted"
    fi
    if [[ -f dist/sw.js ]]; then
      pass "dist/sw.js service worker emitted"
    else
      fail "dist/sw.js service worker was not emitted"
    fi
    # Cesium fetches these at runtime; they cannot be bundled.
    if [[ -d dist/cesium/Assets ]]; then
      pass "dist/cesium/ runtime assets copied"
    else
      fail "dist/cesium/ runtime assets missing -- Cesium will 404 at runtime"
    fi
    # dashboard/main.ts fetches this by a bare relative URL at runtime, not a
    # static import -- Vite's build only copies files it can see referenced
    # (public/ verbatim, or an import/new URL() it can trace), so a file that
    # only `npm run dev`'s filesystem-serving mode can find silently vanishes
    # from `dist/` while local dev keeps working. Exactly this shipped once
    # (404 on the real GitHub Pages deploy, dev server never showed it).
    if [[ -f dist/dashboard/data/decisions.json ]]; then
      pass "dist/dashboard/data/decisions.json emitted"
    else
      fail "dist/dashboard/data/decisions.json missing -- the decisions panel will 404 in production"
    fi
  fi
fi

# --------------------------------------------------------------- [9] verdict ---
printf '\n'
if [[ "$FAILURES" -eq 0 ]]; then
  printf '%sFOUNDATION VERIFIED%s' "$GREEN" "$RESET"
  [[ "$WARNINGS" -gt 0 ]] && printf ' %s(%d warning(s))%s' "$YELLOW" "$WARNINGS" "$RESET"
  printf '\n\n'
  exit 0
fi

printf '%s%d FOUNDATION CHECK(S) FAILED%s\n\n' "$RED" "$FAILURES" "$RESET"
exit 1
