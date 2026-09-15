/**
 * GDTF v1.2 archive unpacker and profile parser (DIN SPEC 15800:2022-02).
 *
 * A `.gdtf` file is a ZIP container. At its root sits `description.xml`, the
 * fixture's complete machine-readable definition: its kinematic tree, its
 * photometric emitter, and every DMX mode the console can patch it in. The
 * binary meshes live under `models/gltf/`, gobo and filter rasters under
 * `wheels/`.
 *
 * This module turns that archive into a plain, immutable `GDTFProfile`. It does
 * NOT touch Three.js -- `GDTFAssetResolver` does the scene assembly. Keeping
 * the split means the parser runs identically in a browser, in Node under the
 * test suite, and in a build script, and it can be tested without a renderer.
 *
 * COORDINATE SYSTEMS DIFFER
 * -------------------------
 * GDTF is right-handed **Z-up** in metres (DIN SPEC 15800 section 6.1); Three.js
 * is right-handed **Y-up**. Every position and matrix this parser emits has
 * already been converted, once, by `gdtfToThree`. Downstream code must never
 * re-apply the conversion.
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Path of the profile definition inside every GDTF archive. */
export const DESCRIPTION_PATH = 'description.xml';

/** Where GDTF stores its binary glTF meshes. */
export const GLTF_MODEL_DIR = 'models/gltf/';

/**
 * The GDTF standard attributes this engine acts on.
 *
 * GDTF defines several hundred; these are the ones with a kinematic or
 * photometric consequence in previz. An attribute outside this list is still
 * parsed and kept on the channel -- it is simply not wired to anything yet.
 */
export const ACTIONABLE_ATTRIBUTES = [
  'Pan',
  'Tilt',
  'Dimmer',
  'ColorAdd_R',
  'ColorAdd_G',
  'ColorAdd_B',
  'Gobo1',
  'Prism1',
  'Focus',
  'Zoom',
  'Shutter1',
] as const;

export type ActionableAttribute = (typeof ACTIONABLE_ATTRIBUTES)[number];

/* -------------------------------------------------------------------------- */
/* Parsed shapes                                                              */
/* -------------------------------------------------------------------------- */

/** A 3-tuple in Three.js axes, metres. Already converted from GDTF Z-up. */
export type Vec3Tuple = readonly [number, number, number];

/**
 * A GDTF `Matrix` reduced to what the resolver needs.
 *
 * GDTF writes a full 4x4, but fixture geometry transforms are rigid-body: the
 * rotation basis plus a translation carries all of it, and keeping them apart
 * means the resolver never has to decompose.
 */
export interface GDTFTransform {
  /** Translation in Three.js axes, metres. */
  readonly translation: Vec3Tuple;
  /** Rotation basis, column-major, Three.js axes. Identity when absent. */
  readonly basis: readonly number[];
}

/** One entry of `<AttributeDefinitions><Attributes>`. */
export interface GDTFAttributeDefinition {
  readonly name: string;
  readonly pretty: string;
  /** e.g. `Position.PanTilt`. Empty when the profile omits it. */
  readonly feature: string;
  /** GDTF `PhysicalUnit` enum name, e.g. `Angle`, `LuminousIntensity`. */
  readonly physicalUnit: string;
}

/** The kinematic role a geometry node plays. */
export type GDTFGeometryKind = 'Geometry' | 'Axis' | 'Beam' | 'Other';

/**
 * The photometric emitter, from a `<Beam>` geometry.
 *
 * These map onto `KHR_lights_punctual` and onto a Three.js `SpotLight`:
 * `beamAngleDegrees` is the cone's inner hot spot, `fieldAngleDegrees` the
 * outer edge where output has fallen to 50%.
 */
export interface GDTFBeam {
  readonly lampType: string;
  readonly powerConsumptionWatts: number;
  readonly luminousFluxLumens: number;
  readonly colorTemperatureKelvin: number;
  readonly beamAngleDegrees: number;
  readonly fieldAngleDegrees: number;
  readonly beamRadiusMeters: number;
  readonly colorRenderingIndex: number;
}

/** One node of the fixture's physical kinematic tree. */
export interface GDTFGeometryNode {
  readonly name: string;
  readonly kind: GDTFGeometryKind;
  /** `<Model>` name this node renders, or null for a pure pivot. */
  readonly model: string | null;
  /** Transform relative to the PARENT node. */
  readonly transform: GDTFTransform;
  /** Present only when `kind === 'Beam'`. */
  readonly beam: GDTFBeam | null;
  readonly children: readonly GDTFGeometryNode[];
}

