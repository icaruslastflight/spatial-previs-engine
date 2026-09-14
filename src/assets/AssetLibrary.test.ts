/**
 * End-to-end check across the asset pipeline.
 *
 * Reads the GLB files the build script produced, pulls `extras.sockets` back
 * out of them, feeds those through the engine's normalizer and then actually
 * snaps two real library assets together. This is the join that matters: a
 * socket schema that validates in the generator but does not drive the engine
 * is worth nothing, and nothing else in the suite crosses that boundary.
 */

import { NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  SocketSnappingEngine,
  normalizeSocket,
  writeSockets,
} from '../engine/SocketSnappingEngine.ts';
import type { SocketDefinition } from '../engine/SocketSnappingEngine.ts';

interface ManifestAsset {
  id: string;
  category: string;
  url: string;
  triangles: number;
  socket_ids: string[];
  dimensions: { meters: number[] };
}
interface Manifest {
  totals: { assets: number; sockets: number };
  budgets: { max_lod0_triangles: number };
  assets: ManifestAsset[];
}

const root = resolve(process.cwd());
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/assets/manifest.json'), 'utf8'),
) as Manifest;

const io = new NodeIO();

/** Pull the socket array back out of a built GLB. */
async function readAssetSockets(asset: ManifestAsset): Promise<SocketDefinition[]> {
  const doc = await io.read(resolve(root, 'public', asset.url));
  const node = doc.getRoot().listNodes().find((n) => n.getName() === asset.id);
  const extras = (node?.getExtras() ?? {}) as { sockets?: SocketDefinition[] };
  return extras.sockets ?? [];
}

/** Rebuild a bare Object3D carrying a library asset's real sockets. */
async function spawn(id: string): Promise<THREE.Object3D> {
  const asset = manifest.assets.find((a) => a.id === id);
  if (asset === undefined) throw new Error(`asset ${id} missing from manifest`);
  const object = new THREE.Object3D();
  object.name = id;
  writeSockets(object, await readAssetSockets(asset));
  return object;
}

describe('[1] Manifest integrity', () => {
  it('lists assets', () => {
    expect(manifest.assets.length).toBeGreaterThan(0);
  });

  it('matches its own totals', () => {
    expect(manifest.totals.assets).toBe(manifest.assets.length);
  });

  it('covers all 7 taxonomy categories', () => {
    const categories = new Set(manifest.assets.map((a) => a.category));
    const required = ['trussing', 'staging', 'video', 'lighting', 'audio', 'sfx', 'site'];
    expect(required.filter((c) => !categories.has(c))).toEqual([]);
  });

  it('keeps every asset inside the LOD0 triangle budget', () => {
    const overBudget = manifest.assets.filter(
      (a) => a.triangles > manifest.budgets.max_lod0_triangles,
    );
    expect(overBudget.map((a) => a.id)).toEqual([]);
  });

  it('gives every asset at least one socket', () => {
    const socketless = manifest.assets.filter((a) => a.socket_ids.length === 0);
    expect(socketless.map((a) => a.id)).toEqual([]);
  });

  it('keeps asset ids unique', () => {
    const ids = manifest.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('[2] extras.sockets survives GLB and normalizes', () => {
  let totalSockets = 0;
  let rejected = 0;
  const miscounted: string[] = [];

  beforeAll(async () => {
    for (const asset of manifest.assets) {
      const sockets = await readAssetSockets(asset);
      if (sockets.length !== asset.socket_ids.length) miscounted.push(asset.id);
      for (const raw of sockets) {
        totalSockets++;
        if (normalizeSocket(raw) === null) rejected++;
      }
    }
  });

  it('returns from every GLB the socket count the manifest claims', () => {
    expect(miscounted).toEqual([]);
  });

  it('normalizes every socket in the library', () => {
    expect(rejected).toBe(0);
  });

  it('totals the same socket count as the manifest', () => {
    expect(totalSockets).toBe(manifest.totals.sockets);
  });
});

describe('[3] Library assets snap through the engine', () => {
  describe('two 2 m F34 sticks, end to end', () => {
    let candidate: ReturnType<SocketSnappingEngine['trySnap']> = null;
    let centreGap = Infinity;

    beforeAll(async () => {
      const scene = new THREE.Scene();
      const engine = new SocketSnappingEngine();

      const anchor = await spawn('truss_f34_box_2m');
      scene.add(anchor);
      engine.register(anchor);

      const moving = await spawn('truss_f34_box_2m');
      moving.position.set(-2.06, 0.03, 0.05); // dropped in roughly, ~7 cm out
      scene.add(moving);
      engine.register(moving);
      scene.updateMatrixWorld(true);

      candidate = engine.trySnap(moving);
      scene.updateMatrixWorld(true);
      centreGap = new THREE.Vector3()
        .setFromMatrixPosition(moving.matrixWorld)
        .distanceTo(new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld));
    });

    it('snaps', () => {
      expect(candidate).not.toBeNull();
    });

    it('lands the centres exactly one stick length apart', () => {
      expect(centreGap).toBeCloseTo(2.0, 6);
    });

    it('mates on a conical F34 chord socket', () => {
      expect(candidate?.target.definition.socket_type).toBe('TRUSS_CONICAL_F34');
    });

    it('locks onto a cardinal detent', () => {
      expect([0, 90, 180, 270]).toContain(candidate?.detentDegrees);
    });

    it('reports the joint load bearing', () => {
      expect(candidate?.target.definition.loadBearing).toBe(true);
    });

    it('carries the chord load rating through the GLB round trip', () => {
      expect(candidate?.target.definition.maxLoadKg).toBe(750);
    });
  });

  describe('two LED tiles, edge to edge', () => {
    let candidate: ReturnType<SocketSnappingEngine['trySnap']> = null;
    let placed = new THREE.Vector3();

    beforeAll(async () => {
      const scene = new THREE.Scene();
      const engine = new SocketSnappingEngine();

      const left = await spawn('led_tile_500x500');
      scene.add(left);
      engine.register(left);

      const right = await spawn('led_tile_500x500');
      right.position.set(0.46, 0.04, 0.0);
      scene.add(right);
      engine.register(right);
      scene.updateMatrixWorld(true);

      candidate = engine.trySnap(right);
      scene.updateMatrixWorld(true);
      placed = new THREE.Vector3().setFromMatrixPosition(right.matrixWorld);
    });

    it('latches MALE into FEMALE', () => {
      expect(candidate).not.toBeNull();
    });

    it('butts at exactly one 500 mm tile pitch', () => {
      expect(Math.abs(placed.x)).toBeCloseTo(0.5, 6);
    });

    it('stays coplanar', () => {
      expect(placed.y).toBeCloseTo(0, 6);
      expect(placed.z).toBeCloseTo(0, 6);
    });

    it('mates on an LED panel fastener', () => {
      expect(candidate?.target.definition.socket_type).toBe('LED_PANEL_FASTENER');
    });
  });

  it('refuses an LED tile against a truss chord', async () => {
    const scene = new THREE.Scene();
    const engine = new SocketSnappingEngine();

    const truss = await spawn('truss_f34_box_2m');
    scene.add(truss);
    engine.register(truss);

    const tile = await spawn('led_tile_500x500');
    tile.position.set(1.0, 0.145, 0.145); // right on a chord socket
    scene.add(tile);
    engine.register(tile);
    scene.updateMatrixWorld(true);

    expect(engine.findSnapCandidate(tile)).toBeNull();
  });
});
