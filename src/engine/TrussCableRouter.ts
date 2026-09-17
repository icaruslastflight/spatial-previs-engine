import * as THREE from 'three';
import type { ProductionProject, AssetInstance, Port } from '../domain/ProductionProject.ts';

export interface CableRoute {
  connectionId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  points: THREE.Vector3[];
  length: number;
  domain: string;
}

export class TrussCableRouter {
  
  /**
   * Routes all logical connections through the mechanical attachment graph using A*.
   * Returns a collection of routed cables with Catmull-Rom spline control points.
   */
  static routeCables(project: ProductionProject): CableRoute[] {
    const instances = new Map<string, AssetInstance>();
    const ports = new Map<string, Port>();
    const adj = new Map<string, string[]>(); // Graph of instanceId -> connected instanceIds

    for (const record of project.records) {
      if (record.kind === 'asset_instance') {
        instances.set(record.id, record);
        adj.set(record.id, []);
      } else if (record.kind === 'port') {
        ports.set(record.id, record);
      }
    }

    // Build the mechanical attachment graph
    for (const record of project.records) {
      if (record.kind === 'mechanical_attachment') {
        const parentId = record.parentInstanceId;
        const childId = record.childInstanceId;
        if (adj.has(parentId) && adj.has(childId)) {
          adj.get(parentId)!.push(childId);
          adj.get(childId)!.push(parentId);
        }
      }
    }

    const routes: CableRoute[] = [];

    // Find paths for all connections
    for (const record of project.records) {
      if (record.kind === 'connection') {
        const sourcePort = ports.get(record.sourcePortId);
        const targetPort = ports.get(record.targetPortId);

        if (!sourcePort || !targetPort) continue;

        const sourceInstanceId = sourcePort.instanceId;
        const targetInstanceId = targetPort.instanceId;

        if (sourceInstanceId === targetInstanceId) continue; // Internal connection
        
        const path = this.findPathAStar(sourceInstanceId, targetInstanceId, instances, adj);
        
        if (path.length > 0) {
          const points = path.map(id => {
            const inst = instances.get(id)!;
            return new THREE.Vector3(
              inst.transform.position[0],
              inst.transform.position[1],
              inst.transform.position[2]
            );
          });
          
          let length = 0;
          for (let i = 0; i < points.length - 1; i++) {
            length += points[i].distanceTo(points[i+1]);
          }

          routes.push({
            connectionId: record.id,
            sourceInstanceId,
            targetInstanceId,
            points,
            length,
            domain: record.domain
          });
        }
      }
    }

    return routes;
  }

  private static findPathAStar(
    start: string,
    goal: string,
    instances: Map<string, AssetInstance>,
    adj: Map<string, string[]>
  ): string[] {
    const openSet = new Set<string>([start]);
    const cameFrom = new Map<string, string>();

    const gScore = new Map<string, number>();
    gScore.set(start, 0);

    const fScore = new Map<string, number>();
    fScore.set(start, this.distance(start, goal, instances));

    while (openSet.size > 0) {
      // Find node with lowest fScore in openSet
      let current = '';
      let minF = Infinity;
      for (const nodeId of openSet) {
        const score = fScore.get(nodeId) ?? Infinity;
        if (score < minF) {
          minF = score;
          current = nodeId;
        }
      }

      if (current === goal) {
        return this.reconstructPath(cameFrom, current);
      }

      openSet.delete(current);

      const neighbors = adj.get(current) || [];
      for (const neighbor of neighbors) {
        const tentativeGScore = (gScore.get(current) ?? Infinity) + this.distance(current, neighbor, instances);
        
        if (tentativeGScore < (gScore.get(neighbor) ?? Infinity)) {
          cameFrom.set(neighbor, current);
          gScore.set(neighbor, tentativeGScore);
          fScore.set(neighbor, tentativeGScore + this.distance(neighbor, goal, instances));
          openSet.add(neighbor);
        }
      }
    }

    // Path not found through truss graph, fallback to direct line
    return [start, goal];
  }

  private static distance(a: string, b: string, instances: Map<string, AssetInstance>): number {
    const instA = instances.get(a);
    const instB = instances.get(b);
    if (!instA || !instB) return Infinity;
    
    const posA = instA.transform.position;
    const posB = instB.transform.position;
    
    const dx = posA[0] - posB[0];
    const dy = posA[1] - posB[1];
    const dz = posA[2] - posB[2];
    
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  private static reconstructPath(cameFrom: Map<string, string>, current: string): string[] {
    const totalPath = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      totalPath.unshift(current);
    }
    return totalPath;
  }
}
