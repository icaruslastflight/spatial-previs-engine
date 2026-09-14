/**
 * Socket metadata authoring, matching the Event Asset Library & Modular
 * Snapping Specification section 3.1 and consumed by SocketSnappingEngine.
 */

// Mirrors SOCKET_TYPES in src/engine/SocketSnappingEngine.ts exactly -- this
// build-time script cannot import the .ts runtime module, so the list is kept
// in lockstep by hand. FIXTURE_YOKE_AXIS is authored only by GDTFParser, never
// through the socket() helper below, but it must still validate here.
export const SOCKET_TYPES = [
  'TRUSS_CONICAL_F34', 'TRUSS_CONICAL_F44', 'STAGE_COFFIN_LOCK', 'STAGE_LEG_RECEIVER',
  'LED_PANEL_FASTENER', 'LED_FLYBAR_PICKUP', 'PIPE_CLAMP_2IN', 'RIG_HOIST_HOOK',
  'SPEAKER_ARRAY_PIN', 'GROUND_SUPPORT_BASE', 'SFX_MOUNT', 'BARRICADE_HINGE',
  'FIXTURE_YOKE_AXIS',
];

export const GENDERS = ['MALE', 'FEMALE', 'NEUTRAL', 'UNIVERSAL'];

/** Project-wide defaults. Per-socket overrides are the exception, not the rule. */
export const DEFAULT_SNAP_RADIUS = 0.15;
export const DEFAULT_SNAP_ANGLE_DEG = 15;
export const DEFAULT_DETENTS_DEG = [0, 90, 180, 270];

/**
 * Author one socket.
 *
 * `normal` points OUTWARD from the mating face; two sockets mate when their
 * normals are anti-parallel. `up` is the roll reference and must not be
 * parallel to `normal`.
 */
export function socket(socketId, socketType, gender, translation, normal, up, options = {}) {
  if (!SOCKET_TYPES.includes(socketType)) {
    throw new Error(`unknown socket_type "${socketType}" on socket "${socketId}"`);
  }
  if (!GENDERS.includes(gender)) {
    throw new Error(`unknown gender "${gender}" on socket "${socketId}"`);
  }

  // A roll reference parallel to the mating axis carries no roll information,
  // so the joint would have an unresolved degree of freedom. Catch it here
  // rather than at runtime.
  const cross = [
    normal[1] * up[2] - normal[2] * up[1],
    normal[2] * up[0] - normal[0] * up[2],
    normal[0] * up[1] - normal[1] * up[0],
  ];
  if (Math.hypot(...cross) < 1e-6) {
    throw new Error(`socket "${socketId}": up vector is parallel to normal`);
  }

  const definition = {
    socket_id: socketId,
    socket_type: socketType,
    gender,
    transform: {
      translation: translation.map(Number),
      normal: normal.map(Number),
      up: up.map(Number),
    },
    tolerances: {
      snap_radius: options.snapRadius ?? DEFAULT_SNAP_RADIUS,
      snap_angle: options.snapAngle ?? DEFAULT_SNAP_ANGLE_DEG,
      detents_deg: options.detents ?? DEFAULT_DETENTS_DEG,
    },
    kinematic_rules: {
      can_parent: options.canParent ?? true,
      can_child: options.canChild ?? true,
      load_bearing: options.loadBearing ?? false,
    },
  };
  if (options.maxLoadKg != null) definition.kinematic_rules.max_load_kg = options.maxLoadKg;
  if (options.tags) definition.tags = options.tags;
  return definition;
}

/**
 * The four chord interfaces on one end of a square box truss.
 *
 * Up vectors point RADIALLY OUTWARD toward each chord. That is what encodes the
 * chord's angular position around the truss axis, so aligning one mated pair
 * also puts the other three in correspondence -- a shared up of (0,1,0) aligns
 * one chord and leaves the other three crossed.
 */
export function trussEndSockets(prefix, x, normal, gender, halfSection, type, loadKg) {
  const quadrants = [
    ['top_near', +1, +1], ['top_far', +1, -1],
    ['bottom_near', -1, +1], ['bottom_far', -1, -1],
  ];
  return quadrants.map(([key, sy, sz]) =>
    socket(`${prefix}_${key}`, type, gender,
      [x, sy * halfSection, sz * halfSection], normal, [0, sy, sz],
      { loadBearing: true, maxLoadKg: loadKg, tags: [prefix, key] }));
}
