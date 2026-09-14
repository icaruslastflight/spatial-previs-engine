/**
 * GDTF (General Device Type Format, DIN SPEC 15800) archive unpacking, XML
 * profile parsing, and `extras.sockets` injection.
 *
 * A `.gdtf` file is a ZIP archive: `description.xml` at its root plus 3D
 * models under `models/gltf/` (GLB, preferred) and `models/3ds/`. This module
 * only reads the glTF path -- this project has no 3DS importer and does not
 * need one, since every fixture on the Phase 3 target list (Robe MegaPointe,
 * Martin MAC Aura, Claypaky Sharpy, GLP JDC1) ships glTF geometry on GDTF
 * Share.
 *
 * SCOPE: this project's target fixtures are conventional moving-head washes
 * and spots, so `GdtfGeometryKind` gives first-class treatment to `Geometry`,
 * `Axis` and `Beam` only. Media server, laser and display geometry types
 * parse structurally (the tree still walks through them) but fall back to
 * `'Other'` rather than getting dedicated fields -- there is nothing in the
 * target list that needs them, and guessing at their semantics without a
 * fixture to test against would be worse than an honest fallback.
 *
 * `DMXValue` attributes (`Default`, `Highlight`, `ChannelFunction.Default`)
 * are extracted as their raw spec-format strings (e.g. `"255/1"`, the
 * byte-mirroring notation from DIN SPEC 15800), not decoded to a resolved
 * numeric level. Decoding needs the channel's byte resolution, which is a
 * DMX-engine concern (Phase 4), not a parsing one -- Task 3.2 asks this
 * module to extract those values, not interpret them.
 */

import * as THREE from 'three';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import type { SocketDefinition } from './SocketSnappingEngine.ts';

/* -------------------------------------------------------------------------- */
/* Parsed profile shape                                                       */
/* -------------------------------------------------------------------------- */

export interface GdtfModel {
  name: string;
  /** Metres. 0 when the profile omits a dimension. */
  lengthMeters: number;
  widthMeters: number;
  heightMeters: number;
  primitiveType: string;
  /** Base filename (no extension, no subfolder) inside `models/gltf/`, or null. */
  file: string | null;
}

/** See the module header for why only these three get dedicated handling. */
export type GdtfGeometryKind = 'Geometry' | 'Axis' | 'Beam' | 'Other';

export interface GdtfBeamProperties {
  lampType: string | null;
  powerConsumptionWatts: number | null;
  luminousFluxLumens: number | null;
  colorTemperatureKelvin: number | null;
  beamAngleDegrees: number | null;
  fieldAngleDegrees: number | null;
  beamType: string | null;
}

export interface GdtfGeometryNode {
  kind: GdtfGeometryKind;
  /** The XML tag name this node was read from, e.g. "Axis", "MediaServerLayer". */
  tagName: string;
  name: string;
  /** Links to `GdtfModel.name`, or null (some Axis nodes carry no model). */
  model: string | null;
  /** LOCAL transform relative to the parent node, GDTF-space (Z-up), as authored. */
  matrix: THREE.Matrix4;
  /** Populated only when `kind === 'Beam'`. */
  beam: GdtfBeamProperties | null;
  children: GdtfGeometryNode[];
}

export interface GdtfChannelFunction {
  name: string;
  physicalFrom: number;
  physicalTo: number;
  /** Raw DMXValue string, e.g. "0" or "255/1". See module header. */
  defaultValue: string;
}

export interface GdtfLogicalChannel {
  attribute: string;
  channelFunctions: GdtfChannelFunction[];
}

export interface GdtfDmxChannel {
  geometry: string | null;
  /** DMX universe offset(s); multi-byte channels list coarse-to-fine, e.g. [1, 2]. */
  offset: number[];
  dmxBreak: number | string;
  defaultValue: string;
  highlight: string | null;
  logicalChannels: GdtfLogicalChannel[];
}

export interface GdtfDmxMode {
  name: string;
  geometry: string | null;
  channels: GdtfDmxChannel[];
  /** Highest DMX offset used by this mode. GDTF does not publish this directly. */
  footprint: number;
}

