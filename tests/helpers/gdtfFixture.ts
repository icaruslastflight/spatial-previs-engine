/**
 * Builds real GDTF v1.2 archives in memory, for the parser and resolver tests.
 *
 * These are genuine ZIP containers holding a genuine `description.xml` written
 * to DIN SPEC 15800 -- not a mock object shaped like a parse result. That
 * matters: the things most likely to break are the ZIP traversal, the XML
 * attribute names, the `{a,b,c,d}` matrix grammar and the `value/resolution`
 * DMX grammar, none of which a hand-built fixture object would exercise.
 *
 * GDTF Share gates its catalogue behind a login, so CI cannot download a real
 * archive. Generating one keeps the whole path covered anyway, which is the
 * same trade the splat pipeline makes with its synthetic capture.
 *
 * Geometry values follow a Robe MegaPointe-class moving head so the numbers are
 * physically plausible; the DMX ranges are the ones the Phase 3 specification
 * names (pan -270..270, tilt -120..120).
 */

import JSZip from 'jszip';

/** Identity, in GDTF's four-brace row-major matrix grammar. */
export const IDENTITY_MATRIX =
  '{1.000000,0.000000,0.000000,0.000000}' +
  '{0.000000,1.000000,0.000000,0.000000}' +
  '{0.000000,0.000000,1.000000,0.000000}' +
  '{0.000000,0.000000,0.000000,1.000000}';

/**
 * A translation-only GDTF matrix.
 *
 * GDTF is Z-up, so `z` is height. The parser converts to Three's Y-up.
 */
export function translationMatrix(x: number, y: number, z: number): string {
  return (
    '{1.000000,0.000000,0.000000,0.000000}' +
    '{0.000000,1.000000,0.000000,0.000000}' +
    '{0.000000,0.000000,1.000000,0.000000}' +
    `{${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)},1.000000}`
  );
}

/** A full GDTF matrix: three basis rows plus a translation row. */
export function basisMatrix(
  xAxis: readonly [number, number, number],
  yAxis: readonly [number, number, number],
  zAxis: readonly [number, number, number],
  translation: readonly [number, number, number],
): string {
  const row = (v: readonly [number, number, number], w: number): string =>
    `{${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)},${w.toFixed(6)}}`;

  return row(xAxis, 0) + row(yAxis, 0) + row(zAxis, 0) + row(translation, 1);
}

/** Height of each joint above its parent, GDTF metres. */
export const YOKE_HEIGHT_M = 0.2;
export const HEAD_HEIGHT_M = 0.25;
export const BEAM_HEIGHT_M = 0.15;

/**
 * Yoke frame: local X turned to point UP (GDTF +Z).
 *
 * A GDTF `<Axis>` rotates about its own local X (DIN SPEC 15800 §6.4), and a
 * moving head's yoke pans about the VERTICAL. So the profile has to orient the
 * yoke's X onto the fixture's up axis -- that orientation is the profile's job,
 * not the resolver's.
 *
 * This is a -90 degree turn about Y: X -> +Z, Y -> Y, Z -> -X.
 */
export const YOKE_MATRIX = basisMatrix([0, 0, 1], [0, 1, 0], [-1, 0, 0], [0, 0, YOKE_HEIGHT_M]);

/**
 * Head frame: local Y turned onto the yoke's local -X, so a neutral head
 * (before any tilt) fires straight down -- and local X left horizontal, so
 * tilt nods the beam through vertical rather than spinning it in place.
 *
 * Expressed in the YOKE's frame, where the fixture's up axis is the yoke's
 * local X (see `YOKE_MATRIX`). The head's translation runs along that same
 * axis, so it still sits above the yoke in world space.
 *
 * Verified numerically, not by hand: a rotation this small (two 90-degree
 * turns composed) is exactly the kind of thing that is easy to get backwards
 * on paper, which is what happened on the first attempt at this matrix --
 * caught by the resolver's own "points straight down at centre" test.
 */
export const HEAD_MATRIX = basisMatrix([0, -1, 0], [0, 0, 1], [-1, 0, 0], [HEAD_HEIGHT_M, 0, 0]);

/**
 * Beam frame, in the HEAD's frame.
 *
 * Identity rotation: the emitter fires along the same axis the head's own
 * local Y already points along. The offset is written in GDTF's Z slot, not
 * its Y slot -- `gdtfToThree` maps GDTF Y to Three -Z and GDTF Z to Three Y,
 * so a Three-local +Y offset (forward, along the aim direction) comes from
 * the GDTF vector's Z component. Reusing the Y slot here, matching the
 * rotation basis vectors above by habit rather than re-deriving it, is
 * exactly the mistake `HEAD_MATRIX` made on its first pass.
 */
export const BEAM_MATRIX = basisMatrix([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, BEAM_HEIGHT_M]);

