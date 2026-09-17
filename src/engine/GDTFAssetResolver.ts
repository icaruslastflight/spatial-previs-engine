/**
 * Runtime GDTF fixture resolver.
 *
 * Turns a parsed `GDTFProfile` into a live Three.js object: a kinematic chain
 * of nested groups (`base -> yoke -> head -> emitter`), a photometrically
 * configured `SpotLight` at the lens, and the `extras.sockets` metadata the
 * snapping engine needs to clamp the fixture onto truss.
 *
 * WHY THE CHAIN IS NESTED GROUPS
 * ------------------------------
 * Pan rotates the yoke; tilt rotates the head, which hangs off the yoke and so
 * inherits pan. Nesting makes that inheritance the scene graph's job rather
 * than trigonometry repeated on every frame, and it means the emitter's world
 * direction falls out of `updateMatrixWorld` for free -- which is what the beam
 * renderer and any future sightline check read.
 *
 * GDTF rotation axes are the LOCAL X of each `<Axis>` geometry (DIN SPEC 15800
 * section 6.4). The parser has already baked each node's orientation into its
 * transform, so this module rotates about X and nothing else. Guessing an axis
 * from the node's name instead would break on any fixture whose manufacturer
 * named its parts differently.
 */

import * as THREE from 'three';

import {
  channelsForAttribute,
  findAxes,
  findBeam,
  findDmxMode,
  normalizeDmx,
  physicalFromNormalized,
  readChannelValue,
} from './GDTFParser.ts';
import type {
  GDTFBeam,
  GDTFDmxChannel,
  GDTFDmxMode,
  GDTFGeometryNode,
  GDTFProfile,
} from './GDTFParser.ts';
import { SNAP_THRESHOLD_METERS } from './SocketSnappingEngine.ts';
import type { SocketDefinition } from './SocketSnappingEngine.ts';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Socket id for the fixture's truss-mounting interface. */
export const CLAMP_SOCKET_ID = 'fixture_clamp';
/** Kinematic reference ids, recorded under `extras.kinematics`. */
export const YOKE_PIVOT_ID = 'yoke_axis';
export const HEAD_PIVOT_ID = 'head_axis';
export const EMITTER_ID = 'lens_emitter';

/**
 * Physical decay exponent for every fixture light.
 *
 * 2.0 is inverse-square, which is what real light does. Three.js allows other
 * values for artistic control; using them here would make the previz disagree
 * with a photometric prediction, which is the one thing this view is for.
 */
export const LIGHT_DECAY = 2.0;

/** Fallback field angle when a profile ships a beam with no cone, degrees. */
const DEFAULT_FIELD_ANGLE_DEGREES = 15;

/**
 * The local X axis, as a shared constant.
 *
 * `Quaternion.setFromAxisAngle` only reads this -- never mutate it. One
 * instance is safe to reuse across every fixture and every frame rather than
 * allocating a `Vector3(1, 0, 0)` per call.
 */
const LOCAL_X_AXIS = new THREE.Vector3(1, 0, 0);

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A kinematic reference frame on the fixture.
 *
 * Deliberately NOT an `extras.sockets` entry. Sockets are a mating vocabulary:
 * every `socket_type` must appear in `SOCKET_TYPES`, and the engine will try to
 * mate anything it finds there. A pan pivot is an internal axis, not a place
 * another asset connects, so it lives in its own block where the snapping
 * engine will not reach for it.
 */
export interface KinematicReference {
  readonly id: string;
  /** Local-space origin of the frame, metres, Three.js axes. */
  readonly position: readonly [number, number, number];
  /** Rotation axis for a pivot, or emission direction for the emitter. */
  readonly axis: readonly [number, number, number];
  readonly kind: 'pivot' | 'emitter';
}

/** Live DMX-driven state of one fixture instance. */
export interface FixtureChannelState {
  readonly panDegrees: number;
  readonly tiltDegrees: number;
  /** 0..1. */
  readonly dimmer: number;
  readonly color: THREE.Color;
}

