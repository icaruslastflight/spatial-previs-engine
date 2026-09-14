/**
 * Geodetic anchoring checks.
 *
 * Everything georeferenced -- the Cesium camera sync, the site bounds, splat
 * placement -- rides on these conversions, and a sign error here is invisible
 * until the whole site is in the wrong hemisphere. Run with `npm test`.
 */

import {
  SITE_FRAME,
  POINT_STATE_PARK,
  geodeticToEcef,
  enuToScene,
  sceneToEnu,
} from './GeoAnchor.ts';
import type { Vec3 } from './GeoAnchor.ts';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label} ${detail}`);
    failures++;
  }
}
const approx = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) < tol;
const magnitude = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

console.log('\n[1] Anchor and frame origin');
{
  const atOrigin = SITE_FRAME.ecefToEnu(geodeticToEcef(POINT_STATE_PARK));
  check('anchor maps to local origin', magnitude(atOrigin) < 1e-6, `(got ${magnitude(atOrigin)})`);

  // Pittsburgh is in the western hemisphere; a positive longitude would put the
  // site in Central Asia. At ~80 deg W the giveaway is ECEF y: the y axis points
  // at 90 deg E, so a western longitude drives it negative. (x stays positive
  // but small, because cos(-80 deg) is positive -- an easy sign trap.)
  const ecef = geodeticToEcef(POINT_STATE_PARK);
  check('longitude is signed west (ECEF y < 0)', ecef[1] < 0, `(y=${ecef[1].toFixed(0)})`);
  check('|ECEF y| >> |ECEF x| near 80 deg W', Math.abs(ecef[1]) > Math.abs(ecef[0]) * 4,
        `(x=${ecef[0].toFixed(0)}, y=${ecef[1].toFixed(0)})`);
  check('northern hemisphere (ECEF z > 0)', ecef[2] > 0, `(z=${ecef[2].toFixed(0)})`);
  // Sanity: the point must lie on the earth's surface, not in orbit.
  check('geocentric radius is plausible', Math.abs(magnitude(ecef) - 6371000) < 25000,
        `(r=${magnitude(ecef).toFixed(0)} m)`);
}

console.log('\n[2] ENU <-> ECEF round trip');
{
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
  check('round trip is exact to sub-micron', worst < 1e-6, `(worst ${worst.toExponential(2)} m)`);

  // Basis vectors must be orthonormal or distances shear.
  const dots = [
    Math.abs(SITE_FRAME.east[0] * SITE_FRAME.north[0] + SITE_FRAME.east[1] * SITE_FRAME.north[1] + SITE_FRAME.east[2] * SITE_FRAME.north[2]),
    Math.abs(SITE_FRAME.east[0] * SITE_FRAME.up[0] + SITE_FRAME.east[1] * SITE_FRAME.up[1] + SITE_FRAME.east[2] * SITE_FRAME.up[2]),
    Math.abs(SITE_FRAME.north[0] * SITE_FRAME.up[0] + SITE_FRAME.north[1] * SITE_FRAME.up[1] + SITE_FRAME.north[2] * SITE_FRAME.up[2]),
  ];
  check('ENU basis is orthogonal', Math.max(...dots) < 1e-12, `(worst dot ${Math.max(...dots).toExponential(2)})`);
  check('ENU basis is unit length',
    approx(magnitude(SITE_FRAME.east), 1, 1e-12) &&
    approx(magnitude(SITE_FRAME.north), 1, 1e-12) &&
    approx(magnitude(SITE_FRAME.up), 1, 1e-12));
}

console.log('\n[3] Three.js Y-up axis bridge');
{
  // three.x = +East, three.y = +Up, three.z = -North
  const enu: Vec3 = [3, 5, 7]; // east 3, north 5, up 7
  const scene = enuToScene(enu);
  check('east  -> +x', approx(scene[0], 3));
  check('up    -> +y', approx(scene[1], 7));
  check('north -> -z', approx(scene[2], -5), `(got ${scene[2]})`);

  const back = sceneToEnu(scene);
  check('scene -> ENU is the exact inverse',
    approx(back[0], enu[0]) && approx(back[1], enu[1]) && approx(back[2], enu[2]));
}

console.log('\n[4] Real-world bearings from the anchor');
{
  const d = 0.001; // degrees

  const north = SITE_FRAME.geodeticToScene({
    latitude: POINT_STATE_PARK.latitude + d,
    longitude: POINT_STATE_PARK.longitude,
    height: POINT_STATE_PARK.height,
  });
  // Going north must move -Z, roughly 111 m per 0.001 deg of latitude.
  check('north of anchor is -z', north[2] < 0, `(z=${north[2].toFixed(2)})`);
  check('0.001 deg lat is ~111 m', Math.abs(Math.abs(north[2]) - 111) < 3,
        `(got ${Math.abs(north[2]).toFixed(2)} m)`);

  const east = SITE_FRAME.geodeticToScene({
    latitude: POINT_STATE_PARK.latitude,
    longitude: POINT_STATE_PARK.longitude + d,
    height: POINT_STATE_PARK.height,
  });
  // At 40.44 deg N a degree of longitude is cos(lat) shorter: ~84.6 m.
  check('east of anchor is +x', east[0] > 0, `(x=${east[0].toFixed(2)})`);
  check('0.001 deg lon is ~84.6 m at this latitude', Math.abs(east[0] - 84.6) < 3,
        `(got ${east[0].toFixed(2)} m)`);

  const up = SITE_FRAME.geodeticToScene({
    latitude: POINT_STATE_PARK.latitude,
    longitude: POINT_STATE_PARK.longitude,
    height: POINT_STATE_PARK.height + 50,
  });
  check('+50 m height is +50 m in y', approx(up[1], 50, 1e-3), `(got ${up[1].toFixed(6)})`);
}

console.log(failures === 0 ? '\nGEO CHECKS PASSED\n' : `\n${failures} GEO CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