export interface FixtureOptions {
  readonly name?: string;
  readonly manufacturer?: string;
  readonly fixtureTypeId?: string;
  /** Include a second, cut-down DMX mode. */
  readonly includeBasicMode?: boolean;
  /** Emit the `<Beam>` geometry. Off exercises the no-emitter path. */
  readonly includeBeam?: boolean;
  /** Write placeholder GLB entries under `models/gltf/`. */
  readonly includeModels?: boolean;
}

export const DEFAULT_FIXTURE_TYPE_ID = '1F2E3D4C-5B6A-4798-8A9B-0C1D2E3F4A5B';

/** Photometrics written into the `<Beam>`. */
export const LUMINOUS_FLUX_LM = 20000;
export const COLOR_TEMPERATURE_K = 7500;
export const BEAM_ANGLE_DEG = 3.8;
export const FIELD_ANGLE_DEG = 4.2;

/** Physical ranges the Phase 3 specification names. */
export const PAN_FROM_DEG = -270;
export const PAN_TO_DEG = 270;
export const TILT_FROM_DEG = -120;
export const TILT_TO_DEG = 120;

/** Build `description.xml` for a moving head. */
export function buildDescriptionXml(options: FixtureOptions = {}): string {
  const {
    name = 'MegaPointe',
    manufacturer = 'Robe Lighting',
    fixtureTypeId = DEFAULT_FIXTURE_TYPE_ID,
    includeBasicMode = true,
    includeBeam = true,
    includeModels = true,
  } = options;

  const beamElement = includeBeam
    ? `            <Beam Name="Beam" Model="Beam" Position="${BEAM_MATRIX}"
                  LampType="Discharge" PowerConsumption="670" LuminousFlux="${LUMINOUS_FLUX_LM}"
                  ColorTemperature="${COLOR_TEMPERATURE_K}" BeamAngle="${BEAM_ANGLE_DEG}"
                  FieldAngle="${FIELD_ANGLE_DEG}" BeamRadius="0.045" BeamType="Spot"
                  ColorRenderingIndex="70"/>`
    : '';

  const modelElements = includeModels
    ? `      <Model Name="Base" Length="0.400" Width="0.380" Height="0.220" PrimitiveType="Undefined" File="base"/>
      <Model Name="Yoke" Length="0.300" Width="0.180" Height="0.400" PrimitiveType="Undefined" File="yoke"/>
      <Model Name="Head" Length="0.260" Width="0.260" Height="0.420" PrimitiveType="Undefined" File="head"/>
      <Model Name="Beam" Length="0.090" Width="0.090" Height="0.010" PrimitiveType="Cylinder" File="beam"/>`
    : '';

  const basicMode = includeBasicMode
    ? `      <DMXMode Name="Basic" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1" Default="128/1" Highlight="None" Geometry="Yoke">
            <LogicalChannel Attribute="Pan" Snap="No" Master="None">
              <ChannelFunction Name="Pan 1" Attribute="Pan" DMXFrom="0/1" Default="128/1"
                               PhysicalFrom="${PAN_FROM_DEG}" PhysicalTo="${PAN_TO_DEG}"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="2" Default="128/1" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Tilt" Snap="No" Master="None">
              <ChannelFunction Name="Tilt 1" Attribute="Tilt" DMXFrom="0/1" Default="128/1"
                               PhysicalFrom="${TILT_FROM_DEG}" PhysicalTo="${TILT_TO_DEG}"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="${name}" ShortName="${name}" LongName="${manufacturer} ${name}"
               Manufacturer="${manufacturer}" Description="Test profile"
               FixtureTypeID="${fixtureTypeId}" Thumbnail="thumbnail" RefFT="">
    <AttributeDefinitions>
      <ActivationGroups>
        <ActivationGroup Name="PanTilt"/>
        <ActivationGroup Name="ColorRGB"/>
      </ActivationGroups>
      <FeatureGroups>
        <FeatureGroup Name="Position" Pretty="Position">
          <Feature Name="PanTilt"/>
        </FeatureGroup>
        <FeatureGroup Name="Dimmer" Pretty="Dimmer">
          <Feature Name="Dimmer"/>
        </FeatureGroup>
        <FeatureGroup Name="Color" Pretty="Color">
          <Feature Name="RGB"/>
        </FeatureGroup>
      </FeatureGroups>
      <Attributes>
        <Attribute Name="Pan" Pretty="P" ActivationGroup="PanTilt" Feature="Position.PanTilt" PhysicalUnit="Angle"/>
        <Attribute Name="Tilt" Pretty="T" ActivationGroup="PanTilt" Feature="Position.PanTilt" PhysicalUnit="Angle"/>
        <Attribute Name="Dimmer" Pretty="Dim" Feature="Dimmer.Dimmer" PhysicalUnit="LuminousIntensity"/>
        <Attribute Name="ColorAdd_R" Pretty="R" ActivationGroup="ColorRGB" Feature="Color.RGB" PhysicalUnit="None"/>
        <Attribute Name="ColorAdd_G" Pretty="G" ActivationGroup="ColorRGB" Feature="Color.RGB" PhysicalUnit="None"/>
        <Attribute Name="ColorAdd_B" Pretty="B" ActivationGroup="ColorRGB" Feature="Color.RGB" PhysicalUnit="None"/>
        <Attribute Name="Zoom" Pretty="Zoom" Feature="Position.PanTilt" PhysicalUnit="Angle"/>
      </Attributes>
    </AttributeDefinitions>
    <Models>
${modelElements}
    </Models>
    <Geometries>
      <Geometry Name="Base" Model="Base" Position="${IDENTITY_MATRIX}">
        <Axis Name="Yoke" Model="Yoke" Position="${YOKE_MATRIX}">
          <Axis Name="Head" Model="Head" Position="${HEAD_MATRIX}">
${beamElement}
          </Axis>
        </Axis>
      </Geometry>
    </Geometries>
    <DMXModes>
      <DMXMode Name="Standard" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1,2" Default="32768/2" Highlight="None" Geometry="Yoke">
            <LogicalChannel Attribute="Pan" Snap="No" Master="None" MibFade="0">
              <ChannelFunction Name="Pan 1" Attribute="Pan" DMXFrom="0/1" Default="32768/2"
                               PhysicalFrom="${PAN_FROM_DEG}" PhysicalTo="${PAN_TO_DEG}" RealFade="0"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="3,4" Default="32768/2" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Tilt" Snap="No" Master="None" MibFade="0">
              <ChannelFunction Name="Tilt 1" Attribute="Tilt" DMXFrom="0/1" Default="32768/2"
                               PhysicalFrom="${TILT_FROM_DEG}" PhysicalTo="${TILT_TO_DEG}" RealFade="0"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="5" Default="0/1" Highlight="255/1" Geometry="Head">
            <LogicalChannel Attribute="Dimmer" Snap="No" Master="Grand">
              <ChannelFunction Name="Dimmer 1" Attribute="Dimmer" DMXFrom="0/1" Default="0/1"
                               PhysicalFrom="0" PhysicalTo="1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="6" Default="255/1" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_R" Snap="No" Master="None">
              <ChannelFunction Name="Red" Attribute="ColorAdd_R" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0" PhysicalTo="1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="7" Default="255/1" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_G" Snap="No" Master="None">
              <ChannelFunction Name="Green" Attribute="ColorAdd_G" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0" PhysicalTo="1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="8" Default="255/1" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_B" Snap="No" Master="None">
              <ChannelFunction Name="Blue" Attribute="ColorAdd_B" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0" PhysicalTo="1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="None" Default="0/1" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Zoom" Snap="No" Master="None">
              <ChannelFunction Name="Zoom 1" Attribute="Zoom" DMXFrom="0/1" Default="0/1"
                               PhysicalFrom="3.8" PhysicalTo="45"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
${basicMode}
    </DMXModes>
  </FixtureType>
</GDTF>
`;
}

