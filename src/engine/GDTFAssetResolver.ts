/**
 * Runtime GDTF fixture resolver.
 *
 * Maintains an in-memory index of parsed GDTF profiles (keyed by
 * `FixtureTypeID`, the spec's own UUID) and instantiates them as Three.js
 * object hierarchies that mirror each profile's `Geometries` tree exactly:
 * one `THREE.Group` per geometry node, parented and positioned the way the
 * GDTF file describes, so pan/tilt articulation (Yoke -> Head) is real scene
 * graph nesting rather than a flattened mesh.
 *
 * Real manufacturer geometry needs a fetched-and-cached `.gdtf` archive
 * (`scripts/fetch_gdtf_library.js`, which needs a free GDTF Share account --
 * see CLAUDE.md §11). Until one is cached, every geometry node gets a
 * dimensionally-scaled placeholder box, same "dimensionally accurate,
 * visually placeholder" contract the procedural modular assets use (§9).
 *
 * Hard constraint 3 (embed `KHR_lights_punctual` into beam geometry): these
 * fixtures are built procedurally at runtime rather than round-tripped
 * through an authored glTF, so there is no glTF node to attach the KHR
 * extension to. A `THREE.SpotLight`, parameterized from the same photometric
 * attributes (`LuminousFlux`, `ColorTemperature`, `BeamAngle`) a real
 * `KHR_lights_punctual` spot node would carry, is the runtime equivalent:
 * Three's own GLTFLoader/Exporter round-trip an authored KHR spot node to
 * exactly a `THREE.SpotLight` and back, so this produces the same object the
 * extension would have produced, just constructed directly.
 */

import * as THREE from 'three';
import { writeSockets } from './SocketSnappingEngine.ts';
import { gdtfSpaceToThreeSpace, injectFixtureSockets } from './GDTFParser.ts';
import type { GdtfBeamProperties, GdtfFixtureType, GdtfGeometryNode } from './GDTFParser.ts';

/* -------------------------------------------------------------------------- */
/* Placeholder materials                                                      */
/* -------------------------------------------------------------------------- */

/** Matte fixture housing. Factory, not a shared singleton -- see ModularPrimitives.ts. */
function createFixtureBodyMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x1a1a1d, metalness: 0.6, roughness: 0.45 });
}

/** Lens/beam-emitting placeholder: faintly self-lit so a Beam node reads as the light source. */
function createFixtureLensMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xfff6e0,
    emissive: 0xfff6e0,
    emissiveIntensity: 0.6,
    metalness: 0,
    roughness: 0.15,
    transparent: true,
    opacity: 0.85,
  });
}

/** Generic placeholder edge length when a geometry node's Model is missing or dimensionless. */
const DEFAULT_DIMENSION_METERS = 0.2;

/* -------------------------------------------------------------------------- */
/* Photometry                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_BEAM_ANGLE_DEGREES = 25;
const DEFAULT_LUMINOUS_FLUX_LUMENS = 8000;
const DEFAULT_COLOR_TEMPERATURE_KELVIN = 6500;

/**
 * Total lumens -> candela (lm/sr) for `THREE.SpotLight.intensity`, which
 * Three's physically-correct lighting model consumes in candela, not lumens.
 * `LuminousFlux` is the fixture's TOTAL output; candela is that output
 * concentrated into the beam's actual solid angle, so a tight 8 deg beam
 * reads much brighter per-steradian than a wide 60 deg wash at equal lumens
 * -- which is exactly how real fixtures behave.
 */
export function luminousFluxToCandela(lumens: number, beamAngleDegrees: number): number {
  const halfAngleRadians = THREE.MathUtils.degToRad(beamAngleDegrees) / 2;
  const solidAngleSteradians = 2 * Math.PI * (1 - Math.cos(halfAngleRadians));
  // Guards a degenerate ~0 deg beam angle, which would otherwise divide by
  // ~0 and produce an absurd (or infinite) candela value.
  if (solidAngleSteradians < 1e-6) return lumens;
  return lumens / solidAngleSteradians;
}

/**
 * Approximate a blackbody color temperature as sRGB, for a fixture's
 * `ColorTemperature` attribute. Tanner Helland's widely-used curve fit over
 * Mitchell Charity's blackbody data -- not a rigorous CIE calculation, which
 * is more precision than a previz beam tint needs. Valid roughly
 * 1000 K-40000 K; stage fixtures sit around 2700-8000 K.
 */
export function colorTemperatureToRgb(kelvin: number): THREE.Color {
  const temp = THREE.MathUtils.clamp(kelvin, 1000, 40000) / 100;
  const clamp255 = (v: number) => THREE.MathUtils.clamp(v, 0, 255) / 255;

  const red = temp <= 66 ? 255 : 329.698727446 * Math.pow(temp - 60, -0.1332047592);
  const green =
    temp <= 66
      ? 99.4708025861 * Math.log(temp) - 161.1195681661
      : 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  const blue = temp >= 66 ? 255 : temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;

  return new THREE.Color(clamp255(red), clamp255(green), clamp255(blue));
}

/* -------------------------------------------------------------------------- */
/* Resolver                                                                    */
/* -------------------------------------------------------------------------- */

export class GDTFAssetResolver {
  private readonly profiles = new Map<string, GdtfFixtureType>();

