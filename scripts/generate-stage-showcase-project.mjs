import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const ROOT_DIR = process.cwd();

console.log('Generating concert stage showcase project...');

// Coordinate constants from FestivalStage.ts
const Z_FRONT = 0;
const Z_BACK = -4.29;
const X_L = -2.145;
const X_R = 2.145;
const Y_3M = 3.145;
const Y_4M = 4.435;
const Y_6M = 6.725;
const CHORD = 0.145;

const qIdentity = [0, 0, 0, 1];
const qVert = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)]; // 90 deg about Z
const qSide = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // 90 deg about Y
const qFlip = [0, 0, 1, 0]; // 180 deg about Z (downward facing)

const records = [];

function addRecord(record) {
  records.push(record);
}

// 1. Asset Definitions
const definitions = [
  { id: 'def:truss_f34_3m', catalogId: 'truss_f34_box_3m', label: 'F34 Box Truss 3m', category: 'trussing', mass: 16.2 },
  { id: 'def:truss_f34_2m', catalogId: 'truss_f34_box_2m', label: 'F34 Box Truss 2m', category: 'trussing', mass: 11.5 },
  { id: 'def:truss_f34_1m', catalogId: 'truss_f34_box_1m', label: 'F34 Box Truss 1m', category: 'trussing', mass: 6.8 },
  { id: 'def:truss_f34_corner', catalogId: 'truss_f34_corner_6way', label: 'F34 6-Way Corner Block', category: 'trussing', mass: 9.5 },
  { id: 'def:truss_baseplate', catalogId: 'truss_baseplate_24in', label: '24x24 in Steel Baseplate', category: 'trussing', mass: 35.0 },
  { id: 'def:deck_4x8', catalogId: 'deck_4x8', label: '4x8 ft Stage Deck', category: 'staging', mass: 58.0 },
  { id: 'def:sub_ks28', catalogId: 'sub_ks28', label: 'KS28 Subwoofer (2x18")', category: 'audio', mass: 79.0, power: 3200 },
  { id: 'def:moving_head_beam', catalogId: 'moving_head_beam', label: 'Claypaky Sharpy Beam', category: 'lighting', mass: 19.0, power: 350 },
  { id: 'def:moving_head_wash', catalogId: 'moving_head_wash', label: 'Claypaky Sharpy Wash 330', category: 'lighting', mass: 22.5, power: 480 },
  { id: 'def:led_tile_500', catalogId: 'led_tile_500x500', label: 'LED Video Tile 500x500mm', category: 'video', mass: 7.5, power: 150 },
];

for (const d of definitions) {
  addRecord({
    locked: false,
    kind: 'asset_definition',
    id: d.id,
    label: d.label,
    catalogId: d.catalogId,
    category: d.category,
    specifications: {
      mass: { status: 'known', unit: 'kg', value: d.mass, provenance: 'manufacturer', source: 'Authored rig plot' },
      ...(d.power ? { power: { status: 'known', unit: 'W', value: d.power, provenance: 'manufacturer', source: 'Authored rig plot' } } : {})
    }
  });
}

