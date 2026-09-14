/**
 * Minimal procedural geometry for the asset library.
 *
 * Deliberately not Three.js: this runs in Node with no DOM, and everything the
 * pipeline needs is raw typed arrays that go straight into glTF accessors.
 * Pulling in a renderer to produce a vertex buffer would be all cost.
 *
 * Every builder returns { positions, normals, indices } with positions and
 * normals as Float32Array and indices as Uint32Array. Units are METRES.
 */

/** An empty mesh, ready to be appended to. */
export function emptyMesh() {
  return { positions: [], normals: [], indices: [] };
}

/** Append `src` into `dst`, re-basing indices. */
export function append(dst, src) {
  const base = dst.positions.length / 3;
  for (let i = 0; i < src.positions.length; i++) dst.positions.push(src.positions[i]);
  for (let i = 0; i < src.normals.length; i++) dst.normals.push(src.normals[i]);
  for (let i = 0; i < src.indices.length; i++) dst.indices.push(src.indices[i] + base);
  return dst;
}

/** Merge any number of meshes. */
export function merge(...meshes) {
  const out = emptyMesh();
  for (const mesh of meshes) append(out, mesh);
  return out;
}

/** Finalize to typed arrays. */
export function finalize(mesh) {
  return {
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.indices),
  };
}

export function triangleCount(mesh) {
  return mesh.indices.length / 3;
}

/* -------------------------------------------------------------------------- */
/* Transforms                                                                  */
/* -------------------------------------------------------------------------- */

/** Translate a mesh in place. */
export function translate(mesh, [tx, ty, tz]) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] += tx;
    mesh.positions[i + 1] += ty;
    mesh.positions[i + 2] += tz;
  }
  return mesh;
}

/** Rotate a mesh about an axis ('x' | 'y' | 'z') by `angle` radians. */
export function rotate(mesh, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const apply = (arr) => {
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i];
      const y = arr[i + 1];
      const z = arr[i + 2];
      if (axis === 'x') {
        arr[i + 1] = y * c - z * s;
        arr[i + 2] = y * s + z * c;
      } else if (axis === 'y') {
        arr[i] = x * c + z * s;
        arr[i + 2] = -x * s + z * c;
      } else {
        arr[i] = x * c - y * s;
        arr[i + 1] = x * s + y * c;
      }
    }
  };
  apply(mesh.positions);
  apply(mesh.normals);
  return mesh;
}

/** Uniform or per-axis scale. Normals are re-normalized. */
export function scale(mesh, [sx, sy, sz]) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] *= sx;
    mesh.positions[i + 1] *= sy;
    mesh.positions[i + 2] *= sz;
  }
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const nx = mesh.normals[i] / sx;
    const ny = mesh.normals[i + 1] / sy;
    const nz = mesh.normals[i + 2] / sz;
    const len = Math.hypot(nx, ny, nz) || 1;
    mesh.normals[i] = nx / len;
    mesh.normals[i + 1] = ny / len;
    mesh.normals[i + 2] = nz / len;
  }
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** Axis-aligned box centred on the origin. 12 triangles. */
export function box(width, height, depth) {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];

  const mesh = emptyMesh();
  for (const face of faces) {
    const base = mesh.positions.length / 3;
    for (const vertex of face.v) {
      mesh.positions.push(...vertex);
      mesh.normals.push(...face.n);
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh;
}

/**
 * Cylinder along +Y, centred on the origin.
 * `capped` adds end discs; leave it off for interior tubes nobody sees.
 */
export function cylinder(radius, height, segments = 12, capped = true) {
  const mesh = emptyMesh();
  const half = height / 2;

  // Side wall.
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const nx = Math.cos(theta);
    const nz = Math.sin(theta);
    mesh.positions.push(nx * radius, -half, nz * radius);
    mesh.normals.push(nx, 0, nz);
    mesh.positions.push(nx * radius, half, nz * radius);
    mesh.normals.push(nx, 0, nz);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    mesh.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  if (capped) {
    for (const [y, ny] of [[half, 1], [-half, -1]]) {
      const centre = mesh.positions.length / 3;
      mesh.positions.push(0, y, 0);
      mesh.normals.push(0, ny, 0);
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        mesh.positions.push(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
        mesh.normals.push(0, ny, 0);
      }
      for (let i = 0; i < segments; i++) {
        if (ny > 0) mesh.indices.push(centre, centre + i + 1, centre + i + 2);
        else mesh.indices.push(centre, centre + i + 2, centre + i + 1);
      }
    }
  }
  return mesh;
}

/** A capped tube spanning two points. */
export function tube(from, to, radius, segments = 8) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return emptyMesh();

  const mesh = cylinder(radius, length, segments, true);

  // Swing +Y onto the segment direction, then move to the midpoint.
  const ux = dx / length;
  const uy = dy / length;
  const uz = dz / length;
  const dot = uy; // dot((0,1,0), u)
  if (dot < 0.999999) {
    if (dot < -0.999999) {
      rotate(mesh, 'x', Math.PI);
    } else {
      // Rodrigues rotation about axis = (0,1,0) x u, angle = acos(dot).
      const ax = uz;
      const az = -ux;
      const axisLen = Math.hypot(ax, 0, az) || 1;
      const kx = ax / axisLen;
      const kz = az / axisLen;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const rodrigues = (arr) => {
        for (let i = 0; i < arr.length; i += 3) {
          const vx = arr[i];
          const vy = arr[i + 1];
          const vz = arr[i + 2];
          // k x v, with ky = 0
          const cx = -kz * vy;
          const cy = kz * vx - kx * vz;
          const cz = kx * vy;
          const kdotv = kx * vx + kz * vz;
          arr[i] = vx * c + cx * s + kx * kdotv * (1 - c);
          arr[i + 1] = vy * c + cy * s;
          arr[i + 2] = vz * c + cz * s + kz * kdotv * (1 - c);
        }
      };
      rodrigues(mesh.positions);
      rodrigues(mesh.normals);
    }
  }

  return translate(mesh, [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2,
  ]);
}