/** What `instantiateFixture` hands back. */
export interface ResolvedFixtureInstance {
  readonly fixtureTypeId: string;
  readonly modeName: string;
  /** Scene-ready root. Add this to the scene. */
  readonly root: THREE.Group;
  readonly baseGroup: THREE.Group;
  readonly yokeGroup: THREE.Group;
  readonly headGroup: THREE.Group;
  readonly emitterGroup: THREE.Group;
  /**
   * The yoke pivot's orientation with pan at zero, i.e. the static basis its
   * `Position` matrix establishes. Driving pan post-multiplies a rotation onto
   * this, so anything solving an aim backwards from a wanted beam direction
   * needs the rest basis separately from the live quaternion.
   */
  readonly yokeRestQuaternion: THREE.Quaternion;
  /** The head pivot's orientation with tilt at zero. */
  readonly headRestQuaternion: THREE.Quaternion;
  readonly light: THREE.SpotLight;
  /** DMX channel footprint of the selected mode. */
  readonly footprint: number;
  /**
   * Drive the fixture from a universe buffer.
   *
   * `baseAddress` is the fixture's 1-indexed patch address. Returns the state
   * it resolved, so a HUD can display it without re-deriving anything.
   */
  updateDMXChannels(universe: Uint8Array, baseAddress?: number): FixtureChannelState;
  /** Release GPU resources held by this instance. */
  dispose(): void;
}

/** Thrown when a profile cannot be turned into a scene object. */
export class GDTFResolveError extends Error {
  constructor(message: string) {
    super(`[GDTFAssetResolver] ${message}`);
    this.name = 'GDTFResolveError';
  }
}

/* -------------------------------------------------------------------------- */
/* Photometry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Convert luminous flux to the luminous intensity Three.js wants.
 *
 * A `SpotLight` in physically-correct mode takes candela (lm/sr), but GDTF
 * publishes total flux in lumens, because that is what a photometric report
 * measures. Spreading the flux over the cone's solid angle converts one to the
 * other:
 *
 *     omega = 2 * pi * (1 - cos(half_angle))     steradians
 *     I     = flux / omega                       candela
 *
 * Handing the lumen figure to `intensity` directly -- the easy mistake -- makes
 * a narrow-beam fixture read as dim as a wash of the same wattage, which is
 * backwards.
 */
export function fluxToCandela(luminousFluxLumens: number, fieldAngleDegrees: number): number {
  if (luminousFluxLumens <= 0) return 0;

  const halfAngle = THREE.MathUtils.degToRad(Math.max(0.1, fieldAngleDegrees) / 2);
  const solidAngle = 2 * Math.PI * (1 - Math.cos(halfAngle));
  if (solidAngle <= 0) return 0;

  return luminousFluxLumens / solidAngle;
}

/**
 * Approximate a blackbody colour for a correlated colour temperature.
 *
 * Neil Bartlett's piecewise fit to the Planckian locus, accurate to about a
 * percent across 1000-40000 K -- far inside what a previz eye can resolve, and
 * far cheaper than a spectral integration per fixture.
 */
export function kelvinToColor(kelvin: number): THREE.Color {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
  }

  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  const clamp255 = (channel: number): number => Math.min(255, Math.max(0, channel)) / 255;
  return new THREE.Color(clamp255(r), clamp255(g), clamp255(b));
}

/**
 * Three.js penumbra from the GDTF beam/field pair.
 *
 * GDTF's `BeamAngle` is the hot spot and `FieldAngle` the 50%-output edge.
 * Three's `penumbra` is the fraction of the cone that is falloff, so the ratio
 * between them converts directly. A profile with beam >= field describes a hard
 * edge, which is penumbra 0.
 */
export function penumbraFrom(beam: GDTFBeam): number {
  const field = beam.fieldAngleDegrees > 0 ? beam.fieldAngleDegrees : DEFAULT_FIELD_ANGLE_DEGREES;
  if (beam.beamAngleDegrees <= 0) return 1;
  if (beam.beamAngleDegrees >= field) return 0;
  return Math.min(1, Math.max(0, 1 - beam.beamAngleDegrees / field));
}

