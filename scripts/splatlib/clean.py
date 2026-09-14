"""
Transient removal and ground reconstruction for Gaussian splat captures.

A walked mobile capture of a public park records the park AND everyone who
happened to be standing in it. Those people, the cars on the access road and
the temporary barricades are transient: they were not there last week and will
not be there on show day, but photogrammetry bakes them into the geometry as
smeared, half-transparent blobs that a designer then has to plan around.

Two detectors run here and their votes are combined:

  geometric  Voxel connected-components over everything standing proud of the
             ground, classified by real-world dimensions. No model weights, no
             GPU, fully deterministic -- this is the one that always runs.

  sam2       Segment Anything 2 instance masks over rendered views,
             back-projected to 3D and scored with the same dimensional rules.
             SAM-2 is class-agnostic, so it does not "know" what a tourist is;
             what it contributes is clean instance BOUNDARIES where geometry
             alone would weld a person to the wall they are standing against.

Combining them matters: geometry alone over-segments crowds into one blob, and
masks alone cannot tell a person from a person-shaped bollard.
"""

from __future__ import annotations

import warnings
from collections import deque

import numpy as np

# Real-world dimension envelopes, metres. These are the semantics of the
# pipeline -- everything else is plumbing.
# `width` is the MINOR horizontal extent, `length` the major one. Keeping them
# separate is what lets a 30 m barricade run classify correctly: it is thin in
# cross-section but arbitrarily long, so a single "footprint" number that caps
# total size would reject the whole line.
TRANSIENT_CLASSES = {
    "person": dict(height=(0.9, 2.3), width=(0.15, 1.2), length=(0.15, 1.8), base=(-0.15, 0.6)),
    "vehicle": dict(height=(1.1, 4.2), width=(1.2, 3.2), length=(1.6, 7.5), base=(-0.15, 0.5)),
    "barricade": dict(height=(0.7, 1.7), width=(0.05, 1.1), length=(0.5, 80.0), base=(-0.15, 0.4)),
}


class GroundModel:
    """
    A 2.5D height field over the capture footprint.

    A single plane is wrong for Point State Park -- the site slopes to the
    rivers on two sides and carries a levee -- so the ground is stored as a
    coarse grid of local minima, hole-filled and smoothed.
    """

    def __init__(self, heights, origin, cell_size, axes):
        self.heights = heights          # (rows, cols) float32
        self.origin = origin            # (2,) world coords of cell (0, 0)
        self.cell_size = cell_size
        self.axes = axes                # the two horizontal axis indices

    def height_at(self, positions):
        """Ground height beneath each position, nearest-cell lookup."""
        rows, cols = self.heights.shape
        gx = np.clip(((positions[:, self.axes[0]] - self.origin[0]) / self.cell_size).astype(np.int64), 0, cols - 1)
        gy = np.clip(((positions[:, self.axes[1]] - self.origin[1]) / self.cell_size).astype(np.int64), 0, rows - 1)
        return self.heights[gy, gx]


def estimate_ground(cloud, up_axis=1, cell_size=1.0, percentile=8.0):
    """
    Fit a hole-filled ground height field.

    Each cell takes a low percentile rather than the strict minimum, so a
    single stray splat under the terrain does not drag the whole cell down.
    """
    positions = cloud.positions
    axes = [a for a in (0, 1, 2) if a != up_axis]
    lo, hi = cloud.bounds()

    origin = np.array([lo[axes[0]], lo[axes[1]]], dtype=np.float64)
    cols = max(1, int(np.ceil((hi[axes[0]] - lo[axes[0]]) / cell_size)) + 1)
    rows = max(1, int(np.ceil((hi[axes[1]] - lo[axes[1]]) / cell_size)) + 1)

    gx = np.clip(((positions[:, axes[0]] - origin[0]) / cell_size).astype(np.int64), 0, cols - 1)
    gy = np.clip(((positions[:, axes[1]] - origin[1]) / cell_size).astype(np.int64), 0, rows - 1)
    flat = gy * cols + gx
    up = positions[:, up_axis]

    heights = np.full(rows * cols, np.nan, dtype=np.float32)
    order = np.argsort(flat, kind="stable")
    sorted_cells, sorted_up = flat[order], up[order]
    boundaries = np.flatnonzero(np.diff(sorted_cells)) + 1
    for chunk in np.split(np.arange(sorted_cells.size), boundaries):
        if chunk.size == 0:
            continue
        heights[sorted_cells[chunk[0]]] = np.percentile(sorted_up[chunk], percentile)

    heights = heights.reshape(rows, cols)
    heights = _fill_holes(heights)
    heights = _smooth(heights)
    return GroundModel(heights, origin, cell_size, axes)


