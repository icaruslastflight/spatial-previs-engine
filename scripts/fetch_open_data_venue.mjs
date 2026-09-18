#!/usr/bin/env node
/**
 * Open-data venue model fetcher — "Layer 2" of the outdoor-venue design.
 *
 * Builds a persistent, redistributable site model of a venue from public
 * online sources and writes it where `showcase/open-data-venue.html` expects
 * it (`public/assets/scans/open_data/<venue>/`):
 *
 *   terrain.json    5 m orthometric elevation grid decoded from AWS Open Data
 *                   "Terrain Tiles" (Mapzen terrarium PNG, zoom 15; USGS NED /
 *                   SRTM upstream). Row 0 = north edge, col 0 = west edge.
 *   ortho_naip.jpg  USGS NAIP orthoimagery for the identical bbox, via the
 *                   nationalmap.gov WMS. Public domain (US federal).
 *   osm.json        OpenStreetMap buildings (with `height` / `building:levels`
 *                   provenance), park polygons, bridge and road centrelines,
 *                   river shoreline outers. ODbL — © OpenStreetMap contributors.
 *   provenance.json What was fetched, from where, under which licence.
 *
 *     npm run fetch:open-data                 # Point State Park, defaults
 *     node scripts/fetch_open_data_venue.mjs --verify   # check the cache, no network
 *     node scripts/fetch_open_data_venue.mjs --force    # re-download everything
 *     node scripts/fetch_open_data_venue.mjs --venue hart_plaza \
 *         --bbox -83.052,42.325,-83.040,42.332 --park-name "Hart Plaza"
 *
 * THE OUTPUT IS GIT-IGNORED
 * -------------------------
 * Roughly 1.2 MB per venue, all regenerable from this script — CLAUDE.md §11
 * keeps that kind of artifact out of the repository, exactly like the splat
 * stand-in and the GDTF cache. A fresh clone runs this once; the showcase page
 * says so when the files are missing.
 *
 * HEIGHTS ARE ORTHOMETRIC — THE PAGE CONVERTS
 * -------------------------------------------
 * Terrarium tiles publish sea-level (geoid) heights. This script writes them
 * untouched and says so in the file. The consumer applies the site's geoid
 * separation and frame offset from `SITE_ELEVATION` (`src/geo/GeoAnchor.ts`)
 * before the vertices go through `SITE_FRAME` — the two numbers are never
 * repeated here (CLAUDE.md §2).
 *
 * WHAT IS DELIBERATELY NOT FETCHED
 * --------------------------------
 * Google Photorealistic 3D Tiles ("Layer 1") is a streamed, key-gated runtime
 * layer whose terms do not permit baking tiles into a persistent asset. It
 * stays in `CesiumGlobe.ts` at runtime and never becomes part of this model.
 *
 * NETWORK
 * -------
 * No keys, no accounts. Uses Node's built-in `fetch`; behind a corporate proxy
 * run with `NODE_USE_ENV_PROXY=1` (Node >= 22.21), which makes it honour
 * `HTTPS_PROXY`. Any fetch failure exits 1 — the data is required, not
 * optional, so silent partial output would be worse than none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { XMLParser } from 'fast-xml-parser';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRAIN_ZOOM = 15; // the highest zoom the terrarium bucket serves
const NAIP_WMS_URL =
  'https://imagery.nationalmap.gov/arcgis/services/USGSNAIPImagery/ImageServer/WMSServer';
const OSM_API_URL = 'https://api.openstreetmap.org/api/0.6/map';

const TILE_SIZE = 256;
const METRES_PER_DEGREE_LAT = 111_320;
const LEVEL_HEIGHT_M = 3.5; // OSM `building:levels` → metres, a stated estimate
const FEET_TO_METRES = 0.3048;

/** Always drawn, wherever they run. */
const MAJOR_ROADS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'secondary',
]);
/** Kept only where the way runs inside the named park polygon. */
const MINOR_ROADS = new Set([
  'tertiary',
  'residential',
  'unclassified',
  'service',
  'pedestrian',
  'footway',
  'path',
  'cycleway',
]);

