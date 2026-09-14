/**
 * Geodetic anchoring checks.
 *
 * Everything georeferenced -- the Cesium camera sync, the site bounds, splat
 * placement -- rides on these conversions, and a sign error here is invisible
 * until the whole site is in the wrong hemisphere. Run with `npm test`.
 */

import { describe, expect, it } from 'vitest';

import {
  SITE_FRAME,
  POINT_STATE_PARK,
  geodeticToEcef,
  enuToScene,
  sceneToEnu,
} from './GeoAnchor.ts';
import type { Vec3 } from './GeoAnchor.ts';

const magnitude = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('[1] Anchor and frame origin', () => {
  it('maps the anchor to the local origin', () => {
    const atOrigin = SITE_FRAME.ecefToEnu(geodeticToEcef(POINT_STATE_PARK));
    expect(magnitude(atOrigin)).toBeLessThan(1e-6);
  });

  it('stores longitude signed west', () => {
    // Pittsburgh is in the western hemisphere; a positive longitude would put
    // the site in Central Asia. At ~80 deg W the giveaway is ECEF y: the y axis
    // points at 90 deg E, so a western longitude drives it negative. (x stays
    // positive but small, because cos(-80 deg) is positive -- an easy sign trap.)
    const ecef = geodeticToEcef(POINT_STATE_PARK);
    expect(ecef[1]).toBeLessThan(0);
    expect(Math.abs(ecef[1])).toBeGreaterThan(Math.abs(ecef[0]) * 4);
  });

  it('places the anchor in the northern hemisphere', () => {
    expect(geodeticToEcef(POINT_STATE_PARK)[2]).toBeGreaterThan(0);
  });

  it('puts the anchor on the earth surface, not in orbit', () => {
    expect(Math.abs(magnitude(geodeticToEcef(POINT_STATE_PARK)) - 6371000)).toBeLessThan(25000);
  });
});

describe('[2] ENU <-> ECEF round trip', () => {
  it('round trips to sub-micron', () => {
    const samples: Vec3[] = [
      [0, 0, 0],
      [250, -180, 35],
      [-1200, 900, -60],
      [12.5, 7.25, 3.125],
    ];
    let worst = 0;
    for (const enu of samples) {
      const back = SITE_FRAME.ecefToEnu(SITE_FRAME.enuToEcef(enu));
      worst = Math.max(worst, Math.hypot(back[0] - enu[0], back[1] - enu[1], back[2] - enu[2]));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('keeps the ENU basis orthogonal', () => {
    // Basis vectors must be orthonormal or distances shear.
    const worstDot = Math.max(
      Math.abs(dot(SITE_FRAME.east, SITE_FRAME.north)),
      Math.abs(dot(SITE_FRAME.east, SITE_FRAME.up)),
      Math.abs(dot(SITE_FRAME.north, SITE_FRAME.up)),
    );
    expect(worstDot).toBeLessThan(1e-12);
  });

  it('keeps the ENU basis unit length', () => {
    expect(magnitude(SITE_FRAME.east)).toBeCloseTo(1, 12);
    expect(magnitude(SITE_FRAME.north)).toBeCloseTo(1, 12);
    expect(magnitude(SITE_FRAME.up)).toBeCloseTo(1, 12);
  });
});

describe('[3] Three.js Y-up axis bridge', () => {
  // three.x = +East, three.y = +Up, three.z = -North
  const enu: Vec3 = [3, 5, 7]; // east 3, north 5, up 7

  it('maps east to +x, up to +y and north to -z', () => {
    const scene = enuToScene(enu);
    expect(scene[0]).toBeCloseTo(3, 6);
    expect(scene[1]).toBeCloseTo(7, 6);
    expect(scene[2]).toBeCloseTo(-5, 6);
  });

  it('inverts exactly', () => {
    const back = sceneToEnu(enuToScene(enu));
    expect(back[0]).toBeCloseTo(enu[0], 6);
    expect(back[1]).toBeCloseTo(enu[1], 6);
    expect(back[2]).toBeCloseTo(enu[2], 6);
  });
});

describe('[4] Real-world bearings from the anchor', () => {
  const d = 0.001; // degrees

  it('puts north of the anchor at -z, ~111 m per 0.001 deg of latitude', () => {
    const north = SITE_FRAME.geodeticToScene({
      latitude: POINT_STATE_PARK.latitude + d,
      longitude: POINT_STATE_PARK.longitude,
      height: POINT_STATE_PARK.height,
    });
    expect(north[2]).toBeLessThan(0);
    expect(Math.abs(Math.abs(north[2]) - 111)).toBeLessThan(3);
  });

  it('puts east of the anchor at +x, ~84.6 m per 0.001 deg of longitude', () => {
    // At 40.44 deg N a degree of longitude is cos(lat) shorter: ~84.6 m.
    const east = SITE_FRAME.geodeticToScene({
      latitude: POINT_STATE_PARK.latitude,
      longitude: POINT_STATE_PARK.longitude + d,
      height: POINT_STATE_PARK.height,
    });
    expect(east[0]).toBeGreaterThan(0);
    expect(Math.abs(east[0] - 84.6)).toBeLessThan(3);
  });

  it('maps +50 m of ellipsoidal height to +50 m in y', () => {
    const up = SITE_FRAME.geodeticToScene({
      latitude: POINT_STATE_PARK.latitude,
      longitude: POINT_STATE_PARK.longitude,
      height: POINT_STATE_PARK.height + 50,
    });
    expect(up[1]).toBeCloseTo(50, 3);
  });
});
