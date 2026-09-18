/**
 * Open-Data Venue Model — Phase 5 shape check.
 *
 * Renders "Layer 2" of the proposed outdoor-venue design: a persistent,
 * redistributable site model of Point State Park built entirely from public
 * online sources, placed through the repo's real anchor chain:
 *
 *   - terrain:  AWS Open Data "Terrain Tiles" (terrarium PNG, z15), decoded to
 *               a 5 m orthometric grid, converted to WGS84 ellipsoidal height
 *               with the SAME two corrections CLAUDE.md §2 requires for the
 *               anchor (GEOID18 −33.82 m, NAD83→ITRF2014 −1.217 m), then run
 *               through SITE_FRAME.geodeticToScene like every other vertex.
 *   - texture:  USGS NAIP orthoimagery for the identical bbox.
 *   - massing:  OpenStreetMap building footprints, extruded to OSM `height`
 *               where present, `building:levels` × 3.5 m where not, and a
 *               labelled default otherwise.
 *
 * Layer 1 (Google Photorealistic 3D Tiles) is deliberately absent: it is a
 * streamed, key-gated runtime layer whose terms do not permit baking it into
 * an asset, so it never becomes part of the model we own.
 *
 * document.body.dataset.ready = 'true'  → scene built, screenshot harness may fire.
 * document.body.dataset.ready = 'error' → build threw.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SITE_FRAME, SITE_ELEVATION, POINT_STATE_PARK } from '../src/geo/GeoAnchor.ts';
import { FOUNTAIN, FOUNTAIN_APEX, wgs84ToLocal } from '../src/geospatial/PointStateParkAnchor.ts';
import { loadSiteBounds } from '../src/viewport/SiteBounds.ts';
import { buildFestivalStage } from '../src/assets/FestivalStage.ts';

/* ─────────────────────────────────────────────────────────────────── */
/* Data shapes (written by the extract step that produced these files) */
/* ─────────────────────────────────────────────────────────────────── */

interface TerrainGrid {
  source: string;
  bbox: { west: number; south: number; east: number; north: number };
  rows: number;
  cols: number;
  step_m: number;
  min_m: number;
  max_m: number;
  /** Row-major, row 0 = north edge, col 0 = west edge. Orthometric metres. */
  elevation_m: number[];
}

type LonLat = [number, number];

interface OsmBuilding {
  id: string;
  name: string | null;
  ring: LonLat[];
  height_m: number | null;
  height_source: string;
}

interface OsmLine {
  name: string | null;
  line: LonLat[];
  highway?: string;
}

interface OsmPoly {
  name: string | null;
  ring: LonLat[];
}

interface OsmData {
  source: string;
  license: string;
  counts: Record<string, number | string>;
  buildings: OsmBuilding[];
  parks: OsmPoly[];
  bridges: OsmLine[];
  shoreline: OsmLine[];
  roads: OsmLine[];
}

/* ─────────────────────────────────────────────────────────────────── */
/* Constants                                                           */
/* ─────────────────────────────────────────────────────────────────── */

const BASE = import.meta.env.BASE_URL;
const DATA = `${BASE}assets/scans/open_data/point_state_park/`;

/**
 * Orthometric → WGS84 ellipsoidal, metres. The DEM publishes sea-level
 * heights; the scene frame is ellipsoidal. Same two per-site terms as the
 * anchor itself, never re-derived here.
 */
const ORTHO_TO_ELLIPSOIDAL_M =
  SITE_ELEVATION.geoidSeparationMeters + SITE_ELEVATION.frameOffsetMeters;

/** Used only when OSM has neither `height` nor `building:levels`. Labelled. */
const DEFAULT_BUILDING_HEIGHT_M = 12;

/** Bridge decks carry no height in OSM; drawn this far above local ground. */
const BRIDGE_DECK_ESTIMATE_M = 10;

/* ─────────────────────────────────────────────────────────────────── */
/* Renderer                                                            */
/* ─────────────────────────────────────────────────────────────────── */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb6d3);
scene.fog = new THREE.Fog(0xa9bfd8, 1200, 4200);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 8000);