const USAGE = `Fetch an open-data venue model (terrain, orthoimagery, OSM vectors).

  --venue <slug>        Output folder name under public/assets/scans/open_data/
                        Default: point_state_park
  --bbox w,s,e,n        Bounding box, signed decimal degrees (west is NEGATIVE)
                        Default: -80.0175,40.4370,-79.9990,40.4470 (Point State Park)
  --step <m>            Terrain grid spacing in metres. Default: 5
  --ortho-width <px>    Orthoimagery width; height follows the bbox aspect. Default: 2048
  --park-name <name>    leisure=park polygon that scopes minor roads and paths.
                        Default: "Point State Park"
  --out-dir <path>      Override the output folder entirely
  --force               Re-fetch layers that are already on disk
  --verify              Check the files on disk and exit; never touches the network
  --help                Show this text
`;

/* ─────────────────────────────────────────────────────────────────── */
/* CLI                                                                 */
/* ─────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const options = {
    venue: 'point_state_park',
    bbox: { west: -80.0175, south: 40.437, east: -79.999, north: 40.447 },
    step: 5,
    orthoWidth: 2048,
    parkName: 'Point State Park',
    outDir: null,
    force: false,
    verify: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value. Try --help.`);
      return value;
    };
    switch (arg) {
      case '--venue':
        options.venue = next();
        break;
      case '--bbox': {
        const parts = next().split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error('--bbox wants four numbers: west,south,east,north');
        }
        const [west, south, east, north] = parts;
        if (!(west < east && south < north)) throw new Error('--bbox must have west < east and south < north');
        options.bbox = { west, south, east, north };
        break;
      }
      case '--step':
        options.step = Number(next());
        if (!(options.step > 0)) throw new Error('--step must be a positive number of metres');
        break;
      case '--ortho-width':
        options.orthoWidth = Math.round(Number(next()));
        if (!(options.orthoWidth >= 256)) throw new Error('--ortho-width must be at least 256');
        break;
      case '--park-name':
        options.parkName = next();
        break;
      case '--out-dir':
        options.outDir = resolve(next());
        break;
      case '--force':
        options.force = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument ${arg}. Try --help.`);
    }
  }
  if (!options.outDir) {
    options.outDir = resolve(REPO_ROOT, 'public/assets/scans/open_data', options.venue);
  }
  return options;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Network                                                             */
/* ─────────────────────────────────────────────────────────────────── */

async function fetchBytes(url, { accept, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'spatial-previs-engine/open-data-fetch (https://github.com/icaruslastflight/spatial-previs-engine)',
          ...(accept ? { Accept: accept } : {}),
        },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = 1000 * 2 ** (attempt - 1);
        console.warn(`[open-data] ${url} failed (${error.message}); retrying in ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? 'unknown error'}`);
}

/* ─────────────────────────────────────────────────────────────────── */
/* PNG decode — enough of the spec for terrarium tiles, no dependency  */
/* ─────────────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function isPng(buffer) {
  return buffer.length > 8 && PNG_SIGNATURE.every((byte, i) => buffer[i] === byte);
}

function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // length + type + data + crc
  }
  const channels = PNG_CHANNELS[colorType];
  if (bitDepth !== 8 || !channels) {
    throw new Error(`unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}`);
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src++];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = cur;
          break;
        case 1:
          value = cur + a;
          break;
        case 2:
          value = cur + b;
          break;
        case 3:
          value = cur + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter byte ${filter} on row ${y}`);
      }
      out[row + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/* ─────────────────────────────────────────────────────────────────── */
/* Terrain                                                             */
/* ─────────────────────────────────────────────────────────────────── */

const lonToTileX = (lon, n) => ((lon + 180) / 360) * n;
const latToTileY = (lat, n) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};
const tileXToLon = (tx, n) => (tx / n) * 360 - 180;
const tileYToLat = (ty, n) => {
  const t = Math.PI - (2 * Math.PI * ty) / n;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
};

function metresPerDegreeLon(bbox) {
  const midLat = (bbox.south + bbox.north) / 2;
  return METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);
}

