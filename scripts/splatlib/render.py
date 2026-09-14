"""
Point projection and visibility for splat clouds.

SAM-2 segments images, not point clouds, so the cleanup pipeline has to put the
splats on a screen before it can ask anything about them. This module does the
minimum needed for that round trip:

  * place virtual cameras around the capture,
  * project splat centres into each camera,
  * resolve which splat each pixel actually sees (painter's algorithm over a
    depth sort -- adequate here because we only need per-splat visibility, not
    a physically correct alpha-composited render),
  * paint an RGB image for the segmenter, and
  * keep the pixel -> splat index map so masks can be back-projected.

Deliberately dependency-light: numpy only, no GL context, so it runs headless
in CI and on a phone-tethered box alike.
"""

from __future__ import annotations

import numpy as np


def look_at(eye, target, up=(0.0, 1.0, 0.0)):
    """Right-handed world -> camera matrix, looking down -Z as OpenGL does."""
    eye = np.asarray(eye, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    up = np.asarray(up, dtype=np.float64)

    forward = target - eye
    norm = np.linalg.norm(forward)
    if norm < 1e-9:
        raise ValueError("camera eye and target coincide")
    forward /= norm

    right = np.cross(forward, up)
    right_norm = np.linalg.norm(right)
    if right_norm < 1e-9:
        # Looking straight along `up`; pick any perpendicular.
        right = np.cross(forward, np.array([1.0, 0.0, 0.0]))
        right_norm = np.linalg.norm(right)
        if right_norm < 1e-9:
            right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
            right_norm = np.linalg.norm(right)
    right /= right_norm
    true_up = np.cross(right, forward)

    view = np.eye(4, dtype=np.float64)
    view[0, :3] = right
    view[1, :3] = true_up
    view[2, :3] = -forward
    view[:3, 3] = -view[:3, :3] @ eye
    return view


def orbit_cameras(center, radius, height, count, up_axis=1):
    """
    A ring of `count` cameras around `center`, looking inward and slightly down.

    A ring is the right sampling pattern for a walked capture: transients are
    only reliably separable when seen from several bearings, and a ring
    guarantees angular spread without needing the original capture trajectory.
    """
    center = np.asarray(center, dtype=np.float64)
    horizontal = [a for a in (0, 1, 2) if a != up_axis]
    up_vector = np.zeros(3)
    up_vector[up_axis] = 1.0

    cameras = []
    for i in range(count):
        theta = 2.0 * np.pi * i / count
        eye = center.copy()
        eye[horizontal[0]] += radius * np.cos(theta)
        eye[horizontal[1]] += radius * np.sin(theta)
        eye[up_axis] += height
        cameras.append(look_at(eye, center, up_vector))
    return cameras


def perspective(fov_y_deg, aspect, near, far):
    f = 1.0 / np.tan(np.radians(fov_y_deg) / 2.0)
    proj = np.zeros((4, 4), dtype=np.float64)
    proj[0, 0] = f / aspect
    proj[1, 1] = f
    proj[2, 2] = (far + near) / (near - far)
    proj[2, 3] = (2 * far * near) / (near - far)
    proj[3, 2] = -1.0
    return proj


class View:
    """One rendered viewpoint plus everything needed to back-project from it."""

    def __init__(self, width, height, index_buffer, depth_buffer, rgb):
        self.width = width
        self.height = height
        # index_buffer[y, x] -> splat index, or -1 where nothing was drawn.
        self.index_buffer = index_buffer
        self.depth_buffer = depth_buffer
        self.rgb = rgb

    def visible_indices(self):
        return np.unique(self.index_buffer[self.index_buffer >= 0])


def render_view(cloud, view_matrix, width=512, height=512, fov_y_deg=60.0,
                near=0.05, far=5000.0, point_radius_px=1):
    """
    Project a cloud through one camera and resolve visibility.

    Returns a View carrying an RGB image for the segmenter and the pixel ->
    splat index map used to turn 2D masks back into 3D selections.
    """
    positions = cloud.positions.astype(np.float64)
    count = positions.shape[0]

    homogeneous = np.hstack([positions, np.ones((count, 1))])
    camera_space = homogeneous @ view_matrix.T
    depth = -camera_space[:, 2]  # looking down -Z, so depth is positive ahead

    in_front = depth > near
    proj = perspective(fov_y_deg, width / height, near, far)
    clip = camera_space @ proj.T

    w = clip[:, 3].copy()
    w[np.abs(w) < 1e-12] = 1e-12
    ndc = clip[:, :3] / w[:, None]

    px = ((ndc[:, 0] + 1.0) * 0.5 * width).astype(np.int64)
    py = ((1.0 - ndc[:, 1]) * 0.5 * height).astype(np.int64)

    on_screen = in_front & (px >= 0) & (px < width) & (py >= 0) & (py < height)
    candidates = np.nonzero(on_screen)[0]

    index_buffer = np.full((height, width), -1, dtype=np.int64)
    depth_buffer = np.full((height, width), np.inf, dtype=np.float64)
    rgb = np.zeros((height, width, 3), dtype=np.uint8)

    if candidates.size == 0:
        return View(width, height, index_buffer, depth_buffer, rgb)

    # Painter's algorithm: draw far to near so the nearest splat wins the pixel.
    order = candidates[np.argsort(-depth[candidates])]
    colors = np.clip(cloud.colors * 255.0, 0, 255).astype(np.uint8)

    offsets = range(-point_radius_px, point_radius_px + 1)
    for dy in offsets:
        for dx in offsets:
            xs = px[order] + dx
            ys = py[order] + dy
            valid = (xs >= 0) & (xs < width) & (ys >= 0) & (ys < height)
            if not np.any(valid):
                continue
            vx, vy, vi = xs[valid], ys[valid], order[valid]
            index_buffer[vy, vx] = vi
            depth_buffer[vy, vx] = depth[vi]
            rgb[vy, vx] = colors[vi]

    return View(width, height, index_buffer, depth_buffer, rgb)


def infer_up_axis(cloud):
    """
    Guess which axis is vertical.

    A walked outdoor capture is far wider than it is tall, so the axis with the
    smallest extent is the reliable signal. Callers should override this
    explicitly when the capture tool's convention is known.
    """
    lo, hi = cloud.bounds()
    return int(np.argmin(hi - lo))