function normalizeQuat(q) {
  const len = Math.hypot(...q);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

let instCounter = 1;
function makeInstance(defId, label, position, rotation = qIdentity) {
  const id = `inst_${String(instCounter++).padStart(4, '0')}`;
  addRecord({
    locked: false,
    kind: 'asset_instance',
    id,
    label,
    definitionId: defId,
    inventoryItemId: null,
    transform: {
      position: [Number(position[0].toFixed(4)), Number(position[1].toFixed(4)), Number(position[2].toFixed(4))],
      rotation: normalizeQuat(rotation)
    }
  });
  return id;
}

// 2. Stage Decks (3 side-by-side 4x8 decks)
makeInstance('def:deck_4x8', 'Stage Deck Center', [0, 0.4, -2.145]);
makeInstance('def:deck_4x8', 'Stage Deck Left', [-1.22, 0.4, -2.145]);
makeInstance('def:deck_4x8', 'Stage Deck Right', [1.22, 0.4, -2.145]);

// 3. Subwoofers along downstage (6 subs in 2 tiers)
for (const x of [-1.25, 0, 1.25]) {
  for (let tier = 0; tier < 2; tier++) {
    makeInstance('def:sub_ks28', `Subwoofer ${x < 0 ? 'L' : x > 0 ? 'R' : 'C'} T${tier + 1}`, [x, 0.4 + tier * 0.8, -0.4]);
  }
}

// 4. Main Box Verticals & Baseplates
for (const x of [X_L, X_R]) {
  const side = x < 0 ? 'Left' : 'Right';
  // Baseplates
  makeInstance('def:truss_baseplate', `Downstage ${side} Baseplate`, [x, 0, Z_FRONT]);
  makeInstance('def:truss_baseplate', `Upstage ${side} Baseplate`, [x, 0, Z_BACK]);

  // Downstage totem
  makeInstance('def:truss_f34_3m', `Downstage ${side} Column Lower (3m)`, [x, 1.5, Z_FRONT], qVert);
  makeInstance('def:truss_f34_corner', `Downstage ${side} Corner Block (3.14m)`, [x, Y_3M, Z_FRONT]);
  makeInstance('def:truss_f34_3m', `Downstage ${side} Column Upper (3m)`, [x, 4.79, Z_FRONT], qVert);
  makeInstance('def:truss_f34_corner', `Downstage ${side} Corner Block (6.43m)`, [x, 6.435, Z_FRONT]);

  // Upstage totem
  makeInstance('def:truss_f34_3m', `Upstage ${side} Column Lower (3m)`, [x, 1.5, Z_BACK], qVert);
  makeInstance('def:truss_f34_corner', `Upstage ${side} Corner Block (3.14m)`, [x, Y_3M, Z_BACK]);
  makeInstance('def:truss_f34_1m', `Upstage ${side} Column Mid (1m)`, [x, 3.79, Z_BACK], qVert);
  makeInstance('def:truss_f34_corner', `Upstage ${side} Corner Block (4.43m)`, [x, Y_4M, Z_BACK]);
  makeInstance('def:truss_f34_2m', `Upstage ${side} Column Top (2m)`, [x, 5.58, Z_BACK], qVert);
  makeInstance('def:truss_f34_corner', `Upstage ${side} Corner Block (6.72m)`, [x, Y_6M, Z_BACK]);
}

// 5. Main Box Horizontals
for (const x of [-1.0, 1.0]) {
  const side = x < 0 ? 'Left' : 'Right';
  makeInstance('def:truss_f34_2m', `Rear Span 4.43m ${side} (2m)`, [x, Y_4M, Z_BACK]);
  makeInstance('def:truss_f34_2m', `Rear Top Span 6.72m ${side} (2m)`, [x, Y_6M, Z_BACK]);
}

// Side spans at 3.14m
for (const x of [X_L, X_R]) {
  const side = x < 0 ? 'Left' : 'Right';
  makeInstance('def:truss_f34_2m', `Side Span 3.14m ${side} Front (2m)`, [x, Y_3M, -1.145], qSide);
  makeInstance('def:truss_f34_2m', `Side Span 3.14m ${side} Rear (2m)`, [x, Y_3M, -3.145], qSide);
}

// 6. Angled Arms (Left and Right)
function buildArmTrusses(isLeft) {
  const sign = isLeft ? -1 : 1;
  const side = isLeft ? 'Left' : 'Right';
  const P0 = new THREE.Vector3(sign * X_R, Y_3M, Z_FRONT);

  const angle1 = (30 * Math.PI) / 180;
  const dir1 = new THREE.Vector3(sign * Math.sin(angle1), 0, Math.cos(angle1)).normalize();
  const P1 = P0.clone().add(dir1.clone().multiplyScalar(3.29));
  const P2 = P1.clone().add(dir1.clone().multiplyScalar(4.29));

  const dir2 = dir1.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), isLeft ? Math.PI / 2 : -Math.PI / 2).normalize();
  const P3 = P2.clone().add(dir2.clone().multiplyScalar(3.29));

  const q1 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir1);
  const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir2);

  const q1Arr = [q1.x, q1.y, q1.z, q1.w];
  const q2Arr = [q2.x, q2.y, q2.z, q2.w];

  // Arm segment 1
  const s1 = P0.clone().add(dir1.clone().multiplyScalar(1.645));
  makeInstance('def:truss_f34_3m', `${side} Arm Truss Run 1`, [s1.x, s1.y, s1.z], q1Arr);
  makeInstance('def:truss_f34_corner', `${side} Arm Corner 1`, [P1.x, P1.y, P1.z]);
  makeInstance('def:truss_f34_3m', `${side} Arm Totem 1`, [P1.x, 1.5, P1.z], qVert);

  // Arm segment 2
  const s2 = P1.clone().add(dir1.clone().multiplyScalar(1.645));
  makeInstance('def:truss_f34_3m', `${side} Arm Truss Run 2`, [s2.x, s2.y, s2.z], q1Arr);
  makeInstance('def:truss_f34_corner', `${side} Arm Corner 2`, [P2.x, P2.y, P2.z]);
  makeInstance('def:truss_f34_3m', `${side} Arm Totem 2`, [P2.x, 1.5, P2.z], qVert);

  // Arm segment 3 (return)
  const s3 = P2.clone().add(dir2.clone().multiplyScalar(1.645));
  makeInstance('def:truss_f34_3m', `${side} Arm Inward Run`, [s3.x, s3.y, s3.z], q2Arr);
  makeInstance('def:truss_f34_corner', `${side} Arm Corner 3`, [P3.x, P3.y, P3.z]);
  makeInstance('def:truss_f34_3m', `${side} Arm Totem 3`, [P3.x, 1.5, P3.z], qVert);

  // Fixtures along this arm
  const runs = [
    { origin: P0, dir: dir1, count: 3, span: 3.29 },
    { origin: P1, dir: dir1, count: 4, span: 4.29 },
    { origin: P2, dir: dir2, count: 3, span: 3.29 },
  ];
  let fxIndex = 1;
  for (const leg of runs) {
    for (let i = 0; i < leg.count; i++) {
      const p = leg.origin.clone().add(leg.dir.clone().multiplyScalar(0.645 + i * 1.0));
      // Top mount: Beam
      makeInstance('def:moving_head_beam', `${side} Arm Fixture ${fxIndex} (Top Beam)`, [p.x, Y_3M + CHORD, p.z]);
      // Bottom mount: Wash
      makeInstance('def:moving_head_wash', `${side} Arm Fixture ${fxIndex} (Bottom Wash)`, [p.x, Y_3M - CHORD, p.z], qFlip);
      fxIndex++;
    }
  }
}