/* -------------------------------------------------------------------------- */
/* Socket metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The fixture's truss clamp, in the `extras.sockets` spec shape.
 *
 * `PIPE_CLAMP_2IN` is the vocabulary's 2-inch (50.8 mm) clamp interface, which
 * is the standard truss boom diameter a moving head hangs from.
 *
 * `can_child: true` is what makes the fixture attachable: the snapping engine
 * gates reparenting on the MOVING socket's `can_child`, and a fixture dragged
 * onto truss is the moving side. `can_parent: false` because nothing hangs off
 * the clamp in turn.
 */
export function buildClampSocket(profile: GDTFProfile): SocketDefinition {
  const mass = estimateFixtureMassKg(profile);

  return {
    socket_id: CLAMP_SOCKET_ID,
    socket_type: 'PIPE_CLAMP_2IN',
    gender: 'MALE',
    transform: {
      // The clamp sits at the base geometry's origin, which GDTF defines as the
      // fixture's mounting plane.
      translation: [0, 0, 0],
      // Points up, out of the mounting face, toward the truss it mates with.
      normal: [0, 1, 0],
      up: [0, 0, -1],
    },
    tolerances: {
      snap_radius: SNAP_THRESHOLD_METERS,
      snap_angle: 15,
      detents_deg: [0, 90, 180, 270],
    },
    kinematic_rules: {
      can_parent: false,
      can_child: true,
      load_bearing: true,
      max_load_kg: mass,
    },
    tags: ['gdtf', 'fixture', 'clamp'],
  };
}

/**
 * Rough fixture mass from its base model envelope.
 *
 * GDTF does not publish mass, and the rigging solver needs a number to sum
 * against a truss span's rating. 250 kg/m^3 is the rough bulk density of a
 * moving head -- mostly air, housing and optics. Flagged via the `estimated`
 * tag on the socket so the solver can widen its safety factor.
 */
function estimateFixtureMassKg(profile: GDTFProfile): number {
  const base = profile.models[0];
  if (base === undefined) return 30;

  const volume = base.lengthMeters * base.widthMeters * base.heightMeters;
  if (volume <= 0) return 30;

  return Math.round(Math.min(120, Math.max(5, volume * 250)));
}

/** Pivot and emitter frames, recorded for inspection and for the beam renderer. */
export function buildKinematicReferences(profile: GDTFProfile): KinematicReference[] {
  const references: KinematicReference[] = [];
  const axes = findAxes(profile);

  // Outermost axis first: on a moving head that is pan, then tilt.
  const ids = [YOKE_PIVOT_ID, HEAD_PIVOT_ID];
  axes.slice(0, 2).forEach((axis, index) => {
    references.push({
      id: ids[index],
      position: axis.transform.translation,
      // GDTF axes rotate about their own local X.
      axis: [1, 0, 0],
      kind: 'pivot',
    });
  });

  const beam = findBeam(profile);
  if (beam !== null) {
    references.push({
      id: EMITTER_ID,
      position: beam.transform.translation,
      // GDTF emits along the geometry's -Z, which the parser has mapped to +Y.
      axis: [0, 1, 0],
      kind: 'emitter',
    });
  }

  return references;
}

/* -------------------------------------------------------------------------- */
/* Scene assembly                                                             */
/* -------------------------------------------------------------------------- */

/** Apply a parsed GDTF transform to a Three.js object. */
function applyTransform(object: THREE.Object3D, node: GDTFGeometryNode): void {
  const [tx, ty, tz] = node.transform.translation;
  object.position.set(tx, ty, tz);

  const b = node.transform.basis;
  if (b.length === 9) {
    const matrix = new THREE.Matrix4().set(
      b[0], b[3], b[6], 0,
      b[1], b[4], b[7], 0,
      b[2], b[5], b[8], 0,
      0, 0, 0, 1,
    );
    object.quaternion.setFromRotationMatrix(matrix);
  }
}

/**
 * Placeholder mesh for a model whose GLB the archive did not ship.
 *
 * A box at the model's declared envelope. Dimensionally honest even when the
 * mesh is missing, which is what matters for a sightline or clearance check --
 * the same trade the procedural asset library makes.
 */
