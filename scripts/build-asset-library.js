#!/usr/bin/env node
/**
 * Modular event asset library build pipeline.
 *
 * Generates the full production asset taxonomy as optimized binary glTF (GLB)
 * with `extras.sockets` metadata embedded on every model, then indexes
 * everything in a manifest the runtime loads at startup.
 *
 *     node scripts/build-asset-library.js
 *     node scripts/build-asset-library.js --only trussing,video
 *     node scripts/build-asset-library.js --verify
 *
 * Output:
 *     public/assets/models/<category>/<id>.glb
 *     public/assets/manifest.json
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG } from './assetlib/catalog.js';
import { bounds, finalize, hullOf, triangleCount } from './assetlib/geometry.js';
import { SOCKET_TYPES, GENDERS } from './assetlib/sockets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'public/assets/models');
const MANIFEST_PATH = join(ROOT, 'public/assets/manifest.json');

/** WebGPU performance budget from the specification's QA matrix. */
const MAX_LOD0_TRIANGLES = 15000;

const FT = 0.3048;

/**
 * Per-category PBR appearance.
 *
 * These are factor-only materials: no texture maps at all. The spec allows
 * 512px-1K PBR, but procedural stock like truss and decking is uniform
 * material, so a texture would add payload without adding information. Real
 * maps belong on assets that actually vary across their surface (LED tile
 * faces, printed scrim) and should be added there when art exists.
 */
const MATERIALS = {
  trussing: { color: [0.72, 0.74, 0.77, 1], metallic: 0.85, roughness: 0.38 },
  staging: { color: [0.17, 0.17, 0.19, 1], metallic: 0.1, roughness: 0.85 },
  video: { color: [0.06, 0.06, 0.08, 1], metallic: 0.25, roughness: 0.45 },
  lighting: { color: [0.11, 0.11, 0.12, 1], metallic: 0.4, roughness: 0.5 },
  audio: { color: [0.09, 0.09, 0.1, 1], metallic: 0.2, roughness: 0.7 },
  sfx: { color: [0.13, 0.13, 0.15, 1], metallic: 0.5, roughness: 0.42 },
  site: { color: [0.55, 0.5, 0.18, 1], metallic: 0.6, roughness: 0.55 },
};

function validateSockets(assetId, sockets) {
  const problems = [];
  const seen = new Set();
  for (const s of sockets) {
    if (seen.has(s.socket_id)) problems.push(`duplicate socket_id "${s.socket_id}"`);
    seen.add(s.socket_id);
    if (!SOCKET_TYPES.includes(s.socket_type)) problems.push(`bad socket_type "${s.socket_type}"`);
    if (!GENDERS.includes(s.gender)) problems.push(`bad gender "${s.gender}"`);

    const { translation, normal, up } = s.transform ?? {};
    for (const [name, v] of [['translation', translation], ['normal', normal], ['up', up]]) {
      if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
        problems.push(`socket "${s.socket_id}" has a malformed ${name}`);
      }
    }
    if (Array.isArray(normal) && Math.hypot(...normal) < 1e-6) {
      problems.push(`socket "${s.socket_id}" has a degenerate normal`);
    }
    const t = s.tolerances ?? {};
    if (!(t.snap_radius > 0 && t.snap_radius <= 0.15)) {
      // The spec fixes the magnetic threshold at 0.15 m; a looser radius would
      // silently diverge from the UE5 build.
      problems.push(`socket "${s.socket_id}" snap_radius ${t.snap_radius} outside (0, 0.15]`);
    }
  }
  if (problems.length) {
    throw new Error(`${assetId}: ${problems.join('; ')}`);
  }
}