/**
 * Minimal valid GLB.
 *
 * A 12-byte header plus an empty JSON chunk holding `{"asset":{"version":"2.0"}}`.
 * Enough for the archive traversal to find and classify it; the resolver builds
 * from the declared model envelopes rather than the mesh.
 */
function placeholderGlb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);

  const total = 12 + 8 + padded.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);

  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true); // version
  view.setUint32(8, total, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  new Uint8Array(buffer).set(padded, 20);

  return new Uint8Array(buffer);
}

/** Pack a complete `.gdtf` archive. */
export async function buildGdtfArchive(options: FixtureOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('description.xml', buildDescriptionXml(options));
  zip.file('thumbnail.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  if (options.includeModels !== false) {
    for (const model of ['base', 'yoke', 'head', 'beam']) {
      zip.file(`models/gltf/${model}.glb`, placeholderGlb());
    }
  }

  zip.file('wheels/gobos/gobo1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  zip.file('wheels/filters/cto.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * A universe buffer with a fixture patched at `baseAddress`.
 *
 * Offsets are the Standard mode's: pan 16-bit at 1-2, tilt 16-bit at 3-4,
 * dimmer at 5, RGB at 6-8.
 */
export function patchUniverse(values: {
  pan16?: number;
  tilt16?: number;
  dimmer?: number;
  rgb?: readonly [number, number, number];
  baseAddress?: number;
}): Uint8Array {
  const universe = new Uint8Array(512);
  const base = (values.baseAddress ?? 1) - 1;

  const pan = values.pan16 ?? 32768;
  const tilt = values.tilt16 ?? 32768;

  universe[base + 0] = (pan >> 8) & 0xff;
  universe[base + 1] = pan & 0xff;
  universe[base + 2] = (tilt >> 8) & 0xff;
  universe[base + 3] = tilt & 0xff;
  universe[base + 4] = values.dimmer ?? 255;

  const [r, g, b] = values.rgb ?? [255, 255, 255];
  universe[base + 5] = r;
  universe[base + 6] = g;
  universe[base + 7] = b;

  return universe;
}