/**
 * Two framings, chosen with `?view=`: `wide` (default) is the elevated
 * three-quarter view from over the Monongahela looking north-east — fountain
 * and rig in front, downtown behind, Fort Pitt Bridge to the left. `rig`
 * drops to eye height near the anchor so the stage reads at true scale
 * against the DEM ground it stands on.
 */
const VIEW = new URLSearchParams(window.location.search).get('view') === 'rig' ? 'rig' : 'wide';
const controls = new OrbitControls(camera, canvas);
if (VIEW === 'rig') {
  camera.position.set(-70, 26, 78);
  controls.target.set(-6, 6, -14);
} else {
  camera.position.set(-330, 125, 305);
  controls.target.set(30, 15, -95);
}
controls.enableDamping = true;
controls.update();

scene.add(new THREE.HemisphereLight(0xd8e6ff, 0x4a4636, 0.85));
const sun = new THREE.DirectionalLight(0xfff0d8, 1.7);
sun.position.set(-500, 700, 300);
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ─────────────────────────────────────────────────────────────────── */
/* Geodesy helpers                                                     */
/* ─────────────────────────────────────────────────────────────────── */

let terrain: TerrainGrid;

/** Bilinear orthometric height at a lon/lat inside the grid, metres. */
function sampleOrthometric(lon: number, lat: number): number {
  const { bbox, rows, cols, elevation_m } = terrain;
  const fc = ((lon - bbox.west) / (bbox.east - bbox.west)) * (cols - 1);
  const fr = ((bbox.north - lat) / (bbox.north - bbox.south)) * (rows - 1);
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(fr)));
  const tx = Math.max(0, Math.min(1, fc - c0));
  const ty = Math.max(0, Math.min(1, fr - r0));
  const h00 = elevation_m[r0 * cols + c0]!;
  const h01 = elevation_m[r0 * cols + c0 + 1]!;
  const h10 = elevation_m[(r0 + 1) * cols + c0]!;
  const h11 = elevation_m[(r0 + 1) * cols + c0 + 1]!;
  return h00 * (1 - tx) * (1 - ty) + h01 * tx * (1 - ty) + h10 * (1 - tx) * ty + h11 * tx * ty;
}

/** Geodetic (orthometric height) → scene metres, via the anchor chain. */
function toScene(lon: number, lat: number, orthometricM: number, target = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = SITE_FRAME.geodeticToScene({
    latitude: lat,
    longitude: lon,
    height: orthometricM + ORTHO_TO_ELLIPSOIDAL_M,
  });
  return target.set(x, y, z);
}

/** Scene position on the DEM surface, lifted by `above` metres. */
function onGround(lon: number, lat: number, above = 0): THREE.Vector3 {
  return toScene(lon, lat, sampleOrthometric(lon, lat) + above);
}

/**
 * The OSM API returns whole ways that merely touch the bbox, so a bridge or
 * road can run well past the terrain's edge, where the DEM sample clamps and
 * the line would float in the sky. Keep only the vertices the grid covers.
 */