def _fill_holes(grid):
    """Fill empty cells by iterative dilation from populated neighbours."""
    filled = grid.copy()
    for _ in range(64):
        missing = np.isnan(filled)
        if not missing.any():
            break
        padded = np.pad(filled, 1, mode="edge")
        stack = np.stack([
            padded[0:-2, 1:-1], padded[2:, 1:-1],
            padded[1:-1, 0:-2], padded[1:-1, 2:],
        ])
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            # Cells with no populated neighbour yet are expected on early passes.
            warnings.simplefilter("ignore", category=RuntimeWarning)
            neighbour_mean = np.nanmean(stack, axis=0)
        filled = np.where(missing & ~np.isnan(neighbour_mean), neighbour_mean, filled)
    return np.nan_to_num(filled, nan=float(np.nanmin(grid)) if not np.all(np.isnan(grid)) else 0.0)


def _smooth(grid, passes=2):
    out = grid.astype(np.float32)
    for _ in range(passes):
        padded = np.pad(out, 1, mode="edge")
        out = (
            padded[1:-1, 1:-1] * 0.4
            + (padded[0:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, 0:-2] + padded[1:-1, 2:]) * 0.15
        ).astype(np.float32)
    return out


def _connected_components(voxel_keys):
    """
    Label 26-connected voxel clusters.

    BFS over a dict of occupied voxels. Linear in occupied voxels, which is the
    right complexity here -- the alternative (a full 3D label pass) would
    allocate a dense volume over a site hundreds of metres across.
    """
    lookup = {}
    for idx, key in enumerate(voxel_keys):
        lookup.setdefault(key, []).append(idx)

    labels = np.full(len(voxel_keys), -1, dtype=np.int64)
    neighbours = [(dx, dy, dz)
                  for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                  if (dx, dy, dz) != (0, 0, 0)]

    label = 0
    unvisited = set(lookup.keys())
    while unvisited:
        seed = unvisited.pop()
        queue = deque([seed])
        cluster = [seed]
        while queue:
            cx, cy, cz = queue.popleft()
            for dx, dy, dz in neighbours:
                key = (cx + dx, cy + dy, cz + dz)
                if key in unvisited:
                    unvisited.remove(key)
                    queue.append(key)
                    cluster.append(key)
        for key in cluster:
            for idx in lookup[key]:
                labels[idx] = label
        label += 1
    return labels, label


def classify_cluster(height, width, length, base_height):
    """
    Return the transient class this cluster's real-world dimensions fit, or None.

    `width` must be the minor horizontal extent and `length` the major one.
    """
    if width > length:
        width, length = length, width
    for name, envelope in TRANSIENT_CLASSES.items():
        h_lo, h_hi = envelope["height"]
        w_lo, w_hi = envelope["width"]
        l_lo, l_hi = envelope["length"]
        b_lo, b_hi = envelope["base"]
        if (h_lo <= height <= h_hi and w_lo <= width <= w_hi
                and l_lo <= length <= l_hi and b_lo <= base_height <= b_hi):
            return name
    return None


