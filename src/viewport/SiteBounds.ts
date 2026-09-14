/**
 * Draws the georeferenced site envelope for Point State Park.
 *
 * Reads the GeoJSON in public/assets/scans/ -- the placeholder standing in for
 * a real scan -- and projects it into the local ENU scene frame. When a real
 * capture lands, this keeps working: the box is simply the site envelope, and
 * the scan renders inside it.
 */

import * as THREE from 'three';
import { SITE_FRAME } from '../geo/GeoAnchor.ts';

interface BoundsProperties {
  name?: string;
  kind?: string;
  base_height_m?: number;
  top_height_m?: number;
}

interface BoundsFeature {
  id?: string;
  properties?: BoundsProperties;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
}

export interface SiteBoundsResult {
  object: THREE.Group;
  label: string;
  /** Footprint extents in meters, east-west by north-south. */
  extents: { eastWest: number; northSouth: number } | null;
}

/** GeoJSON positions are [longitude, latitude]. */
function isLonLatRing(value: unknown): value is [number, number][] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(
      (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number',
    )
  );
}

export async function loadSiteBounds(url: string): Promise<SiteBoundsResult> {
  const group = new THREE.Group();
  group.name = 'SiteBounds';

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Site bounds fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { features?: BoundsFeature[] };
  const features = data.features ?? [];

  let label = 'Site bounds';
  let extents: SiteBoundsResult['extents'] = null;

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const geometry = feature.geometry ?? {};

    if (geometry.type === 'Polygon') {
      const rings = geometry.coordinates;
      if (!Array.isArray(rings) || !isLonLatRing(rings[0])) continue;
      const ring = rings[0];

      const baseHeight = properties.base_height_m ?? SITE_FRAME.origin.height;
      const topHeight = properties.top_height_m ?? baseHeight + 30;
      label = properties.name ?? label;

      // GeoJSON closes its rings by repeating the first position; drop it so
      // the line loop does not draw a zero-length segment.
      const open = ring.slice(0, -1);
      const toScene = (lon: number, lat: number, height: number) => {
        const [x, y, z] = SITE_FRAME.geodeticToScene({
          latitude: lat,
          longitude: lon,
          height,
        });
        return new THREE.Vector3(x, y, z);
      };

      const base = open.map(([lon, lat]) => toScene(lon, lat, baseHeight));
      const top = open.map(([lon, lat]) => toScene(lon, lat, topHeight));

      const points: THREE.Vector3[] = [];
      for (let i = 0; i < base.length; i++) {
        const next = (i + 1) % base.length;
        points.push(base[i]!, base[next]!); // base ring
        points.push(top[i]!, top[next]!); // top ring
        points.push(base[i]!, top[i]!); // vertical edge
      }

      const boxGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const box = new THREE.LineSegments(
        boxGeometry,
        new THREE.LineBasicMaterial({ color: 0x35d6a0, transparent: true, opacity: 0.55 }),
      );
      box.name = 'SiteBoundingVolume';
      group.add(box);

      // Report real ground extents so the HUD can state the site size.
      if (base.length >= 4) {
        const xs = base.map((v) => v.x);
        const zs = base.map((v) => v.z);
        extents = {
          eastWest: Math.max(...xs) - Math.min(...xs),
          northSouth: Math.max(...zs) - Math.min(...zs),
        };
      }
    }

    if (geometry.type === 'Point') {
      const coordinates = geometry.coordinates;
      if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number') continue;
      const [lon, lat] = coordinates as [number, number];
      const [x, y, z] = SITE_FRAME.geodeticToScene({
        latitude: lat,
        longitude: lon,
        height: SITE_FRAME.origin.height,
      });
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(3, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8 }),
      );
      marker.position.set(x, y + 6, z);
      marker.name = feature.id ?? 'landmark';
      group.add(marker);
    }
  }

  return { object: group, label, extents };
}
