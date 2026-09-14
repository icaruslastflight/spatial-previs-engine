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

import {
  SocketSnappingEngine,
  normalizeSocket,
  writeSockets,
} from '../engine/SocketSnappingEngine.ts';
import type { SocketDefinition } from '../engine/SocketSnappingEngine.ts';

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

console.log('\n[1] Manifest integrity');
{
  check('manifest lists assets', manifest.assets.length > 0, `(${manifest.assets.length})`);
  check('totals match the asset list', manifest.totals.assets === manifest.assets.length);

  const categories = new Set(manifest.assets.map((a) => a.category));
  const required = ['trussing', 'staging', 'video', 'lighting', 'audio', 'sfx', 'site'];
  check('all 7 taxonomy categories present',
    required.every((c) => categories.has(c)),
    `(missing ${required.filter((c) => !categories.has(c)).join(', ') || 'none'})`);

  const overBudget = manifest.assets.filter((a) => a.triangles > manifest.budgets.max_lod0_triangles);
  check('every asset is inside the LOD0 triangle budget', overBudget.length === 0,
    `(${overBudget.map((a) => a.id).join(', ')})`);

  const socketless = manifest.assets.filter((a) => a.socket_ids.length === 0);
  check('every asset carries at least one socket', socketless.length === 0,
    `(${socketless.map((a) => a.id).join(', ')})`);

  const ids = manifest.assets.map((a) => a.id);
  check('asset ids are unique', new Set(ids).size === ids.length);
}

console.log('\n[2] extras.sockets survives GLB and normalizes');
{
  let totalSockets = 0;
  let rejected = 0;
  const badAssets: string[] = [];

  for (const asset of manifest.assets) {
    const sockets = await readAssetSockets(asset);
    if (sockets.length !== asset.socket_ids.length) badAssets.push(asset.id);
    for (const raw of sockets) {
      totalSockets++;
      if (normalizeSocket(raw) === null) rejected++;
    }
  }

  check('every GLB returns the socket count the manifest claims', badAssets.length === 0,
    `(${badAssets.join(', ')})`);
  check('every socket in the library normalizes', rejected === 0, `(${rejected} rejected)`);
  check('socket total matches the manifest', totalSockets === manifest.totals.sockets,
    `(${totalSockets} vs ${manifest.totals.sockets})`);
}

console.log('\n[3] Library assets snap through the engine');
{
  /** Rebuild a bare Object3D carrying a library asset's real sockets. */
  const spawn = async (id: string): Promise<THREE.Object3D> => {
    const asset = manifest.assets.find((a) => a.id === id);
    if (asset === undefined) throw new Error(`asset ${id} missing from manifest`);
    const object = new THREE.Object3D();
    object.name = id;
    writeSockets(object, await readAssetSockets(asset));
    return object;
  };

  // Two 2 m F34 sticks, end to end.
  {
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

    const candidate = engine.trySnap(moving);
    check('two F34 sticks snap end to end', candidate !== null);
    if (candidate) {
      scene.updateMatrixWorld(true);
      const gap = new THREE.Vector3().setFromMatrixPosition(moving.matrixWorld)
        .distanceTo(new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld));
      check('centres land exactly one stick length apart', approx(gap, 2.0, 1e-6),
        `(${gap.toFixed(9)} m)`);
      check('mated on a conical F34 chord socket',
        candidate.target.definition.socket_type === 'TRUSS_CONICAL_F34');
      check('detent is cardinal', [0, 90, 180, 270].includes(candidate.detentDegrees),
        `(${candidate.detentDegrees})`);
      check('joint is load bearing', candidate.target.definition.loadBearing);
      check('chord load rating carried through GLB',
        candidate.target.definition.maxLoadKg === 750,
        `(${candidate.target.definition.maxLoadKg})`);
    }
  }

  // Two LED tiles, edge to edge: MALE latch into FEMALE latch.
  {
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

    const candidate = engine.trySnap(right);
    check('LED tiles latch edge to edge', candidate !== null);
    if (candidate) {
      scene.updateMatrixWorld(true);
      const p = new THREE.Vector3().setFromMatrixPosition(right.matrixWorld);
      // 500 mm tiles butt at exactly one tile pitch.
      check('tile pitch is exactly 0.5 m', approx(Math.abs(p.x), 0.5, 1e-6), `(${p.x.toFixed(6)})`);
      check('tile stays coplanar', approx(p.y, 0, 1e-6) && approx(p.z, 0, 1e-6),
        `(y ${p.y.toFixed(6)}, z ${p.z.toFixed(6)})`);
      check('mated on an LED panel fastener',
        candidate.target.definition.socket_type === 'LED_PANEL_FASTENER');
    }
  }

  // Cross-category must refuse: a truss chord is not an LED latch.
  {
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

    check('truss chord refuses an LED tile', engine.findSnapCandidate(tile) === null);
  }
}

console.log(failures === 0 ? '\nASSET LIBRARY CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
