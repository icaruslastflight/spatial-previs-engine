#!/usr/bin/env python3
"""
AI scan clean-up and object inpainting for Gaussian splat venue captures.

Removes transient obstructions -- tourists, moving vehicles, temporary security
barricades -- from a Gaussian splat capture and reconstructs the ground surface
they were standing on, writing a clean binary .splat for the web runtime.

    # Clean a real capture
    python3 scripts/cleanup_splat.py \
        --input  public/assets/scans/point_state_park/raw.ply \
        --output public/assets/scans/point_state_park_clean.splat

    # Prove the pipeline end to end on a synthetic scene with known transients
    python3 scripts/cleanup_splat.py --self-test

    # Emit a labelled synthetic stand-in capture
    python3 scripts/cleanup_splat.py --synthesize public/assets/scans/point_state_park/synthetic_raw.splat

DETECTORS
    geometric  Always available. Voxel connected-components classified by
               real-world dimensions. Deterministic, no weights, no GPU.
    sam2       Segment Anything 2 instance masks over rendered views,
               back-projected and scored by the same dimensional rules, with
               multi-view voting. Needs `pip install sam2` and a checkpoint.
    auto       sam2 when weights are present, else geometric. Default.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from splatlib.formats import SplatCloud, load_any, write_splat  # noqa: E402
from splatlib.render import orbit_cameras, render_view, infer_up_axis  # noqa: E402
from splatlib.clean import (  # noqa: E402
    detect_transients_geometric,
    detect_transients_sam2,
    estimate_ground,
    inpaint_ground,
)

DEFAULT_SAM2_CHECKPOINT = "models/sam2/sam2.1_hiera_tiny.pt"
DEFAULT_SAM2_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"


# --------------------------------------------------------------------------- #
# Synthetic capture                                                            #
# --------------------------------------------------------------------------- #

def synthesize_capture(seed=7, up_axis=1):
    """
    Build a labelled stand-in capture of a riverfront park.

    Ground slopes toward the rivers, carries permanent structure (a pavilion,
    tree canopies, a fountain basin), and is populated with transients whose
    indices are recorded so detection can be scored exactly. This is what makes
    the pipeline testable in the absence of a real scan.

    Returns (cloud, truth) where truth is a boolean array: True == transient.
    """
    rng = np.random.default_rng(seed)
    chunks, labels = [], []
    axes = [a for a in (0, 1, 2) if a != up_axis]

    def emit(points, color, spread, transient, opacity=0.95):
        n = points.shape[0]
        cloud = SplatCloud(
            points.astype(np.float32),
            np.full((n, 3), spread, dtype=np.float32),
            np.clip(color + rng.normal(0, 0.035, (n, 3)), 0, 1).astype(np.float32),
            np.full(n, opacity, dtype=np.float32),
            np.tile(np.array([1, 0, 0, 0], dtype=np.float32), (n, 1)),
        )
        chunks.append(cloud)
        labels.append(np.full(n, transient, dtype=bool))

    def ground_height(a, b):
        # Gentle slope to the rivers plus a low levee ridge.
        return -0.018 * a - 0.012 * b + 0.35 * np.exp(-((a + 18.0) ** 2) / 260.0)

    # --- Terrain -----------------------------------------------------------
    n_ground = 120_000
    ga = rng.uniform(-60, 60, n_ground)
    gb = rng.uniform(-45, 45, n_ground)
    pts = np.zeros((n_ground, 3))
    pts[:, axes[0]] = ga
    pts[:, axes[1]] = gb
    pts[:, up_axis] = ground_height(ga, gb) + rng.normal(0, 0.012, n_ground)
    emit(pts, np.array([0.29, 0.36, 0.22]), 0.05, False)   # turf

    # --- Permanent structure: pavilion -------------------------------------
    n_wall = 9_000
    wa = rng.uniform(20, 30, n_wall)
    wb = rng.choice([-12.0, -4.0], n_wall) + rng.normal(0, 0.06, n_wall)
    pts = np.zeros((n_wall, 3))
    pts[:, axes[0]] = wa
    pts[:, axes[1]] = wb
    pts[:, up_axis] = ground_height(wa, wb) + rng.uniform(0, 4.2, n_wall)
    emit(pts, np.array([0.62, 0.58, 0.52]), 0.05, False)

    # --- Permanent structure: tree canopies --------------------------------
    for ta, tb in [(-30, 20), (-14, -26), (34, 16), (5, 33)]:
        n_tree = 5_000
        radius = rng.uniform(0, 3.1, n_tree) ** 0.5 * 3.1
        theta = rng.uniform(0, 2 * np.pi, n_tree)
        pts = np.zeros((n_tree, 3))
        pts[:, axes[0]] = ta + radius * np.cos(theta)
        pts[:, axes[1]] = tb + radius * np.sin(theta)
        # Canopy sits 3-7 m up: tall enough to fall outside every transient envelope.
        pts[:, up_axis] = ground_height(ta, tb) + rng.uniform(3.0, 7.0, n_tree)
        emit(pts, np.array([0.18, 0.33, 0.16]), 0.07, False)

    # --- Permanent structure: fountain basin wall --------------------------
    n_basin = 7_000
    theta = rng.uniform(0, 2 * np.pi, n_basin)
    pts = np.zeros((n_basin, 3))
    pts[:, axes[0]] = -40 + 8.0 * np.cos(theta)
    pts[:, axes[1]] = 0 + 8.0 * np.sin(theta)
    pts[:, up_axis] = ground_height(-40, 0) + rng.uniform(0, 0.55, n_basin)
    emit(pts, np.array([0.55, 0.54, 0.5]), 0.05, False)

    # --- Transients: tourists ----------------------------------------------
    tourist_spots = [(-6, 5), (-2, 9), (3, 4), (11, -7), (-20, -3),
                     (18, 12), (-33, 8), (7, 21), (25, -18), (-11, 27),
                     (14, 3), (-25, -14)]
    for ta, tb in tourist_spots:
        n_person = 900
        pts = np.zeros((n_person, 3))
        pts[:, axes[0]] = ta + rng.normal(0, 0.19, n_person)
        pts[:, axes[1]] = tb + rng.normal(0, 0.15, n_person)
        pts[:, up_axis] = ground_height(ta, tb) + rng.uniform(0.05, 1.78, n_person)
        emit(pts, np.array([0.45, 0.3, 0.34]), 0.035, True, opacity=0.8)

    # --- Transients: vehicles ----------------------------------------------
    for va, vb in [(42, -30), (-48, 26)]:
        n_vehicle = 3_000
        pts = np.zeros((n_vehicle, 3))
        pts[:, axes[0]] = va + rng.uniform(-2.3, 2.3, n_vehicle)
        pts[:, axes[1]] = vb + rng.uniform(-0.85, 0.85, n_vehicle)
        pts[:, up_axis] = ground_height(va, vb) + rng.uniform(0.06, 1.55, n_vehicle)
        emit(pts, np.array([0.3, 0.32, 0.38]), 0.05, True)

    # --- Transients: barricade line ----------------------------------------
    for offset in range(6):
        n_bar = 700
        ba = -5 + offset * 2.2
        pts = np.zeros((n_bar, 3))
        pts[:, axes[0]] = ba + rng.uniform(-0.95, 0.95, n_bar)
        pts[:, axes[1]] = -20 + rng.uniform(-0.1, 0.1, n_bar)
        pts[:, up_axis] = ground_height(ba, -20) + rng.uniform(0.05, 1.15, n_bar)
        emit(pts, np.array([0.7, 0.66, 0.2]), 0.04, True)

    # --- Transients: floaters (moving-object smear) ------------------------
    n_float = 1_500
    fa = rng.uniform(-25, 25, n_float)
    fb = rng.uniform(-25, 25, n_float)
    pts = np.zeros((n_float, 3))
    pts[:, axes[0]] = fa
    pts[:, axes[1]] = fb
    pts[:, up_axis] = ground_height(fa, fb) + rng.uniform(2.0, 2.9, n_float)
    emit(pts, np.array([0.5, 0.48, 0.5]), 0.06, True, opacity=0.35)

    cloud = chunks[0]
    for chunk in chunks[1:]:
        cloud = cloud.concat(chunk)
    return cloud, np.concatenate(labels)


# --------------------------------------------------------------------------- #
# Pipeline                                                                     #
# --------------------------------------------------------------------------- #

def clean_cloud(cloud, up_axis=None, detector="auto", views=8, voxel_size=0.25,
                ground_cell=1.0, sam2_checkpoint=DEFAULT_SAM2_CHECKPOINT,
                sam2_config=DEFAULT_SAM2_CONFIG, verbose=True):
    """Run the full clean-up. Returns (clean_cloud, removed_mask, stats)."""
    stats = {}
    if up_axis is None:
        up_axis = infer_up_axis(cloud)
    stats["up_axis"] = up_axis
    stats["input_splats"] = len(cloud)

    def log(message):
        if verbose:
            print(message, flush=True)

    log(f"  up axis            : {'XYZ'[up_axis]}")

    t0 = time.perf_counter()
    ground = estimate_ground(cloud, up_axis=up_axis, cell_size=ground_cell)
    log(f"  ground field       : {ground.heights.shape[0]}x{ground.heights.shape[1]} cells "
        f"@ {ground_cell} m ({time.perf_counter() - t0:.2f}s)")

    # Geometric pass always runs: it is the deterministic baseline.
    t0 = time.perf_counter()
    geo_mask, geo_report = detect_transients_geometric(
        cloud, ground, up_axis=up_axis, voxel_size=voxel_size
    )
    stats["geometric"] = geo_report
    log(f"  geometric detector : {int(geo_mask.sum())} splats flagged from "
        f"{geo_report['clusters']} clusters "
        f"(person {geo_report['person']}, vehicle {geo_report['vehicle']}, "
        f"barricade {geo_report['barricade']}, floater {geo_report['floater']}) "
        f"({time.perf_counter() - t0:.2f}s)")

    removed = geo_mask
    stats["detector_used"] = "geometric"

    want_sam2 = detector in ("auto", "sam2")
    have_weights = os.path.isfile(sam2_checkpoint)
    if want_sam2 and not have_weights:
        message = f"SAM-2 checkpoint not found at {sam2_checkpoint}"
        if detector == "sam2":
            raise SystemExit(f"ERROR: {message}")
        log(f"  sam2 detector      : skipped ({message})")
    elif want_sam2:
        t0 = time.perf_counter()
        try:
            lo, hi = cloud.bounds()
            center = (lo + hi) / 2.0
            span = float(np.max(hi - lo))
            cameras = orbit_cameras(center, span * 0.55, span * 0.18, views, up_axis=up_axis)
            rendered = [render_view(cloud, cam, 512, 512) for cam in cameras]
            sam_mask, sam_report = detect_transients_sam2(
                cloud, rendered, ground, up_axis=up_axis,
                checkpoint=sam2_checkpoint, model_cfg=sam2_config,
            )
            # Union: SAM-2 recovers instances geometry welds together, geometry
            # recovers instances no camera happened to see cleanly.
            removed = geo_mask | sam_mask
            stats["sam2"] = sam_report
            stats["detector_used"] = "geometric+sam2"
            log(f"  sam2 detector      : {int(sam_mask.sum())} splats flagged from "
                f"{sam_report['sam2_instances']} instances across {sam_report['views']} views "
                f"({time.perf_counter() - t0:.2f}s)")
        except Exception as exc:
            if detector == "sam2":
                raise
            log(f"  sam2 detector      : unavailable, geometric only ({exc})")

    stats["removed"] = int(removed.sum())

    t0 = time.perf_counter()
    patch, patch_report = inpaint_ground(cloud, removed, ground, up_axis=up_axis)
    stats["inpaint"] = patch_report
    log(f"  ground inpainting  : {patch_report['added']} splats across "
        f"{patch_report['patched_cells']} cells ({time.perf_counter() - t0:.2f}s)")

    clean = cloud.subset(~removed)
    if len(patch) > 0:
        clean = clean.concat(patch)
    stats["output_splats"] = len(clean)
    return clean, removed, stats


def score(truth, predicted):
    """Precision/recall of transient removal against ground truth."""
    tp = int(np.sum(truth & predicted))
    fp = int(np.sum(~truth & predicted))
    fn = int(np.sum(truth & ~predicted))
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    return precision, recall, tp, fp, fn


def run_self_test(args):
    print("\n=== cleanup_splat self-test (synthetic capture) ===\n")
    cloud, truth = synthesize_capture()
    print(f"  synthetic capture  : {len(cloud)} splats, "
          f"{int(truth.sum())} transient ({100 * truth.mean():.1f}%)")

    clean, removed, stats = clean_cloud(
        cloud, up_axis=1, detector=args.detector, views=args.views,
        sam2_checkpoint=args.sam2_checkpoint, sam2_config=args.sam2_config,
    )

    precision, recall, tp, fp, fn = score(truth, removed)
    print(f"\n  transient recall   : {100 * recall:5.1f}%  ({tp} removed / {tp + fn} present)")
    print(f"  removal precision  : {100 * precision:5.1f}%  ({fp} permanent splats wrongly removed)")
    print(f"  output             : {len(clean)} splats\n")

    checks = [
        ("recall >= 90% of transients removed", recall >= 0.90, f"{100 * recall:.1f}%"),
        ("precision >= 95% (terrain preserved)", precision >= 0.95, f"{100 * precision:.1f}%"),
        ("output is non-empty", len(clean) > 0, f"{len(clean)} splats"),
        ("ground was inpainted", stats["inpaint"]["added"] > 0, f"{stats['inpaint']['added']} added"),
    ]

    # The written file must round-trip: this is the binary the runtime loads.
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".splat", delete=False) as handle:
        temp_path = handle.name
    written = write_splat(temp_path, clean)
    reloaded = load_any(temp_path)
    os.unlink(temp_path)
    checks.append((
        "binary .splat round-trips",
        len(reloaded) == len(clean) and written == len(clean) * 32,
        f"{written} bytes, {len(reloaded)} splats",
    ))

    failures = 0
    for name, passed, detail in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}  ({detail})")
        if not passed:
            failures += 1

    print(f"\n{'SELF-TEST PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}\n")
    return 0 if failures == 0 else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Remove transient obstructions from a Gaussian splat capture.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", "-i", help="input .ply or .splat capture")
    parser.add_argument("--output", "-o", help="output binary .splat")
    parser.add_argument("--up-axis", type=int, choices=[0, 1, 2],
                        help="vertical axis (default: inferred from extents)")
    parser.add_argument("--detector", choices=["auto", "geometric", "sam2"], default="auto")
    parser.add_argument("--views", type=int, default=8, help="rendered views for SAM-2")
    parser.add_argument("--voxel-size", type=float, default=0.25)
    parser.add_argument("--ground-cell", type=float, default=1.0)
    parser.add_argument("--sam2-checkpoint", default=DEFAULT_SAM2_CHECKPOINT)
    parser.add_argument("--sam2-config", default=DEFAULT_SAM2_CONFIG)
    parser.add_argument("--self-test", action="store_true",
                        help="run the synthetic-capture verification and exit")
    parser.add_argument("--synthesize", metavar="PATH",
                        help="write a labelled synthetic capture and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test(args)

    if args.synthesize:
        cloud, truth = synthesize_capture()
        os.makedirs(os.path.dirname(os.path.abspath(args.synthesize)), exist_ok=True)
        written = write_splat(args.synthesize, cloud)
        print(f"Wrote synthetic capture: {args.synthesize}")
        print(f"  {len(cloud)} splats, {written / 1e6:.1f} MB, "
              f"{int(truth.sum())} transient ({100 * truth.mean():.1f}%)")
        return 0

    if not args.input or not args.output:
        parser.error("--input and --output are required (or use --self-test / --synthesize)")
    if not os.path.isfile(args.input):
        raise SystemExit(f"ERROR: input not found: {args.input}")

    print(f"\n=== cleanup_splat: {args.input} ===\n")
    cloud = load_any(args.input)
    print(f"  loaded             : {len(cloud)} splats")

    clean, removed, stats = clean_cloud(
        cloud, up_axis=args.up_axis, detector=args.detector, views=args.views,
        voxel_size=args.voxel_size, ground_cell=args.ground_cell,
        sam2_checkpoint=args.sam2_checkpoint, sam2_config=args.sam2_config,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    written = write_splat(args.output, clean)
    delta = len(clean) - len(cloud)
    pct = 100.0 * delta / max(1, len(cloud))
    direction = "smaller" if delta < 0 else "larger"
    print(f"\n  removed            : {stats['removed']} transient splats")
    print(f"  wrote              : {args.output}")
    print(f"                       {len(clean)} splats, {written / 1e6:.2f} MB "
          f"({abs(pct):.1f}% {direction} than input)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
