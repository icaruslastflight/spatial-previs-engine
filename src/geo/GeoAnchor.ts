/**
 * Geodetic anchoring for the Festival Visualizer.
 *
 * The Three.js scene is authored in a LOCAL ENU (East / North / Up) tangent plane
 * expressed in METERS, anchored at Point State Park. Everything the production
 * team places -- truss, decks, towers -- lives in that local frame, exactly as it
 * does in the Unreal Engine 5 desktop build. This module is the single source of
 * truth for converting between that local frame and WGS84 / ECEF.
 *
 * AXIS CONVENTION
 * ---------------
 * Geodesy uses a Z-up ENU triad. Three.js is Y-up and right-handed. The bridge is:
 *
 *     three.x = +East        east  = +three.x
 *     three.y = +Up          north = -three.z
 *     three.z = -North       up    = +three.y
 *
 * Keep every conversion inside this module so the convention is stated once.
 */

/** WGS84 semi-major axis (meters). */
const WGS84_A = 6378137.0;
/** WGS84 flattening. */
const WGS84_F = 1 / 298.257223563;
/** WGS84 first eccentricity squared. */
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;

const DEG2RAD = Math.PI / 180;

export interface Geodetic {
  /** Latitude in degrees, positive north. */
  latitude: number;
  /** Longitude in degrees, positive east (Pittsburgh is negative). */
  longitude: number;
  /** Height above the WGS84 ellipsoid, meters. */
  height: number;
}

/** A right-handed triple. Used for both ECEF and local-frame vectors. */
export type Vec3 = readonly [number, number, number];

/**
 * PROJECT ANCHOR -- Point State Park, Pittsburgh, PA.
 *
 * Confluence of the Allegheny and Monongahela into the Ohio. This constant is
 * mirrored verbatim in the UE5 georeferencing actor; changing it here without
 * changing it there breaks Strict Dual-Platform Parity.
 *
 * Longitude is stored SIGNED (80.0075 degrees WEST => -80.0075).
 */
export const POINT_STATE_PARK: Geodetic = {
  latitude: 40.4417,
  longitude: -80.0075,
  /**
   * Ellipsoidal height. Point State Park sits at roughly 219 m orthometric
   * (the Ohio River pool elevation at the Point is ~710 ft / 216 m). The
   * EGM96 geoid separation for western Pennsylvania is about -33 m, so the
   * ellipsoidal height is ~186 m.
   */
  height: 186.0,
};

/** Convert geodetic coordinates to earth-centered, earth-fixed (ECEF) meters. */
export function geodeticToEcef(geo: Geodetic): Vec3 {
  const lat = geo.latitude * DEG2RAD;
  const lon = geo.longitude * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  // Radius of curvature in the prime vertical.
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return [
    (n + geo.height) * cosLat * cosLon,
    (n + geo.height) * cosLat * sinLon,
    (n * (1 - WGS84_E2) + geo.height) * sinLat,
  ];
}

/**
 * An ENU tangent frame: the ECEF origin plus the three ECEF-expressed basis
 * vectors of the local East/North/Up triad.
 */
export class EnuFrame {
  readonly origin: Geodetic;
  readonly originEcef: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  readonly up: Vec3;

  constructor(origin: Geodetic) {
    this.origin = origin;
    this.originEcef = geodeticToEcef(origin);

    const lat = origin.latitude * DEG2RAD;
    const lon = origin.longitude * DEG2RAD;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);

    this.east = [-sinLon, cosLon, 0];
    this.north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
    this.up = [cosLat * cosLon, cosLat * sinLon, sinLat];
  }

  /** Local ENU meters (E, N, U) -> ECEF meters. */
  enuToEcef(enu: Vec3): Vec3 {
    const [e, n, u] = enu;
    return [
      this.originEcef[0] + this.east[0] * e + this.north[0] * n + this.up[0] * u,
      this.originEcef[1] + this.east[1] * e + this.north[1] * n + this.up[1] * u,
      this.originEcef[2] + this.east[2] * e + this.north[2] * n + this.up[2] * u,
    ];
  }

  /** ECEF meters -> local ENU meters (E, N, U). */
  ecefToEnu(ecef: Vec3): Vec3 {
    const dx = ecef[0] - this.originEcef[0];
    const dy = ecef[1] - this.originEcef[1];
    const dz = ecef[2] - this.originEcef[2];
    return [
      this.east[0] * dx + this.east[1] * dy + this.east[2] * dz,
      this.north[0] * dx + this.north[1] * dy + this.north[2] * dz,
      this.up[0] * dx + this.up[1] * dy + this.up[2] * dz,
    ];
  }

  /**
   * Rotate a local ENU DIRECTION (not a position) into ECEF.
   * Skips the origin translation.
   */
  enuDirectionToEcef(enu: Vec3): Vec3 {
    const [e, n, u] = enu;
    return [
      this.east[0] * e + this.north[0] * n + this.up[0] * u,
      this.east[1] * e + this.north[1] * n + this.up[1] * u,
      this.east[2] * e + this.north[2] * n + this.up[2] * u,
    ];
  }

  /** Geodetic -> Three.js scene coordinates (meters, Y-up). */
  geodeticToScene(geo: Geodetic): Vec3 {
    return enuToScene(this.ecefToEnu(geodeticToEcef(geo)));
  }
}

/** ENU (E, N, U) -> Three.js (x, y, z). See the axis convention above. */
export function enuToScene(enu: Vec3): Vec3 {
  return [enu[0], enu[2], -enu[1]];
}

/** Three.js (x, y, z) -> ENU (E, N, U). See the axis convention above. */
export function sceneToEnu(scene: Vec3): Vec3 {
  return [scene[0], -scene[2], scene[1]];
}

/** The project-wide tangent frame. Import this, do not build your own. */
export const SITE_FRAME = new EnuFrame(POINT_STATE_PARK);
