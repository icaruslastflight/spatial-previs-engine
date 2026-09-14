/**
 * GDTF archive/XML parsing and socket-injection checks.
 *
 * Everything here runs against a hand-written minimal fixture -- no network,
 * no real `.gdtf` archive, no committed binary -- matching this repo's
 * established synthetic-stand-in testing philosophy (the splat pipeline's
 * `--self-test`, the procedural modular assets). A `.gdtf` file is just a ZIP
 * wrapping XML plus glTF, so both are buildable in-memory with the same
 * libraries the parser itself uses.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { Document, NodeIO } from '@gltf-transform/core';

import {
  gdtfSpaceToThreeSpace,
  injectFixtureSockets,
  parseDescriptionXml,
  parseGdtfMatrix,
  unpackGdtfArchive,
} from './GDTFParser.ts';
// Node-only (gltf-transform's NodeIO touches node:fs/node:path), so it lives
// under scripts/, not src/engine/, and stays plain JS -- see that file's own
// header for why. Reached from here anyway: `npm test`'s src/**/*.test.ts
// glob (vitest.config.ts) is what actually runs this check, and a test file
// is never part of the browser production bundle regardless of what it
// imports, unlike the production source that used to live next to it.
import { injectSocketsIntoGlb } from '../../scripts/gdtf/injectSocketsIntoGlb.js';

/* -------------------------------------------------------------------------- */
/* Fixture: a synthetic two-axis wash light                                   */
/* -------------------------------------------------------------------------- */