buildArmTrusses(true);
buildArmTrusses(false);

// 7. Gobo Sharpy Beams on Rear Top Span
for (let i = 0; i < 4; i++) {
  makeInstance('def:moving_head_beam', `Rear Top Gobo Beam ${i + 1}`, [-1.5 + i * 1.0, Y_6M - CHORD, Z_BACK], qFlip);
}

// 8. LED Video Wall Tiles (4m wide by 2.5m high: 8 tiles wide x 5 tiles high = 40 tiles)
const wallTiles = [];
const tileWidth = 0.5;
const tileHeight = 0.5;
const wallOriginX = -1.75;
const wallOriginY = 1.25;
const wallZ = Z_BACK + CHORD;

for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 8; col++) {
    const tileId = makeInstance('def:led_tile_500', `LED Tile R${row + 1}C${col + 1}`, [
      wallOriginX + col * tileWidth,
      wallOriginY + row * tileHeight,
      wallZ
    ]);
    wallTiles.push(tileId);
  }
}

// 9. Assembly for LED Wall
addRecord({
  locked: false,
  kind: 'assembly',
  id: 'assembly:led_wall',
  label: 'Upstage LED Video Wall (4x2.5m)',
  instanceIds: wallTiles
});

// 10. Video Surface & Raster Mapping
addRecord({
  locked: false,
  kind: 'surface',
  id: 'surface:led_wall_screen',
  label: 'Upstage LED Video Screen Plane',
  shape: 'plane',
  transform: {
    position: [0, 2.25, wallZ],
    rotation: qIdentity
  },
  width: { status: 'known', unit: 'm', value: 4.0, provenance: 'manufacturer', source: 'LED tile matrix (8x5)' },
  height: { status: 'known', unit: 'm', value: 2.5, provenance: 'manufacturer', source: 'LED tile matrix (8x5)' }
});

addRecord({
  locked: false,
  kind: 'raster_mapping',
  id: 'raster:edm_show_loop',
  label: 'EDM Video Wall Visuals (Orange & Purple)',
  surfaceId: 'surface:led_wall_screen',
  width: 1920,
  height: 1080
});

// 11. Audience Safety Zone (EN 60825-1 MPE Evaluation)
addRecord({
  locked: false,
  kind: 'zone',
  id: 'zone:audience_safety',
  label: 'Audience Safety Zone (EN 60825-1 MPE)',
  role: 'audience',
  shape: 'box',
  transform: {
    position: [0, 1.5, 7.0],
    rotation: qIdentity
  },
  sizeMeters: [16.0, 3.0, 14.0]
});

const project = {
  schemaVersion: 1,
  projectId: 'concert-stage-showcase',
  revision: 0,
  coordinateFrame: 'right_handed_y_up_meters',
  records
};

const jsonContent = JSON.stringify(project, null, 2);

// Write to public/stage-showcase.json
const publicPath = path.join(ROOT_DIR, 'public', 'stage-showcase.json');
fs.writeFileSync(publicPath, jsonContent, 'utf8');
console.log(`Wrote ${records.length} records to ${publicPath}`);

// Also write to dist/stage-showcase.json if dist exists
const distPath = path.join(ROOT_DIR, 'dist', 'stage-showcase.json');
if (fs.existsSync(path.dirname(distPath))) {
  fs.writeFileSync(distPath, jsonContent, 'utf8');
  console.log(`Wrote to ${distPath}`);
}