/** A `<Model>` declaration: the mesh file and its bounding envelope. */
export interface GDTFModel {
  readonly name: string;
  /** Basename without extension, as GDTF stores it. */
  readonly file: string;
  readonly lengthMeters: number;
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly primitiveType: string;
}

/**
 * A DMX value paired with the byte resolution it was written at.
 *
 * GDTF writes these as `value/resolution`, e.g. `32768/2` is 32768 at 16-bit.
 * Keeping the resolution is what makes `toNormalized` exact rather than a guess
 * about how wide the field was.
 */
export interface GDTFDmxValue {
  readonly value: number;
  /** Byte count: 1 = 8-bit, 2 = 16-bit, 3 = 24-bit, 4 = 32-bit. */
  readonly resolution: number;
}

/** One `<ChannelFunction>`: a DMX sub-range mapped to a physical range. */
export interface GDTFChannelFunction {
  readonly name: string;
  readonly attribute: string;
  readonly dmxFrom: GDTFDmxValue;
  readonly physicalFrom: number;
  readonly physicalTo: number;
  readonly defaultValue: GDTFDmxValue;
}

/** One `<DMXChannel>`, already resolved to absolute channel offsets. */
export interface GDTFDmxChannel {
  /** GDTF `DMXBreak`; 1 for a single-universe fixture. */
  readonly dmxBreak: number;
  /**
   * 1-indexed offsets within the mode, coarse first.
   * `[3]` is 8-bit at channel 3; `[1, 2]` is 16-bit with fine at 2.
   */
  readonly offsets: readonly number[];
  /** Geometry this channel drives, e.g. `Yoke`. */
  readonly geometry: string;
  /** Primary attribute, taken from the first logical channel. */
  readonly attribute: string;
  readonly functions: readonly GDTFChannelFunction[];
  readonly defaultValue: GDTFDmxValue;
}

/** One `<DMXMode>`: a complete patch footprint. */
export interface GDTFDmxMode {
  readonly name: string;
  /** Root geometry the mode drives. */
  readonly geometry: string;
  readonly channels: readonly GDTFDmxChannel[];
  /** Highest offset used -- the fixture's channel count in this mode. */
  readonly footprint: number;
}

/** Binary payloads lifted out of the archive, keyed by archive-relative path. */
export interface GDTFArchiveAssets {
  /** `models/gltf/<name>.glb` contents, keyed by basename without extension. */
  readonly models: ReadonlyMap<string, Uint8Array>;
  /** `thumbnail.png`, when the archive ships one. */
  readonly thumbnail: Uint8Array | null;
  /** `wheels/gobos/*` and `wheels/filters/*`, keyed by full archive path. */
  readonly wheels: ReadonlyMap<string, Uint8Array>;
}

/** A fully parsed GDTF fixture profile. */
export interface GDTFProfile {
  /** `DataVersion` from the `<GDTF>` root, e.g. `1.2`. */
  readonly dataVersion: string;
  readonly name: string;
  readonly shortName: string;
  readonly longName: string;
  readonly manufacturer: string;
  readonly description: string;
  /** `FixtureTypeID` UUID -- the resolver's cache key. */
  readonly fixtureTypeId: string;
  readonly attributes: readonly GDTFAttributeDefinition[];
  readonly models: readonly GDTFModel[];
  /** Root of the kinematic tree. */
  readonly geometry: GDTFGeometryNode | null;
  readonly dmxModes: readonly GDTFDmxMode[];
  readonly assets: GDTFArchiveAssets;
}

/** Thrown when an archive is not a readable GDTF profile. */
export class GDTFParseError extends Error {
  constructor(message: string) {
    super(`[GDTFParser] ${message}`);
    this.name = 'GDTFParseError';
  }
}

/* -------------------------------------------------------------------------- */
/* Primitive parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Convert a GDTF Z-up vector to Three.js Y-up.
 *
 * GDTF: +X right, +Y into the scene, +Z up. Three: +X right, +Y up, +Z toward
 * the viewer. So Z becomes Y, and Y becomes -Z -- a -90 degree turn about X.
 */
export function gdtfToThree(x: number, y: number, z: number): Vec3Tuple {
  return [x, z, -y];
}

function toNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(raw: unknown, fallback = ''): string {
  if (raw === undefined || raw === null) return fallback;
  return String(raw);
}

/**
 * Parse a GDTF `Matrix` attribute.
 *
 * Written as four brace groups of four floats, ROW by row, with the fourth row
 * carrying the translation (DIN SPEC 15800 section 6.2). An absent or malformed
 * matrix yields identity, because a fixture with one unreadable joint is still
 * worth rendering upright.
 */
export function parseMatrix(raw: unknown): GDTFTransform {
  const identity: GDTFTransform = {
    translation: [0, 0, 0],
    basis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
  if (raw === undefined || raw === null) return identity;

  const groups = String(raw).match(/\{([^}]*)\}/g);
  if (groups === null || groups.length < 4) return identity;

  const rows = groups.map((group) =>
    group
      .slice(1, -1)
      .split(',')
      .map((cell) => toNumber(cell, 0)),
  );
  if (rows.some((row) => row.length < 4)) return identity;

  // Rows 0-2 are the rotation basis in GDTF axes; row 3 is the translation.
  const [rx, ry, rz, translation] = rows as [number[], number[], number[], number[]];

  // Each basis ROW is an axis of the child frame expressed in the parent. Map
  // each axis through the Z-up -> Y-up change, then emit column-major, which is
  // what THREE.Matrix4.set consumers expect from `basis`.
  const ax = gdtfToThree(rx[0], rx[1], rx[2]);
  const ay = gdtfToThree(ry[0], ry[1], ry[2]);
  const az = gdtfToThree(rz[0], rz[1], rz[2]);

  // The image of GDTF's Y axis is -Z in Three, so the basis column order has to
  // follow the same permutation or the frame comes out mirrored.
  return {
    translation: gdtfToThree(translation[0], translation[1], translation[2]),
    basis: [ax[0], ax[1], ax[2], az[0], az[1], az[2], -ay[0], -ay[1], -ay[2]],
  };
}

/**
 * Parse a GDTF `DMXValue`, written `value/resolution` (e.g. `32768/2`).
 *
 * A bare number is 8-bit by GDTF's default. `None` -- which GDTF uses for an
 * absent highlight -- yields zero at 8-bit rather than throwing, since it is a
 * legitimate value in a well-formed profile.
 */
export function parseDmxValue(raw: unknown, fallback: GDTFDmxValue = { value: 0, resolution: 1 }): GDTFDmxValue {
  if (raw === undefined || raw === null || raw === '') return fallback;

  const text = String(raw).trim();
  if (text === 'None') return { value: 0, resolution: 1 };

  const slash = text.indexOf('/');
  if (slash === -1) return { value: toNumber(text, fallback.value), resolution: 1 };

  const value = toNumber(text.slice(0, slash), fallback.value);
  const resolution = Math.min(4, Math.max(1, Math.round(toNumber(text.slice(slash + 1), 1))));
  return { value, resolution };
}

/** Largest value representable at a byte resolution. */
export function dmxMaxValue(resolution: number): number {
  return 2 ** (8 * Math.min(4, Math.max(1, resolution))) - 1;
}

/**
 * Normalize a DMX value to 0..1 at its own resolution.
 *
 * Division is by the maximum REPRESENTABLE value, not by the next power of two,
 * so full-scale DMX maps to exactly 1.0. Getting this wrong leaves a fixture
 * unable to reach its own end stops.
 */