function insideBbox([lon, lat]: LonLat): boolean {
  const { bbox } = terrain;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Layer builders                                                      */
/* ─────────────────────────────────────────────────────────────────── */

function buildTerrain(texture: THREE.Texture): THREE.Mesh {
  const { bbox, rows, cols } = terrain;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const scratch = new THREE.Vector3();

  for (let r = 0; r < rows; r++) {
    const lat = bbox.north - ((bbox.north - bbox.south) * r) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const lon = bbox.west + ((bbox.east - bbox.west) * c) / (cols - 1);
      toScene(lon, lat, terrain.elevation_m[r * cols + c]!, scratch);
      const i = r * cols + c;
      positions[i * 3] = scratch.x;
      positions[i * 3 + 1] = scratch.y;
      positions[i * 3 + 2] = scratch.z;
      // Row 0 is the north edge; the JPEG's top row is north; flipY leaves v=1 at top.
      uvs[i * 2] = c / (cols - 1);
      uvs[i * 2 + 1] = 1 - r / (rows - 1);
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain-open-data';
  return mesh;
}

interface BuildingStats {
  measured: number;
  estimated: number;
  defaulted: number;
}

function buildBuildings(osm: OsmData): { group: THREE.Group; stats: BuildingStats } {
  const buckets: Record<keyof BuildingStats, THREE.BufferGeometry[]> = { measured: [], estimated: [], defaulted: [] };
  const stats: BuildingStats = { measured: 0, estimated: 0, defaulted: 0 };
  const rotate = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const translate = new THREE.Matrix4();
  const point = new THREE.Vector3();

  for (const building of osm.buildings) {
    if (building.ring.length < 3) continue;

    let lonSum = 0;
    let latSum = 0;
    for (const [lon, lat] of building.ring) {
      lonSum += lon;
      latSum += lat;
    }
    const cLon = lonSum / building.ring.length;
    const cLat = latSum / building.ring.length;
    if (!insideBbox([cLon, cLat])) continue;
    const baseY = onGround(cLon, cLat).y;

    const bucket: keyof BuildingStats = building.height_m === null
      ? 'defaulted'
      : building.height_source === 'osm:height'
        ? 'measured'
        : 'estimated';
    const height = building.height_m ?? DEFAULT_BUILDING_HEIGHT_M;
    stats[bucket] += 1;

    // Shape lives in the XY plane; after rotateX(-90°) shape +Y becomes -Z, so
    // feed (x, -z) and the footprint lands back on the ground plane. Sink the
    // base 2 m so nothing floats on a sloped block.
    const shape = new THREE.Shape();
    building.ring.forEach(([lon, lat], index) => {
      toScene(lon, lat, 0, point);
      if (index === 0) shape.moveTo(point.x, -point.z);
      else shape.lineTo(point.x, -point.z);
    });
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height + 2, bevelEnabled: false });
    geometry.applyMatrix4(rotate);
    geometry.applyMatrix4(translate.makeTranslation(0, baseY - 2, 0));
    buckets[bucket].push(geometry);
  }

  const group = new THREE.Group();
  group.name = 'buildings-osm';
  const materials: Record<keyof BuildingStats, THREE.Material> = {
    measured: new THREE.MeshStandardMaterial({ color: 0xc9c3b6, roughness: 0.8, flatShading: true }),
    estimated: new THREE.MeshStandardMaterial({ color: 0x9ea6b0, roughness: 0.85, flatShading: true }),
    defaulted: new THREE.MeshStandardMaterial({ color: 0x6d7580, roughness: 0.9, flatShading: true }),
  };
  for (const key of Object.keys(buckets) as (keyof BuildingStats)[]) {
    if (buckets[key].length === 0) continue;
    const merged = mergeGeometries(buckets[key], false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, materials[key]);
    mesh.name = `buildings-${key}`;
    group.add(mesh);
  }
  return { group, stats };
}

function polyline(points: THREE.Vector3[], color: number, opacity = 1): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

function buildVectors(osm: OsmData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'vectors-osm';

  const clipped = (line: LonLat[], above: number): THREE.Vector3[] =>
    line.filter(insideBbox).map(([lon, lat]) => onGround(lon, lat, above));

  for (const bridge of osm.bridges) {
    const points = clipped(bridge.line, BRIDGE_DECK_ESTIMATE_M);
    if (points.length >= 2) group.add(polyline(points, 0xffd166, 0.95));
  }
  for (const shore of osm.shoreline) {
    const points = clipped(shore.line, 0.4);
    if (points.length >= 2) group.add(polyline(points, 0x5fb8ff, 0.9));
  }
  for (const park of osm.parks) {
    if (park.name !== 'Point State Park' || park.ring.length < 3) continue;
    const points = park.ring.map(([lon, lat]) => onGround(lon, lat, 0.6));
    points.push(points[0]!.clone());
    group.add(polyline(points, 0x7dd3a8, 1));
  }
  for (const road of osm.roads) {
    const inPark = road.highway === 'footway' || road.highway === 'pedestrian' || road.highway === 'path';
    if (!inPark) continue;
    const points = clipped(road.line, 0.3);
    if (points.length >= 2) group.add(polyline(points, 0xffffff, 0.35));
  }
  return group;
}