async function buildTerrain(bbox, step) {
  const z = TERRAIN_ZOOM;
  const n = 2 ** z;
  const x0 = Math.floor(lonToTileX(bbox.west, n));
  const x1 = Math.floor(lonToTileX(bbox.east, n));
  const y0 = Math.floor(latToTileY(bbox.north, n));
  const y1 = Math.floor(latToTileY(bbox.south, n));
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;
  if (tilesX * tilesY > 64) {
    throw new Error(`bbox spans ${tilesX * tilesY} terrain tiles; keep venues under a few km`);
  }

  const mosaicW = tilesX * TILE_SIZE;
  const mosaicH = tilesY * TILE_SIZE;
  const elevation = new Float32Array(mosaicW * mosaicH);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = `${TERRAIN_TILE_URL}/${z}/${tx}/${ty}.png`;
      console.log(`[open-data] terrain tile ${z}/${tx}/${ty}`);
      const bytes = await fetchBytes(url, { accept: 'image/png' });
      if (!isPng(bytes)) throw new Error(`${url} did not return a PNG (${bytes.length} bytes)`);
      const png = decodePng(bytes);
      if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) {
        throw new Error(`${url} is ${png.width}x${png.height}, expected ${TILE_SIZE}`);
      }
      const ox = (tx - x0) * TILE_SIZE;
      const oy = (ty - y0) * TILE_SIZE;
      for (let j = 0; j < TILE_SIZE; j++) {
        for (let i = 0; i < TILE_SIZE; i++) {
          const p = (j * TILE_SIZE + i) * png.channels;
          // Terrarium encoding: h = R * 256 + G + B / 256 - 32768, metres.
          elevation[(oy + j) * mosaicW + (ox + i)] =
            png.data[p] * 256 + png.data[p + 1] + png.data[p + 2] / 256 - 32768;
        }
      }
    }
  }

  // Resample the mercator mosaic onto a regular lon/lat grid at ~step metres.
  const cols = Math.round(((bbox.east - bbox.west) * metresPerDegreeLon(bbox)) / step) + 1;
  const rows = Math.round(((bbox.north - bbox.south) * METRES_PER_DEGREE_LAT) / step) + 1;
  const out = new Array(rows * cols);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < rows; r++) {
    const lat = bbox.north - ((bbox.north - bbox.south) * r) / (rows - 1); // row 0 = north
    const py = (latToTileY(lat, n) - y0) * TILE_SIZE;
    for (let c = 0; c < cols; c++) {
      const lon = bbox.west + ((bbox.east - bbox.west) * c) / (cols - 1);
      const px = (lonToTileX(lon, n) - x0) * TILE_SIZE;
      const ix = Math.max(0, Math.min(mosaicW - 2, Math.floor(px)));
      const iy = Math.max(0, Math.min(mosaicH - 2, Math.floor(py)));
      const fx = px - ix;
      const fy = py - iy;
      const h =
        elevation[iy * mosaicW + ix] * (1 - fx) * (1 - fy) +
        elevation[iy * mosaicW + ix + 1] * fx * (1 - fy) +
        elevation[(iy + 1) * mosaicW + ix] * (1 - fx) * fy +
        elevation[(iy + 1) * mosaicW + ix + 1] * fx * fy;
      out[r * cols + c] = Math.round(h * 10) / 10;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  return {
    source:
      'AWS Open Data "Terrain Tiles" (Mapzen terrarium encoding), zoom 15; upstream USGS NED / SRTM. ' +
      'Heights are ORTHOMETRIC metres (sea-level referenced), not WGS84 ellipsoidal.',
    license: 'Terrain Tiles: open data (see the AWS Open Data registry entry).',
    fetched: new Date().toISOString().slice(0, 10),
    vertical_datum: 'orthometric (NAVD88 / EGM96-derived, per tile source)',
    bbox,
    mosaic: {
      west: tileXToLon(x0, n),
      east: tileXToLon(x1 + 1, n),
      north: tileYToLat(y0, n),
      south: tileYToLat(y1 + 1, n),
    },
    rows,
    cols,
    step_m: step,
    order: 'row-major, row 0 = north edge, col 0 = west edge',
    min_m: Math.round(min * 10) / 10,
    max_m: Math.round(max * 10) / 10,
    elevation_m: out,
  };
}

/* ─────────────────────────────────────────────────────────────────── */
/* Orthoimagery                                                        */
/* ─────────────────────────────────────────────────────────────────── */

function orthoDimensions(bbox, width) {
  const widthM = (bbox.east - bbox.west) * metresPerDegreeLon(bbox);
  const heightM = (bbox.north - bbox.south) * METRES_PER_DEGREE_LAT;
  return { width, height: Math.round((width * heightM) / widthM) };
}

async function fetchOrtho(bbox, width) {
  const dims = orthoDimensions(bbox, width);
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'USGSNAIPImagery', // `LAYERS=0` answers "InvalidLayers" on this server
    STYLES: '',
    CRS: 'CRS:84', // lon,lat axis order, unlike EPSG:4326 in WMS 1.3.0
    BBOX: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    WIDTH: String(dims.width),
    HEIGHT: String(dims.height),
    FORMAT: 'image/jpeg',
  });
  const url = `${NAIP_WMS_URL}?${params}`;
  console.log(`[open-data] NAIP orthoimagery ${dims.width}x${dims.height}`);
  const bytes = await fetchBytes(url, { accept: 'image/jpeg' });
  // WMS reports errors as XML with a 200 status, so check the bytes, not the code.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`NAIP WMS did not return a JPEG: ${bytes.toString('utf8', 0, 300)}`);
  }
  return { bytes, dims };
}

