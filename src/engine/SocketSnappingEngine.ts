/**
 * SocketSnappingEngine -- semantic magnetic snapping for modular show assets.
 *
 * Mirrors the UE5 desktop implementation. Any behavioural change here MUST be
 * mirrored there (Strict Dual-Platform Parity), because a preview built on the
 * phone has to match the plot the crew builds on the workstation.
 *
 * PIPELINE
 *   1. register(object)      -- harvest `extras.sockets` into a world-space cache
 *   2. findSnapCandidate(o)  -- nearest compatible socket pair within 0.15 m
 *   3. applySnap(candidate)  -- align mating axes, snap roll to a 90 deg detent,
 *                               translate sockets coincident, then reparent
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Contract -- Event Asset Library & Modular Snapping Specification, section 3 */
/* -------------------------------------------------------------------------- */

/**
 * The shared socket-type catalogue.
 *
 * This list is a contract with the UE5 build and with any glTF authored for the
 * project. An asset carrying a type outside this list is rejected at
 * registration rather than silently ignored -- a mistyped socket that merely
 * never snaps is far more expensive to find on site than one that fails loudly
 * at load.
 */
export const SOCKET_TYPES = [
  /** F34-series conical truss coupler (4 per truss end). */
  'TRUSS_CONICAL_F34',
  /** F44-series conical truss coupler. */
  'TRUSS_CONICAL_F44',
  /** Hermaphroditic coffin lock on a deck perimeter. */
  'STAGE_COFFIN_LOCK',
  /** Deck corner leg receiver. */
  'STAGE_LEG_RECEIVER',
  /** LED tile edge fastener / locking latch. */
  'LED_PANEL_FASTENER',
  /** LED flybar pickup point. */
  'LED_FLYBAR_PICKUP',
  /** 2-inch pipe / truss-boom clamp interface. */
  'PIPE_CLAMP_2IN',
  /** Chain-hoist hook or shackle pickup. */
  'RIG_HOIST_HOOK',
  /** Line-array inter-cabinet rigging pin. */
  'SPEAKER_ARRAY_PIN',
  /** Ground-support base plate / ballast interface. */
  'GROUND_SUPPORT_BASE',
  /** Effects unit yoke or clamp mount. */
  'SFX_MOUNT',
  /** Barricade / fencing panel hinge. */
  'BARRICADE_HINGE',
  /**
   * A moving fixture's pan/tilt articulation point (GDTF `Axis` geometry).
   *
   * Unlike every other type above, this never participates in magnetic
   * snapping -- nothing in the catalogue mates with it, and
   * `kinematic_rules.can_parent`/`can_child` are always false wherever this
   * type is emitted (see `GDTFParser.injectFixtureSockets`). It rides on the
   * same `extras.sockets` contract purely so a fixture's articulation points
   * are discoverable through the one query mechanism (`readSockets`) the rest
   * of the codebase already uses, instead of requiring bespoke GDTF-tree
   * traversal wherever that information is needed.
   */
  'FIXTURE_YOKE_AXIS',
] as const;

export type SocketType = (typeof SOCKET_TYPES)[number];

/**
 * Mating polarity.
 *
 *   MALE      mates only with FEMALE (and UNIVERSAL)
 *   FEMALE    mates only with MALE (and UNIVERSAL)
 *   NEUTRAL   mates only with NEUTRAL (and UNIVERSAL) -- coffin locks are
 *             hermaphroditic, so two identical locks mate
 *   UNIVERSAL mates with anything of the same socket_type
 */
export type SocketGender = 'MALE' | 'FEMALE' | 'NEUTRAL' | 'UNIVERSAL';

/** A 3-tuple in the owning object's LOCAL space. Snake_case matches glTF extras. */
export type Vec3Tuple = [number, number, number];

/** Where the socket sits and which way it faces, in the asset's local space. */
export interface SocketTransform {
  /** Local position, metres. */
  translation: Vec3Tuple;
  /** Forward normal: points OUTWARD from the mating face. Unit length. */
  normal: Vec3Tuple;
  /** Roll reference. Orthogonalized against `normal` on registration. */
  up: Vec3Tuple;
}

