"""
Gaussian splat file I/O.

Two formats matter for this pipeline:

  .splat  The compact runtime format that @mkkellogg/gaussian-splats-3d and
          antimatter15's viewer consume. 32 bytes per splat, no header:
              position  3 x float32   (12 B)
              scale     3 x float32   (12 B)
              color     4 x uint8     ( 4 B)  RGBA, alpha is opacity
              rotation  4 x uint8     ( 4 B)  quaternion wxyz, (q * 128) + 128

  .ply    The training-format INRIA/3DGS point cloud that Scaniverse, Polycam,
          Postshot and the original 3DGS implementation export. Positions are
          raw, but colour arrives as spherical-harmonic DC coefficients,
          opacity as a logit, and scale as a natural log -- all three need
          decoding before they mean anything.
"""

from __future__ import annotations

import re
import numpy as np

SPLAT_RECORD_BYTES = 32

# Zeroth-order spherical harmonic basis constant, used to decode 3DGS DC colour.
SH_C0 = 0.28209479177387814


class SplatCloud:
    """
    A Gaussian splat cloud in decoded, human-meaningful units.

    positions  (N, 3) float32, metres
    scales     (N, 3) float32, metres (already exponentiated)
    colors     (N, 3) float32, 0..1 linear RGB
    opacities  (N,)   float32, 0..1 (already through the sigmoid)
    rotations  (N, 4) float32, unit quaternions in wxyz order
    """

    def __init__(self, positions, scales, colors, opacities, rotations):
        self.positions = np.ascontiguousarray(positions, dtype=np.float32)
        self.scales = np.ascontiguousarray(scales, dtype=np.float32)
        self.colors = np.ascontiguousarray(colors, dtype=np.float32)
        self.opacities = np.ascontiguousarray(opacities, dtype=np.float32)
        self.rotations = np.ascontiguousarray(rotations, dtype=np.float32)

    def __len__(self) -> int:
        return int(self.positions.shape[0])

    def subset(self, mask) -> "SplatCloud":
        """A new cloud containing only the splats selected by a boolean mask."""
        return SplatCloud(
            self.positions[mask],
            self.scales[mask],
            self.colors[mask],
            self.opacities[mask],
            self.rotations[mask],
        )

    def concat(self, other: "SplatCloud") -> "SplatCloud":
        return SplatCloud(
            np.vstack([self.positions, other.positions]),
            np.vstack([self.scales, other.scales]),
            np.vstack([self.colors, other.colors]),
            np.concatenate([self.opacities, other.opacities]),
            np.vstack([self.rotations, other.rotations]),
        )

    def bounds(self):
        return self.positions.min(axis=0), self.positions.max(axis=0)


# --------------------------------------------------------------------------- #
# .splat                                                                       #
# --------------------------------------------------------------------------- #

