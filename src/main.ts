/**
 * Festival Visualizer -- browser viewport entry point.
 *
 * Composes the georeferenced Cesium basemap, the Three.js show layer, the
 * socket snapping engine and the touch drag controller into one app.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { SocketSnappingEngine, SNAP_THRESHOLD_METERS } from './engine/SocketSnappingEngine.ts';
import type { SnapCandidate } from './engine/SocketSnappingEngine.ts';
import { SceneIndex } from './engine/SceneIndex.ts';
import { createF34BoxTruss2M, createStageDeck4x8 } from './assets/ModularPrimitives.ts';
import { buildFestivalStage } from './assets/FestivalStage.ts';
import { CesiumGlobe } from './geo/CesiumGlobe.ts';
import { POINT_STATE_PARK } from './geo/GeoAnchor.ts';
import { loadSiteBounds } from './viewport/SiteBounds.ts';
import { loadRegisteredSplatScenes } from './assets/SplatSceneLoader.ts';
import type { SplatLoadResult } from './assets/SplatSceneLoader.ts';
import { DragSnapController } from './viewport/DragSnapController.ts';
import { PlaytestController } from './components/PlaytestController.ts';
import { engineLoop, TICK_PRIORITY } from './core/EngineLoop.ts';
import './style.css';

/* -------------------------------------------------------------------------- */
/* DOM                                                                         */
/* -------------------------------------------------------------------------- */

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const cesiumContainer = requireElement<HTMLDivElement>('cesium-container');
const canvas = requireElement<HTMLCanvasElement>('three-canvas');
const statusBasemap = requireElement<HTMLSpanElement>('status-basemap');
const statusRenderer = requireElement<HTMLSpanElement>('status-renderer');
const statusSite = requireElement<HTMLSpanElement>('status-site');
const statusSnap = requireElement<HTMLSpanElement>('status-snap');
const statusScans = requireElement<HTMLSpanElement>('status-scans');

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Probe for WebGPU.
 *
 * The show layer renders through WebGLRenderer: Cesium is WebGL-only, and
 * running the basemap and the show layer on the same backend keeps the two
 * canvases in step. The probe is still worth doing -- the Gaussian splat
 * pipeline is the piece that will take the WebGPU path once scans land, and
 * the operator should be able to see on-site whether their device supports it.
 */
async function detectWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (gpu === undefined) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true, // the Cesium basemap shows through
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 0);
// Cap DPR: phones ship 3x+ panels and a previz viewport is fill-rate bound.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap was removed in three r186.
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  20000,
);
// Far enough out to hold the whole starting rig, including the arm ends.
camera.position.set(14, 10, 26);

/* -------------------------------------------------------------------------- */
/* Lighting                                                                    */
/* -------------------------------------------------------------------------- */

scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2a2a2a, 1.5));

const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(-38, 55, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
scene.add(sun);

// Catches shadows so assets read as sitting on the ground, without painting
// over the basemap.
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.ShadowMaterial({ opacity: 0.32 }),
);
shadowCatcher.rotateX(-Math.PI / 2);
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

const grid = new THREE.GridHelper(200, 100, 0x3d5a80, 0x243447);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.28;
scene.add(grid);

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enableRotate = true;
controls.enableZoom = true;
controls.enablePan = true;
controls.screenSpacePanning = false;
controls.minDistance = 1.5;
controls.maxDistance = 3000;
// Stop just short of the horizon so the camera never ends up under the site.
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set(0, 3, 1);
// One finger orbits; two fingers pinch-zoom AND pan together.
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.update();

// Desktop playtest rig: WASD/RMB-orbit + diagnostics HUD, additive to the
// touch contract above. See PlaytestController's header for the split.
new PlaytestController({ domElement: canvas, camera, controls, engineLoop });

/* -------------------------------------------------------------------------- */
/* Show assets                                                                 */
/* -------------------------------------------------------------------------- */

const engine = new SocketSnappingEngine();
const sceneIndex = new SceneIndex(engine);
const showLayer = new THREE.Group();
showLayer.name = 'ShowLayer';
scene.add(showLayer);

/**
 * Manifest labels for the procedural stand-ins.
 *
 * `ModularPrimitives` builds geometry but carries no catalogue identity, so the
 * asset id and category are attached here. They match `public/assets/manifest.json`
 * exactly, which is what lets a scene saved from procedural stock reopen against
 * real GLB assets later.
 */
const ASSET_LABELS = {
  truss: { assetId: 'truss_f34_box_2m', category: 'trussing' },
  deck: { assetId: 'deck_4x8', category: 'staging' },
  paraflex: { assetId: 'paraflex_diy_sub', category: 'audio' },
} as const;

type AssetKind = keyof typeof ASSET_LABELS;

let instanceCounter = 0;

