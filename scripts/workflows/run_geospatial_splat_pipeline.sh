#!/usr/bin/env bash
#
# Reusable geospatial Gaussian-splat venue pipeline.
#
# Ingests a capture, strips transient obstructions, georeferences the result
# against a WGS84 origin, registers it for the web runtime and verifies the
# build. Parameterised so any future event site runs the same path Point State
# Park did.
#
#   scripts/workflows/run_geospatial_splat_pipeline.sh \
#       --venue-name "Point State Park" \
#       --lat 40.4417 --long -80.0075 --elevation 220 \
#       --input-scan  captures/psp_raw.ply \
#       --output-splat public/assets/scans/point_state_park_clean.splat
#
# ELEVATION IS ORTHOMETRIC (metres above mean sea level) -- the number on the
# survey drawing. WGS84 and Cesium want ELLIPSOIDAL height, so the script
# converts using the geoid separation for the site. Feeding a raw MSL figure
# into a WGS84 pipeline floats the venue tens of metres off the basemap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------- defaults ---
VENUE_NAME=""
LAT=""
LONG=""
ELEVATION=""              # orthometric metres (MSL)
GEOID_SEPARATION=""       # metres; negative where the geoid is below the ellipsoid
INPUT_SCAN=""
OUTPUT_SPLAT=""
DETECTOR="auto"
VIEWS=8
SKIP_BUILD=0
SKIP_CLEAN=0
SYNTHESIZE=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^#//; s/^ //'
  cat <<'USAGE'

Required:
  --venue-name   NAME    Human-readable venue name (e.g. "Point State Park")
  --lat          DEG     Latitude, signed decimal degrees (north positive)
  --long         DEG     Longitude, signed decimal degrees (EAST positive;
                         western hemisphere is NEGATIVE -- -80.0075, not 80.0075)
  --elevation    M       Site elevation, metres above MEAN SEA LEVEL

Scan input (one of):
  --input-scan   PATH    Capture to ingest (.ply or .splat)
  --synthesize           Generate a labelled synthetic capture instead. Use when
                         no real scan exists yet, to exercise the pipeline.

Optional:
  --output-splat PATH    Cleaned output (default: public/assets/scans/<slug>_clean.splat)
  --geoid-separation M   Geoid height above the ellipsoid (default: -33.4, western PA).
                         Look this up per site; it varies by tens of metres globally.
  --detector     MODE    auto | geometric | sam2   (default: auto)
  --views        N       Rendered views for the SAM-2 pass (default: 8)
  --skip-clean           Ingest and georeference only; do not run clean-up
  --skip-build           Do not run typecheck/build at the end
  -h, --help             This message
USAGE
}

# ------------------------------------------------------------------- args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --venue-name)       VENUE_NAME="$2"; shift 2 ;;
    --lat)              LAT="$2"; shift 2 ;;
    --long|--lon)       LONG="$2"; shift 2 ;;
    --elevation)        ELEVATION="$2"; shift 2 ;;
    --geoid-separation) GEOID_SEPARATION="$2"; shift 2 ;;
    --input-scan)       INPUT_SCAN="$2"; shift 2 ;;
    --output-splat)     OUTPUT_SPLAT="$2"; shift 2 ;;
    --detector)         DETECTOR="$2"; shift 2 ;;
    --views)            VIEWS="$2"; shift 2 ;;
    --synthesize)       SYNTHESIZE=1; shift ;;
    --skip-build)       SKIP_BUILD=1; shift ;;
    --skip-clean)       SKIP_CLEAN=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { echo "ERROR: $*" >&2; exit 2; }

[[ -n "$VENUE_NAME" ]] || fail "--venue-name is required"
[[ -n "$LAT"        ]] || fail "--lat is required"
[[ -n "$LONG"       ]] || fail "--long is required"
[[ -n "$ELEVATION"  ]] || fail "--elevation is required"
[[ -n "$INPUT_SCAN" || "$SYNTHESIZE" -eq 1 ]] || fail "one of --input-scan or --synthesize is required"

GEOID_SEPARATION="${GEOID_SEPARATION:--33.4}"

# Numeric sanity. A latitude of 400 or a longitude of 800 is a typo, not a site.
awk -v v="$LAT"  'BEGIN{ if (v+0 < -90  || v+0 > 90)  exit 1 }' || fail "--lat $LAT is outside [-90, 90]"
awk -v v="$LONG" 'BEGIN{ if (v+0 < -180 || v+0 > 180) exit 1 }' || fail "--long $LONG is outside [-180, 180]"

# Western-hemisphere guard: the single most common georeferencing mistake is a
# longitude entered without its sign, which lands the venue in Asia.
case "$VENUE_NAME" in
  *Pittsburgh*|*"Point State"*)
    awk -v v="$LONG" 'BEGIN{ exit (v+0 < 0) ? 0 : 1 }' \
      || fail "--long $LONG is positive for a US venue; western longitudes are NEGATIVE"
    ;;
esac

SLUG="$(printf '%s' "$VENUE_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '_' | sed 's/^_//; s/_$//')"
[[ -n "$SLUG" ]] || fail "--venue-name '$VENUE_NAME' produced an empty slug"

SCAN_DIR="public/assets/scans/${SLUG}"
OUTPUT_SPLAT="${OUTPUT_SPLAT:-public/assets/scans/${SLUG}_clean.splat}"

ELLIPSOIDAL="$(awk -v h="$ELEVATION" -v n="$GEOID_SEPARATION" 'BEGIN{ printf "%.3f", h + n }')"