/* ─────────────────────────────────────────────────────────────────── */
/* OpenStreetMap                                                       */
/* ─────────────────────────────────────────────────────────────────── */

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function parseHeight(tags) {
  const height = tags.height;
  if (height) {
    const match = /^\s*([\d.]+)\s*(m|ft|')?/.exec(height);
    if (match) {
      const value = Number(match[1]);
      const unit = match[2] ?? 'm';
      const metres = unit === 'm' ? value : value * FEET_TO_METRES;
      return { height_m: Math.round(metres * 10) / 10, height_source: 'osm:height' };
    }
  }
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return {
      height_m: Math.round(levels * LEVEL_HEIGHT_M * 10) / 10,
      height_source: `estimate:levels*${LEVEL_HEIGHT_M}m`,
    };
  }
  return { height_m: null, height_source: 'default' };
}

function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function extractOsm(xml, bbox, parkName) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    isArray: (name) => ['node', 'way', 'relation', 'tag', 'nd', 'member'].includes(name),
  });
  const root = parser.parse(xml).osm;
  if (!root) throw new Error('OSM response has no <osm> root');

  const nodes = new Map();
  for (const node of asArray(root.node)) {
    nodes.set(node.id, [
      Math.round(Number(node.lon) * 1e6) / 1e6,
      Math.round(Number(node.lat) * 1e6) / 1e6,
    ]);
  }
  const tagsOf = (el) => Object.fromEntries(asArray(el.tag).map((t) => [t.k, t.v]));
  const pointsOf = (way) =>
    asArray(way.nd)
      .map((nd) => nodes.get(nd.ref))
      .filter(Boolean);

  const ways = new Map(asArray(root.way).map((w) => [w.id, w]));
  const buildings = [];
  const water = [];
  const parks = [];
  const roadsAll = [];
  for (const [id, way] of ways) {
    const tags = tagsOf(way);
    const points = pointsOf(way);
    if (points.length < 2) continue;
    const closed =
      points.length >= 4 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1];
    const ring = closed ? points.slice(0, -1) : null;
    if (tags.building && ring) {
      buildings.push({ id, name: tags.name ?? null, ring, ...parseHeight(tags), building: tags.building });
    } else if (ring && (tags.natural === 'water' || tags.waterway === 'riverbank')) {
      water.push({ id, name: tags.name ?? null, ring });
    } else if (ring && tags.leisure === 'park') {
      parks.push({ id, name: tags.name ?? null, ring });
    } else if (tags.highway && (MAJOR_ROADS.has(tags.highway) || MINOR_ROADS.has(tags.highway))) {
      roadsAll.push({
        id,
        name: tags.name ?? null,
        highway: tags.highway,
        line: points,
        bridge: tags.bridge === 'yes',
        layer: tags.layer ?? null,
        lanes: tags.lanes ?? null,
      });
    }
  }

  // Minor roads and paths only matter inside the venue; the surrounding
  // street grid would otherwise dominate the vector layer.
  const parkRings = parks.filter((p) => p.name === parkName).map((p) => p.ring);
  const insidePark = (line) => {
    const mid = line[Math.floor(line.length / 2)];
    return parkRings.some((ring) => pointInRing(mid, ring));
  };
  const bridges = roadsAll.filter((r) => r.bridge);
  const roads = roadsAll.filter((r) => !r.bridge && (MAJOR_ROADS.has(r.highway) || insidePark(r.line)));

  // River multipolygons: keep the outer ways that fell inside the bbox as
  // open shoreline polylines. The full relation is never complete in a bbox
  // extract, so no attempt is made to close it.
  const shoreline = [];
  for (const relation of asArray(root.relation)) {
    const tags = tagsOf(relation);
    const isWater =
      tags.type === 'multipolygon' &&
      (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water === 'river' || tags.water === 'canal');
    if (!isWater) continue;
    for (const member of asArray(relation.member)) {
      if (member.type !== 'way' || !ways.has(member.ref)) continue;
      if (member.role !== 'outer' && member.role !== '') continue;
      const line = pointsOf(ways.get(member.ref));
      if (line.length >= 2) shoreline.push({ relation: relation.id, name: tags.name ?? null, way: member.ref, line });
    }
  }

  const bboxText = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  return {
    source: `OpenStreetMap via api.openstreetmap.org/api/0.6/map, bbox ${bboxText}`,
    license: 'ODbL 1.0 — © OpenStreetMap contributors',
    fetched: new Date().toISOString().slice(0, 10),
    counts: {
      buildings: buildings.length,
      with_height: buildings.filter((b) => b.height_source !== 'default').length,
      water_polygons: water.length,
      river_shoreline_ways: shoreline.length,
      parks: parks.length,
      roads: roads.length,
      bridges: bridges.length,
      note: `roads trimmed to major classes plus minor roads and paths inside the "${parkName}" polygon`,
    },
    buildings,
    water,
    shoreline,
    parks,
    roads,
    bridges,
  };
}