/** A thin rectangular plate: a box with a dominant face. */
export function plate(width, thickness, depth) {
  return box(width, thickness, depth);
}

/** Truncated cone along +Y, for lamp bodies and lens hoods. */
export function frustum(bottomRadius, topRadius, height, segments = 12) {
  const mesh = emptyMesh();
  const half = height / 2;
  const slope = Math.atan2(bottomRadius - topRadius, height);
  const ny = Math.sin(slope);
  const nr = Math.cos(slope);

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    mesh.positions.push(cx * bottomRadius, -half, cz * bottomRadius);
    mesh.normals.push(cx * nr, ny, cz * nr);
    mesh.positions.push(cx * topRadius, half, cz * topRadius);
    mesh.normals.push(cx * nr, ny, cz * nr);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    mesh.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  for (const [y, ny2, r] of [[half, 1, topRadius], [-half, -1, bottomRadius]]) {
    if (r <= 1e-9) continue;
    const centre = mesh.positions.length / 3;
    mesh.positions.push(0, y, 0);
    mesh.normals.push(0, ny2, 0);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      mesh.positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
      mesh.normals.push(0, ny2, 0);
    }
    for (let i = 0; i < segments; i++) {
      if (ny2 > 0) mesh.indices.push(centre, centre + i + 1, centre + i + 2);
      else mesh.indices.push(centre, centre + i + 2, centre + i + 1);
    }
  }
  return mesh;
}

/**
 * Zig-zag lacing between two parallel chords -- the W-brace pattern that makes
 * a box truss read as a truss rather than four floating pipes.
 */
export function lacing(chordA, chordB, halfLength, bays, radius) {
  const out = emptyMesh();
  const step = (halfLength * 2) / bays;
  let previous = chordA(-halfLength);
  for (let i = 1; i <= bays; i++) {
    const x = -halfLength + step * i;
    const current = i % 2 === 1 ? chordB(x) : chordA(x);
    append(out, tube(previous, current, radius, 6));
    previous = current;
  }
  return out;
}

/** Axis-aligned bounds of a mesh, for collision hulls and manifest dimensions. */
export function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Low-poly box hull matching a mesh's bounds. Used for collision and occlusion. */
export function hullOf(mesh) {
  const b = bounds(mesh);
  const hull = box(b.size[0] || 0.01, b.size[1] || 0.01, b.size[2] || 0.01);
  return translate(hull, [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ]);
}