/** Capture tolerances. Omitted fields fall back to the project defaults. */
export interface SocketTolerances {
  /** Capture radius between socket origins, metres. Spec default 0.15. */
  snap_radius?: number;
  /**
   * Angular capture window in DEGREES: how far the mating axes may deviate
   * from anti-parallel and still capture. Spec default 15.
   *
   * This is a tolerance, NOT the detent step -- see `detents_deg`.
   */
  snap_angle?: number;
  /**
   * Roll detents in degrees. Spec default [0, 90, 180, 270].
   *
   * Kept separate from `snap_angle` because conflating them is the classic
   * misreading: the joint captures within 15 degrees, then locks onto a
   * cardinal detent.
   */
  detents_deg?: number[];
}

/** How the joint behaves once mated. */
export interface SocketKinematicRules {
  /** May act as the parent of a kinematic chain. Default true. */
  can_parent?: boolean;
  /** May be reparented as a child. Default true. */
  can_child?: boolean;
  /** Transfers structural load across the joint (rigging analysis). */
  load_bearing?: boolean;
  /** Working load limit at this interface, kilograms. */
  max_load_kg?: number;
}

/**
 * One socket, as embedded under `extras.sockets` in the asset.
 *
 * Two shapes are accepted on read. This nested form is the specification shape
 * and what everything in this codebase now emits. The older flat form --
 * position/normal/up as siblings of socket_id, with lowercase types and
 * genders -- is still parsed so that assets authored before the schema
 * migration keep loading; see `normalizeSocket`.
 */
export interface SocketDefinition {
  socket_id: string;
  socket_type: SocketType;
  gender: SocketGender;
  transform: SocketTransform;
  tolerances?: SocketTolerances;
  kinematic_rules?: SocketKinematicRules;
  /** Free-form labels, e.g. ['end_a', 'chord_top_left']. */
  tags?: string[];
}

/** The `extras` payload an asset carries. */
export interface SocketExtras {
  sockets: SocketDefinition[];
}

/* -------------------------------------------------------------------------- */
/* Tolerances -- keep in lockstep with CLAUDE.md and the UE5 build             */
/* -------------------------------------------------------------------------- */

/** Magnetic capture radius between two socket origins, metres. */
export const SNAP_THRESHOLD_METERS = 0.15;

/**
 * Angular capture window, radians (15 degrees).
 *
 * A candidate pair whose mating axes deviate further than this from
 * anti-parallel does not capture, however close the origins are.
 */
export const SNAP_ANGLE_RADIANS = (15 * Math.PI) / 180;

/** Roll about the mating axis quantizes to 0 / 90 / 180 / 270 degrees. */
export const DETENT_STEP_RADIANS = Math.PI / 2;

/** Below this, a direction vector is treated as degenerate. */
const EPSILON = 1e-6;

/* -------------------------------------------------------------------------- */
/* Runtime types                                                               */
/* -------------------------------------------------------------------------- */

/** A socket resolved into world space for the current frame. */
export interface WorldSocket {
  definition: NormalizedSocket;
  owner: THREE.Object3D;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  up: THREE.Vector3;
}

/** A proposed snap, fully resolved but not yet applied. */
export interface SnapCandidate {
  /** Socket on the object being dragged. */
  moving: WorldSocket;
  /** Socket on the stationary object being mated to. */
  target: WorldSocket;
  /** Distance between socket origins at query time, meters. */
  distance: number;
  /** World position the moving object's origin resolves to. */
  resolvedPosition: THREE.Vector3;
  /** World quaternion the moving object resolves to. */
  resolvedQuaternion: THREE.Quaternion;
  /** Chosen roll detent: 0, 90, 180 or 270 degrees. */
  detentDegrees: number;
}

/** A parent-child relationship established by a snap. */
export interface KinematicLink {
  child: THREE.Object3D;
  parent: THREE.Object3D;
  childSocketId: string;
  parentSocketId: string;
}