export interface GdtfFixtureType {
  name: string;
  shortName: string;
  manufacturer: string;
  description: string;
  fixtureTypeId: string;
  thumbnail: string | null;
  models: GdtfModel[];
  geometries: GdtfGeometryNode[];
  dmxModes: GdtfDmxMode[];
}

export interface GdtfArchive {
  descriptionXml: string;
  /** Keyed by base filename (no extension), matching `GdtfModel.file`. */
  modelFiles: Map<string, Uint8Array>;
}

/* -------------------------------------------------------------------------- */
/* Matrix parsing and the GDTF -> Three axis bridge                           */
/* -------------------------------------------------------------------------- */

const MATRIX_ROW_RE = /\{([^{}]*)\}/g;

/**
 * Parse a GDTF `Matrix` attribute: four `{a,b,c,d}` groups, one per row, row-
 * major. Missing or malformed input falls back to identity with a warning --
 * a fixture that fails to parse should still stand somewhere sane, not throw
 * away every other geometry node in the same tree.
 */
export function parseGdtfMatrix(text: string | null | undefined): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (text === null || text === undefined || text.length === 0) return matrix;

  const rows: number[][] = [];
  for (const match of text.matchAll(MATRIX_ROW_RE)) {
    rows.push(match[1]!.split(',').map(Number));
  }
  if (rows.length !== 4 || rows.some((row) => row.length !== 4 || row.some((n) => !Number.isFinite(n)))) {
    console.warn(`[GDTFParser] Malformed Matrix "${text}"; using identity.`);
    return matrix;
  }

  // GDTF serializes row-major (each {} group IS one row). THREE.Matrix4.set()
  // also takes its 16 arguments in row-major reading order -- n11..n14 is row
  // 1, and so on -- even though .elements is column-major internally, so the
  // four groups transcribe directly with no transpose.
  const [r0, r1, r2, r3] = rows as [number[], number[], number[], number[]];
  matrix.set(
    r0[0]!, r0[1]!, r0[2]!, r0[3]!,
    r1[0]!, r1[1]!, r1[2]!, r1[3]!,
    r2[0]!, r2[1]!, r2[2]!, r2[3]!,
    r3[0]!, r3[1]!, r3[2]!, r3[3]!,
  );
  return matrix;
}

/**
 * Change of basis from GDTF's own coordinate convention -- right-handed,
 * Z-up, +Y away from the viewer (DIN SPEC 15800's own definition; nothing to
 * do with WGS84/ENU) -- into Three's right-handed Y-up convention.
 *
 * Framed as `P * M * P^-1` rather than a per-point remap so a node's full
 * local transform -- rotation AND translation -- comes out right; remapping
 * only the translation would leave every fixture's internal rotations wrong.
 * `P` is a pure axis permutation (det +1, orthogonal), so `P^-1 = P^T` and no
 * matrix inversion is needed.
 *
 * The resulting axis relationship -- three.x=gdtf.x, three.y=gdtf.z,
 * three.z=-gdtf.y -- is numerically identical in form to `SITE_FRAME`'s ENU
 * bridge in `GeoAnchor.ts` (three.x=+East, three.y=+Up, three.z=-North).
 * That is a coincidence of two unrelated Z-up conventions, not a reason to
 * share code: this is fixture-local geometry, not geodesy, so it stays its
 * own helper rather than borrowing `EnuFrame`'s geodesy-specific types --
 * CLAUDE.md's "do not hand-roll geodetic math elsewhere," inverted, is "do
 * not borrow geodetic types elsewhere."
 */
const GDTF_TO_THREE_BASIS = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
);
const GDTF_TO_THREE_BASIS_INVERSE = GDTF_TO_THREE_BASIS.clone().transpose();

export function gdtfSpaceToThreeSpace(
  gdtfMatrix: THREE.Matrix4,
  target: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
  return target.copy(GDTF_TO_THREE_BASIS).multiply(gdtfMatrix).multiply(GDTF_TO_THREE_BASIS_INVERSE);
}

/* -------------------------------------------------------------------------- */
/* Archive unpacking                                                          */
/* -------------------------------------------------------------------------- */