function placeholderMesh(
  profile: GDTFProfile,
  modelName: string | null,
  material: THREE.Material,
): THREE.Mesh | null {
  if (modelName === null) return null;

  const model = profile.models.find((candidate) => candidate.name === modelName);
  if (model === undefined) return null;

  const width = model.widthMeters > 0 ? model.widthMeters : 0.2;
  const height = model.heightMeters > 0 ? model.heightMeters : 0.2;
  const length = model.lengthMeters > 0 ? model.lengthMeters : 0.2;

  // GDTF envelopes are Length(X) x Width(Y) x Height(Z) in its Z-up frame;
  // in Three's Y-up frame the height becomes the Y extent.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), material);
  mesh.name = `${modelName}_placeholder`;
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * In-memory index of parsed profiles, keyed by `FixtureTypeID`.
 *
 * A show patches many copies of a handful of fixture types. Parsing a 20 MB
 * archive once per instance would dominate load time, so the profile is parsed
 * once and every instance is assembled from the cached result.
 */
export class GDTFAssetResolver {
  readonly #profiles = new Map<string, GDTFProfile>();

  /** Register a parsed profile. Returns its `FixtureTypeID`. */
  register(profile: GDTFProfile): string {
    this.#profiles.set(profile.fixtureTypeId, profile);
    return profile.fixtureTypeId;
  }

  has(fixtureTypeId: string): boolean {
    return this.#profiles.has(fixtureTypeId);
  }

  get(fixtureTypeId: string): GDTFProfile | null {
    return this.#profiles.get(fixtureTypeId) ?? null;
  }

  /** Every registered `FixtureTypeID`. */
  get fixtureTypeIds(): string[] {
    return Array.from(this.#profiles.keys());
  }

  clear(): void {
    this.#profiles.clear();
  }

  /**
   * Build a scene-ready fixture.
   *
   * `modeName` selects a DMX mode; omitted, the profile's first mode is used,
   * which is the convention GDTF authors follow for the manufacturer default.
   */
  instantiateFixture(fixtureTypeId: string, modeName?: string): ResolvedFixtureInstance {
    const profile = this.#profiles.get(fixtureTypeId);
    if (profile === undefined) {
      throw new GDTFResolveError(
        `No profile registered for FixtureTypeID "${fixtureTypeId}". ` +
          `Registered: ${this.fixtureTypeIds.join(', ') || '(none)'}.`,
      );
    }

    const mode = findDmxMode(profile, modeName);
    if (mode === null) {
      throw new GDTFResolveError(
        `Profile "${profile.name}" has no DMX mode${modeName === undefined ? '' : ` named "${modeName}"`}. ` +
          `Available: ${profile.dmxModes.map((m) => m.name).join(', ') || '(none)'}.`,
      );
    }

    return assembleFixture(profile, mode);
  }
}

function assembleFixture(profile: GDTFProfile, mode: GDTFDmxMode): ResolvedFixtureInstance {
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  const housing = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.62, metalness: 0.25 });
  owned.push(housing);

  const root = new THREE.Group();
  root.name = `${profile.manufacturer} ${profile.name}`.trim();

  const baseGroup = new THREE.Group();
  baseGroup.name = 'base';
  const yokeGroup = new THREE.Group();
  yokeGroup.name = 'yoke';
  const headGroup = new THREE.Group();
  headGroup.name = 'head';
  const emitterGroup = new THREE.Group();
  emitterGroup.name = 'emitter';

  root.add(baseGroup);
  baseGroup.add(yokeGroup);
  yokeGroup.add(headGroup);
  headGroup.add(emitterGroup);

  const axes = findAxes(profile);
  const beamNode = findBeam(profile);

  if (profile.geometry !== null) {
    applyTransform(baseGroup, profile.geometry);
    const mesh = placeholderMesh(profile, profile.geometry.model, housing);
    if (mesh !== null) {
      baseGroup.add(mesh);
      owned.push(mesh.geometry);
    }
  }

  // Each pivot's orientation from its Position matrix, held aside from the
  // live quaternion. GDTF's Axis rotates about its OWN local X -- the X axis
  // of the frame this static basis establishes, not the parent's X axis -- so
  // driving pan/tilt has to compose a rotation on top of this basis, never
  // replace it. See the DMX composition note on `updateDMXChannels` below.
  const yokeStaticQuaternion = new THREE.Quaternion();
  const headStaticQuaternion = new THREE.Quaternion();
  const staticQuaternions = [yokeStaticQuaternion, headStaticQuaternion];

  const pivotGroups = [yokeGroup, headGroup];
  axes.slice(0, 2).forEach((axis, index) => {
    const group = pivotGroups[index];
    applyTransform(group, axis);
    group.userData.gdtfAxisName = axis.name;
    staticQuaternions[index].copy(group.quaternion);

    const mesh = placeholderMesh(profile, axis.model, housing);
    if (mesh !== null) {
      group.add(mesh);
      owned.push(mesh.geometry);
    }
  });

  const beam: GDTFBeam = beamNode?.beam ?? {
    lampType: 'Unknown',
    powerConsumptionWatts: 0,
    luminousFluxLumens: 0,
    colorTemperatureKelvin: 6000,
    beamAngleDegrees: 0,
    fieldAngleDegrees: DEFAULT_FIELD_ANGLE_DEGREES,
    beamRadiusMeters: 0,
    colorRenderingIndex: 100,
  };

  if (beamNode !== null) applyTransform(emitterGroup, beamNode);

  const fieldAngle = beam.fieldAngleDegrees > 0 ? beam.fieldAngleDegrees : DEFAULT_FIELD_ANGLE_DEGREES;
  const light = new THREE.SpotLight(
    kelvinToColor(beam.colorTemperatureKelvin),
    fluxToCandela(beam.luminousFluxLumens, fieldAngle),
    0, // no cutoff: the beam is bounded by decay, not by an arbitrary radius
    THREE.MathUtils.degToRad(fieldAngle / 2),
    penumbraFrom(beam),
    LIGHT_DECAY,
  );
  light.name = EMITTER_ID;

  // A SpotLight aims at its target, not along its own axis. Parenting the
  // target one metre ahead in the emitter frame makes the beam track the head
  // through pan and tilt with no per-frame aiming maths.
  light.target = new THREE.Object3D();
  light.target.position.set(0, 1, 0);
  emitterGroup.add(light);
  emitterGroup.add(light.target);

  root.userData.sockets = [buildClampSocket(profile)];
  root.userData.kinematics = buildKinematicReferences(profile);
  root.userData.gdtf = {
    fixtureTypeId: profile.fixtureTypeId,
    manufacturer: profile.manufacturer,
    name: profile.name,
    modeName: mode.name,
    footprint: mode.footprint,
    beam,
  };

  const panChannels = channelsForAttribute(mode, 'Pan');
  const tiltChannels = channelsForAttribute(mode, 'Tilt');
  const dimmerChannels = channelsForAttribute(mode, 'Dimmer');
  const redChannels = channelsForAttribute(mode, 'ColorAdd_R');
  const greenChannels = channelsForAttribute(mode, 'ColorAdd_G');
  const blueChannels = channelsForAttribute(mode, 'ColorAdd_B');

  const baseColor = kelvinToColor(beam.colorTemperatureKelvin);
  const peakIntensity = fluxToCandela(beam.luminousFluxLumens, fieldAngle);

  // Scratch instances, reused every frame. updateDMXChannels runs on the
  // telemetry tick for every patched fixture, so allocating here would put a
  // fresh Color or Quaternion in front of the collector 44 times a second per
  // fixture.
  const scratchColor = new THREE.Color();
  const scratchAxisRotation = new THREE.Quaternion();

  function updateDMXChannels(universe: Uint8Array, baseAddress = 1): FixtureChannelState {
    const panDegrees = resolvePhysical(panChannels, universe, baseAddress, 0);
    const tiltDegrees = resolvePhysical(tiltChannels, universe, baseAddress, 0);
    const dimmer = resolveNormalized(dimmerChannels, universe, baseAddress, 1);

    // Compose, never overwrite: `quaternion.x = angle` would stomp whatever
    // Euler decomposition Three derived from the static basis on the first
    // frame, which is only ever correct by accident (it happens to work when
    // that basis is a bare rotation about world Z, and silently produces the
    // wrong world-space orientation for anything else -- which is most real
    // GDTF axes, since a fixture's pan axis is rarely the parent's raw X).
    // Post-multiplying rotates about the pivot's OWN local X -- the axis DIN
    // SPEC 15800 6.4 actually means -- and leaves the static basis intact.
    scratchAxisRotation.setFromAxisAngle(LOCAL_X_AXIS, THREE.MathUtils.degToRad(panDegrees));
    yokeGroup.quaternion.copy(yokeStaticQuaternion).multiply(scratchAxisRotation);

    scratchAxisRotation.setFromAxisAngle(LOCAL_X_AXIS, THREE.MathUtils.degToRad(tiltDegrees));
    headGroup.quaternion.copy(headStaticQuaternion).multiply(scratchAxisRotation);

    if (redChannels.length > 0 || greenChannels.length > 0 || blueChannels.length > 0) {
      scratchColor.setRGB(
        resolveNormalized(redChannels, universe, baseAddress, 1),
        resolveNormalized(greenChannels, universe, baseAddress, 1),
        resolveNormalized(blueChannels, universe, baseAddress, 1),
      );
    } else {
      scratchColor.copy(baseColor);
    }

    light.color.copy(scratchColor);
    light.intensity = peakIntensity * dimmer;

    return { panDegrees, tiltDegrees, dimmer, color: scratchColor };
  }

  function dispose(): void {
    for (const resource of owned) resource.dispose();
    light.dispose();
  }

  return {
    fixtureTypeId: profile.fixtureTypeId,
    modeName: mode.name,
    root,
    baseGroup,
    yokeGroup,
    headGroup,
    emitterGroup,
    yokeRestQuaternion: yokeStaticQuaternion.clone(),
    headRestQuaternion: headStaticQuaternion.clone(),
    light,
    footprint: mode.footprint,
    updateDMXChannels,
    dispose,
  };
}