/* -------------------------------------------------------------------------- */
/* Metadata access                                                             */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Normalized runtime form                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A socket flattened into the form the engine actually works with.
 *
 * Normalizing once on registration means the hot path never has to branch on
 * which schema an asset was authored against, nor re-apply defaults per frame.
 */
export interface NormalizedSocket {
  socket_id: string;
  socket_type: SocketType;
  gender: SocketGender;
  position: Vec3Tuple;
  normal: Vec3Tuple;
  up: Vec3Tuple;
  snapRadius: number;
  snapAngleRadians: number;
  detentStepRadians: number;
  canParent: boolean;
  canChild: boolean;
  loadBearing: boolean;
  maxLoadKg: number | null;
  tags: string[];
}

/** Legacy lowercase socket types, mapped onto the specification vocabulary. */
const LEGACY_TYPE_ALIASES: Record<string, SocketType> = {
  truss_f34_chord: 'TRUSS_CONICAL_F34',
  truss_f44_chord: 'TRUSS_CONICAL_F44',
  deck_coffin_lock: 'STAGE_COFFIN_LOCK',
  deck_leg: 'STAGE_LEG_RECEIVER',
  ground_support_base: 'GROUND_SUPPORT_BASE',
};

function coerceSocketType(raw: unknown): SocketType | null {
  if (typeof raw !== 'string') return null;
  if ((SOCKET_TYPES as readonly string[]).includes(raw)) return raw as SocketType;
  const upper = raw.toUpperCase();
  if ((SOCKET_TYPES as readonly string[]).includes(upper)) return upper as SocketType;
  return LEGACY_TYPE_ALIASES[raw] ?? null;
}

function coerceGender(raw: unknown): SocketGender | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  return upper === 'MALE' || upper === 'FEMALE' || upper === 'NEUTRAL' || upper === 'UNIVERSAL'
    ? (upper as SocketGender)
    : null;
}