const GLTF_MODEL_PATH_RE = /^models\/gltf\//i;

/** Unzip a `.gdtf` archive into its description XML and glTF model payloads. */
export function unpackGdtfArchive(bytes: Uint8Array): GdtfArchive {
  const files = unzipSync(bytes);

  const descriptionBytes = files['description.xml'];
  if (descriptionBytes === undefined) {
    throw new Error('[GDTFParser] Archive has no description.xml at its root.');
  }
  const descriptionXml = new TextDecoder('utf-8').decode(descriptionBytes);

  const modelFiles = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (!GLTF_MODEL_PATH_RE.test(path)) continue;
    // Model.File in the XML has no extension and no subfolder -- keying on
    // the bare basename here means a Geometry's `model` name looks it up
    // directly, with no path reconstruction at the call site.
    const baseName = path.slice(path.lastIndexOf('/') + 1).replace(/\.glb$/i, '');
    modelFiles.set(baseName, data);
  }
  return { descriptionXml, modelFiles };
}

/* -------------------------------------------------------------------------- */
/* XML parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Tag names that must always parse to an array, regardless of how many
 * siblings are present in a given file. fast-xml-parser collapses a single
 * repeated child to a bare object by default; every one of these can
 * legitimately appear exactly once (a fixture with one DMX mode, one Axis),
 * and code below assumes an array either way.
 */
const GEOMETRY_TAG_NAMES = [
  'Geometry', 'Axis', 'Beam',
  'FilterBeam', 'FilterColor', 'FilterGobo', 'FilterShaper',
  'MediaServerLayer', 'MediaServerCamera', 'MediaServerMaster', 'Display', 'Laser',
  'GeometryReference', 'WiringObject', 'Inventory', 'Structure', 'Support', 'Magnet',
] as const;

const FORCE_ARRAY_TAG_NAMES = new Set<string>([
  ...GEOMETRY_TAG_NAMES,
  'Model', 'DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'ChannelSet',
]);

