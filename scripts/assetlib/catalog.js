/**
 * The modular event asset catalogue.
 *
 * Every entry is built to real rental-stock dimensions so a plot laid out
 * against these placeholders stays valid when manufacturer CAD replaces them --
 * that is Divergence Checkpoint CP-3: socket names and positions must match
 * exactly, so a hot-swap lands in the same world position.
 *
 * Units are METRES. Imperial stock is converted at FT.
 */

import {
  append, box, cylinder, emptyMesh, frustum, lacing, merge, rotate, translate, tube,
} from './geometry.js';
import { socket, trussEndSockets } from './sockets.js';

const FT = 0.3048;
const IN = 0.0254;

/* -------------------------------------------------------------------------- */
/* 1. Trussing & structural rigging                                            */
/* -------------------------------------------------------------------------- */

const F34 = { section: 0.29, chord: 0.05, brace: 0.02, loadKg: 750 };
const F44 = { section: 0.39, chord: 0.05, brace: 0.025, loadKg: 1200 };

function buildBoxTruss(length, spec, typeName) {
  const half = spec.section / 2;
  const halfLength = length / 2;
  const chordRadius = spec.chord / 2;
  const braceRadius = spec.brace / 2;
  const quadrants = [[+1, +1], [+1, -1], [-1, +1], [-1, -1]];
  const chordLine = (sy, sz) => (x) => [x, sy * half, sz * half];

  const mesh = emptyMesh();
  for (const [sy, sz] of quadrants) {
    const line = chordLine(sy, sz);
    append(mesh, tube(line(-halfLength), line(halfLength), chordRadius, 10));
  }
  // Bay count scales with length so lacing density stays realistic.
  const bays = Math.max(2, Math.round(length / 0.5));
  const faces = [[0, 1], [2, 3], [0, 2], [1, 3]];
  for (const [a, b] of faces) {
    append(mesh, lacing(
      chordLine(...quadrants[a]), chordLine(...quadrants[b]), halfLength, bays, braceRadius));
  }

  const sockets = [
    ...trussEndSockets('end_a', halfLength, [1, 0, 0], 'MALE', half, typeName, spec.loadKg),
    ...trussEndSockets('end_b', -halfLength, [-1, 0, 0], 'FEMALE', half, typeName, spec.loadKg),
  ];
  // Hoist pickups on the top chords, one per third of the stick.
  if (length >= 1.0) {
    for (const [i, t] of [-0.33, 0.33].entries()) {
      sockets.push(socket(`hoist_pickup_${i + 1}`, 'RIG_HOIST_HOOK', 'FEMALE',
        [t * length, half, 0], [0, 1, 0], [1, 0, 0],
        { loadBearing: true, maxLoadKg: 1000, tags: ['rigging'] }));
    }
  }
  return { mesh, sockets };
}

/* -------------------------------------------------------------------------- */
/* 2. Staging, decking & riser systems                                         */
/* -------------------------------------------------------------------------- */

function buildDeck(lengthFt, widthFt) {
  const length = lengthFt * FT;
  const width = widthFt * FT;
  const thickness = 0.075;
  const surfaceThickness = 0.018;
  const railThickness = 0.04;

  const mesh = emptyMesh();
  // Walking surface: top face sits exactly at y = 0, so deck height is set
  // purely by leg length -- the way a crew actually builds.
  append(mesh, translate(box(length, surfaceThickness, width), [0, -surfaceThickness / 2, 0]));
  const railDepth = thickness - surfaceThickness;
  const railY = -surfaceThickness - railDepth / 2;
  append(mesh, translate(box(length, railDepth, railThickness), [0, railY, width / 2 - railThickness / 2]));
  append(mesh, translate(box(length, railDepth, railThickness), [0, railY, -width / 2 + railThickness / 2]));
  append(mesh, translate(box(railThickness, railDepth, width - railThickness * 2), [length / 2 - railThickness / 2, railY, 0]));
  append(mesh, translate(box(railThickness, railDepth, width - railThickness * 2), [-length / 2 + railThickness / 2, railY, 0]));

  const lockY = -thickness / 2;
  const sockets = [];
  // Coffin locks are hermaphroditic: a lock mates with an identical lock, so
  // they are NEUTRAL. Long sides take two, short sides one.
  const longCount = lengthFt >= 8 ? 2 : 1;
  for (const [key, z, normal] of [['near', width / 2, [0, 0, 1]], ['far', -width / 2, [0, 0, -1]]]) {
    for (let i = 0; i < longCount; i++) {
      const x = longCount === 1 ? 0 : (i === 0 ? -length / 4 : length / 4);
      sockets.push(socket(`lock_${key}_${i + 1}`, 'STAGE_COFFIN_LOCK', 'NEUTRAL',
        [x, lockY, z], normal, [0, 1, 0],
        { loadBearing: true, maxLoadKg: 500, tags: ['perimeter', `side_${key}`] }));
    }
  }
  for (const [key, x, normal] of [['end_a', length / 2, [1, 0, 0]], ['end_b', -length / 2, [-1, 0, 0]]]) {
    sockets.push(socket(`lock_${key}`, 'STAGE_COFFIN_LOCK', 'NEUTRAL',
      [x, lockY, 0], normal, [0, 1, 0],
      { loadBearing: true, maxLoadKg: 500, tags: ['perimeter', `side_${key}`] }));
  }

  const inset = 0.05;
  for (const [key, sx, sz] of [['a_near', 1, 1], ['a_far', 1, -1], ['b_near', -1, 1], ['b_far', -1, -1]]) {
    sockets.push(socket(`leg_${key}`, 'STAGE_LEG_RECEIVER', 'FEMALE',
      [sx * (length / 2 - inset), -thickness, sz * (width / 2 - inset)], [0, -1, 0], [1, 0, 0],
      { loadBearing: true, maxLoadKg: 400, tags: ['leg_receiver', `corner_${key}`] }));
  }
  return { mesh, sockets };
}