function spawn(object: THREE.Object3D, kind: AssetKind, position: THREE.Vector3): THREE.Object3D {
  const label = ASSET_LABELS[kind];
  instanceCounter += 1;
  // Stable across a save/load, unlike the per-session Three.js uuid.
  object.userData['instance_id'] = `inst_${String(instanceCounter).padStart(4, '0')}`;
  object.userData['asset_id'] = label.assetId;
  object.userData['category'] = label.category;

  object.position.copy(position);
  showLayer.add(object);
  object.updateMatrixWorld(true);
  engine.register(object);
  sceneIndex.invalidate();
  return object;
}

async function buildStartingPlot(): Promise<void> {
  // The reference rig, from the same definition the showcase renders.
  const stage = await buildFestivalStage();
  showLayer.add(stage.group);
  for (const piece of stage.registerable) engine.register(piece);

  // Two loose truss sticks off to one side. The rig itself is already mated,
  // so without these there is nothing to practise drag-to-snap against.
  spawn(createF34BoxTruss2M(), 'truss', new THREE.Vector3(6.2, 2.4, 2.6));
  spawn(createF34BoxTruss2M(), 'truss', new THREE.Vector3(6.55, 2.4, 4.15));

  sceneIndex.invalidate();
}

void buildStartingPlot();

/**
 * Paraflex cabinets are cut to a CAD plan rather than bought, so the viewport
 * generates one to the entered spec instead of cloning a fixed asset. Volume
 * scales off the driver, which is what actually drives the box dimensions.
 */
function createParaflexSub(model: string, driverSize: string, material: string): THREE.Group {
  const group = new THREE.Group();

  const driverInches = Number.parseInt(driverSize, 10) || 18;
  const scale = driverInches / 18;
  const width = 0.6 * scale;
  const height = 0.9 * scale;
  const depth = 0.6 * scale;

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }),
  );
  box.position.y = height / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  // Wireframe stands in for the horn mouth until real CAD lands.
  const mouth = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.8, height * 0.8),
    new THREE.MeshBasicMaterial({ color: 0x050505, wireframe: true }),
  );
  mouth.position.set(0, height / 2, depth / 2 + 0.01);
  group.add(mouth);

  // Carried through save/load so a cut list can be produced from the scene.
  group.userData['paraflex'] = { model, driver: driverSize, material };

  return group;
}

interface ParaflexSpec {
  model: string;
  driver: string;
  material: string;
}

let spawnCursor = 0;
function spawnFromPalette(kind: AssetKind, paraflex?: ParaflexSpec): void {
  // Lay new stock out in a row off to the side of the build.
  spawnCursor += 1;
  const x = 5 + (spawnCursor % 4) * 2.6;
  const z = 4 + Math.floor(spawnCursor / 4) * 2.2;
  if (kind === 'truss') {
    spawn(createF34BoxTruss2M(), 'truss', new THREE.Vector3(x, 2.4, z));
  } else if (kind === 'deck') {
    spawn(createStageDeck4x8(), 'deck', new THREE.Vector3(x, 0, z));
  } else if (paraflex) {
    const cabinet = createParaflexSub(paraflex.model, paraflex.driver, paraflex.material);
    spawn(cabinet, 'paraflex', new THREE.Vector3(x, 0, z));
  }
}

requireElement<HTMLButtonElement>('add-truss').addEventListener('click', () =>
  spawnFromPalette('truss'),
);
requireElement<HTMLButtonElement>('add-deck').addEventListener('click', () =>
  spawnFromPalette('deck'),
);

/* Paraflex spec modal. */
const paraflexModal = requireElement<HTMLDivElement>('paraflex-modal');
const paraflexForm = requireElement<HTMLFormElement>('paraflex-form');

function closeParaflexModal(): void {
  paraflexModal.hidden = true;
}

requireElement<HTMLButtonElement>('add-paraflex').addEventListener('click', () => {
  paraflexModal.hidden = false;
  requireElement<HTMLInputElement>('pf-model').focus();
});
requireElement<HTMLButtonElement>('pf-cancel').addEventListener('click', closeParaflexModal);
paraflexModal.addEventListener('click', (event) => {
  // Tapping the scrim dismisses; tapping the card itself must not.
  if (event.target === paraflexModal) closeParaflexModal();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !paraflexModal.hidden) closeParaflexModal();
});
paraflexForm.addEventListener('submit', (event) => {
  event.preventDefault();
  spawnFromPalette('paraflex', {
    model: requireElement<HTMLInputElement>('pf-model').value,
    driver: requireElement<HTMLSelectElement>('pf-driver').value,
    material: requireElement<HTMLSelectElement>('pf-material').value,
  });
  closeParaflexModal();
});

/* -------------------------------------------------------------------------- */
/* Drag + snap                                                                 */
/* -------------------------------------------------------------------------- */