/** Build one GLB document: render mesh, collision hull, and socket extras. */
function buildDocument(asset, mesh, sockets) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene(asset.id);

  const palette = MATERIALS[asset.category] ?? MATERIALS.trussing;
  const material = doc
    .createMaterial(`${asset.category}_material`)
    .setBaseColorFactor(palette.color)
    .setMetallicFactor(palette.metallic)
    .setRoughnessFactor(palette.roughness);

  const addMesh = (name, geometry, mat) => {
    const data = finalize(geometry);
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(data.positions))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(data.normals))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(data.indices))
      .setMaterial(mat);
    return doc.createMesh(name).addPrimitive(primitive);
  };

  const root = doc.createNode(asset.id).setMesh(addMesh(`${asset.id}_lod0`, mesh, material));
  // The socket contract rides on the root node's extras, which is exactly where
  // Three's GLTFLoader surfaces it (flattened onto userData) and where the UE5
  // importer reads it.
  root.setExtras({
    sockets,
    asset_id: asset.id,
    category: asset.category,
    reference: asset.reference ?? null,
  });
  scene.addChild(root);

  // Low-poly convex hull for collision queries and volumetric light occlusion.
  // Shipped in the same GLB so it can never drift from the render mesh.
  const hullMaterial = doc
    .createMaterial('collision_hull')
    .setBaseColorFactor([0, 1, 0, 0.15])
    .setAlphaMode('BLEND');
  const hull = doc
    .createNode(`${asset.id}_collision`)
    .setMesh(addMesh(`${asset.id}_hull`, hullOf(mesh), hullMaterial));
  hull.setExtras({ collision_hull: true, render: false });
  root.addChild(hull);

  return doc;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.indexOf('--only');
  const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(',')) : null;
  const verifyOnly = args.includes('--verify');

  const io = new NodeIO();
  const manifestAssets = [];
  const failures = [];
  let totalTriangles = 0;
  let totalBytes = 0;

  console.log('\n=== Modular event asset library build ===\n');

  for (const asset of CATALOG) {
    if (only && !only.has(asset.category)) continue;
    try {
      const { mesh, sockets } = asset.build();
      validateSockets(asset.id, sockets);

      const triangles = triangleCount(mesh);
      if (triangles > MAX_LOD0_TRIANGLES) {
        throw new Error(`LOD0 ${triangles} tris exceeds the ${MAX_LOD0_TRIANGLES} budget`);
      }
      const box = bounds(mesh);

      const relativePath = join('models', asset.category, `${asset.id}.glb`);
      const outPath = join(MODELS_DIR, asset.category, `${asset.id}.glb`);
      if (!verifyOnly) {
        await mkdir(dirname(outPath), { recursive: true });
        const glb = await io.writeBinary(buildDocument(asset, mesh, sockets));
        await writeFile(outPath, glb);
        totalBytes += glb.byteLength;
      }

      totalTriangles += triangles;
      manifestAssets.push({
        id: asset.id,
        name: asset.name,
        category: asset.category,
        reference: asset.reference ?? null,
        url: `assets/${relativePath.split(/[\\/]/).join('/')}`,
        dimensions: {
          meters: box.size.map((v) => Number(v.toFixed(4))),
          feet: box.size.map((v) => Number((v / FT).toFixed(3))),
          bounds_min: box.min.map((v) => Number(v.toFixed(4))),
          bounds_max: box.max.map((v) => Number(v.toFixed(4))),
        },
        triangles,
        dmx: asset.dmx ?? null,
        socket_ids: sockets.map((s) => s.socket_id),
        socket_types: [...new Set(sockets.map((s) => s.socket_type))],
      });

      console.log(
        `  ${asset.category.padEnd(9)} ${asset.id.padEnd(28)} ` +
        `${String(triangles).padStart(6)} tris  ` +
        `${box.size.map((v) => v.toFixed(2)).join(' x ')} m  ` +
        `${String(sockets.length).padStart(2)} sockets`,
      );
    } catch (error) {
      failures.push(`${asset.id}: ${error.message}`);
      console.error(`  FAIL ${asset.id}: ${error.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} asset(s) failed:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }

  const byCategory = {};
  for (const a of manifestAssets) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;

  if (!verifyOnly) {
    const manifest = {
      $schema_version: '1.0.0',
      generated_by: 'scripts/build-asset-library.js',
      socket_schema: {
        spec: 'Event Asset Library and Modular Snapping Specification, section 3.1',
        embedded_at: 'glTF node extras.sockets',
        socket_types: SOCKET_TYPES,
        genders: GENDERS,
        tolerances: { snap_radius_m: 0.15, snap_angle_deg: 15, detents_deg: [0, 90, 180, 270] },
      },
      budgets: { max_lod0_triangles: MAX_LOD0_TRIANGLES, collision_hull: 'box, shipped in-GLB' },
      totals: {
        assets: manifestAssets.length,
        categories: byCategory,
        triangles: totalTriangles,
        sockets: manifestAssets.reduce((n, a) => n + a.socket_ids.length, 0),
      },
      assets: manifestAssets,
    };
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`\n  assets      : ${manifestAssets.length}`);
  console.log(`  categories  : ${Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  triangles   : ${totalTriangles} (max ${MAX_LOD0_TRIANGLES}/asset)`);
  console.log(`  sockets     : ${manifestAssets.reduce((n, a) => n + a.socket_ids.length, 0)}`);
  if (!verifyOnly) {
    console.log(`  GLB payload : ${(totalBytes / 1024).toFixed(1)} KB total`);
    console.log(`  manifest    : ${MANIFEST_PATH.replace(ROOT + '/', '')}`);
  }

  // Read every GLB back and confirm the socket contract survived serialization.
  if (!verifyOnly) {
    let checked = 0;
    for (const entry of manifestAssets) {
      const doc = await io.read(join(ROOT, 'public', entry.url));
      const node = doc.getRoot().listNodes().find((n) => n.getName() === entry.id);
      const extras = node?.getExtras() ?? {};
      if (!Array.isArray(extras.sockets) || extras.sockets.length !== entry.socket_ids.length) {
        throw new Error(`${entry.id}: sockets did not survive the GLB round trip`);
      }
      checked++;
    }
    console.log(`  round trip  : ${checked}/${manifestAssets.length} GLBs re-read with sockets intact`);
  }

  console.log('\nASSET LIBRARY BUILD OK\n');
}

main().catch((error) => {
  console.error('\nBUILD FAILED:', error.message, '\n');
  process.exit(1);
});
