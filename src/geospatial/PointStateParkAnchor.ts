/**
 * Point State Park venue anchoring -- Divergence Checkpoint CP-1.
 *
 * CP-1 ("Geospatial & Coordinate Origin Alignment") requires that the free
 * development line and the full enterprise deployment share one world origin,
 * so that swapping Cesium ion asset IDs or upgrading to RTK-drone
 * photogrammetry never changes transform logic. This module is that shared
 * origin for the web client.
 *
 * It is the VENUE layer. The primitive geodesy -- WGS84/ECEF/ENU and the Z-up
 * to Y-up bridge -- lives in `src/geo/GeoAnchor.ts` and is imported, never
 * re-derived, per the parity rule in CLAUDE.md.
 */

import * as THREE from 'three';
import {
  SITE_FRAME,
  SITE_ELEVATION,
  POINT_STATE_PARK,
  geodeticToEcef,
  enuToScene,
} from '../geo/GeoAnchor.ts';
import type { Geodetic } from '../geo/GeoAnchor.ts';

/* -------------------------------------------------------------------------- */
/* Reference origin                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The venue's global WGS84 reference origin.
 *
 * Latitude 40.4417 N, Longitude 80.0075 W, elevation 220 m above mean sea
 * level. The elevation is stored ellipsoidally (184.963 m) because that is what
 * WGS84 and Cesium consume -- see SITE_ELEVATION for the datum arithmetic, which
 * takes both a geoid separation and a NAD83 -> WGS84 frame offset.
 */
export const WGS84_ORIGIN: Readonly<Geodetic> = Object.freeze({
  latitude: POINT_STATE_PARK.latitude,
  longitude: POINT_STATE_PARK.longitude,
  height: POINT_STATE_PARK.height,
});

/** The elevation figures behind WGS84_ORIGIN, both datums, for reporting. */
export const ORIGIN_ELEVATION = SITE_ELEVATION;

/**
 * The fountain at the tip of the Point -- the alignment landmark for CP-1.
 *
 * The basin sits at the confluence of the Allegheny and Monongahela, west of
 * the site origin. "Apex" is the top of the water column at full height: the
 * fountain throws roughly 46 m, and it is the one feature unambiguously
 * identifiable in both a mobile Gaussian splat capture and Google
 * Photorealistic 3D Tiles, which is exactly why it is the registration target.
 */
export const FOUNTAIN = {
  /** Centre of the fountain basin at ground level. */
  basin: Object.freeze({
    latitude: 40.4417,
    longitude: -80.0098,
    height: SITE_ELEVATION.ellipsoidalMeters,
  }) as Readonly<Geodetic>,
  /** Height of the water column above the basin, metres. */
  apexHeightMeters: 46.0,
} as const;

/** The fountain apex as a geodetic point. */
export const FOUNTAIN_APEX: Readonly<Geodetic> = Object.freeze({
  latitude: FOUNTAIN.basin.latitude,
  longitude: FOUNTAIN.basin.longitude,
  height: FOUNTAIN.basin.height + FOUNTAIN.apexHeightMeters,
});

/* -------------------------------------------------------------------------- */
/* Coordinate conversion                                                       */
/* -------------------------------------------------------------------------- */

/** Global WGS84 -> local Three.js / WebGPU Cartesian metres (Y-up). */
export function wgs84ToLocal(geodetic: Geodetic, target = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = SITE_FRAME.geodeticToScene(geodetic);
  return target.set(x, y, z);
}

/**
 * Local Three.js Cartesian metres -> global WGS84.
 *
 * Inverts the ellipsoidal forward conversion with Bowring's method, which
 * converges to well under a millimetre for near-surface points in a single
 * pass and avoids an iterative solve in the render loop.
 */
export function localToWgs84(local: THREE.Vector3): Geodetic {
  const enu: [number, number, number] = [local.x, -local.z, local.y];
  const [X, Y, Z] = SITE_FRAME.enuToEcef(enu);

  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = 2 * f - f * f;
  const ep2 = (a * a - b * b) / (b * b);

  const p = Math.hypot(X, Y);
  const theta = Math.atan2(Z * a, p * b);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const latitude = Math.atan2(
    Z + ep2 * b * sinTheta * sinTheta * sinTheta,
    p - e2 * a * cosTheta * cosTheta * cosTheta,
  );
  const longitude = Math.atan2(Y, X);
  const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) * Math.sin(latitude));
  const height = p / Math.cos(latitude) - n;

  return {
    latitude: THREE.MathUtils.radToDeg(latitude),
    longitude: THREE.MathUtils.radToDeg(longitude),
    height,
  };
}