function buildTelescopicLeg() {
  // 16" to 72" adjustable; modelled at mid extension (44").
  const extended = 44 * IN;
  const outer = 0.05;
  const mesh = merge(
    translate(cylinder(outer / 2, extended * 0.6, 10), [0, extended * 0.3, 0]),
    translate(cylinder(outer * 0.4, extended * 0.55, 10), [0, extended * 0.72, 0]),
    translate(box(0.11, 0.012, 0.11), [0, 0.006, 0]),  // levelling foot
  );
  return {
    mesh,
    sockets: [
      socket('leg_head', 'STAGE_LEG_RECEIVER', 'MALE', [0, extended, 0], [0, 1, 0], [1, 0, 0],
        { loadBearing: true, maxLoadKg: 400, canParent: false, tags: ['spigot'] }),
      socket('leg_foot', 'GROUND_SUPPORT_BASE', 'MALE', [0, 0, 0], [0, -1, 0], [1, 0, 0],
        { loadBearing: true, tags: ['ground'] }),
    ],
  };
}

function buildGuardrail(lengthFt) {
  const length = lengthFt * FT;
  const height = 1.07; // OSHA guardrail height
  const mesh = merge(
    translate(cylinder(0.02, height, 8), [-length / 2 + 0.03, height / 2, 0]),
    translate(cylinder(0.02, height, 8), [length / 2 - 0.03, height / 2, 0]),
    rotate(translate(cylinder(0.018, length, 8), [0, 0, 0]), 'z', Math.PI / 2),
  );
  translate(mesh, [0, 0, 0]);
  append(mesh, translate(rotate(cylinder(0.018, length, 8), 'z', Math.PI / 2), [0, height, 0]));
  append(mesh, translate(rotate(cylinder(0.018, length, 8), 'z', Math.PI / 2), [0, height * 0.5, 0]));
  return {
    mesh,
    sockets: [
      socket('rail_base_a', 'STAGE_COFFIN_LOCK', 'NEUTRAL', [-length / 2 + 0.03, 0, 0], [0, -1, 0], [1, 0, 0], { tags: ['mount'] }),
      socket('rail_base_b', 'STAGE_COFFIN_LOCK', 'NEUTRAL', [length / 2 - 0.03, 0, 0], [0, -1, 0], [1, 0, 0], { tags: ['mount'] }),
    ],
  };
}