function describeCandidate(candidate: SnapCandidate): string {
  const moving = candidate.moving.definition;
  const target = candidate.target.definition;
  return (
    `${moving.socket_id} (${moving.gender}) -> ${target.socket_id} (${target.gender}) | ` +
    `${(candidate.distance * 1000).toFixed(0)} mm | detent ${candidate.detentDegrees} deg`
  );
}

new DragSnapController({
  domElement: canvas,
  camera,
  scene: showLayer,
  controls,
  engine,
  onCandidateChange: (candidate) => {
    statusSnap.textContent =
      candidate === null ? 'no socket in range' : `ARMED - ${describeCandidate(candidate)}`;
    statusSnap.classList.toggle('armed', candidate !== null);
  },
  onSnap: (candidate) => {
    statusSnap.textContent = `SNAPPED - ${describeCandidate(candidate)}`;
    statusSnap.classList.remove('armed');
  },
  onDragStateChange: (dragging) => {
    if (!dragging) statusSnap.classList.remove('armed');
  },
});

/* -------------------------------------------------------------------------- */
/* Basemap + site bounds                                                       */
/* -------------------------------------------------------------------------- */

const globe = new CesiumGlobe(cesiumContainer, requireElement<HTMLDivElement>('cesium-credits'));
globe.flyHome();

void globe.loadBasemap().then((status) => {
  statusBasemap.textContent = status.label;
  statusBasemap.title = status.detail;
});

void loadSiteBounds(`${import.meta.env.BASE_URL}assets/scans/point-state-park-bounds.geojson`)
  .then(({ object, extents }) => {
    scene.add(object);
    statusSite.textContent =
      extents === null
        ? 'bounds loaded'
        : `${extents.eastWest.toFixed(0)} x ${extents.northSouth.toFixed(0)} m envelope`;
  })
  .catch((error: unknown) => {
    console.error('[main] Site bounds failed to load.', error);
    statusSite.textContent = 'bounds unavailable';
  });

/**
 * Gaussian splat captures, if any are registered. While one is loaded the splat
 * viewer owns the draw call for the show layer, since it composites splats and
 * ordinary meshes together in one pass.
 */
let splats: SplatLoadResult | null = null;

void loadRegisteredSplatScenes({
  renderer,
  camera,
  threeScene: scene,
  manifestUrl: `${import.meta.env.BASE_URL}assets/scans/manifest.json`,
  resolveUrl: (url) => `${import.meta.env.BASE_URL}${url.replace(/^\/+/, '')}`,
})
  .then((result) => {
    splats = result;
    statusScans.textContent = result.detail;
  })
  .catch((error: unknown) => {
    console.error('[main] Splat loader failed.', error);
    statusScans.textContent = 'scan loader failed';
  });

void detectWebGpu().then((available) => {
  statusRenderer.textContent = available
    ? 'WebGL2 (WebGPU available)'
    : 'WebGL2 (no WebGPU)';
  statusRenderer.title = available
    ? 'WebGPU adapter present. The show layer stays on WebGL to share a backend with Cesium; the splat pipeline will take the WebGPU path.'
    : 'No WebGPU adapter. Everything runs on WebGL2.';
});

/* -------------------------------------------------------------------------- */
/* Resize + frame loop                                                         */
/* -------------------------------------------------------------------------- */

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  globe.resize();
}

window.addEventListener('resize', resize);
// iOS fires this on rotate without always firing resize.
window.addEventListener('orientationchange', resize);
resize();

/**
 * Viewport submission, registered on the shared frame clock rather than on a
 * private `requestAnimationFrame`.
 *
 * Priority 3 (RENDER) is the last band, so telemetry, physics and automation
 * have all settled for the frame before anything draws. The clock also holds
 * the loop to 60 FPS, which halves GPU submissions on the 120 Hz phone panels
 * this is operated from.
 */
engineLoop.register(TICK_PRIORITY.RENDER, () => {
  controls.update();
  // Cesium is driven FROM the Three camera, so it must sync before it draws.
  globe.syncFromCamera(camera, window.innerWidth, window.innerHeight);
  globe.render();

  const splatViewer = splats?.viewer ?? null;
  if (splatViewer !== null) {
    // The splat viewer draws the whole Three scene alongside the splat cloud,
    // so it replaces the plain render call rather than adding to it.
    splatViewer.update();
    splatViewer.render();
  } else {
    renderer.render(scene, camera);
  }
});

engineLoop.start();

console.info(
  `[Festival Visualizer] Anchored at Point State Park ` +
    `(${POINT_STATE_PARK.latitude}, ${POINT_STATE_PARK.longitude}); ` +
    `snap threshold ${SNAP_THRESHOLD_METERS} m.`,
);