/**
 * The 4x4 matrix taking local scene coordinates into earth-centred,
 * earth-fixed (ECEF) metres.
 *
 * Columns are the scene basis expressed in ECEF: scene +X is East, scene +Y is
 * Up, scene +Z is South (negative North). Hand this to any consumer that wants
 * to place the whole scene on the globe in one transform -- Cesium primitives,
 * a WebGPU compute pass, or a UE5 georeferencing actor.
 */
export function getLocalToEcefMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
  const { east, north, up, originEcef } = SITE_FRAME;
  // Matrix4.set takes row-major arguments.
  return target.set(
    east[0], up[0], -north[0], originEcef[0],
    east[1], up[1], -north[1], originEcef[1],
    east[2], up[2], -north[2], originEcef[2],
    0,       0,     0,         1,
  );
}

/** Inverse of {@link getLocalToEcefMatrix}. */
export function getEcefToLocalMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
  return getLocalToEcefMatrix(target).invert();
}

/* -------------------------------------------------------------------------- */
/* Scan alignment                                                              */
/* -------------------------------------------------------------------------- */

export interface ScanAlignmentOptions {
  /**
   * Where the scan's own local origin sits in the real world. Mobile capture
   * apps (Scaniverse, Polycam, Luma) emit a scan-local frame whose origin is
   * wherever the operator started walking, so this is the surveyed or
   * eyeballed geodetic position of that point.
   *
   * Defaults to the fountain apex, the CP-1 registration landmark.
   */
  scanOrigin?: Geodetic;
  /**
   * Heading of the scan's +Z axis, degrees clockwise from true north.
   *
   * Mobile captures inherit the device compass, which is routinely tens of
   * degrees off near the steel and rebar of a park pavilion, so this is the
   * knob that actually gets turned during registration.
   */
  headingDegrees?: number;
  /** Uniform scale. Metric captures are 1.0; leave it unless the scan drifted. */
  scale?: number;
  /** Residual nudge in local scene metres, applied after rotation and scale. */
  offsetMeters?: THREE.Vector3;
}

/**
 * Build the transform that drops a captured scan onto the basemap.
 *
 * Composition order is scale, then heading about the vertical axis, then
 * translation to the georeferenced origin, then the manual nudge. Heading is
 * applied about Y (scene up) and negated because compass bearings run clockwise
 * from north while Three.js rotations are counter-clockwise about +Y.
 */
export function createScanAlignmentMatrix(
  options: ScanAlignmentOptions = {},
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  const scanOrigin = options.scanOrigin ?? FOUNTAIN_APEX;
  const heading = THREE.MathUtils.degToRad(options.headingDegrees ?? 0);
  const scale = options.scale ?? 1.0;

  const translation = wgs84ToLocal(scanOrigin);
  if (options.offsetMeters !== undefined) translation.add(options.offsetMeters);

  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
  return target.compose(translation, rotation, new THREE.Vector3(scale, scale, scale));
}

/**
 * Apply the alignment to a loaded scan object in place.
 * Returns the object so it can be chained into a scene graph.
 */
export function alignScanToVenue<T extends THREE.Object3D>(
  scan: T,
  options: ScanAlignmentOptions = {},
): T {
  const matrix = createScanAlignmentMatrix(options);
  matrix.decompose(scan.position, scan.quaternion, scan.scale);
  scan.updateMatrixWorld(true);
  return scan;
}

/* -------------------------------------------------------------------------- */
/* CP-1 kink-isolation test                                                    */
/* -------------------------------------------------------------------------- */

