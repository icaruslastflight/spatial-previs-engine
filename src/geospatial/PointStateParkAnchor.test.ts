/**
 * CP-1 geospatial checkpoint verification. Run with `npm test`.
 *
 * The substance lives in `runCp1SelfTest()` so the same checkpoint can be run
 * from the browser console on site, where the suite is not available. This file
 * surfaces each of its checks as an individual test case so a failure names the
 * check that broke rather than the whole checkpoint.
 */

import { describe, expect, it } from 'vitest';

import { runCp1SelfTest, WGS84_ORIGIN, ORIGIN_ELEVATION } from './PointStateParkAnchor.ts';

const report = runCp1SelfTest();

describe('[CP-1] Geospatial & Coordinate Origin Alignment', () => {
  it('anchors at Point State Park with an orthometric-to-ellipsoidal conversion', () => {
    expect(WGS84_ORIGIN.latitude).toBe(40.4417);
    expect(WGS84_ORIGIN.longitude).toBe(-80.0075);
    expect(ORIGIN_ELEVATION.orthometricMeters).toBe(220.0);
    // 220.0 m NAVD88, then GEOID18 (-33.82 m) to reach the NAD83 ellipsoid,
    // then the NAD83(2011) -> ITRF2014 frame offset (-1.217 m) to reach WGS84,
    // which is the frame Cesium and Google 3D Tiles actually consume.
    expect(ORIGIN_ELEVATION.geoidSeparationMeters).toBe(-33.82);
    expect(ORIGIN_ELEVATION.frameOffsetMeters).toBe(-1.217);
    expect(WGS84_ORIGIN.height).toBeCloseTo(184.963, 6);
  });

  it.each(report.checks.map((check) => [check.name, check] as const))(
    '%s',
    (_name, check) => {
      expect(check.passed, check.detail).toBe(true);
    },
  );

  it('reports the checkpoint as passing overall', () => {
    expect(report.passed).toBe(true);
  });
});