def read_splat(path) -> SplatCloud:
    raw = np.fromfile(path, dtype=np.uint8)
    if raw.size % SPLAT_RECORD_BYTES != 0:
        raise ValueError(
            f"{path}: {raw.size} bytes is not a multiple of {SPLAT_RECORD_BYTES}; "
            "this does not look like a .splat file"
        )
    count = raw.size // SPLAT_RECORD_BYTES
    records = raw.reshape(count, SPLAT_RECORD_BYTES)

    floats = records[:, :24].copy().view(np.float32).reshape(count, 6)
    positions = floats[:, 0:3]
    scales = floats[:, 3:6]

    rgba = records[:, 24:28].astype(np.float32) / 255.0
    colors = rgba[:, :3]
    opacities = rgba[:, 3]

    # Rotation bytes decode as (b - 128) / 128, then renormalise.
    quat = (records[:, 28:32].astype(np.float32) - 128.0) / 128.0
    norm = np.linalg.norm(quat, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    rotations = quat / norm

    return SplatCloud(positions, scales, colors, opacities, rotations)


def write_splat(path, cloud: SplatCloud) -> int:
    """Write a cloud as a binary .splat. Returns the byte count written."""
    count = len(cloud)
    records = np.zeros((count, SPLAT_RECORD_BYTES), dtype=np.uint8)

    floats = np.zeros((count, 6), dtype=np.float32)
    floats[:, 0:3] = cloud.positions
    floats[:, 3:6] = cloud.scales
    records[:, :24] = floats.view(np.uint8).reshape(count, 24)

    rgba = np.zeros((count, 4), dtype=np.float32)
    rgba[:, :3] = cloud.colors
    rgba[:, 3] = cloud.opacities
    records[:, 24:28] = np.clip(rgba * 255.0, 0, 255).astype(np.uint8)

    quat = cloud.rotations
    norm = np.linalg.norm(quat, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    packed = (quat / norm) * 128.0 + 128.0
    records[:, 28:32] = np.clip(packed, 0, 255).astype(np.uint8)

    records.tofile(path)
    return count * SPLAT_RECORD_BYTES


# --------------------------------------------------------------------------- #
# .ply                                                                         #
# --------------------------------------------------------------------------- #

_PLY_TYPES = {
    "float": np.float32, "float32": np.float32,
    "double": np.float64, "float64": np.float64,
    "uchar": np.uint8, "uint8": np.uint8,
    "char": np.int8, "int8": np.int8,
    "ushort": np.uint16, "uint16": np.uint16,
    "short": np.int16, "int16": np.int16,
    "uint": np.uint32, "uint32": np.uint32,
    "int": np.int32, "int32": np.int32,
}


def _parse_ply_header(handle):
    if handle.readline().strip() != b"ply":
        raise ValueError("not a PLY file")
    fmt, count, fields = None, 0, []
    while True:
        line = handle.readline()
        if not line:
            raise ValueError("unterminated PLY header")
        parts = line.strip().split()
        if not parts:
            continue
        key = parts[0]
        if key == b"format":
            fmt = parts[1].decode()
        elif key == b"element" and parts[1] == b"vertex":
            count = int(parts[2])
        elif key == b"property" and len(parts) == 3:
            fields.append((parts[2].decode(), _PLY_TYPES[parts[1].decode()]))
        elif key == b"end_header":
            break
    return fmt, count, fields


def read_ply(path) -> SplatCloud:
    with open(path, "rb") as handle:
        fmt, count, fields = _parse_ply_header(handle)
        if fmt != "binary_little_endian":
            raise ValueError(f"{path}: only binary_little_endian PLY is supported, got {fmt}")
        dtype = np.dtype([(name, t) for name, t in fields])
        data = np.frombuffer(handle.read(dtype.itemsize * count), dtype=dtype, count=count)

    names = data.dtype.names
    positions = np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float32)

    # Colour: 3DGS stores the SH DC term; plain PLYs may carry red/green/blue.
    if "f_dc_0" in names:
        dc = np.stack([data["f_dc_0"], data["f_dc_1"], data["f_dc_2"]], axis=1).astype(np.float32)
        colors = np.clip(0.5 + SH_C0 * dc, 0.0, 1.0)
    elif "red" in names:
        colors = np.stack([data["red"], data["green"], data["blue"]], axis=1).astype(np.float32) / 255.0
    else:
        colors = np.full((count, 3), 0.5, dtype=np.float32)

    # Opacity is stored as a logit.
    if "opacity" in names:
        opacities = (1.0 / (1.0 + np.exp(-data["opacity"].astype(np.float32)))).astype(np.float32)
    else:
        opacities = np.ones(count, dtype=np.float32)

    # Scale is stored as log(sigma).
    scale_fields = sorted([n for n in names if re.fullmatch(r"scale_\d+", n)])
    if scale_fields:
        raw_scale = np.stack([data[n] for n in scale_fields[:3]], axis=1).astype(np.float32)
        scales = np.exp(raw_scale)
    else:
        scales = np.full((count, 3), 0.01, dtype=np.float32)

    rot_fields = sorted([n for n in names if re.fullmatch(r"rot_\d+", n)])
    if rot_fields:
        rotations = np.stack([data[n] for n in rot_fields[:4]], axis=1).astype(np.float32)
        norm = np.linalg.norm(rotations, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        rotations = rotations / norm
    else:
        rotations = np.tile(np.array([1, 0, 0, 0], dtype=np.float32), (count, 1))

    return SplatCloud(positions, scales, colors, opacities, rotations)


def load_any(path) -> SplatCloud:
    """Load a cloud by extension."""
    lowered = str(path).lower()
    if lowered.endswith(".ply"):
        return read_ply(path)
    if lowered.endswith(".splat"):
        return read_splat(path)
    raise ValueError(f"unsupported scan format: {path} (expected .ply or .splat)")