async function fetchOsm(bbox, parkName) {
  const url = `${OSM_API_URL}?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  console.log('[open-data] OpenStreetMap extract');
  const bytes = await fetchBytes(url, { accept: 'application/xml' });
  return extractOsm(bytes.toString('utf8'), bbox, parkName);
}

/* ─────────────────────────────────────────────────────────────────── */
/* Verify                                                              */
/* ─────────────────────────────────────────────────────────────────── */

function verify(outDir) {
  const problems = [];
  const need = (name) => {
    const path = resolve(outDir, name);
    if (!existsSync(path)) problems.push(`${name} is missing`);
    return path;
  };
  const terrainPath = need('terrain.json');
  const osmPath = need('osm.json');
  const orthoPath = need('ortho_naip.jpg');
  const provenancePath = need('provenance.json');
  if (problems.length) return problems;

  try {
    const terrain = JSON.parse(readFileSync(terrainPath, 'utf8'));
    if (!Array.isArray(terrain.elevation_m) || terrain.elevation_m.length !== terrain.rows * terrain.cols) {
      problems.push(`terrain.json: elevation_m has ${terrain.elevation_m?.length} samples, expected rows*cols = ${terrain.rows * terrain.cols}`);
    }
    if (!terrain.bbox || !(terrain.step_m > 0)) problems.push('terrain.json: bbox or step_m missing');
    if (terrain.elevation_m?.some((h) => !Number.isFinite(h))) problems.push('terrain.json: non-finite elevation sample');
  } catch (error) {
    problems.push(`terrain.json: ${error.message}`);
  }
  try {
    const osm = JSON.parse(readFileSync(osmPath, 'utf8'));
    for (const key of ['buildings', 'parks', 'bridges', 'shoreline', 'roads']) {
      if (!Array.isArray(osm[key])) problems.push(`osm.json: ${key} is not an array`);
    }
  } catch (error) {
    problems.push(`osm.json: ${error.message}`);
  }
  const jpeg = readFileSync(orthoPath);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) problems.push('ortho_naip.jpg: not a JPEG');
  try {
    JSON.parse(readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    problems.push(`provenance.json: ${error.message}`);
  }
  return problems;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Main                                                                */
/* ─────────────────────────────────────────────────────────────────── */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (options.verify) {
    const problems = verify(options.outDir);
    if (problems.length) {
      for (const p of problems) console.error(`[open-data] ${p}`);
      console.error(`[open-data] cache at ${options.outDir} is not usable; run without --verify to fetch`);
      return 1;
    }
    console.log(`[open-data] cache at ${options.outDir} verified`);
    return 0;
  }

  mkdirSync(options.outDir, { recursive: true });
  const { bbox, step, parkName } = options;
  const out = (name) => resolve(options.outDir, name);
  const present = (name) => !options.force && existsSync(out(name));
  const bboxText = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;

  let terrain;
  if (present('terrain.json')) {
    console.log('[open-data] terrain.json already present -- skipping (use --force)');
    terrain = JSON.parse(readFileSync(out('terrain.json'), 'utf8'));
  } else {
    terrain = await buildTerrain(bbox, step);
    writeFileSync(out('terrain.json'), JSON.stringify(terrain));
    console.log(`[open-data] terrain ${terrain.cols}x${terrain.rows} @ ${step} m, ${terrain.min_m}-${terrain.max_m} m orthometric`);
  }

  let orthoDims = orthoDimensions(bbox, options.orthoWidth);
  if (present('ortho_naip.jpg')) {
    console.log('[open-data] ortho_naip.jpg already present -- skipping (use --force)');
  } else {
    const ortho = await fetchOrtho(bbox, options.orthoWidth);
    orthoDims = ortho.dims;
    writeFileSync(out('ortho_naip.jpg'), ortho.bytes);
    console.log(`[open-data] orthoimagery ${ortho.bytes.length} bytes`);
  }

  let osm;
  if (present('osm.json')) {
    console.log('[open-data] osm.json already present -- skipping (use --force)');
    osm = JSON.parse(readFileSync(out('osm.json'), 'utf8'));
  } else {
    osm = await fetchOsm(bbox, parkName);
    writeFileSync(out('osm.json'), JSON.stringify(osm));
    console.log(`[open-data] OSM: ${JSON.stringify(osm.counts)}`);
  }

  const provenance = {
    venue: options.venue,
    purpose:
      'Layer 2 persistent open-data site model for showcase/open-data-venue.html. ' +
      'A demonstration asset built from public sources; not a survey.',
    generated: new Date().toISOString().slice(0, 10),
    generator: 'scripts/fetch_open_data_venue.mjs',
    bbox,
    anchor:
      'src/geo/GeoAnchor.ts POINT_STATE_PARK and SITE_ELEVATION are the single source of truth; ' +
      'their numbers are deliberately not repeated in this file.',
    vertical_datum_handling:
      'terrain.json heights are orthometric (sea-level). The consumer converts to WGS84 ellipsoidal ' +
      'with SITE_ELEVATION.geoidSeparationMeters + SITE_ELEVATION.frameOffsetMeters before SITE_FRAME, ' +
      'applied uniformly across the bbox.',
    layers: {
      terrain: {
        file: 'terrain.json',
        source: terrain.source,
        license: terrain.license,
        rows: terrain.rows,
        cols: terrain.cols,
        step_m: terrain.step_m,
        min_m: terrain.min_m,
        max_m: terrain.max_m,
      },
      orthoimagery: {
        file: 'ortho_naip.jpg',
        source: `USGS NAIP via imagery.nationalmap.gov WMS (USGSNAIPImagery), GetMap 1.3.0 CRS:84, bbox ${bboxText}, ${orthoDims.width}x${orthoDims.height} JPEG`,
        license: 'USGS / NAIP imagery -- public domain (US federal); verify current terms before redistribution',
      },
      vector: {
        file: 'osm.json',
        source: osm.source,
        license: osm.license,
        counts: osm.counts,
      },
    },
    not_included:
      'Google Photorealistic 3D Tiles (Layer 1) -- streamed at runtime only, key-gated; ' +
      'its terms do not permit persistent extraction.',
  };
  writeFileSync(out('provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

  const problems = verify(options.outDir);
  if (problems.length) {
    for (const p of problems) console.error(`[open-data] ${p}`);
    return 1;
  }
  console.log(`[open-data] wrote ${options.outDir}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[open-data] ${error.message}`);
    process.exit(1);
  },
);