  /** Index a parsed profile by its `FixtureTypeID`. Profiles without one are rejected. */
  registerProfile(profile: GdtfFixtureType): void {
    if (profile.fixtureTypeId.length === 0) {
      console.warn(`[GDTFAssetResolver] "${profile.name}" has no FixtureTypeID; not registered.`);
      return;
    }
    this.profiles.set(profile.fixtureTypeId, profile);
  }

  getProfile(fixtureTypeId: string): GdtfFixtureType | undefined {
    return this.profiles.get(fixtureTypeId);
  }

  get registeredProfiles(): readonly GdtfFixtureType[] {
    return [...this.profiles.values()];
  }

  /**
   * Build a fixture's Object3D hierarchy from its registered profile, with
   * `extras.sockets` (fixture clamp + yoke-axis pickups) already written onto
   * the root -- ready to hand straight to `SocketSnappingEngine.register()`.
   */
  instantiateFixture(fixtureTypeId: string): THREE.Object3D | null {
    const profile = this.profiles.get(fixtureTypeId);
    if (profile === undefined) {
      console.warn(`[GDTFAssetResolver] No profile registered for FixtureTypeID "${fixtureTypeId}".`);
      return null;
    }

    const root = new THREE.Group();
    root.name = profile.name;
    root.userData['gdtf'] = {
      fixtureTypeId: profile.fixtureTypeId,
      manufacturer: profile.manufacturer,
      name: profile.name,
    };

    for (const node of profile.geometries) {
      root.add(this.buildGeometryNode(node, profile));
    }

    writeSockets(root, injectFixtureSockets(profile));
    return root;
  }

  private buildGeometryNode(node: GdtfGeometryNode, profile: GdtfFixtureType): THREE.Object3D {
    const group = new THREE.Group();
    group.name = node.name;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    gdtfSpaceToThreeSpace(node.matrix).decompose(position, quaternion, scale);
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    // Scale intentionally not applied: GDTF Position matrices are rigid
    // transforms in practice, and non-uniform scale under a rotation is not
    // something SocketSnappingEngine.setWorldTransform supports either (see
    // its own doc comment) -- staying consistent with that existing,
    // documented limitation rather than introducing a new one here.

    group.add(this.buildPlaceholderMesh(node, profile));

    if (node.kind === 'Beam' && node.beam !== null) {
      group.add(this.buildBeamLight(node.beam));
    }

    for (const child of node.children) {
      group.add(this.buildGeometryNode(child, profile));
    }

    return group;
  }

  private buildPlaceholderMesh(node: GdtfGeometryNode, profile: GdtfFixtureType): THREE.Mesh {
    const model = profile.models.find((m) => m.name === node.model);
    const length = model !== undefined && model.lengthMeters > 0 ? model.lengthMeters : DEFAULT_DIMENSION_METERS;
    const width = model !== undefined && model.widthMeters > 0 ? model.widthMeters : DEFAULT_DIMENSION_METERS;
    const height = model !== undefined && model.heightMeters > 0 ? model.heightMeters : DEFAULT_DIMENSION_METERS;

    // Model dimensions are Length(X)/Width(Y)/Height(Z) in GDTF space,
    // bridged the same way geometry is: three.x=length, three.y=height (GDTF
    // Z is up), three.z=width.
    const geometry = new THREE.BoxGeometry(length, height, width);
    const material = node.kind === 'Beam' ? createFixtureLensMaterial() : createFixtureBodyMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = node.kind !== 'Beam';
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildBeamLight(beam: GdtfBeamProperties): THREE.SpotLight {
    const beamAngleDegrees = beam.beamAngleDegrees ?? DEFAULT_BEAM_ANGLE_DEGREES;
    const lumens = beam.luminousFluxLumens ?? DEFAULT_LUMINOUS_FLUX_LUMENS;
    const kelvin = beam.colorTemperatureKelvin ?? DEFAULT_COLOR_TEMPERATURE_KELVIN;

    const light = new THREE.SpotLight(
      colorTemperatureToRgb(kelvin),
      luminousFluxToCandela(lumens, beamAngleDegrees),
    );
    light.angle = THREE.MathUtils.degToRad(beamAngleDegrees) / 2; // SpotLight.angle is the HALF-angle.
    // GDTF has no independent inner/outer cone; penumbra approximates the
    // soft falloff between BeamAngle's hard core and FieldAngle's wider edge.
    light.penumbra = 0.35;
    light.distance = 30; // meters -- a showground-scale cutoff, not physically infinite reach.
    light.decay = 2; // physically correct inverse-square falloff.
    // No shadow map per fixture: a previz build can carry a dozen-plus
    // fixtures, and per-light shadow maps are not affordable on the phone
    // fill-rate budget this line targets (CLAUDE.md §1.3).
    light.castShadow = false;

    // Points along the Beam node's own local -Y (down, in Three-space): the
    // natural resting orientation for a yoke-mounted moving light at its
    // pan/tilt home position. GDTF does not fix which local axis a Beam's
    // optical axis follows independent of its Model's own authored geometry,
    // so this is a documented default, not a verified spec guarantee. The
    // target is parented to the light itself (not the fixture root) so the
    // beam direction stays fixed relative to the fixture's own geometry as
    // pan/tilt rotate the Head/Yoke chain above it.
    light.target.position.set(0, -1, 0);
    light.add(light.target);

    return light;
  }
}