type XmlNode = Record<string, unknown>;

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseOffset(raw: string | null): number[] {
  if (raw === null || raw === 'None') return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function parseBeamProperties(node: XmlNode): GdtfBeamProperties {
  return {
    lampType: readString(node['@_LampType']),
    powerConsumptionWatts: readNumber(node['@_PowerConsumption']),
    luminousFluxLumens: readNumber(node['@_LuminousFlux']),
    colorTemperatureKelvin: readNumber(node['@_ColorTemperature']),
    beamAngleDegrees: readNumber(node['@_BeamAngle']),
    fieldAngleDegrees: readNumber(node['@_FieldAngle']),
    beamType: readString(node['@_BeamType']),
  };
}

function parseGeometryNode(tagName: string, node: XmlNode): GdtfGeometryNode {
  const kind: GdtfGeometryKind =
    tagName === 'Geometry' || tagName === 'Axis' || tagName === 'Beam' ? tagName : 'Other';
  return {
    kind,
    tagName,
    name: readString(node['@_Name']) ?? 'Unnamed',
    model: readString(node['@_Model']),
    matrix: parseGdtfMatrix(readString(node['@_Position'])),
    beam: kind === 'Beam' ? parseBeamProperties(node) : null,
    children: collectGeometryChildren(node),
  };
}

/**
 * Flatten every geometry-typed child of `node` across all known tag names
 * into one array. Order is grouped by tag name (all `Axis` children, then
 * all `Beam` children, ...) rather than strict document order across mixed
 * sibling tag names -- this project's target fixtures never interleave
 * different geometry tag names under one parent, so that distinction does
 * not arise in practice.
 */
function collectGeometryChildren(node: XmlNode): GdtfGeometryNode[] {
  const children: GdtfGeometryNode[] = [];
  for (const tagName of GEOMETRY_TAG_NAMES) {
    const entries = node[tagName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      children.push(parseGeometryNode(tagName, entry as XmlNode));
    }
  }
  return children;
}

function parseModel(node: XmlNode): GdtfModel {
  return {
    name: readString(node['@_Name']) ?? '',
    lengthMeters: readNumber(node['@_Length']) ?? 0,
    widthMeters: readNumber(node['@_Width']) ?? 0,
    heightMeters: readNumber(node['@_Height']) ?? 0,
    primitiveType: readString(node['@_PrimitiveType']) ?? 'Cube',
    file: readString(node['@_File']),
  };
}

function parseChannelFunction(node: XmlNode): GdtfChannelFunction {
  return {
    name: readString(node['@_Name']) ?? '',
    physicalFrom: readNumber(node['@_PhysicalFrom']) ?? 0,
    physicalTo: readNumber(node['@_PhysicalTo']) ?? 1,
    defaultValue: readString(node['@_Default']) ?? '0',
  };
}

function parseLogicalChannel(node: XmlNode): GdtfLogicalChannel {
  const functions = node['ChannelFunction'];
  return {
    attribute: readString(node['@_Attribute']) ?? '',
    channelFunctions: Array.isArray(functions)
      ? functions.map((f) => parseChannelFunction(f as XmlNode))
      : [],
  };
}

function parseDmxChannel(node: XmlNode): GdtfDmxChannel {
  const logicalChannels = node['LogicalChannel'];
  return {
    geometry: readString(node['@_Geometry']),
    offset: parseOffset(readString(node['@_Offset'])),
    dmxBreak: (readNumber(node['@_DMXBreak']) ?? readString(node['@_DMXBreak'])) ?? 1,
    defaultValue: readString(node['@_Default']) ?? '0',
    highlight: readString(node['@_Highlight']),
    logicalChannels: Array.isArray(logicalChannels)
      ? logicalChannels.map((c) => parseLogicalChannel(c as XmlNode))
      : [],
  };
}

function parseDmxMode(node: XmlNode): GdtfDmxMode {
  const channelsWrapper = node['DMXChannels'] as XmlNode | undefined;
  const channelNodes = channelsWrapper?.['DMXChannel'];
  const channels = Array.isArray(channelNodes) ? channelNodes.map((c) => parseDmxChannel(c as XmlNode)) : [];
  const footprint = channels.reduce((max, ch) => Math.max(max, 0, ...ch.offset), 0);
  return {
    name: readString(node['@_Name']) ?? '',
    geometry: readString(node['@_Geometry']),
    channels,
    footprint,
  };
}

/** Parse a GDTF `description.xml` document into a typed fixture profile. */
export function parseDescriptionXml(xml: string): GdtfFixtureType {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: true,
    isArray: (tagName) => FORCE_ARRAY_TAG_NAMES.has(tagName),
  });
  const doc = parser.parse(xml) as XmlNode;
  const gdtfRoot = doc['GDTF'] as XmlNode | undefined;
  const fixtureType = gdtfRoot?.['FixtureType'] as XmlNode | undefined;
  if (fixtureType === undefined) {
    throw new Error('[GDTFParser] description.xml has no <GDTF><FixtureType> root.');
  }

  const modelsWrapper = fixtureType['Models'] as XmlNode | undefined;
  const modelNodes = modelsWrapper?.['Model'];
  const geometriesWrapper = fixtureType['Geometries'] as XmlNode | undefined;
  const dmxModesWrapper = fixtureType['DMXModes'] as XmlNode | undefined;
  const dmxModeNodes = dmxModesWrapper?.['DMXMode'];

  return {
    name: readString(fixtureType['@_Name']) ?? 'Unnamed Fixture',
    shortName: readString(fixtureType['@_ShortName']) ?? '',
    manufacturer: readString(fixtureType['@_Manufacturer']) ?? '',
    description: readString(fixtureType['@_Description']) ?? '',
    fixtureTypeId: readString(fixtureType['@_FixtureTypeID']) ?? '',
    thumbnail: readString(fixtureType['@_Thumbnail']),
    models: Array.isArray(modelNodes) ? modelNodes.map((m) => parseModel(m as XmlNode)) : [],
    geometries: geometriesWrapper !== undefined ? collectGeometryChildren(geometriesWrapper) : [],
    dmxModes: Array.isArray(dmxModeNodes) ? dmxModeNodes.map((m) => parseDmxMode(m as XmlNode)) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Socket injection -- Event Asset Library & Modular Snapping Specification   */
/* -------------------------------------------------------------------------- */

/** Local-space roll reference used for both injected socket types. */
const UP_REFERENCE: THREE.Vector3 = new THREE.Vector3(1, 0, 0);

/**
 * Derive the fixture's `extras.sockets`: one `PIPE_CLAMP_2IN` at the
 * fixture's own origin (how it grips the truss it hangs from), plus one
 * `FIXTURE_YOKE_AXIS` per `Axis` geometry node (its pan/tilt articulation
 * points), positioned in the fixture ROOT's local space by composing parent
 * transforms down to each node -- matching the "LOCAL space" contract every
 * other socket in this codebase is authored against.
 */
export function injectFixtureSockets(fixtureType: GdtfFixtureType): SocketDefinition[] {
  const sockets: SocketDefinition[] = [];

  // The clamp is the "grabbing" half of the interface (MALE), the same
  // polarity convention STAGE_LEG_RECEIVER uses in reverse for its FEMALE
  // spigot socket: the passive tube it clamps onto carries no socket at all
  // today (ModularPrimitives' truss only sockets its two ends), so this pairs
  // with nothing yet -- that is future work, not a Phase 3 gap.
  sockets.push({
    socket_id: 'fixture_clamp',
    socket_type: 'PIPE_CLAMP_2IN',
    gender: 'MALE',
    transform: { translation: [0, 0, 0], normal: [0, 1, 0], up: [1, 0, 0] },
    tolerances: { snap_radius: 0.15, snap_angle: 15, detents_deg: [0, 90, 180, 270] },
    kinematic_rules: { can_parent: false, can_child: true, load_bearing: true },
    tags: ['fixture_clamp'],
  });

  // A one-shot walk over a handful of nodes at fixture-registration time, not
  // per-frame render-loop code, so this allocates a fresh matrix/vector per
  // node rather than reusing scratch objects -- reusing a mutable "current
  // world transform" across a recursive tree walk is exactly the kind of
  // aliasing hazard (a child's mutation corrupting an unfinished sibling
  // iteration higher up the stack) not worth risking for a negligible,
  // one-time allocation saving. Matches ModularPrimitives.ts's own
  // allocate-freely style for one-shot construction.
  const usedIds = new Set<string>(['fixture_clamp']);

  const walk = (nodes: GdtfGeometryNode[], parentMatrix: THREE.Matrix4): void => {
    for (const node of nodes) {
      const worldMatrix = parentMatrix.clone().multiply(gdtfSpaceToThreeSpace(node.matrix));

      if (node.kind === 'Axis') {
        const position = new THREE.Vector3().setFromMatrixPosition(worldMatrix);
        const rotation = new THREE.Matrix4().extractRotation(worldMatrix);
        const normal = new THREE.Vector3(0, 1, 0).applyMatrix4(rotation);
        const up = UP_REFERENCE.clone().applyMatrix4(rotation);

        let socketId = `yoke_axis_${node.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
        // Disambiguate same-named axes (rare, but two "Head" nodes under
        // different parents would otherwise collide).
        if (usedIds.has(socketId)) socketId = `${socketId}_${usedIds.size}`;
        usedIds.add(socketId);

        sockets.push({
          socket_id: socketId,
          socket_type: 'FIXTURE_YOKE_AXIS',
          // Never mates, so polarity is meaningless; NEUTRAL is the closest
          // "no polarity" reading without inventing a fifth gender value.
          gender: 'NEUTRAL',
          transform: {
            translation: [position.x, position.y, position.z],
            normal: [normal.x, normal.y, normal.z],
            up: [up.x, up.y, up.z],
          },
          // Pinned false, not defaulted: this is what makes the type inert
          // for findSnapCandidate, not merely an authoring convention.
          kinematic_rules: { can_parent: false, can_child: false },
          tags: ['yoke_axis', node.name],
        });
      }

      walk(node.children, worldMatrix);
    }
  };
  walk(fixtureType.geometries, new THREE.Matrix4());

  return sockets;
}