def detect_transients_geometric(cloud, ground, up_axis=1, voxel_size=0.25,
                                min_clearance=0.20, max_cluster_splats=200000,
                                ground_contact_floor=0.045, footprint_margin=0.15):
    """
    Flag splats belonging to clusters whose real-world dimensions match a
    transient class, plus unsupported floaters.

    Returns (mask, report).
    """
    positions = cloud.positions
    above = positions[:, up_axis] - ground.height_at(positions)

    standing = np.nonzero(above > min_clearance)[0]
    mask = np.zeros(len(cloud), dtype=bool)
    report = {"clusters": 0, "person": 0, "vehicle": 0, "barricade": 0,
              "floater": 0, "ground_contact": 0}
    footprints = []
    if standing.size == 0:
        return mask, report

    voxels = np.floor(positions[standing] / voxel_size).astype(np.int64)
    keys = [tuple(v) for v in voxels]
    labels, count = _connected_components(keys)
    report["clusters"] = count

    axes = [a for a in (0, 1, 2) if a != up_axis]
    for label in range(count):
        member_local = np.nonzero(labels == label)[0]
        if member_local.size == 0 or member_local.size > max_cluster_splats:
            continue
        members = standing[member_local]
        pts = positions[members]

        heights_above = above[members]
        extent_u = float(pts[:, up_axis].max() - pts[:, up_axis].min())
        extent_a = float(pts[:, axes[0]].max() - pts[:, axes[0]].min())
        extent_b = float(pts[:, axes[1]].max() - pts[:, axes[1]].min())
        base = float(heights_above.min())

        # Floater: hovering with nothing beneath it. Classic moving-object
        # artifact -- a person who walked through frame leaves a smear that
        # never touches the ground.
        if base > 1.6 and extent_u < 3.0:
            mask[members] = True
            report["floater"] += 1
            footprints.append((pts[:, axes[0]].min(), pts[:, axes[0]].max(),
                               pts[:, axes[1]].min(), pts[:, axes[1]].max()))
            continue

        kind = classify_cluster(extent_u, min(extent_a, extent_b), max(extent_a, extent_b), base)
        if kind is not None:
            mask[members] = True
            report[kind] += 1
            footprints.append((pts[:, axes[0]].min(), pts[:, axes[0]].max(),
                               pts[:, axes[1]].min(), pts[:, axes[1]].max()))

    # Sweep the footprint of every flagged object for the splats the clearance
    # filter hid: a person's shoes, a tyre contact patch, a barricade foot. They
    # sit below `min_clearance` so they never entered the clustering pass, and
    # leaving them behind strands a rim of debris exactly where the object was.
    # The floor here stays above the terrain band so turf is not eaten -- and
    # whatever is removed inside the footprint is re-synthesised by the
    # inpainting pass anyway.
    if footprints:
        low = (above > ground_contact_floor) & (above <= min_clearance)
        low_idx = np.nonzero(low)[0]
        if low_idx.size:
            la = positions[low_idx][:, axes[0]]
            lb = positions[low_idx][:, axes[1]]
            for a_lo, a_hi, b_lo, b_hi in footprints:
                inside = ((la >= a_lo - footprint_margin) & (la <= a_hi + footprint_margin)
                          & (lb >= b_lo - footprint_margin) & (lb <= b_hi + footprint_margin))
                if np.any(inside):
                    mask[low_idx[inside]] = True
            report["ground_contact"] = int(mask[low_idx].sum())

    return mask, report


def detect_transients_sam2(cloud, views, ground, up_axis=1, checkpoint=None,
                           model_cfg=None, min_votes=2, device="cpu"):
    """
    Refine detection with SAM-2 instance masks back-projected from rendered views.

    Each mask becomes a candidate 3D instance; the same dimensional rules that
    drive the geometric detector then decide whether it is transient. A splat
    must be flagged in at least `min_votes` views to survive to removal, which
    is what stops a single bad viewing angle from eating a chunk of terrain.

    Raises RuntimeError if SAM-2 or its weights are unavailable -- the caller
    decides whether to fall back.
    """
    try:
        from sam2.build_sam import build_sam2
        from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    except Exception as exc:  # pragma: no cover - import guard
        raise RuntimeError(f"SAM-2 unavailable: {exc}") from exc

    if checkpoint is None:
        raise RuntimeError("SAM-2 checkpoint path is required")

    model = build_sam2(model_cfg, checkpoint, device=device, apply_postprocessing=False)
    generator = SAM2AutomaticMaskGenerator(
        model,
        points_per_side=16,        # tiny model on CPU; 16 is the practical ceiling
        pred_iou_thresh=0.7,
        stability_score_thresh=0.85,
        min_mask_region_area=200,
    )

    positions = cloud.positions
    above = positions[:, up_axis] - ground.height_at(positions)
    axes = [a for a in (0, 1, 2) if a != up_axis]

    votes = np.zeros(len(cloud), dtype=np.int32)
    instances = 0

    for view in views:
        masks = generator.generate(view.rgb)
        for record in masks:
            segmentation = record["segmentation"]
            covered = view.index_buffer[segmentation & (view.index_buffer >= 0)]
            members = np.unique(covered)
            if members.size < 12:
                continue

            pts = positions[members]
            extent_u = float(pts[:, up_axis].max() - pts[:, up_axis].min())
            extent_a = float(pts[:, axes[0]].max() - pts[:, axes[0]].min())
            extent_b = float(pts[:, axes[1]].max() - pts[:, axes[1]].min())
            base = float(above[members].min())

            if classify_cluster(extent_u, min(extent_a, extent_b),
                                max(extent_a, extent_b), base) is not None:
                votes[members] += 1
                instances += 1

    return votes >= min_votes, {"sam2_instances": instances, "views": len(views)}


