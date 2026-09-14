/**
 * CP-1 geospatial checkpoint verification. Run with `npm test`.
 */

import { runCp1SelfTest, WGS84_ORIGIN, ORIGIN_ELEVATION } from './PointStateParkAnchor.ts';

console.log('\n[CP-1] Geospatial & Coordinate Origin Alignment');
console.log(
  `  anchor: ${WGS84_ORIGIN.latitude} N, ${WGS84_ORIGIN.longitude} E, ` +
    `${ORIGIN_ELEVATION.orthometricMeters} m MSL -> ${WGS84_ORIGIN.height.toFixed(1)} m ellipsoidal`,
);

const report = runCp1SelfTest();
for (const check of report.checks) {
  console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name}  (${check.detail})`);
}
console.log(report.passed ? '\nCP-1 CHECKS PASSED\n' : '\nCP-1 CHECKS FAILED\n');
process.exit(report.passed ? 0 : 1);