export interface Cp1Report {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

/**
 * CP-1 kink-isolation test.
 *
 * The checkpoint calls for verifying coordinate accuracy by overlaying
 * open-source data against Google 3D Tiles. Tile imagery needs a network and a
 * key, so what is verified here is the half that must hold before any overlay
 * is meaningful: that the transform chain is self-consistent, that the datum
 * arithmetic is right, and that the fountain lands where it should relative to
 * the origin. A tile overlay on a wrong transform tells you nothing.
 */
export function runCp1SelfTest(): Cp1Report {
  const checks: Cp1Report['checks'] = [];
  const record = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail });

  // 1. Round trip through the local frame must be sub-millimetre.
  const probe: Geodetic = { latitude: 40.4425, longitude: -80.0101, height: 200 };
  const round = localToWgs84(wgs84ToLocal(probe));
  const latErr = Math.abs(round.latitude - probe.latitude) * 111320;
  const lonErr =
    Math.abs(round.longitude - probe.longitude) * 111320 * Math.cos(THREE.MathUtils.degToRad(probe.latitude));
  const hErr = Math.abs(round.height - probe.height);
  const worst = Math.max(latErr, lonErr, hErr);
  record('WGS84 round trip', worst < 1e-3, `worst error ${(worst * 1000).toFixed(4)} mm`);

  // 2. The origin must sit at the local origin.
  const originLocal = wgs84ToLocal(WGS84_ORIGIN);
  record('origin maps to (0,0,0)', originLocal.length() < 1e-6,
    `|p| = ${originLocal.length().toExponential(2)} m`);

  // 3. Datum arithmetic: 220 m MSL must become 184.963 m WGS84 ellipsoidal,
  //    via the GEOID18 separation AND the NAD83 -> ITRF2014 frame offset.
  //    Derived from the constants rather than hard-coded, so this checks the
  //    arithmetic wiring; the numbers themselves are sourced in GeoAnchor.ts.
  const expected =
    ORIGIN_ELEVATION.orthometricMeters +
    ORIGIN_ELEVATION.geoidSeparationMeters +
    ORIGIN_ELEVATION.frameOffsetMeters;
  record('orthometric -> ellipsoidal', Math.abs(ORIGIN_ELEVATION.ellipsoidalMeters - expected) < 1e-9,
    `${ORIGIN_ELEVATION.orthometricMeters} m MSL -> ${ORIGIN_ELEVATION.ellipsoidalMeters.toFixed(3)} m ellipsoidal`);

  // 3b. Guard the absolute value too: a sign flip on either correction still
  //     satisfies the check above, and both have been got backwards before.
  record('ellipsoidal height is 184.963 m',
    Math.abs(ORIGIN_ELEVATION.ellipsoidalMeters - 184.963) < 1e-3,
    `${ORIGIN_ELEVATION.ellipsoidalMeters.toFixed(3)} m`);

  // 4. The fountain lies west of origin (-X) and its apex is 46 m up.
  const basin = wgs84ToLocal(FOUNTAIN.basin);
  const apex = wgs84ToLocal(FOUNTAIN_APEX);
  record('fountain is west of origin', basin.x < 0, `x = ${basin.x.toFixed(1)} m`);
  record('fountain apex is 46 m above basin', Math.abs(apex.y - basin.y - 46.0) < 0.01,
    `dy = ${(apex.y - basin.y).toFixed(3)} m`);

  // 5. The ECEF matrix must agree with the scalar path.
  const viaMatrix = new THREE.Vector3(basin.x, basin.y, basin.z).applyMatrix4(getLocalToEcefMatrix());
  const direct = geodeticToEcef(FOUNTAIN.basin);
  const matrixErr = Math.hypot(viaMatrix.x - direct[0], viaMatrix.y - direct[1], viaMatrix.z - direct[2]);
  record('local->ECEF matrix matches scalar path', matrixErr < 1e-6,
    `delta ${matrixErr.toExponential(2)} m`);

  // 6. A scan aligned with defaults must land on the fountain apex.
  const aligned = new THREE.Vector3().setFromMatrixPosition(createScanAlignmentMatrix());
  const apexErr = aligned.distanceTo(apex);
  record('default scan alignment lands on fountain apex', apexErr < 1e-6,
    `delta ${apexErr.toExponential(2)} m`);

  return { passed: checks.every((c) => c.passed), checks };
}

/** Convenience for the console: local scene position of the venue landmarks. */
export const VENUE_LANDMARKS = {
  origin: () => wgs84ToLocal(WGS84_ORIGIN),
  fountainBasin: () => wgs84ToLocal(FOUNTAIN.basin),
  fountainApex: () => wgs84ToLocal(FOUNTAIN_APEX),
} as const;

/** Re-exported so callers need only one import for scene-space conversions. */
export { enuToScene };