echo
echo "=== Geospatial splat pipeline: ${VENUE_NAME} ==="
echo "  slug            : ${SLUG}"
echo "  WGS84 origin    : ${LAT}, ${LONG}"
echo "  elevation       : ${ELEVATION} m MSL  +  ${GEOID_SEPARATION} m geoid  =  ${ELLIPSOIDAL} m ellipsoidal"
echo "  output          : ${OUTPUT_SPLAT}"
echo "  detector        : ${DETECTOR}"
echo

command -v python3 >/dev/null || fail "python3 not found"
python3 -c "import numpy" 2>/dev/null || fail "numpy not installed (pip3 install numpy)"
command -v node >/dev/null || fail "node not found"

mkdir -p "$SCAN_DIR"

# ----------------------------------------------------------- 1. ingestion ---
echo "[1/5] Ingesting capture"
if [[ "$SYNTHESIZE" -eq 1 ]]; then
  INGESTED="${SCAN_DIR}/${SLUG}_synthetic_raw.splat"
  python3 scripts/cleanup_splat.py --synthesize "$INGESTED"
  echo "      synthetic capture written (labelled stand-in, NOT survey data)"
else
  [[ -f "$INPUT_SCAN" ]] || fail "input scan not found: $INPUT_SCAN"
  case "$INPUT_SCAN" in
    *.ply|*.splat) ;;
    *) fail "unsupported scan format: $INPUT_SCAN (expected .ply or .splat)" ;;
  esac
  INGESTED="${SCAN_DIR}/$(basename "$INPUT_SCAN")"
  if [[ "$(cd "$(dirname "$INPUT_SCAN")" && pwd)/$(basename "$INPUT_SCAN")" != "$(cd "$SCAN_DIR" && pwd)/$(basename "$INPUT_SCAN")" ]]; then
    cp -f "$INPUT_SCAN" "$INGESTED"
  fi
  echo "      $(du -h "$INGESTED" | cut -f1) -> $INGESTED"
fi

# ------------------------------------------------------------ 2. clean-up ---
echo "[2/5] AI clean-up and ground inpainting"
if [[ "$SKIP_CLEAN" -eq 1 ]]; then
  echo "      skipped (--skip-clean); copying capture through unchanged"
  mkdir -p "$(dirname "$OUTPUT_SPLAT")"
  cp -f "$INGESTED" "$OUTPUT_SPLAT"
else
  python3 scripts/cleanup_splat.py \
    --input "$INGESTED" \
    --output "$OUTPUT_SPLAT" \
    --detector "$DETECTOR" \
    --views "$VIEWS"
fi

# ----------------------------------------------- 3. georeference + register ---
echo "[3/5] Georeferencing and registering"
VENUE_CONFIG="${SCAN_DIR}/venue.json"
cat > "$VENUE_CONFIG" <<JSON
{
  "venue_name": "${VENUE_NAME}",
  "slug": "${SLUG}",
  "wgs84_origin": {
    "latitude": ${LAT},
    "longitude": ${LONG},
    "elevation_orthometric_m": ${ELEVATION},
    "geoid_separation_m": ${GEOID_SEPARATION},
    "height_ellipsoidal_m": ${ELLIPSOIDAL}
  },
  "clean_splat": "$(printf '%s' "$OUTPUT_SPLAT" | sed 's#^public/##')",
  "generated_by": "scripts/workflows/run_geospatial_splat_pipeline.sh"
}
JSON
echo "      wrote $VENUE_CONFIG"

MANIFEST="public/assets/scans/manifest.json"
node -e '
  const fs = require("node:fs");
  const [manifestPath, configPath] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { scans: [] };
  manifest.scans = (manifest.scans ?? []).filter((s) => s.id !== config.slug);
  manifest.scans.push({
    id: config.slug,
    venue: config.venue_name,
    url: config.clean_splat,
    format: "splat",
    anchor: {
      latitude: config.wgs84_origin.latitude,
      longitude: config.wgs84_origin.longitude,
      height: config.wgs84_origin.height_ellipsoidal_m,
    },
    enu_offset_m: [0, 0, 0],
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`      registered "${config.slug}" in ${manifestPath}`);
' "$MANIFEST" "$VENUE_CONFIG"

# ------------------------------------------------------------ 4. verify -----
echo "[4/5] Verifying output"
[[ -f "$OUTPUT_SPLAT" ]] || fail "expected output not produced: $OUTPUT_SPLAT"
python3 - "$OUTPUT_SPLAT" <<'PYVERIFY'
import os, sys
path = sys.argv[1]
size = os.path.getsize(path)
if size == 0:
    sys.exit(f"ERROR: {path} is empty")
if size % 32 != 0:
    sys.exit(f"ERROR: {path} is {size} bytes, not a multiple of the 32-byte .splat record")
print(f"      {path}: {size // 32} splats, {size / 1e6:.2f} MB")
PYVERIFY

# ------------------------------------------------------------- 5. build -----
echo "[5/5] Build verification"
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo "      skipped (--skip-build)"
else
  npx tsc --noEmit
  echo "      typecheck clean"
  npm run build --silent >/dev/null
  echo "      production build clean"
fi

echo
echo "PIPELINE COMPLETE -- ${VENUE_NAME}"
echo "  clean splat : ${OUTPUT_SPLAT}"
echo "  venue config: ${VENUE_CONFIG}"
echo