export function normalizeDmx(value: number, resolution: number): number {
  const max = dmxMaxValue(resolution);
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Map a normalized 0..1 reading onto a channel function's physical range. */
export function physicalFromNormalized(fn: GDTFChannelFunction, normalized: number): number {
  return fn.physicalFrom + (fn.physicalTo - fn.physicalFrom) * normalized;
}

/* -------------------------------------------------------------------------- */
/* XML traversal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * fast-xml-parser collapses a single child to an object and repeats to an
 * array. Every call site wants an array, so normalize once here rather than
 * branching at each one.
 */
function asArray(node: unknown): Record<string, unknown>[] {
  if (node === undefined || node === null) return [];
  if (Array.isArray(node)) return node as Record<string, unknown>[];
  return [node as Record<string, unknown>];
}

/** Element names GDTF uses for geometry nodes that are not plain geometry. */
const GEOMETRY_ELEMENTS = [
  'Geometry',
  'Axis',
  'Beam',
  'FilterBeam',
  'FilterColor',
  'FilterGobo',
  'FilterShaper',
  'MediaServerLayer',
  'MediaServerCamera',
  'MediaServerMaster',
  'Display',
  'GeometryReference',
  'Laser',
  'WiringObject',
  'Inventory',
  'Structure',
  'Support',
  'Magnet',
] as const;

function geometryKindOf(element: string): GDTFGeometryKind {
  if (element === 'Geometry') return 'Geometry';
  if (element === 'Axis') return 'Axis';
  if (element === 'Beam') return 'Beam';
  return 'Other';
}

function parseBeam(node: Record<string, unknown>): GDTFBeam {
  return {
    lampType: toText(node['@_LampType'], 'Discharge'),
    powerConsumptionWatts: toNumber(node['@_PowerConsumption'], 0),
    luminousFluxLumens: toNumber(node['@_LuminousFlux'], 0),
    colorTemperatureKelvin: toNumber(node['@_ColorTemperature'], 6000),
    beamAngleDegrees: toNumber(node['@_BeamAngle'], 0),
    fieldAngleDegrees: toNumber(node['@_FieldAngle'], 0),
    beamRadiusMeters: toNumber(node['@_BeamRadius'], 0),
    colorRenderingIndex: toNumber(node['@_ColorRenderingIndex'], 100),
  };
}

/** Recursively build the kinematic tree from a geometry container element. */
function parseGeometryNode(element: string, node: Record<string, unknown>): GDTFGeometryNode {
  const kind = geometryKindOf(element);
  const children: GDTFGeometryNode[] = [];

  for (const childElement of GEOMETRY_ELEMENTS) {
    for (const child of asArray(node[childElement])) {
      children.push(parseGeometryNode(childElement, child));
    }
  }

  const model = toText(node['@_Model'], '');

  return {
    name: toText(node['@_Name'], element),
    kind,
    model: model === '' ? null : model,
    transform: parseMatrix(node['@_Position']),
    beam: kind === 'Beam' ? parseBeam(node) : null,
    children,
  };
}

function parseAttributes(fixtureType: Record<string, unknown>): GDTFAttributeDefinition[] {
  const definitions = fixtureType['AttributeDefinitions'] as Record<string, unknown> | undefined;
  if (definitions === undefined) return [];

  const container = definitions['Attributes'] as Record<string, unknown> | undefined;
  if (container === undefined) return [];

  return asArray(container['Attribute']).map((attribute) => ({
    name: toText(attribute['@_Name']),
    pretty: toText(attribute['@_Pretty']),
    feature: toText(attribute['@_Feature']),
    physicalUnit: toText(attribute['@_PhysicalUnit'], 'None'),
  }));
}

function parseModels(fixtureType: Record<string, unknown>): GDTFModel[] {
  const container = fixtureType['Models'] as Record<string, unknown> | undefined;
  if (container === undefined) return [];

  return asArray(container['Model']).map((model) => ({
    name: toText(model['@_Name']),
    file: toText(model['@_File']),
    lengthMeters: toNumber(model['@_Length'], 0),
    widthMeters: toNumber(model['@_Width'], 0),
    heightMeters: toNumber(model['@_Height'], 0),
    primitiveType: toText(model['@_PrimitiveType'], 'Undefined'),
  }));
}

function parseChannelFunctions(logical: Record<string, unknown>): GDTFChannelFunction[] {
  return asArray(logical['ChannelFunction']).map((fn) => ({
    name: toText(fn['@_Name']),
    attribute: toText(fn['@_Attribute']),
    dmxFrom: parseDmxValue(fn['@_DMXFrom']),
    physicalFrom: toNumber(fn['@_PhysicalFrom'], 0),
    physicalTo: toNumber(fn['@_PhysicalTo'], 1),
    defaultValue: parseDmxValue(fn['@_Default']),
  }));
}

/**
 * Parse `Offset="1,2"` into 1-indexed channel offsets, coarse first.
 *
 * GDTF writes `None` for a virtual channel that occupies no DMX footprint;
 * that yields an empty list rather than a zero, so footprint arithmetic stays
 * correct.
 */
function parseOffsets(raw: unknown): number[] {
  const text = toText(raw, '').trim();
  if (text === '' || text === 'None') return [];

  return text
    .split(',')
    .map((part) => Math.round(toNumber(part, 0)))
    .filter((offset) => offset > 0);
}

function parseDmxChannels(mode: Record<string, unknown>): GDTFDmxChannel[] {
  const container = mode['DMXChannels'] as Record<string, unknown> | undefined;
  if (container === undefined) return [];

  return asArray(container['DMXChannel']).map((channel) => {
    const logicals = asArray(channel['LogicalChannel']);
    const functions = logicals.flatMap(parseChannelFunctions);
    const attribute = logicals.length > 0 ? toText(logicals[0]['@_Attribute']) : '';
    const offsets = parseOffsets(channel['@_Offset']);

    // GDTF permits the default on either the channel or its first function.
    // Preferring the channel keeps a profile that sets both self-consistent.
    const channelDefault = channel['@_Default'];
    const defaultValue =
      channelDefault !== undefined
        ? parseDmxValue(channelDefault)
        : (functions[0]?.defaultValue ?? { value: 0, resolution: Math.max(1, offsets.length) });

    return {
      dmxBreak: toNumber(channel['@_DMXBreak'], 1),
      offsets,
      geometry: toText(channel['@_Geometry']),
      attribute,
      functions,
      defaultValue,
    };
  });
}

function parseDmxModes(fixtureType: Record<string, unknown>): GDTFDmxMode[] {
  const container = fixtureType['DMXModes'] as Record<string, unknown> | undefined;
  if (container === undefined) return [];

  return asArray(container['DMXMode']).map((mode) => {
    const channels = parseDmxChannels(mode);
    let footprint = 0;
    for (const channel of channels) {
      for (const offset of channel.offsets) {
        if (offset > footprint) footprint = offset;
      }
    }

    return {
      name: toText(mode['@_Name']),
      geometry: toText(mode['@_Geometry']),
      channels,
      footprint,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Archive handling                                                           */
/* -------------------------------------------------------------------------- */

/** Strip a directory prefix and file extension, leaving the GDTF model name. */
function modelKeyOf(path: string): string {
  const base = path.slice(GLTF_MODEL_DIR.length);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

async function readArchiveAssets(zip: JSZip): Promise<GDTFArchiveAssets> {
  const models = new Map<string, Uint8Array>();
  const wheels = new Map<string, Uint8Array>();
  let thumbnail: Uint8Array | null = null;

  const pending: Promise<void>[] = [];

  zip.forEach((path, entry) => {
    if (entry.dir) return;

    // Archives in the wild use either separator, and some nest the tree under
    // a leading './'. Normalize before matching or half the models go missing.
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');

    if (normalized.startsWith(GLTF_MODEL_DIR) && normalized.toLowerCase().endsWith('.glb')) {
      pending.push(
        entry.async('uint8array').then((bytes) => {
          models.set(modelKeyOf(normalized), bytes);
        }),
      );
      return;
    }

    if (normalized.startsWith('wheels/')) {
      pending.push(
        entry.async('uint8array').then((bytes) => {
          wheels.set(normalized, bytes);
        }),
      );
      return;
    }

    if (normalized === 'thumbnail.png') {
      pending.push(
        entry.async('uint8array').then((bytes) => {
          thumbnail = bytes;
        }),
      );
    }
  });

  await Promise.all(pending);
  return { models, thumbnail, wheels };
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `description.xml` reader.
 *
 * `ignoreAttributes: false` is the whole point -- GDTF carries essentially all
 * of its data in XML attributes, so the default would discard the profile and
 * leave a tree of empty elements.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
});

/** Unpack and parse a `.gdtf` archive. */
export async function parseGDTF(archive: Uint8Array | ArrayBuffer): Promise<GDTFProfile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive);
  } catch (error) {
    throw new GDTFParseError(
      `Archive is not a readable ZIP container: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const descriptionEntry = zip.file(DESCRIPTION_PATH) ?? zip.file(`./${DESCRIPTION_PATH}`);
  if (descriptionEntry === null) {
    throw new GDTFParseError(
      `Archive has no ${DESCRIPTION_PATH} at its root. Every GDTF package must carry one ` +
        `(DIN SPEC 15800 section 5.1); a package without it is not a fixture profile.`,
    );
  }

  const xml = await descriptionEntry.async('string');
  const document = xmlParser.parse(xml) as Record<string, unknown>;

  const root = document['GDTF'] as Record<string, unknown> | undefined;
  if (root === undefined) {
    throw new GDTFParseError(`${DESCRIPTION_PATH} has no <GDTF> root element.`);
  }

  const fixtureType = root['FixtureType'] as Record<string, unknown> | undefined;
  if (fixtureType === undefined) {
    throw new GDTFParseError(`${DESCRIPTION_PATH} has no <FixtureType> element.`);
  }

  const fixtureTypeId = toText(fixtureType['@_FixtureTypeID']);
  if (fixtureTypeId === '') {
    throw new GDTFParseError(
      'FixtureType is missing its FixtureTypeID. That UUID is the resolver cache key, ' +
        'so a profile without one cannot be indexed.',
    );
  }

  // GDTF nests the tree under a <Geometries> container whose own children are
  // the roots. Multi-root profiles exist; the first is the fixture body.
  const geometries = fixtureType['Geometries'] as Record<string, unknown> | undefined;
  let geometry: GDTFGeometryNode | null = null;
  if (geometries !== undefined) {
    for (const element of GEOMETRY_ELEMENTS) {
      const found = asArray(geometries[element]);
      if (found.length > 0) {
        geometry = parseGeometryNode(element, found[0]);
        break;
      }
    }
  }

  return {
    dataVersion: toText(root['@_DataVersion'], '1.2'),
    name: toText(fixtureType['@_Name']),
    shortName: toText(fixtureType['@_ShortName']),
    longName: toText(fixtureType['@_LongName']),
    manufacturer: toText(fixtureType['@_Manufacturer']),
    description: toText(fixtureType['@_Description']),
    fixtureTypeId,
    attributes: parseAttributes(fixtureType),
    models: parseModels(fixtureType),
    geometry,
    dmxModes: parseDmxModes(fixtureType),
    assets: await readArchiveAssets(zip),
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/** Depth-first walk of a geometry tree, parents before children. */
export function* walkGeometry(node: GDTFGeometryNode): Generator<GDTFGeometryNode> {
  yield node;
  for (const child of node.children) yield* walkGeometry(child);
}

/** The first `<Beam>` in the tree -- the fixture's optical emitter. */
export function findBeam(profile: GDTFProfile): GDTFGeometryNode | null {
  if (profile.geometry === null) return null;
  for (const node of walkGeometry(profile.geometry)) {
    if (node.kind === 'Beam') return node;
  }
  return null;
}

/**
 * The fixture's rotation axes, outermost first.
 *
 * On a moving head this is `[yoke, head]`: pan then tilt. Reading them off the
 * tree rather than matching on names is what keeps this working for a fixture
 * whose manufacturer called them something else.
 */
export function findAxes(profile: GDTFProfile): GDTFGeometryNode[] {
  if (profile.geometry === null) return [];

  const axes: GDTFGeometryNode[] = [];
  for (const node of walkGeometry(profile.geometry)) {
    if (node.kind === 'Axis') axes.push(node);
  }
  return axes;
}

/** Look up a mode by name, or the first mode when `name` is undefined. */
export function findDmxMode(profile: GDTFProfile, name?: string): GDTFDmxMode | null {
  if (profile.dmxModes.length === 0) return null;
  if (name === undefined) return profile.dmxModes[0];

  const wanted = name.toLowerCase();
  return profile.dmxModes.find((mode) => mode.name.toLowerCase() === wanted) ?? null;
}

/** Every channel in a mode driving a given GDTF attribute. */
export function channelsForAttribute(mode: GDTFDmxMode, attribute: string): GDTFDmxChannel[] {
  return mode.channels.filter((channel) => channel.attribute === attribute);
}

/**
 * Read one channel's current value out of a universe buffer.
 *
 * `offsets` are 1-indexed within the mode and `baseAddress` is the fixture's
 * patch address, so slot zero of the buffer is DMX channel 1. Coarse byte
 * first, each subsequent offset one byte less significant.
 */
export function readChannelValue(
  channel: GDTFDmxChannel,
  universe: Uint8Array,
  baseAddress = 1,
): GDTFDmxValue {
  const resolution = channel.offsets.length;
  if (resolution === 0) return { value: channel.defaultValue.value, resolution: 1 };

  let value = 0;
  for (const offset of channel.offsets) {
    const index = baseAddress - 1 + offset - 1;
    const byte = index >= 0 && index < universe.length ? universe[index] : 0;
    value = value * 256 + byte;
  }

  return { value, resolution };
}