function buildStairs(steps) {
  const rise = 0.19;
  const run = 0.28;
  const width = 1.0;
  const mesh = emptyMesh();
  for (let i = 0; i < steps; i++) {
    append(mesh, translate(box(width, 0.04, run), [0, (i + 1) * rise, -i * run]));
    append(mesh, translate(box(width, rise, 0.03), [0, (i + 0.5) * rise, -i * run - run / 2]));
  }
  return {
    mesh,
    sockets: [
      socket('stair_top', 'STAGE_COFFIN_LOCK', 'NEUTRAL',
        [0, steps * rise, -(steps - 1) * run - run / 2], [0, 0, -1], [0, 1, 0],
        { loadBearing: true, tags: ['deck_edge'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Modular video walls                                                      */
/* -------------------------------------------------------------------------- */

function buildLedTile(widthMm, heightMm) {
  const w = widthMm / 1000;
  const h = heightMm / 1000;
  const depth = 0.08;
  const mesh = merge(
    translate(box(w, h, depth * 0.75), [0, 0, -depth * 0.125]),   // cabinet
    translate(box(w * 0.985, h * 0.985, 0.004), [0, 0, depth * 0.377]), // emissive face
  );

  const sockets = [];
  // Edge latches: MALE on the right/top, FEMALE on the left/bottom, so tiles
  // chain in a consistent direction the way a wall is actually built.
  const half = depth * 0.375;
  sockets.push(socket('latch_right', 'LED_PANEL_FASTENER', 'MALE', [w / 2, 0, -half + depth * 0.375], [1, 0, 0], [0, 1, 0], { tags: ['edge'] }));
  sockets.push(socket('latch_left', 'LED_PANEL_FASTENER', 'FEMALE', [-w / 2, 0, -half + depth * 0.375], [-1, 0, 0], [0, 1, 0], { tags: ['edge'] }));
  sockets.push(socket('latch_top', 'LED_PANEL_FASTENER', 'MALE', [0, h / 2, -half + depth * 0.375], [0, 1, 0], [1, 0, 0], { tags: ['edge'] }));
  sockets.push(socket('latch_bottom', 'LED_PANEL_FASTENER', 'FEMALE', [0, -h / 2, -half + depth * 0.375], [0, -1, 0], [1, 0, 0], { tags: ['edge'] }));
  sockets.push(socket('flybar_pickup', 'LED_FLYBAR_PICKUP', 'MALE', [0, h / 2, -depth * 0.3], [0, 1, 0], [0, 0, 1],
    { loadBearing: true, maxLoadKg: 120, tags: ['rigging'] }));
  return { mesh, sockets };
}

function buildLedFlybar(tiles) {
  const span = tiles * 0.5;
  const mesh = merge(
    translate(box(span, 0.1, 0.1), [0, 0, 0]),
    translate(box(0.08, 0.16, 0.16), [-span / 2 + 0.04, 0.08, 0]),
    translate(box(0.08, 0.16, 0.16), [span / 2 - 0.04, 0.08, 0]),
  );
  const sockets = [
    socket('hoist_pickup', 'RIG_HOIST_HOOK', 'FEMALE', [0, 0.08, 0], [0, 1, 0], [1, 0, 0],
      { loadBearing: true, maxLoadKg: 1000, canChild: false, tags: ['rigging'] }),
  ];
  for (let i = 0; i < tiles; i++) {
    const x = -span / 2 + 0.25 + i * 0.5;
    sockets.push(socket(`tile_${i + 1}`, 'LED_FLYBAR_PICKUP', 'FEMALE', [x, -0.05, 0], [0, -1, 0], [0, 0, 1],
      { loadBearing: true, maxLoadKg: 120, tags: ['tile_hang'] }));
  }
  return { mesh, sockets };
}

function buildLedGroundStack() {
  const height = 2.0;
  const mesh = merge(
    translate(box(1.1, 0.06, 0.9), [0, 0.03, 0]),                 // ballast tray
    translate(box(0.08, height, 0.08), [-0.45, height / 2, -0.3]),
    translate(box(0.08, height, 0.08), [0.45, height / 2, -0.3]),
    translate(box(1.0, 0.06, 0.06), [0, height * 0.5, -0.3]),
    translate(box(1.0, 0.06, 0.06), [0, height, -0.3]),
  );
  return {
    mesh,
    sockets: [
      socket('base_ground', 'GROUND_SUPPORT_BASE', 'FEMALE', [0, 0, 0], [0, -1, 0], [1, 0, 0], { loadBearing: true, tags: ['ground'] }),
      socket('tile_mount', 'LED_FLYBAR_PICKUP', 'FEMALE', [0, height * 0.75, -0.26], [0, 0, 1], [0, 1, 0],
        { loadBearing: true, maxLoadKg: 400, tags: ['stack'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Lighting fixtures                                                        */
/* -------------------------------------------------------------------------- */

function buildMovingHead(bodyW, bodyH, bodyD, headRadius, headLength) {
  const mesh = merge(
    translate(box(bodyW, bodyH * 0.42, bodyD), [0, bodyH * 0.21, 0]),                // base
    translate(box(bodyW * 0.18, bodyH * 0.5, bodyD * 0.7), [-bodyW * 0.41, bodyH * 0.6, 0]), // yoke arms
    translate(box(bodyW * 0.18, bodyH * 0.5, bodyD * 0.7), [bodyW * 0.41, bodyH * 0.6, 0]),
    translate(rotate(frustum(headRadius, headRadius * 0.86, headLength, 14), 'x', Math.PI / 2), [0, bodyH * 0.72, headLength * 0.2]),
  );
  return {
    mesh,
    sockets: [
      // A fixture hangs from a clamp: it is a child, never a parent.
      socket('clamp_mount', 'PIPE_CLAMP_2IN', 'MALE', [0, 0, 0], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 45, canParent: false, tags: ['hang'] }),
      socket('safety_bond', 'RIG_HOIST_HOOK', 'MALE', [bodyW * 0.3, 0.01, 0], [0, -1, 0], [1, 0, 0],
        { canParent: false, tags: ['safety'] }),
    ],
  };
}

function buildStrobeBar(width, height, depth) {
  const mesh = merge(
    translate(box(width, height, depth), [0, 0, 0]),
    translate(box(width * 0.96, height * 0.6, 0.008), [0, 0, depth / 2 + 0.004]),
  );
  return {
    mesh,
    sockets: [
      socket('clamp_mount_a', 'PIPE_CLAMP_2IN', 'MALE', [-width * 0.28, height / 2, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 30, canParent: false, tags: ['hang'] }),
      socket('clamp_mount_b', 'PIPE_CLAMP_2IN', 'MALE', [width * 0.28, height / 2, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 30, canParent: false, tags: ['hang'] }),
    ],
  };
}

function buildBlinder4Lite() {
  const mesh = emptyMesh();
  append(mesh, box(0.52, 0.52, 0.12));
  for (const [sx, sy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    append(mesh, translate(rotate(frustum(0.11, 0.12, 0.09, 12), 'x', Math.PI / 2), [sx * 0.125, sy * 0.125, 0.10]));
  }
  return {
    mesh,
    sockets: [
      socket('clamp_mount', 'PIPE_CLAMP_2IN', 'MALE', [0, 0.26, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 20, canParent: false, tags: ['hang'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Audio: line arrays & subs                                                */
/* -------------------------------------------------------------------------- */

function buildLineArrayModule(width, height, depth) {
  // Trapezoidal cabinet: the front face is taller than the rear, which is what
  // gives an array its splay.
  const mesh = merge(
    translate(box(width, height, depth * 0.8), [0, 0, 0]),
    translate(box(width * 0.94, height * 0.86, 0.02), [0, 0, depth * 0.41]),
    translate(box(width * 0.06, height, 0.05), [-width / 2 + 0.02, 0, -depth * 0.3]),
    translate(box(width * 0.06, height, 0.05), [width / 2 - 0.02, 0, -depth * 0.3]),
  );
  return {
    mesh,
    sockets: [
      socket('rig_top', 'SPEAKER_ARRAY_PIN', 'FEMALE', [0, height / 2, -depth * 0.1], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 1400, tags: ['array'] }),
      socket('rig_bottom', 'SPEAKER_ARRAY_PIN', 'MALE', [0, -height / 2, -depth * 0.1], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 1400, tags: ['array'] }),
    ],
  };
}

function buildArrayFlybar() {
  const mesh = merge(
    box(1.4, 0.12, 0.3),
    translate(box(0.1, 0.2, 0.2), [0, 0.16, 0]),
  );
  return {
    mesh,
    sockets: [
      socket('hoist_pickup', 'RIG_HOIST_HOOK', 'FEMALE', [0, 0.26, 0], [0, 1, 0], [1, 0, 0],
        { loadBearing: true, maxLoadKg: 2000, canChild: false, tags: ['rigging'] }),
      socket('array_top', 'SPEAKER_ARRAY_PIN', 'MALE', [0, -0.06, -0.03], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 2000, tags: ['array'] }),
    ],
  };
}

function buildSubwoofer(width, height, depth) {
  const mesh = merge(
    box(width, height, depth),
    translate(box(width * 0.9, height * 0.8, 0.02), [0, 0, depth / 2 + 0.01]),
  );
  return {
    mesh,
    sockets: [
      socket('stack_top', 'GROUND_SUPPORT_BASE', 'FEMALE', [0, height / 2, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 1200, tags: ['stack'] }),
      socket('stack_bottom', 'GROUND_SUPPORT_BASE', 'MALE', [0, -height / 2, 0], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 1200, tags: ['stack'] }),
    ],
  };
}

function buildDelayTower() {
  const height = 5.0;
  const mesh = merge(
    translate(box(1.6, 0.08, 1.6), [0, 0.04, 0]),
    translate(cylinder(0.06, height, 10), [0, height / 2, 0]),
    translate(box(0.5, 0.06, 0.5), [0, height, 0]),
  );
  return {
    mesh,
    sockets: [
      socket('tower_base', 'GROUND_SUPPORT_BASE', 'FEMALE', [0, 0, 0], [0, -1, 0], [1, 0, 0], { loadBearing: true, tags: ['ground'] }),
      socket('array_pickup', 'SPEAKER_ARRAY_PIN', 'MALE', [0, height, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 600, tags: ['array'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 6. Lasers & SFX                                                             */
/* -------------------------------------------------------------------------- */

function buildLaserProjector(width, height, depth) {
  const mesh = merge(
    box(width, height, depth),
    translate(rotate(cylinder(height * 0.16, 0.06, 12), 'x', Math.PI / 2), [0, 0, depth / 2 + 0.03]),
    translate(box(0.05, 0.03, 0.05), [width / 2 - 0.05, height / 2 + 0.015, 0]), // e-stop
  );
  return {
    mesh,
    sockets: [
      socket('yoke_mount', 'SFX_MOUNT', 'MALE', [0, -height / 2, 0], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 40, canParent: false, tags: ['mount'] }),
      socket('clamp_mount', 'PIPE_CLAMP_2IN', 'MALE', [0, height / 2, 0], [0, 1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 40, canParent: false, tags: ['hang'] }),
    ],
  };
}

function buildSfxUnit(width, height, depth, nozzle) {
  const mesh = merge(box(width, height, depth));
  if (nozzle) {
    append(mesh, translate(rotate(frustum(0.045, 0.02, 0.16, 10), 'x', -Math.PI / 2), [0, height / 2 - 0.02, depth / 2]));
  }
  return {
    mesh,
    sockets: [
      socket('unit_mount', 'SFX_MOUNT', 'MALE', [0, -height / 2, 0], [0, -1, 0], [0, 0, 1],
        { loadBearing: true, maxLoadKg: 25, canParent: false, tags: ['mount'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 7. Crowd control, cabling & site infrastructure                             */
/* -------------------------------------------------------------------------- */

function buildMojoBarricade() {
  const width = 1.22;
  const height = 1.1;
  const mesh = merge(
    translate(box(width, height, 0.05), [0, height / 2, 0]),          // front panel
    translate(box(width, 0.05, 0.75), [0, 0.025, 0.4]),               // blow-through deck
    translate(box(0.05, height * 0.9, 0.05), [-width / 2 + 0.03, height * 0.45, 0.38]),
    translate(box(0.05, height * 0.9, 0.05), [width / 2 - 0.03, height * 0.45, 0.38]),
  );
  return {
    mesh,
    sockets: [
      socket('hinge_left', 'BARRICADE_HINGE', 'MALE', [-width / 2, height / 2, 0], [-1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
      socket('hinge_right', 'BARRICADE_HINGE', 'FEMALE', [width / 2, height / 2, 0], [1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
    ],
  };
}

function buildCableRamp() {
  const length = 0.9;
  const width = 0.5;
  const mesh = merge(
    translate(box(length, 0.055, width), [0, 0.0275, 0]),
    translate(box(length, 0.02, width * 0.92), [0, 0.065, 0]),        // hinged lid
  );
  return {
    mesh,
    sockets: [
      socket('ramp_a', 'BARRICADE_HINGE', 'MALE', [length / 2, 0.0275, 0], [1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
      socket('ramp_b', 'BARRICADE_HINGE', 'FEMALE', [-length / 2, 0.0275, 0], [-1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
    ],
  };
}

function buildBikeRackFence() {
  const width = 2.5;
  const height = 1.1;
  const mesh = emptyMesh();
  append(mesh, translate(rotate(cylinder(0.018, width, 8), 'z', Math.PI / 2), [0, height, 0]));
  append(mesh, translate(rotate(cylinder(0.018, width, 8), 'z', Math.PI / 2), [0, 0.1, 0]));
  for (let i = 0; i <= 10; i++) {
    const x = -width / 2 + (i * width) / 10;
    append(mesh, translate(cylinder(0.01, height - 0.1, 6), [x, (height + 0.1) / 2, 0]));
  }
  for (const sx of [-1, 1]) {
    append(mesh, translate(rotate(cylinder(0.016, 0.6, 6), 'x', Math.PI / 2), [sx * (width / 2 - 0.02), 0.05, 0]));
  }
  return {
    mesh,
    sockets: [
      socket('fence_a', 'BARRICADE_HINGE', 'MALE', [width / 2, height / 2, 0], [1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
      socket('fence_b', 'BARRICADE_HINGE', 'FEMALE', [-width / 2, height / 2, 0], [-1, 0, 0], [0, 1, 0], { tags: ['chain'] }),
    ],
  };
}

function buildFohTent(sizeFt) {
  const size = sizeFt * FT;
  const legHeight = 2.1;
  const peak = 0.6;
  const mesh = emptyMesh();
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    append(mesh, translate(cylinder(0.025, legHeight, 8), [sx * size / 2, legHeight / 2, sz * size / 2]));
  }
  append(mesh, translate(box(size, 0.05, size), [0, legHeight, 0]));
  // A 4-segment frustum is a square pyramid, but its vertices sit ON the
  // circumradius -- so it must be rotated 45 degrees and its radius set to
  // size/sqrt(2), or the roof overhangs the footprint by a factor of sqrt(2)
  // (a 10 ft tent measuring 4.4 m across).
  const roof = rotate(frustum((size / Math.SQRT2), 0.05, peak, 4), 'y', Math.PI / 4);
  append(mesh, translate(roof, [0, legHeight + peak / 2, 0]));
  return {
    mesh,
    sockets: [
      socket('anchor_ne', 'GROUND_SUPPORT_BASE', 'MALE', [size / 2, 0, size / 2], [0, -1, 0], [1, 0, 0], { tags: ['ballast'] }),
      socket('anchor_sw', 'GROUND_SUPPORT_BASE', 'MALE', [-size / 2, 0, -size / 2], [0, -1, 0], [1, 0, 0], { tags: ['ballast'] }),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `dmx` carries a default channel profile where the fixture has one. It feeds
 * the manifest so a patch can be generated without opening each model.
 */
export const CATALOG = [
  // 1. Trussing & rigging
  ...[0.5, 1.0, 2.0, 3.0].map((len) => ({
    // "0m5", "1m", "2m", "3m" -- metric stick naming, decimal point as `m`.
    id: `truss_f34_box_${Number.isInteger(len) ? `${len}m` : `${String(len).replace('.', 'm')}`}`,
    category: 'trussing',
    name: `F34 Box Truss ${len} m`,
    reference: 'Global Truss F34 / Prolyte H30V class',
    build: () => buildBoxTruss(len, F34, 'TRUSS_CONICAL_F34'),
  })),
  {
    id: 'truss_f44_box_2m', category: 'trussing', name: 'F44 Box Truss 2 m',
    reference: 'Global Truss F44 class',
    build: () => buildBoxTruss(2.0, F44, 'TRUSS_CONICAL_F44'),
  },
  {
    id: 'truss_f34_corner_6way', category: 'trussing', name: 'F34 6-Way Corner Block',
    reference: 'Global Truss F34 corner block',
    build: () => {
      const s = F34.section;
      const half = s / 2;
      const mesh = box(s, s, s);
      const sockets = [];
      const faces = [
        ['px', [1, 0, 0], [0, 1, 0], 'MALE'], ['nx', [-1, 0, 0], [0, 1, 0], 'FEMALE'],
        ['py', [0, 1, 0], [0, 0, 1], 'MALE'], ['ny', [0, -1, 0], [0, 0, 1], 'FEMALE'],
        ['pz', [0, 0, 1], [0, 1, 0], 'MALE'], ['nz', [0, 0, -1], [0, 1, 0], 'FEMALE'],
      ];
      for (const [key, normal, up, gender] of faces) {
        for (const [qk, a, b] of [['tn', 1, 1], ['tf', 1, -1], ['bn', -1, 1], ['bf', -1, -1]]) {
          // Offsets lie in the plane perpendicular to this face's normal.
          const offset = [0, 0, 0];
          const perp = [0, 1, 2].filter((i) => normal[i] === 0);
          offset[perp[0]] = a * half;
          offset[perp[1]] = b * half;
          offset[[0, 1, 2].find((i) => normal[i] !== 0)] = normal.find((v) => v !== 0) * half;
          const radial = [0, 0, 0];
          radial[perp[0]] = a;
          radial[perp[1]] = b;
          sockets.push(socket(`${key}_${qk}`, 'TRUSS_CONICAL_F34', gender, offset, normal, radial,
            { loadBearing: true, maxLoadKg: F34.loadKg, tags: [key] }));
        }
      }
      return { mesh, sockets };
    },
  },
  {
    id: 'truss_baseplate_24in', category: 'trussing', name: '24x24 in Steel Baseplate',
    reference: '610 x 610 mm steel base',
    build: () => {
      const side = 24 * IN;
      const mesh = merge(
        translate(box(side, 0.012, side), [0, 0.006, 0]),
        translate(box(F34.section, 0.05, F34.section), [0, 0.037, 0]),
      );
      const sockets = [socket('base_ground', 'GROUND_SUPPORT_BASE', 'FEMALE', [0, 0, 0], [0, -1, 0], [1, 0, 0],
        { loadBearing: true, tags: ['ground'] })];
      const half = F34.section / 2;
      for (const [qk, a, b] of [['tn', 1, 1], ['tf', 1, -1], ['bn', -1, 1], ['bf', -1, -1]]) {
        sockets.push(socket(`spigot_${qk}`, 'TRUSS_CONICAL_F34', 'MALE',
          [a * half, 0.062, b * half], [0, 1, 0], [a, 0, b],
          { loadBearing: true, maxLoadKg: F34.loadKg, tags: ['spigot'] }));
      }
      return { mesh, sockets };
    },
  },
  {
    id: 'hoist_cm_lodestar_1t', category: 'trussing', name: 'CM Lodestar 1-Ton Chain Hoist',
    reference: 'Columbus McKinnon Lodestar RRS',
    build: () => ({
      mesh: merge(
        box(0.52, 0.3, 0.28),
        translate(cylinder(0.03, 0.12, 8), [0, 0.2, 0]),
        translate(box(0.06, 0.1, 0.03), [0, 0.27, 0]),
      ),
      sockets: [
        socket('hook_top', 'RIG_HOIST_HOOK', 'MALE', [0, 0.32, 0], [0, 1, 0], [1, 0, 0],
          { loadBearing: true, maxLoadKg: 1000, canParent: false, tags: ['pickup'] }),
        socket('hook_bottom', 'RIG_HOIST_HOOK', 'FEMALE', [0, -0.15, 0], [0, -1, 0], [1, 0, 0],
          { loadBearing: true, maxLoadKg: 1000, tags: ['load'] }),
      ],
    }),
  },

  // 2. Staging
  { id: 'deck_4x8', category: 'staging', name: '4x8 ft Stage Deck', reference: 'Bil-Jax / StageRight black diamond', build: () => buildDeck(8, 4) },
  { id: 'deck_4x4', category: 'staging', name: '4x4 ft Stage Deck', reference: 'Bil-Jax / StageRight black diamond', build: () => buildDeck(4, 4) },
  { id: 'leg_telescopic_16_72', category: 'staging', name: 'Telescopic Leg 16-72 in', reference: 'Screw-jack levelling leg', build: buildTelescopicLeg },
  { id: 'guardrail_8ft', category: 'staging', name: '8 ft Guardrail', reference: 'OSHA 1.07 m guardrail', build: () => buildGuardrail(8) },
  { id: 'stairs_4step', category: 'staging', name: '4-Step Stair Unit', reference: 'Adjustable stage stair', build: () => buildStairs(4) },

  // 3. Video
  { id: 'led_tile_500x500', category: 'video', name: 'LED Tile 500x500 mm', reference: 'ROE Carbon / Absen Polaris class', build: () => buildLedTile(500, 500) },
  { id: 'led_tile_500x1000', category: 'video', name: 'LED Tile 500x1000 mm', reference: 'ROE Black Pearl class', build: () => buildLedTile(500, 1000) },
  { id: 'led_flybar_8tile', category: 'video', name: 'LED Flybar (8 tile)', reference: 'Single-header flybar', build: () => buildLedFlybar(8) },
  { id: 'led_ground_stack', category: 'video', name: 'LED Ground-Stack Frame', reference: 'Ladder frame with ballast tray', build: buildLedGroundStack },

  // 4. Lighting
  {
    id: 'moving_head_beam', category: 'lighting', name: 'Moving Head Beam', reference: 'Claypaky Sharpy class',
    dmx: { mode: 'Standard', channels: 16 }, build: () => buildMovingHead(0.34, 0.52, 0.25, 0.09, 0.3),
  },
  {
    id: 'moving_head_spot', category: 'lighting', name: 'Moving Head Spot/Profile', reference: 'Robe MegaPointe class',
    dmx: { mode: 'Mode 1', channels: 35 }, build: () => buildMovingHead(0.42, 0.63, 0.28, 0.11, 0.36),
  },
  {
    id: 'moving_head_wash', category: 'lighting', name: 'Moving Head Wash', reference: 'Martin MAC Aura class',
    dmx: { mode: 'Extended', channels: 30 }, build: () => buildMovingHead(0.38, 0.45, 0.26, 0.13, 0.22),
  },
  {
    id: 'strobe_jdc1', category: 'lighting', name: 'Hybrid Strobe (JDC1 class)', reference: 'GLP JDC1',
    dmx: { mode: 'Full', channels: 75 }, build: () => buildStrobeBar(0.63, 0.27, 0.19),
  },
  {
    id: 'blinder_4lite', category: 'lighting', name: '4-Lite Blinder', reference: 'Moles / Chauvet Strike class',
    dmx: { mode: 'Individual', channels: 4 }, build: buildBlinder4Lite,
  },

  // 5. Audio
  { id: 'line_array_k1', category: 'audio', name: 'Line Array Module K1 class', reference: 'L-Acoustics K1', build: () => buildLineArrayModule(1.35, 0.44, 0.72) },
  { id: 'line_array_k2', category: 'audio', name: 'Line Array Module K2 class', reference: 'L-Acoustics K2', build: () => buildLineArrayModule(1.34, 0.4, 0.69) },
  { id: 'line_array_ksl', category: 'audio', name: 'Line Array Module KSL class', reference: 'd&b audiotechnik KSL', build: () => buildLineArrayModule(1.32, 0.37, 0.68) },
  { id: 'array_flybar', category: 'audio', name: 'Line Array Flybar', reference: 'Pull-back rigging frame', build: buildArrayFlybar },
  { id: 'sub_ks28', category: 'audio', name: 'Subwoofer KS28 class', reference: 'L-Acoustics KS28', build: () => buildSubwoofer(1.34, 0.535, 0.79) },
  { id: 'delay_tower', category: 'audio', name: 'FOH Delay Tower', reference: '5 m ground-support delay mast', build: buildDelayTower },

  // 6. Lasers & SFX
  { id: 'laser_10w', category: 'sfx', name: '10 W Laser Projector', reference: 'Kvant / Pangolin ClubMAX class', dmx: { mode: 'Standard', channels: 16 }, build: () => buildLaserProjector(0.42, 0.24, 0.3) },
  { id: 'laser_40w', category: 'sfx', name: '40 W Laser Projector', reference: 'Kvant ClubMAX 40 class', dmx: { mode: 'Standard', channels: 16 }, build: () => buildLaserProjector(0.56, 0.32, 0.38) },
  { id: 'hazer_unique21', category: 'sfx', name: 'Hazer (Unique 2.1 class)', reference: 'Look Solutions Unique 2.1', dmx: { mode: 'Standard', channels: 2 }, build: () => buildSfxUnit(0.53, 0.32, 0.26, true) },
  { id: 'co2_jet', category: 'sfx', name: 'CO2 Cryo Jet', reference: 'Single-nozzle cryo jet', dmx: { mode: 'On/Off', channels: 1 }, build: () => buildSfxUnit(0.22, 0.3, 0.22, true) },
  { id: 'cold_spark', category: 'sfx', name: 'Cold Spark Machine', reference: 'Sparkular class', dmx: { mode: 'Standard', channels: 2 }, build: () => buildSfxUnit(0.36, 0.4, 0.3, true) },

  // 7. Site infrastructure
  { id: 'barricade_mojo', category: 'site', name: 'Mojo Blow-Through Barricade', reference: 'Mojo aluminium barricade', build: buildMojoBarricade },
  { id: 'cable_ramp_5ch', category: 'site', name: '5-Channel Cable Ramp', reference: 'Yellow Jacket 5-channel', build: buildCableRamp },
  { id: 'fence_bike_rack', category: 'site', name: 'Bike-Rack Perimeter Fence', reference: 'Standard 2.5 m bike rack', build: buildBikeRackFence },
  { id: 'tent_foh_10x10', category: 'site', name: 'FOH Tent 10x10 ft', reference: 'Pop-up FOH shelter', build: () => buildFohTent(10) },
];