def inpaint_ground(cloud, removed_mask, ground, up_axis=1, cell_size=0.5,
                   min_missing_ratio=0.35, rng=None):
    """
    Synthesise ground splats where removals opened holes.

    Only cells that actually lost coverage are filled, and only from the colour
    statistics of surviving ground splats nearby, so the patch matches the turf
    or paving it sits in rather than inventing texture. New splats are flat
    discs lying in the local ground plane.
    """
    rng = rng or np.random.default_rng(0xC0FFEE)
    positions = cloud.positions
    axes = ground.axes

    kept = ~removed_mask
    above_all = positions[:, up_axis] - ground.height_at(positions)
    ground_like = kept & (above_all < 0.35)

    if not np.any(removed_mask) or not np.any(ground_like):
        return cloud.subset(np.zeros(len(cloud), dtype=bool)), {"patched_cells": 0, "added": 0}

    def cell_of(idx_positions):
        cx = np.floor(idx_positions[:, axes[0]] / cell_size).astype(np.int64)
        cy = np.floor(idx_positions[:, axes[1]] / cell_size).astype(np.int64)
        return cx, cy

    rx, ry = cell_of(positions[removed_mask])
    kx, ky = cell_of(positions[ground_like])

    removed_cells = {}
    for x, y in zip(rx, ry):
        removed_cells[(x, y)] = removed_cells.get((x, y), 0) + 1
    kept_cells = {}
    for x, y in zip(kx, ky):
        kept_cells[(x, y)] = kept_cells.get((x, y), 0) + 1

    mean_ground_density = max(1.0, float(np.mean(list(kept_cells.values()))) if kept_cells else 1.0)
    ground_colors = cloud.colors[ground_like]
    ground_scales = cloud.scales[ground_like]
    palette_mean = ground_colors.mean(axis=0)
    palette_std = ground_colors.std(axis=0) + 1e-4
    disc_scale = float(np.median(ground_scales)) if ground_scales.size else 0.05

    new_positions, new_colors = [], []
    patched = 0
    for (cx, cy), lost in removed_cells.items():
        present = kept_cells.get((cx, cy), 0)
        if present >= mean_ground_density * (1.0 - min_missing_ratio):
            continue  # cell still has enough ground; nothing to fill

        deficit = int(max(0, mean_ground_density - present))
        if deficit <= 0:
            continue
        patched += 1

        # Scatter uniformly inside the cell, snapped onto the height field.
        offsets = rng.random((deficit, 2)) * cell_size
        pts = np.zeros((deficit, 3), dtype=np.float32)
        pts[:, axes[0]] = cx * cell_size + offsets[:, 0]
        pts[:, axes[1]] = cy * cell_size + offsets[:, 1]
        pts[:, up_axis] = ground.height_at(pts)

        colors = np.clip(
            palette_mean + rng.normal(0.0, 1.0, (deficit, 3)) * palette_std * 0.5, 0.0, 1.0
        ).astype(np.float32)

        new_positions.append(pts)
        new_colors.append(colors)

    if not new_positions:
        return cloud.subset(np.zeros(len(cloud), dtype=bool)), {"patched_cells": 0, "added": 0}

    positions_out = np.vstack(new_positions).astype(np.float32)
    colors_out = np.vstack(new_colors).astype(np.float32)
    total = positions_out.shape[0]

    # Flat, ground-hugging discs: wide in the horizontal axes, thin vertically.
    scales_out = np.full((total, 3), disc_scale, dtype=np.float32)
    scales_out[:, up_axis] = disc_scale * 0.25

    from .formats import SplatCloud
    patch = SplatCloud(
        positions_out,
        scales_out,
        colors_out,
        np.full(total, 0.95, dtype=np.float32),
        np.tile(np.array([1, 0, 0, 0], dtype=np.float32), (total, 1)),
    )
    return patch, {"patched_cells": patched, "added": total}