function isVec3Tuple(v: unknown): v is Vec3Tuple {
  return (
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Normalize a raw socket record from either schema, or return null if it is
 * not a usable socket.
 */
export function normalizeSocket(value: unknown): NormalizedSocket | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const socketId = raw['socket_id'];
  const socketType = coerceSocketType(raw['socket_type']);
  const gender = coerceGender(raw['gender']);
  if (typeof socketId !== 'string' || socketType === null || gender === null) return null;

  // Spec shape nests the pose under `transform`; the legacy shape inlines it.
  const transform = raw['transform'] as Record<string, unknown> | undefined;
  const position = transform?.['translation'] ?? raw['position'];
  const normal = transform?.['normal'] ?? raw['normal'];
  const up = transform?.['up'] ?? raw['up'];
  if (!isVec3Tuple(position) || !isVec3Tuple(normal) || !isVec3Tuple(up)) return null;

  const tolerances = (raw['tolerances'] ?? {}) as SocketTolerances;
  const rules = (raw['kinematic_rules'] ?? {}) as SocketKinematicRules;

  const detents = tolerances.detents_deg;
  // Detents are stored as a step. A uniform list (0/90/180/270) is the only
  // shape the alignment maths supports, so derive the step from its spacing.
  const detentStep =
    Array.isArray(detents) && detents.length > 1
      ? (Math.abs(detents[1]! - detents[0]!) * Math.PI) / 180
      : DETENT_STEP_RADIANS;

  const legacyLoad = raw['load_rating_kg'];

  return {
    socket_id: socketId,
    socket_type: socketType,
    gender,
    position: [...position] as Vec3Tuple,
    normal: [...normal] as Vec3Tuple,
    up: [...up] as Vec3Tuple,
    snapRadius: typeof tolerances.snap_radius === 'number' ? tolerances.snap_radius : SNAP_THRESHOLD_METERS,
    snapAngleRadians:
      typeof tolerances.snap_angle === 'number'
        ? (tolerances.snap_angle * Math.PI) / 180
        : SNAP_ANGLE_RADIANS,
    detentStepRadians: detentStep > EPSILON ? detentStep : DETENT_STEP_RADIANS,
    canParent: rules.can_parent !== false,
    canChild: rules.can_child !== false,
    loadBearing: rules.load_bearing === true,
    maxLoadKg:
      typeof rules.max_load_kg === 'number'
        ? rules.max_load_kg
        : typeof legacyLoad === 'number'
          ? legacyLoad
          : null,
    tags: Array.isArray(raw['tags']) ? (raw['tags'] as string[]).filter((t) => typeof t === 'string') : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Metadata access                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read and normalize socket definitions off an object.
 *
 * Two container shapes are accepted. Assets authored here write the literal
 * spec shape `userData.extras.sockets`. Three's GLTFLoader, however, flattens a
 * glTF node's `extras` straight onto `userData` via Object.assign -- so an
 * asset round-tripped through glTF arrives as `userData.sockets`. Both are the
 * same `extras.sockets` contract, so both are read here.
 */
export function readSockets(object: THREE.Object3D): NormalizedSocket[] {
  const userData = object.userData as Record<string, unknown>;
  const extras = userData['extras'] as Record<string, unknown> | undefined;
  const raw = extras?.['sockets'] ?? userData['sockets'];
  if (!Array.isArray(raw)) return [];

  const valid: NormalizedSocket[] = [];
  for (const entry of raw) {
    const normalized = normalizeSocket(entry);
    if (normalized !== null) {
      valid.push(normalized);
    } else {
      console.warn(
        `[SocketSnappingEngine] Discarding malformed socket on "${object.name || object.uuid}".`,
        entry,
      );
    }
  }
  return valid;
}

/** Write socket definitions onto an object in the literal `extras.sockets` shape. */
export function writeSockets(object: THREE.Object3D, sockets: SocketDefinition[]): void {
  const extras: SocketExtras = { sockets };
  object.userData['extras'] = extras;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Project `v` onto the plane perpendicular to unit vector `axis` and normalize.
 * Returns null when `v` is (near) parallel to the axis and so carries no roll
 * information.
 */
function projectOntoPlane(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
  const projected = v.clone().addScaledVector(axis, -v.dot(axis));
  if (projected.lengthSq() < EPSILON * EPSILON) return null;
  return projected.normalize();
}

/**
 * Signed angle from `from` to `to`, measured about `axis` (right-hand rule).
 * All three must be unit vectors; `from` and `to` must be perpendicular to `axis`.
 */
function signedAngleAbout(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  const cross = new THREE.Vector3().crossVectors(from, to);
  return Math.atan2(cross.dot(axis), from.dot(to));
}

/** Are these two sockets allowed to mate? */
export function areSocketsCompatible(a: NormalizedSocket, b: NormalizedSocket): boolean {
  if (a.socket_type !== b.socket_type) return false;
  // UNIVERSAL is the wildcard: it accepts any polarity of its own type.
  if (a.gender === 'UNIVERSAL' || b.gender === 'UNIVERSAL') return true;
  if (a.gender === 'NEUTRAL' || b.gender === 'NEUTRAL') {
    return a.gender === 'NEUTRAL' && b.gender === 'NEUTRAL';
  }
  return a.gender !== b.gender;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export interface SnapEngineOptions {
  /** Capture radius in meters. Defaults to SNAP_THRESHOLD_METERS (0.15). */
  thresholdMeters?: number;
  /**
   * Reparent the moving object under the target on snap, forming a kinematic
   * chain so moving a parent carries its children. Defaults to true.
   */
  kinematicLinking?: boolean;
}

export class SocketSnappingEngine {
  private readonly registry = new Map<string, THREE.Object3D>();
  private readonly socketCache = new Map<string, NormalizedSocket[]>();
  /** Keys of sockets already consumed by a snap: `${uuid}:${socket_id}`. */
  private readonly occupied = new Set<string>();
  private readonly links: KinematicLink[] = [];

  readonly thresholdMeters: number;
  readonly kinematicLinking: boolean;

  constructor(options: SnapEngineOptions = {}) {
    this.thresholdMeters = options.thresholdMeters ?? SNAP_THRESHOLD_METERS;
    this.kinematicLinking = options.kinematicLinking ?? true;
  }

  /** Register an object so its sockets participate in snapping. */
  register(object: THREE.Object3D): void {
    const sockets = readSockets(object);
    if (sockets.length === 0) {
      console.warn(
        `[SocketSnappingEngine] "${object.name || object.uuid}" has no valid sockets; not registered.`,
      );
      return;
    }
    this.registry.set(object.uuid, object);
    this.socketCache.set(object.uuid, sockets);
  }

  /** Remove an object and any links or socket reservations it holds. */
  unregister(object: THREE.Object3D): void {
    this.registry.delete(object.uuid);
    this.socketCache.delete(object.uuid);
    for (const key of [...this.occupied]) {
      if (key.startsWith(`${object.uuid}:`)) this.occupied.delete(key);
    }
    for (let i = this.links.length - 1; i >= 0; i--) {
      const link = this.links[i]!;
      if (link.child === object || link.parent === object) this.links.splice(i, 1);
    }
  }

  /** Is this exact object registered as a snappable? */
  isRegistered(object: THREE.Object3D): boolean {
    return this.registry.has(object.uuid) && this.registry.get(object.uuid) === object;
  }

  get registeredObjects(): readonly THREE.Object3D[] {
    return [...this.registry.values()];
  }

  get kinematicLinks(): readonly KinematicLink[] {
    return this.links;
  }

  private static socketKey(object: THREE.Object3D, socketId: string): string {
    return `${object.uuid}:${socketId}`;
  }

  isOccupied(object: THREE.Object3D, socketId: string): boolean {
    return this.occupied.has(SocketSnappingEngine.socketKey(object, socketId));
  }

  /**
   * Resolve an object's sockets into world space.
   *
   * Directions are rotated by the object's world quaternion only -- socket
   * normals are orientations, not positions, so they must not pick up
   * translation. `up` is orthogonalized against `normal` so authored metadata
   * that is merely approximate still yields an exact orthonormal frame.
   */
  getWorldSockets(object: THREE.Object3D): WorldSocket[] {
    const definitions = this.socketCache.get(object.uuid) ?? readSockets(object);
    if (definitions.length === 0) return [];

    object.updateWorldMatrix(true, false);
    const worldQuaternion = new THREE.Quaternion();
    const worldPosition = new THREE.Vector3();
    const worldScale = new THREE.Vector3();
    object.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);

    const result: WorldSocket[] = [];
    for (const definition of definitions) {
      const position = new THREE.Vector3(...definition.position).applyMatrix4(object.matrixWorld);

      const normal = new THREE.Vector3(...definition.normal);
      if (normal.lengthSq() < EPSILON * EPSILON) {
        console.warn(
          `[SocketSnappingEngine] Socket "${definition.socket_id}" has a degenerate normal; skipped.`,
        );
        continue;
      }
      normal.normalize().applyQuaternion(worldQuaternion).normalize();

      const rawUp = new THREE.Vector3(...definition.up).applyQuaternion(worldQuaternion);
      const up = projectOntoPlane(rawUp, normal);
      if (up === null) {
        console.warn(
          `[SocketSnappingEngine] Socket "${definition.socket_id}" has an up vector parallel to its normal; skipped.`,
        );
        continue;
      }

      result.push({ definition, owner: object, position, normal, up });
    }
    return result;
  }

  /**
   * Resolve the transform that mates `moving` onto `target`.
   *
   * Three steps, composed into a single world-space delta:
   *   q1  swings the moving normal onto the target's inverse normal, so the two
   *       mating faces oppose one another;
   *   q2  rotates about that shared axis by the nearest cardinal detent, so the
   *       roll lands on 0 / 90 / 180 / 270 instead of wherever the drag left it;
   *   t   places the object's origin so the two socket origins coincide.
   */
  resolveSnapTransform(moving: WorldSocket, target: WorldSocket): SnapCandidate {
    const movingObject = moving.owner;
    movingObject.updateWorldMatrix(true, false);

    const currentPosition = new THREE.Vector3();
    const currentQuaternion = new THREE.Quaternion();
    const currentScale = new THREE.Vector3();
    movingObject.matrixWorld.decompose(currentPosition, currentQuaternion, currentScale);

    // 1. Mating axis: the moving socket must end up facing INTO the target.
    const matingAxis = target.normal.clone().negate();
    const swing = new THREE.Quaternion().setFromUnitVectors(moving.normal, matingAxis);

    // 2. Residual roll about the mating axis, quantized to a cardinal detent.
    const swungUp = moving.up.clone().applyQuaternion(swing);
    const fromUp = projectOntoPlane(swungUp, matingAxis);
    const toUp = projectOntoPlane(target.up, matingAxis);

    let detentIndex = 0;
    let detentStepDegrees = (DETENT_STEP_RADIANS * 180) / Math.PI;
    const twist = new THREE.Quaternion();
    if (fromUp !== null && toUp !== null) {
      // `rawAngle` is the rotation that would drive the moving up-vector exactly
      // onto the target's. Rotating by the QUANTIZED raw angle would leave the
      // leftover fraction as error; instead rotate by the small correction that
      // removes it, landing the joint precisely on detent `detentIndex`.
      const rawAngle = signedAngleAbout(fromUp, toUp, matingAxis);
      const step = target.definition.detentStepRadians;
      detentIndex = Math.round(rawAngle / step);
      const correction = rawAngle - detentIndex * step;
      twist.setFromAxisAngle(matingAxis, correction);
      detentStepDegrees = (step * 180) / Math.PI;
    }

    const delta = twist.clone().multiply(swing);
    const resolvedQuaternion = delta.clone().multiply(currentQuaternion);

    // 3. Translate so the socket origins coincide. The socket's world offset
    //    from the object origin rotates with the object, so the new offset is
    //    delta applied to the current offset.
    const socketOffset = moving.position.clone().sub(currentPosition).applyQuaternion(delta);
    const resolvedPosition = target.position.clone().sub(socketOffset);

    // The residual offset between the mated up-vectors, which the correction
    // above has driven to exactly this multiple of 90 degrees.
    const detentDegrees = (((detentIndex * detentStepDegrees) % 360) + 360) % 360;

    return {
      moving,
      target,
      distance: moving.position.distanceTo(target.position),
      resolvedPosition,
      resolvedQuaternion,
      detentDegrees,
    };
  }

  /**
   * Find the best snap for `movingObject`: the closest compatible, unoccupied
   * socket pair inside the capture radius.
   *
   * Objects in the moving object's own hierarchy are excluded -- snapping a
   * truss to something already hanging off it would create a parent cycle.
   */
  findSnapCandidate(movingObject: THREE.Object3D): SnapCandidate | null {
    const movingSockets = this.getWorldSockets(movingObject).filter(
      (s) => !this.isOccupied(movingObject, s.definition.socket_id),
    );
    if (movingSockets.length === 0) return null;

    let best: SnapCandidate | null = null;

    for (const targetObject of this.registry.values()) {
      if (targetObject === movingObject) continue;
      if (isInHierarchy(targetObject, movingObject)) continue;

      for (const targetSocket of this.getWorldSockets(targetObject)) {
        if (this.isOccupied(targetObject, targetSocket.definition.socket_id)) continue;

        for (const movingSocket of movingSockets) {
          if (!areSocketsCompatible(movingSocket.definition, targetSocket.definition)) continue;

          const distance = movingSocket.position.distanceTo(targetSocket.position);
          // Per-socket radius when the asset declares one; the tighter of the
          // mating pair governs.
          const radius = Math.min(
            this.thresholdMeters,
            movingSocket.definition.snapRadius,
            targetSocket.definition.snapRadius,
          );
          if (distance > radius) continue;
          if (best !== null && distance >= best.distance) continue;

          // Angular capture window. Sockets mate when their normals are
          // ANTI-parallel, so deviation is measured against -1: a pair facing
          // the same way is 180 degrees out of alignment, not 0.
          const deviation = Math.acos(
            THREE.MathUtils.clamp(-movingSocket.normal.dot(targetSocket.normal), -1, 1),
          );
          if (
            deviation >
            Math.min(movingSocket.definition.snapAngleRadians, targetSocket.definition.snapAngleRadians)
          ) {
            continue;
          }

          // Kinematic rules: the child must be reparentable, the target willing
          // to act as a parent.
          if (this.kinematicLinking) {
            if (!movingSocket.definition.canChild) continue;
            if (!targetSocket.definition.canParent) continue;
          }

          best = this.resolveSnapTransform(movingSocket, targetSocket);
        }
      }
    }

    return best;
  }

  /**
   * Commit a candidate: move the object onto the resolved transform, reserve
   * both sockets, and link the pair into a kinematic chain.
   */
  applySnap(candidate: SnapCandidate): KinematicLink | null {
    const child = candidate.moving.owner;
    const parent = candidate.target.owner;

    setWorldTransform(child, candidate.resolvedPosition, candidate.resolvedQuaternion);

    if (this.kinematicLinking) {
      // Object3D.attach() reparents while preserving the world transform we
      // just resolved, which is exactly the kinematic semantics we want.
      parent.attach(child);
    }

    this.occupied.add(
      SocketSnappingEngine.socketKey(child, candidate.moving.definition.socket_id),
    );
    this.occupied.add(
      SocketSnappingEngine.socketKey(parent, candidate.target.definition.socket_id),
    );

    const link: KinematicLink = {
      child,
      parent,
      childSocketId: candidate.moving.definition.socket_id,
      parentSocketId: candidate.target.definition.socket_id,
    };
    this.links.push(link);
    return link;
  }

  /**
   * Convenience: query and commit in one call.
   * Returns the committed candidate, or null when nothing was in range.
   */
  trySnap(movingObject: THREE.Object3D): SnapCandidate | null {
    const candidate = this.findSnapCandidate(movingObject);
    if (candidate === null) return null;
    this.applySnap(candidate);
    return candidate;
  }

  /**
   * Break the kinematic link holding `child`, returning it to `newParent`
   * (the scene root by default) with its world transform preserved.
   */
  unlink(child: THREE.Object3D, newParent: THREE.Object3D): boolean {
    const index = this.links.findIndex((l) => l.child === child);
    if (index === -1) return false;

    const link = this.links[index]!;
    this.occupied.delete(SocketSnappingEngine.socketKey(link.child, link.childSocketId));
    this.occupied.delete(SocketSnappingEngine.socketKey(link.parent, link.parentSocketId));
    this.links.splice(index, 1);

    newParent.attach(child);
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Object3D utilities                                                          */
/* -------------------------------------------------------------------------- */

/** Is `candidate` equal to `root` or one of its descendants? */
export function isInHierarchy(candidate: THREE.Object3D, root: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = candidate;
  while (node !== null) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Place an object at a world-space position/orientation, compensating for
 * whatever parent transform it currently sits under.
 *
 * Scale is read from the existing world matrix and preserved; snapping rotates
 * and translates only. Non-uniform scale on a rotated parent is not supported
 * (it is not a rigid transform and has no meaningful socket alignment).
 */
export function setWorldTransform(
  object: THREE.Object3D,
  worldPosition: THREE.Vector3,
  worldQuaternion: THREE.Quaternion,
): void {
  object.updateWorldMatrix(true, false);
  const worldScale = new THREE.Vector3();
  object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);

  const target = new THREE.Matrix4().compose(worldPosition, worldQuaternion, worldScale);

  const parent = object.parent;
  if (parent !== null) {
    parent.updateWorldMatrix(true, false);
    target.premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
  }

  target.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
}