/**
 * Resolve a physical value (degrees, percent) from the first channel driving an
 * attribute.
 *
 * The channel function whose `dmxFrom` the reading falls into decides the
 * mapping -- that is how GDTF encodes a channel that means different things
 * across its range, such as a shutter that strobes above 32.
 */
function resolvePhysical(
  channels: readonly GDTFDmxChannel[],
  universe: Uint8Array,
  baseAddress: number,
  fallback: number,
): number {
  const channel = channels[0];
  if (channel === undefined) return fallback;

  const reading = readChannelValue(channel, universe, baseAddress);
  const normalized = normalizeDmx(reading.value, reading.resolution);

  const fn = selectFunction(channel, reading.value, reading.resolution);
  if (fn === null) return fallback;

  return physicalFromNormalized(fn, normalized);
}

/** Resolve a 0..1 reading, for attributes whose physical range is a fraction. */
function resolveNormalized(
  channels: readonly GDTFDmxChannel[],
  universe: Uint8Array,
  baseAddress: number,
  fallback: number,
): number {
  const channel = channels[0];
  if (channel === undefined) return fallback;

  const reading = readChannelValue(channel, universe, baseAddress);
  return normalizeDmx(reading.value, reading.resolution);
}

/**
 * The channel function covering a DMX reading.
 *
 * GDTF orders functions ascending by `DMXFrom` and each runs until the next
 * begins, so the match is the last one at or below the reading. Comparison is
 * done at a common resolution because a profile may write `DMXFrom` at 8-bit on
 * a 16-bit channel.
 */
function selectFunction(
  channel: GDTFDmxChannel,
  value: number,
  resolution: number,
): GDTFDmxChannel['functions'][number] | null {
  if (channel.functions.length === 0) return null;

  const reading = normalizeDmx(value, resolution);
  let selected = channel.functions[0];

  for (const fn of channel.functions) {
    if (normalizeDmx(fn.dmxFrom.value, fn.dmxFrom.resolution) <= reading) selected = fn;
    else break;
  }

  return selected;
}