// Yoke sits 0.3 m up the base (GDTF Z-up); Head sits a further 0.15 m up the
// Yoke. Chosen so the composed position is trivial to hand-check: 0.45 m.
const SAMPLE_DESCRIPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Test Wash 300" ShortName="TW300" Manufacturer="Acme Lighting"
      Description="Synthetic test fixture" FixtureTypeID="11111111-2222-3333-4444-555555555555"
      Thumbnail="thumbnail">
    <Models>
      <Model Name="base_model" Length="0.4" Width="0.3" Height="0.35" PrimitiveType="Base" File="base_model"/>
      <Model Name="head_model" Length="0.25" Width="0.2" Height="0.3" PrimitiveType="Head" File="head_model"/>
    </Models>
    <Geometries>
      <Axis Name="Yoke" Model="base_model" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0.3}{0,0,0,1}">
        <Axis Name="Head" Model="head_model" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0.15}{0,0,0,1}">
          <Beam Name="Beam" Model="head_model" LampType="LED" PowerConsumption="300" LuminousFlux="12000"
              ColorTemperature="6500" BeamAngle="18" FieldAngle="20" BeamType="Spot"/>
        </Axis>
      </Axis>
    </Geometries>
    <DMXModes>
      <DMXMode Name="Standard" Geometry="Yoke">
        <DMXChannels>
          <DMXChannel Geometry="Yoke" Offset="1,2" Default="32768/2" Highlight="65535/2" DMXBreak="1">
            <LogicalChannel Attribute="Pan">
              <ChannelFunction Name="Pan" PhysicalFrom="-270" PhysicalTo="270" Default="32768/2"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel Geometry="Head" Offset="3,4" Default="32768/2" DMXBreak="1">
            <LogicalChannel Attribute="Tilt">
              <ChannelFunction Name="Tilt" PhysicalFrom="-135" PhysicalTo="135" Default="32768/2"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel Geometry="Beam" Offset="5" Default="0" DMXBreak="1">
            <LogicalChannel Attribute="Dimmer">
              <ChannelFunction Name="Dimmer" PhysicalFrom="0" PhysicalTo="1" Default="0"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>`;

/* -------------------------------------------------------------------------- */
/* [1] Matrix parsing                                                         */
/* -------------------------------------------------------------------------- */

describe('[1] parseGdtfMatrix', () => {
  it('reads translation out of the 4th column of each row', () => {
    const m = parseGdtfMatrix('{1,0,0,2}{0,1,0,3}{0,0,1,4}{0,0,0,1}');
    const t = new THREE.Vector3().setFromMatrixPosition(m);
    expect(t.x).toBeCloseTo(2, 9);
    expect(t.y).toBeCloseTo(3, 9);
    expect(t.z).toBeCloseTo(4, 9);
  });

  it('falls back to identity for missing input', () => {
    expect(parseGdtfMatrix(null).equals(new THREE.Matrix4())).toBe(true);
    expect(parseGdtfMatrix(undefined).equals(new THREE.Matrix4())).toBe(true);
  });

  it('falls back to identity for malformed input rather than throwing', () => {
    expect(() => parseGdtfMatrix('not a matrix')).not.toThrow();
    expect(parseGdtfMatrix('{1,2,3}').equals(new THREE.Matrix4())).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* [2] GDTF -> Three axis bridge                                              */
/* -------------------------------------------------------------------------- */

describe('[2] gdtfSpaceToThreeSpace', () => {
  it('maps +Y (away from viewer) translation to -Z', () => {
    const gdtf = new THREE.Matrix4().makeTranslation(0, 5, 0);
    const three = gdtfSpaceToThreeSpace(gdtf);
    const t = new THREE.Vector3().setFromMatrixPosition(three);
    expect(t.x).toBeCloseTo(0, 9);
    expect(t.y).toBeCloseTo(0, 9);
    expect(t.z).toBeCloseTo(-5, 9);
  });

  it('maps +Z (up) translation to +Y', () => {
    const gdtf = new THREE.Matrix4().makeTranslation(0, 0, 7);
    const three = gdtfSpaceToThreeSpace(gdtf);
    const t = new THREE.Vector3().setFromMatrixPosition(three);
    expect(t.x).toBeCloseTo(0, 9);
    expect(t.y).toBeCloseTo(7, 9);
    expect(t.z).toBeCloseTo(0, 9);
  });

  it('keeps +X translation unchanged', () => {
    const gdtf = new THREE.Matrix4().makeTranslation(9, 0, 0);
    const t = new THREE.Vector3().setFromMatrixPosition(gdtfSpaceToThreeSpace(gdtf));
    expect(t.x).toBeCloseTo(9, 9);
  });

  it('carries rotation through, not just translation', () => {
    // A 90 deg rotation about GDTF's up axis (Z) must become a 90 deg
    // rotation about Three's up axis (Y), turning GDTF +X into GDTF +Y
    // (i.e. Three +X into Three -Z) -- proving the bridge is a real change
    // of basis (P * M * P^-1), not a translation-only remap.
    const gdtfYaw90 = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const three = gdtfSpaceToThreeSpace(gdtfYaw90);
    const rotatedX = new THREE.Vector3(1, 0, 0).applyMatrix4(three);
    expect(rotatedX.x).toBeCloseTo(0, 9);
    expect(rotatedX.y).toBeCloseTo(0, 9);
    expect(rotatedX.z).toBeCloseTo(-1, 9);

    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(three);
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.y).toBeCloseTo(1, 9);
    expect(up.z).toBeCloseTo(0, 9);
  });

  it('composes correctly across a parent/child chain', () => {
    // Converting each local matrix and composing must equal composing in
    // GDTF-space and converting once (a similarity transform distributes
    // over composition) -- this is the property injectFixtureSockets relies
    // on when it walks the tree one local matrix at a time.
    const parentGdtf = new THREE.Matrix4().makeTranslation(0, 2, 0);
    const childGdtf = new THREE.Matrix4().makeTranslation(0, 0, 1);

    const viaPerNode = gdtfSpaceToThreeSpace(parentGdtf).multiply(gdtfSpaceToThreeSpace(childGdtf));
    const viaComposeFirst = gdtfSpaceToThreeSpace(parentGdtf.clone().multiply(childGdtf));

    const a = new THREE.Vector3().setFromMatrixPosition(viaPerNode);
    const b = new THREE.Vector3().setFromMatrixPosition(viaComposeFirst);
    expect(a.distanceTo(b)).toBeLessThan(1e-9);
  });
});

/* -------------------------------------------------------------------------- */
/* [3] Archive unpacking                                                      */
/* -------------------------------------------------------------------------- */

describe('[3] unpackGdtfArchive', () => {
  const archiveBytes = zipSync({
    'description.xml': strToU8(SAMPLE_DESCRIPTION_XML),
    'models/gltf/base_model.glb': new Uint8Array([1, 2, 3, 4]),
    'models/gltf/head_model.glb': new Uint8Array([5, 6, 7, 8, 9]),
    'thumbnail.png': new Uint8Array([0]),
  });

  it('extracts description.xml verbatim', () => {
    const { descriptionXml } = unpackGdtfArchive(archiveBytes);
    expect(descriptionXml).toBe(SAMPLE_DESCRIPTION_XML);
  });

  it('keys glTF model files by bare basename, ignoring extension and folder', () => {
    const { modelFiles } = unpackGdtfArchive(archiveBytes);
    expect([...modelFiles.keys()].sort()).toEqual(['base_model', 'head_model']);
    expect(modelFiles.get('base_model')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('does not pick up files outside models/gltf/', () => {
    const { modelFiles } = unpackGdtfArchive(archiveBytes);
    expect(modelFiles.has('thumbnail')).toBe(false);
  });

  it('throws when description.xml is missing', () => {
    const noDescription = zipSync({ 'models/gltf/x.glb': new Uint8Array([1]) });
    expect(() => unpackGdtfArchive(noDescription)).toThrow(/description\.xml/);
  });
});

/* -------------------------------------------------------------------------- */
/* [4] XML parsing                                                            */
/* -------------------------------------------------------------------------- */

describe('[4] parseDescriptionXml', () => {
  const profile = parseDescriptionXml(SAMPLE_DESCRIPTION_XML);

  it('reads FixtureType metadata', () => {
    expect(profile.name).toBe('Test Wash 300');
    expect(profile.manufacturer).toBe('Acme Lighting');
    expect(profile.fixtureTypeId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('reads Models with numeric dimensions', () => {
    expect(profile.models).toHaveLength(2);
    const base = profile.models.find((m) => m.name === 'base_model');
    expect(base?.lengthMeters).toBeCloseTo(0.4, 9);
    expect(base?.file).toBe('base_model');
  });

  it('builds the Geometries tree with a single Axis child at the root, not flattened', () => {
    expect(profile.geometries).toHaveLength(1);
    const yoke = profile.geometries[0]!;
    expect(yoke.kind).toBe('Axis');
    expect(yoke.name).toBe('Yoke');
    expect(yoke.children).toHaveLength(1);

    const head = yoke.children[0]!;
    expect(head.kind).toBe('Axis');
    expect(head.name).toBe('Head');
    expect(head.children).toHaveLength(1);
  });

  it('extracts Beam photometric properties', () => {
    const beam = profile.geometries[0]!.children[0]!.children[0]!;
    expect(beam.kind).toBe('Beam');
    expect(beam.beam).not.toBeNull();
    expect(beam.beam?.luminousFluxLumens).toBe(12000);
    expect(beam.beam?.colorTemperatureKelvin).toBe(6500);
    expect(beam.beam?.beamAngleDegrees).toBe(18);
    expect(beam.beam?.beamType).toBe('Spot');
  });

  it('does not collapse a single DMXMode/DMXChannel into a bare object', () => {
    expect(profile.dmxModes).toHaveLength(1);
    expect(profile.dmxModes[0]!.channels).toHaveLength(3);
  });

  it('parses multi-byte Offset lists and single-byte offsets alike', () => {
    const [pan, tilt, dimmer] = profile.dmxModes[0]!.channels;
    expect(pan!.offset).toEqual([1, 2]);
    expect(tilt!.offset).toEqual([3, 4]);
    expect(dimmer!.offset).toEqual([5]);
  });

  it('derives mode footprint from the highest channel offset', () => {
    expect(profile.dmxModes[0]!.footprint).toBe(5);
  });

  it('extracts LogicalChannel/ChannelFunction with physical range and raw DMXValue', () => {
    const pan = profile.dmxModes[0]!.channels[0]!;
    expect(pan.logicalChannels).toHaveLength(1);
    const fn = pan.logicalChannels[0]!.channelFunctions[0]!;
    expect(pan.logicalChannels[0]!.attribute).toBe('Pan');
    expect(fn.physicalFrom).toBe(-270);
    expect(fn.physicalTo).toBe(270);
    // Raw DIN SPEC 15800 byte-mirroring notation, not decoded to a level.
    expect(fn.defaultValue).toBe('32768/2');
  });

  it('throws a clear error on a document with no GDTF/FixtureType root', () => {
    expect(() => parseDescriptionXml('<NotGdtf/>')).toThrow(/FixtureType/);
  });
});

/* -------------------------------------------------------------------------- */
/* [5] Socket injection                                                       */
/* -------------------------------------------------------------------------- */

describe('[5] injectFixtureSockets', () => {
  const profile = parseDescriptionXml(SAMPLE_DESCRIPTION_XML);
  const sockets = injectFixtureSockets(profile);

  it('emits exactly one clamp socket and one yoke-axis socket per Axis node', () => {
    expect(sockets).toHaveLength(3); // fixture_clamp + Yoke + Head
    expect(sockets.filter((s) => s.socket_type === 'PIPE_CLAMP_2IN')).toHaveLength(1);
    expect(sockets.filter((s) => s.socket_type === 'FIXTURE_YOKE_AXIS')).toHaveLength(2);
  });

  it('places the clamp at the fixture origin, pointing up', () => {
    const clamp = sockets.find((s) => s.socket_type === 'PIPE_CLAMP_2IN')!;
    expect(clamp.transform.translation).toEqual([0, 0, 0]);
    expect(clamp.transform.normal).toEqual([0, 1, 0]);
  });

  it('composes the Head axis position down through its Yoke parent (0.3 + 0.15 m up)', () => {
    const head = sockets.find((s) => s.tags?.includes('Head'))!;
    expect(head.transform.translation[0]).toBeCloseTo(0, 9);
    expect(head.transform.translation[1]).toBeCloseTo(0.45, 9);
    expect(head.transform.translation[2]).toBeCloseTo(0, 9);
  });

  it('places the Yoke axis 0.3 m up, unaffected by its own child', () => {
    const yoke = sockets.find((s) => s.tags?.includes('Yoke'))!;
    expect(yoke.transform.translation[1]).toBeCloseTo(0.3, 9);
  });

  it('pins yoke-axis sockets inert for snapping: can_parent and can_child both false', () => {
    for (const s of sockets.filter((s) => s.socket_type === 'FIXTURE_YOKE_AXIS')) {
      expect(s.kinematic_rules?.can_parent).toBe(false);
      expect(s.kinematic_rules?.can_child).toBe(false);
    }
  });

  it('gives every socket a unique id', () => {
    const ids = sockets.map((s) => s.socket_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------- */
/* [6] GLB extras injection (gltf-transform round trip)                       */
/* -------------------------------------------------------------------------- */

describe('[6] injectSocketsIntoGlb', () => {
  it('writes sockets and extra extras onto every root node, round-tripped through a real GLB', async () => {
    const doc = new Document();
    doc.createBuffer();
    const scene = doc.createScene('scene');
    const node = doc.createNode('root');
    scene.addChild(node);
    const glb = await new NodeIO().writeBinary(doc);

    const sockets = injectFixtureSockets(parseDescriptionXml(SAMPLE_DESCRIPTION_XML));
    const injected = await injectSocketsIntoGlb(glb, sockets, { fixture_type_id: 'test-uuid' });

    const readBack = await new NodeIO().readBinary(injected);
    const rootNode = readBack.getRoot().listScenes()[0]!.listChildren()[0]!;
    const extras = rootNode.getExtras() as { sockets?: unknown; fixture_type_id?: unknown };
    expect(Array.isArray(extras.sockets)).toBe(true);
    expect((extras.sockets as unknown[]).length).toBe(sockets.length);
    expect(extras.fixture_type_id).toBe('test-uuid');
  });
});
