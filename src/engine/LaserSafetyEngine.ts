import { Vector3, Box3, Ray, Quaternion } from 'three';
import type { ProductionProject } from '../domain/ProductionProject.ts';

export interface LaserSafetyViolation {
  laserInstanceId: string;
  zoneId: string;
  intersectionPoint: [number, number, number];
  elevation: number;
}

/**
 * Laser MPE (Maximum Permissible Exposure) Safety Engine
 * Evaluates laser beams against audience bounding boxes to detect intersections
 * below the 2.5m safety elevation threshold.
 */
export class LaserSafetyEngine {
  static readonly MPE_ELEVATION_THRESHOLD = 2.5; // meters

  public evaluateProject(project: ProductionProject): LaserSafetyViolation[] {
    const violations: LaserSafetyViolation[] = [];
    
    const lasers = project.records.filter(r => 
      r.kind === 'asset_instance' && 
      project.records.some(def => def.id === r.definitionId && def.kind === 'asset_definition' && (def.category === 'Laser' || (def as any).catalogId?.includes('laser')))
    ) as any[];

    const audienceZones = project.records.filter(r => r.kind === 'zone' && r.role === 'audience') as any[];

    for (const laser of lasers) {
      // Get laser world transform
      const origin = new Vector3(...(laser.transform?.position ?? [0, 0, 0]));
      
      // Assume laser shoots 'forward' in local -Z or +Y depending on orientation.
      // Standard moving head laser typically shoots along local -Z or +Y. We'll use local -Z (0, 0, -1) mapped to world.
      const quaternion = laser.transform?.rotation ?? [0, 0, 0, 1];
      const direction = new Vector3(0, 0, -1).applyQuaternion(new (Quaternion as any)(...quaternion)).normalize();
      const ray = new Ray(origin, direction);

      for (const zone of audienceZones) {
        // Construct zone bounding box. Zones have width/height/depth or shape properties.
        const zPos = new Vector3(...(zone.transform?.position ?? [0, 0, 0]));
        // Simplified AABB for the audience zone (typically width/depth on X/Z plane)
        // Audience zones have X/Z dimensions. We assume 3m height.
        const extents = new Vector3(zone.width ?? 10, 3, zone.depth ?? 10).multiplyScalar(0.5);
        const box = new Box3(zPos.clone().sub(extents), zPos.clone().add(extents));
        
        const intersection = new Vector3();
        if (ray.intersectBox(box, intersection)) {
          // Check if intersection is below 2.5m elevation
          // Assuming world Y is up
          if (intersection.y < LaserSafetyEngine.MPE_ELEVATION_THRESHOLD) {
            violations.push({
              laserInstanceId: laser.id,
              zoneId: zone.id,
              intersectionPoint: [intersection.x, intersection.y, intersection.z],
              elevation: intersection.y
            });
          }
        }
      }
    }

    return violations;
  }
}