function buildFountain(groundYAtBasin: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'fountain-landmark';
  const basin = wgs84ToLocal(FOUNTAIN.basin);
  const apex = wgs84ToLocal(FOUNTAIN_APEX);
  const columnHeight = apex.y - basin.y;
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 2.4, columnHeight, 16),
    new THREE.MeshStandardMaterial({ color: 0xdff4ff, emissive: 0x6ec6ff, emissiveIntensity: 0.35, transparent: true, opacity: 0.7 }),
  );
  column.position.set(basin.x, groundYAtBasin + columnHeight / 2, basin.z);
  group.add(column);
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(14, 32),
    new THREE.MeshStandardMaterial({ color: 0x3f8fd6, roughness: 0.2 }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(basin.x, groundYAtBasin + 0.5, basin.z);
  group.add(pool);
  return group;
}

/* ─────────────────────────────────────────────────────────────────── */
/* HUD                                                                 */
/* ─────────────────────────────────────────────────────────────────── */

function row(k: string, v: string, warn = false): string {
  return `<tr><td class="k">${k}</td><td class="v${warn ? ' warn' : ''}">${v}</td></tr>`;
}

function legendRow(color: string, text: string, source: string): string {
  return `<div class="row"><span class="swatch" style="background:${color}"></span><div>${text}<br><span class="src">${source}</span></div></div>`;
}

function renderHud(
  osm: OsmData,
  stats: BuildingStats,
  demAtAnchor: number,
  rigLiftM: number,
  orthoSize: string,
): void {
  const demDelta = demAtAnchor - SITE_ELEVATION.orthometricMeters;
  const table = document.getElementById('datum-table') as HTMLTableElement;
  table.innerHTML = [
    row('anchor', `${POINT_STATE_PARK.latitude.toFixed(4)}°, ${POINT_STATE_PARK.longitude.toFixed(4)}°`),
    row('H orthometric (spec)', `${SITE_ELEVATION.orthometricMeters.toFixed(3)} m`),
    row('N geoid (GEOID18)', `${SITE_ELEVATION.geoidSeparationMeters.toFixed(3)} m`),
    row('d frame (NAD83→ITRF)', `${SITE_ELEVATION.frameOffsetMeters.toFixed(3)} m`),
    row('h ellipsoidal (scene y = 0)', `${SITE_ELEVATION.ellipsoidalMeters.toFixed(3)} m`),
    row('DEM at anchor (ortho)', `${demAtAnchor.toFixed(2)} m`),
    row('DEM − spec residual', `${demDelta >= 0 ? '+' : ''}${demDelta.toFixed(2)} m`, Math.abs(demDelta) > 0.5),
    row('rig lifted onto DEM ground', `${rigLiftM >= 0 ? '+' : ''}${rigLiftM.toFixed(2)} m`),
    row('DEM range in bbox', `${terrain.min_m.toFixed(1)} – ${terrain.max_m.toFixed(1)} m`),
    row('grid', `${terrain.cols} × ${terrain.rows} @ ${terrain.step_m} m`),
    row('UE5 anchor', 'none yet · §1.1 open', true),
  ].join('');

  const legend = document.getElementById('legend-rows') as HTMLDivElement;
  legend.innerHTML = [
    legendRow('#8a9a6a', 'Terrain surface, orthometric → ellipsoidal, through SITE_FRAME', 'AWS Open Data Terrain Tiles (terrarium z15, USGS NED/SRTM upstream)'),
    legendRow('#b8a888', 'Orthoimagery draped on the terrain', `USGS NAIP, ${orthoSize} for the same bbox`),
    legendRow('#c9c3b6', `Buildings, OSM height (${stats.measured})`, 'OpenStreetMap © contributors, ODbL'),
    legendRow('#9ea6b0', `Buildings, levels × 3.5 m estimate (${stats.estimated})`, 'OpenStreetMap building:levels'),
    legendRow('#6d7580', `Buildings, ${DEFAULT_BUILDING_HEIGHT_M} m default (${stats.defaulted})`, 'no height data — labelled default'),
    legendRow('#ffd166', `Bridges (${osm.bridges.length}), deck +${BRIDGE_DECK_ESTIMATE_M} m estimate`, 'OSM bridge=yes centrelines'),
    legendRow('#7dd3a8', 'Point State Park boundary · in-park paths', 'OSM leisure=park / highway=footway'),
    legendRow('#5fb8ff', 'River shorelines · fountain landmark (46 m column)', 'OSM multipolygon outers · PointStateParkAnchor.ts'),
    legendRow('#35d6a0', 'Site envelope (placeholder GeoJSON)', 'public/assets/scans/point-state-park-bounds.geojson'),
    legendRow('#ff7a1a', 'Festival stage rig at the anchor, for scale', 'src/assets/FestivalStage.ts — the same rig the concert demo lights'),
  ].join('');
}

/* ─────────────────────────────────────────────────────────────────── */
/* Build                                                               */
/* ─────────────────────────────────────────────────────────────────── */

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (response.status === 404) {
    // The data folder is git-ignored (CLAUDE.md §11); a fresh clone has to
    // regenerate it once. Say so instead of surfacing a bare 404.
    throw new Error(`${url} is missing — run \`npm run fetch:open-data\` to regenerate the open-data layers`);
  }
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  status.textContent = 'fetching open-data layers…';
  const [terrainData, osm, texture, bounds] = await Promise.all([
    fetchJson<TerrainGrid>(`${DATA}terrain.json`),
    fetchJson<OsmData>(`${DATA}osm.json`),
    new THREE.TextureLoader().loadAsync(`${DATA}ortho_naip.jpg`),
    loadSiteBounds(`${BASE}assets/scans/point-state-park-bounds.geojson`),
  ]);
  terrain = terrainData;

  status.textContent = 'building terrain and massing…';
  scene.add(buildTerrain(texture));
  const { group: buildings, stats } = buildBuildings(osm);
  scene.add(buildings);
  scene.add(buildVectors(osm));
  scene.add(bounds.object);

  const demAtAnchor = sampleOrthometric(POINT_STATE_PARK.longitude, POINT_STATE_PARK.latitude);
  const groundAtAnchor = onGround(POINT_STATE_PARK.longitude, POINT_STATE_PARK.latitude);
  const groundAtBasin = onGround(FOUNTAIN.basin.longitude, FOUNTAIN.basin.latitude);
  scene.add(buildFountain(groundAtBasin.y));

  status.textContent = 'placing the stage rig…';
  const stage = await buildFestivalStage({ baseUrl: BASE, placeFixtureProps: true });
  // Rig feet sit on the DEM ground, not on the spec's 220 m plane, so the
  // residual between survey drawing and DEM is visible rather than hidden.
  stage.group.position.set(groundAtAnchor.x, groundAtAnchor.y, groundAtAnchor.z);
  stage.group.rotation.y = Math.PI; // audience side toward the fountain and the rivers
  scene.add(stage.group);

  const image = texture.image as { width?: number; height?: number } | undefined;
  const orthoSize = image?.width && image?.height ? `${image.width}×${image.height}` : 'size unknown';
  renderHud(osm, stats, demAtAnchor, groundAtAnchor.y, orthoSize);

  status.innerHTML =
    `<b>ready</b> · terrain ${terrain.cols}×${terrain.rows} @ ${terrain.step_m} m · ` +
    `${stats.measured + stats.estimated + stats.defaulted}/${osm.buildings.length} buildings in bbox (${stats.measured} measured) · ` +
    `${osm.bridges.length} bridges · DEM − spec ${(demAtAnchor - SITE_ELEVATION.orthometricMeters).toFixed(2)} m`;

  renderer.render(scene, camera);
  document.body.dataset.ready = 'true';
}

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

main()
  .then(animate)
  .catch((error: unknown) => {
    console.error(error);
    status.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
    document.body.dataset.ready = 'error';
  });
