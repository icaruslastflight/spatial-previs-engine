/**
 * GDTF parser and runtime resolver verification.
 *
 * Runs against real `.gdtf` archives built in `helpers/gdtfFixture.ts` -- actual
 * ZIP containers holding actual DIN SPEC 15800 XML -- so the ZIP traversal, the
 * attribute names, the matrix grammar and the `value/resolution` DMX grammar are
 * all on the path under test.
 *
 * The DMX assertions are the ones worth reading closely. A fixture that maps
 * 16-bit pan slightly wrong still looks plausible on screen while pointing a
 * degree off, which is exactly the error a previz pass exists to catch.
 */

import { describe, expect, it } from 'vitest';

import {
  channelsForAttribute,
  findAxes,
  findBeam,
  findDmxMode,
  normalizeDmx,
  parseDmxValue,
  parseGDTF,
  parseMatrix,
  readChannelValue,
  walkGeometry,
  GDTFParseError,
} from '../src/engine/GDTFParser.ts';
import {
  CLAMP_SOCKET_ID,
  EMITTER_ID,
  GDTFAssetResolver,
  GDTFResolveError,
  HEAD_PIVOT_ID,
  LIGHT_DECAY,
  YOKE_PIVOT_ID,
  fluxToCandela,
  kelvinToColor,
  penumbraFrom,
} from '../src/engine/GDTFAssetResolver.ts';
import { normalizeSocket } from '../src/engine/SocketSnappingEngine.ts';
import {
  BEAM_ANGLE_DEG,
  BEAM_HEIGHT_M,
  COLOR_TEMPERATURE_K,
  DEFAULT_FIXTURE_TYPE_ID,
  FIELD_ANGLE_DEG,
  HEAD_HEIGHT_M,
  LUMINOUS_FLUX_LM,
  PAN_FROM_DEG,
  PAN_TO_DEG,
  TILT_FROM_DEG,
  TILT_TO_DEG,
  YOKE_HEIGHT_M,
  buildGdtfArchive,
  patchUniverse,
} from './helpers/gdtfFixture.ts';

/* -------------------------------------------------------------------------- */
/* Primitive grammars                                                         */
/* -------------------------------------------------------------------------- */

describe('GDTF value grammars', () => {
  it('reads a DMX value at its declared resolution', () => {
    expect(parseDmxValue('32768/2')).toEqual({ value: 32768, resolution: 2 });
    expect(parseDmxValue('255/1')).toEqual({ value: 255, resolution: 1 });
  });

  it('treats a bare number as 8-bit, per the GDTF default', () => {
    expect(parseDmxValue('128')).toEqual({ value: 128, resolution: 1 });
  });

  it('reads None as zero rather than throwing', () => {
    // GDTF writes None for an absent highlight; it is valid, not malformed.
    expect(parseDmxValue('None')).toEqual({ value: 0, resolution: 1 });
  });

  it('normalizes against the maximum representable value so full scale is 1.0', () => {
    expect(normalizeDmx(255, 1)).toBe(1);
    expect(normalizeDmx(65535, 2)).toBe(1);
    expect(normalizeDmx(0, 2)).toBe(0);
  });

  it('converts a GDTF Z-up translation into Three Y-up', () => {
    // GDTF (0, 0, 2) is two metres up; Three calls that +Y.
    const transform = parseMatrix(
      '{1,0,0,0}{0,1,0,0}{0,0,1,0}{0.000000,0.000000,2.000000,1.000000}',
    );
    expect(transform.translation[0]).toBeCloseTo(0, 6);
    expect(transform.translation[1]).toBeCloseTo(2, 6);
    expect(transform.translation[2]).toBeCloseTo(0, 6);
  });

  it('falls back to identity for a malformed matrix instead of throwing', () => {
    // One unreadable joint should not cost the whole fixture.
    expect(parseMatrix('not a matrix').translation).toEqual([0, 0, 0]);
    expect(parseMatrix(undefined).basis).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

describe('parseGDTF', () => {
  it('extracts the fixture identity and data version', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());

    expect(profile.dataVersion).toBe('1.2');
    expect(profile.fixtureTypeId).toBe(DEFAULT_FIXTURE_TYPE_ID);
    expect(profile.name).toBe('MegaPointe');
    expect(profile.manufacturer).toBe('Robe Lighting');
    expect(profile.longName).toBe('Robe Lighting MegaPointe');
  });

  it('extracts every declared attribute definition', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const names = profile.attributes.map((attribute) => attribute.name);

    expect(names).toContain('Pan');
    expect(names).toContain('Tilt');
    expect(names).toContain('Dimmer');
    expect(names).toContain('ColorAdd_R');

    const pan = profile.attributes.find((attribute) => attribute.name === 'Pan');
    expect(pan?.physicalUnit).toBe('Angle');
    expect(pan?.feature).toBe('Position.PanTilt');
  });

  it('builds the kinematic tree base -> yoke -> head -> beam', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());

    expect(profile.geometry).not.toBeNull();
    const names = Array.from(walkGeometry(profile.geometry!)).map((node) => node.name);
    expect(names).toEqual(['Base', 'Yoke', 'Head', 'Beam']);

    const axes = findAxes(profile);
    expect(axes.map((axis) => axis.name)).toEqual(['Yoke', 'Head']);

    // Each joint's transform is relative to its parent, converted to Y-up.
    expect(axes[0].transform.translation[1]).toBeCloseTo(YOKE_HEIGHT_M, 6);
    expect(axes[1].transform.translation[1]).toBeCloseTo(HEAD_HEIGHT_M, 6);
  });

  it('extracts the photometric beam', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const beamNode = findBeam(profile);

    expect(beamNode).not.toBeNull();
    expect(beamNode!.beam!.luminousFluxLumens).toBe(LUMINOUS_FLUX_LM);
    expect(beamNode!.beam!.colorTemperatureKelvin).toBe(COLOR_TEMPERATURE_K);
    expect(beamNode!.beam!.beamAngleDegrees).toBeCloseTo(BEAM_ANGLE_DEG, 4);
    expect(beamNode!.beam!.fieldAngleDegrees).toBeCloseTo(FIELD_ANGLE_DEG, 4);
    expect(beamNode!.transform.translation[1]).toBeCloseTo(BEAM_HEIGHT_M, 6);
  });

  it('parses every DMX mode and its channel count', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());

    expect(profile.dmxModes).toHaveLength(2);
    expect(profile.dmxModes.map((mode) => mode.name)).toEqual(['Standard', 'Basic']);

    const standard = findDmxMode(profile, 'Standard')!;
    // Pan 16-bit, tilt 16-bit, dimmer, R, G, B, plus one virtual Zoom channel.
    expect(standard.channels).toHaveLength(7);
    // Footprint counts only channels that occupy DMX slots.
    expect(standard.footprint).toBe(8);
  });

  it('resolves 16-bit channel offsets coarse-first', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const standard = findDmxMode(profile, 'Standard')!;

    const pan = channelsForAttribute(standard, 'Pan')[0];
    expect(pan.offsets).toEqual([1, 2]);
    expect(pan.dmxBreak).toBe(1);
    expect(pan.geometry).toBe('Yoke');

    const tilt = channelsForAttribute(standard, 'Tilt')[0];
    expect(tilt.offsets).toEqual([3, 4]);
  });

  it('gives a virtual channel an empty footprint rather than offset zero', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const standard = findDmxMode(profile, 'Standard')!;

    const zoom = channelsForAttribute(standard, 'Zoom')[0];
    expect(zoom.offsets).toEqual([]);
  });

  it('carries each channel function physical range through', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const standard = findDmxMode(profile, 'Standard')!;

    const pan = channelsForAttribute(standard, 'Pan')[0];
    expect(pan.functions[0].physicalFrom).toBe(PAN_FROM_DEG);
    expect(pan.functions[0].physicalTo).toBe(PAN_TO_DEG);

    const tilt = channelsForAttribute(standard, 'Tilt')[0];
    expect(tilt.functions[0].physicalFrom).toBe(TILT_FROM_DEG);
    expect(tilt.functions[0].physicalTo).toBe(TILT_TO_DEG);
  });

  it('lifts models, thumbnail and wheel rasters out of the archive', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());

    expect(Array.from(profile.assets.models.keys()).sort()).toEqual(['base', 'beam', 'head', 'yoke']);
    expect(profile.assets.thumbnail).not.toBeNull();
    expect(Array.from(profile.assets.wheels.keys()).sort()).toEqual([
      'wheels/filters/cto.png',
      'wheels/gobos/gobo1.png',
    ]);

    // Each model entry is a real GLB: magic "glTF" in the first four bytes.
    const base = profile.assets.models.get('base')!;
    expect(Array.from(base.subarray(0, 4))).toEqual([0x67, 0x6c, 0x54, 0x46]);
  });

  it('reads a 16-bit value coarse byte first', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const standard = findDmxMode(profile, 'Standard')!;
    const pan = channelsForAttribute(standard, 'Pan')[0];

    // 0xBEEF split across the coarse and fine slots.
    const universe = new Uint8Array(512);
    universe[0] = 0xbe;
    universe[1] = 0xef;

    expect(readChannelValue(pan, universe, 1)).toEqual({ value: 0xbeef, resolution: 2 });
  });

  it('honours the patch address when reading a channel', async () => {
    const profile = await parseGDTF(await buildGdtfArchive());
    const standard = findDmxMode(profile, 'Standard')!;
    const pan = channelsForAttribute(standard, 'Pan')[0];

    const universe = new Uint8Array(512);
    universe[100] = 0x12; // DMX channel 101
    universe[101] = 0x34;

    expect(readChannelValue(pan, universe, 101).value).toBe(0x1234);
  });

  it('rejects an archive that is not a ZIP', async () => {
    await expect(parseGDTF(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(GDTFParseError);
  });

  it('rejects a ZIP with no description.xml', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('readme.txt', 'not a fixture');

    await expect(parseGDTF(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /no description\.xml/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Photometry                                                                 */
/* -------------------------------------------------------------------------- */

describe('photometric conversion', () => {
  it('spreads luminous flux over the cone to get candela', () => {
    // I = flux / (2*pi*(1 - cos(half angle)))
    const halfAngle = (FIELD_ANGLE_DEG / 2) * (Math.PI / 180);
    const expected = LUMINOUS_FLUX_LM / (2 * Math.PI * (1 - Math.cos(halfAngle)));

    expect(fluxToCandela(LUMINOUS_FLUX_LM, FIELD_ANGLE_DEG)).toBeCloseTo(expected, 3);
  });

  it('makes a narrow beam more intense than a wide one at equal flux', () => {
    // The whole reason flux cannot be handed to intensity directly.
    expect(fluxToCandela(20000, 4)).toBeGreaterThan(fluxToCandela(20000, 40));
  });

  it('reports zero intensity for a profile with no published flux', () => {
    expect(fluxToCandela(0, 10)).toBe(0);
  });

  it('derives penumbra from the beam/field ratio', () => {
    expect(penumbraFrom({ beamAngleDegrees: 3.8, fieldAngleDegrees: 4.2 } as never)).toBeCloseTo(
      1 - 3.8 / 4.2,
      6,
    );
  });

  it('treats beam >= field as a hard edge', () => {
    expect(penumbraFrom({ beamAngleDegrees: 10, fieldAngleDegrees: 10 } as never)).toBe(0);
  });

  it('puts a warm source red-dominant and a cool source blue-dominant', () => {
    const warm = kelvinToColor(2700);
    const cool = kelvinToColor(9000);

    expect(warm.r).toBeGreaterThan(warm.b);
    expect(cool.b).toBeGreaterThan(cool.r);
  });
});

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

async function makeResolver(): Promise<GDTFAssetResolver> {
  const resolver = new GDTFAssetResolver();
  resolver.register(await parseGDTF(await buildGdtfArchive()));
  return resolver;
}

describe('GDTFAssetResolver', () => {
  it('indexes profiles by FixtureTypeID', async () => {
    const resolver = await makeResolver();

    expect(resolver.has(DEFAULT_FIXTURE_TYPE_ID)).toBe(true);
    expect(resolver.fixtureTypeIds).toEqual([DEFAULT_FIXTURE_TYPE_ID]);
    expect(resolver.get(DEFAULT_FIXTURE_TYPE_ID)?.name).toBe('MegaPointe');
  });

  it('refuses to instantiate an unregistered fixture type', async () => {
    const resolver = await makeResolver();
    expect(() => resolver.instantiateFixture('nope')).toThrow(GDTFResolveError);
  });

  it('refuses a mode the profile does not declare', async () => {
    const resolver = await makeResolver();
    expect(() => resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID, 'Extended')).toThrow(
      /no DMX mode named "Extended"/,
    );
  });

  it('nests the kinematic chain base -> yoke -> head -> emitter', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    expect(fixture.baseGroup.parent).toBe(fixture.root);
    expect(fixture.yokeGroup.parent).toBe(fixture.baseGroup);
    expect(fixture.headGroup.parent).toBe(fixture.yokeGroup);
    expect(fixture.emitterGroup.parent).toBe(fixture.headGroup);

    fixture.dispose();
  });

  it('stacks the joint offsets into world space', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    fixture.root.updateMatrixWorld(true);

    const headWorld = fixture.headGroup.getWorldPosition(new (await import('three')).Vector3());
    expect(headWorld.y).toBeCloseTo(YOKE_HEIGHT_M + HEAD_HEIGHT_M, 6);

    const emitterWorld = fixture.emitterGroup.getWorldPosition(
      new (await import('three')).Vector3(),
    );
    expect(emitterWorld.y).toBeCloseTo(YOKE_HEIGHT_M + HEAD_HEIGHT_M + BEAM_HEIGHT_M, 6);

    fixture.dispose();
  });

  it('injects a clamp socket the snapping engine accepts', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    const sockets = fixture.root.userData.sockets;
    expect(Array.isArray(sockets)).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].socket_id).toBe(CLAMP_SOCKET_ID);
    expect(sockets[0].socket_type).toBe('PIPE_CLAMP_2IN');

    // The real check: the engine's own normalizer must accept it. A socket the
    // engine rejects is metadata that looks right and does nothing.
    const normalized = normalizeSocket(sockets[0]);
    expect(normalized).not.toBeNull();
    expect(normalized!.socket_id).toBe(CLAMP_SOCKET_ID);
    expect(normalized!.socket_type).toBe('PIPE_CLAMP_2IN');
    expect(normalized!.snapRadius).toBeCloseTo(0.15, 6);

    fixture.dispose();
  });

  it('makes the clamp reparentable so a fixture can hang off truss', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    const normalized = normalizeSocket(fixture.root.userData.sockets[0])!;
    // The engine gates reparenting on the MOVING socket's canChild, and a
    // fixture dragged onto truss is the moving side.
    expect(normalized.canChild).toBe(true);
    expect(normalized.loadBearing).toBe(true);

    fixture.dispose();
  });

  it('records the pan pivot, tilt pivot and emitter as kinematic references', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    const ids = fixture.root.userData.kinematics.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual([YOKE_PIVOT_ID, HEAD_PIVOT_ID, EMITTER_ID]);

    fixture.dispose();
  });

  it('configures the spot light from the GDTF beam', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    // Three's angle is the half-angle from the cone centre.
    expect(fixture.light.angle).toBeCloseTo((FIELD_ANGLE_DEG / 2) * (Math.PI / 180), 6);
    expect(fixture.light.penumbra).toBeCloseTo(1 - BEAM_ANGLE_DEG / FIELD_ANGLE_DEG, 6);
    expect(fixture.light.decay).toBe(LIGHT_DECAY);
    expect(fixture.light.intensity).toBeCloseTo(fluxToCandela(LUMINOUS_FLUX_LM, FIELD_ANGLE_DEG), 3);

    fixture.dispose();
  });

  it('parents the light target ahead of the emitter so the beam tracks the head', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    expect(fixture.light.target.parent).toBe(fixture.emitterGroup);
    expect(fixture.light.target.position.y).toBeCloseTo(1, 6);

    fixture.dispose();
  });

  it('reports the mode footprint so the fixture can be patched', async () => {
    const resolver = await makeResolver();

    expect(resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID, 'Standard').footprint).toBe(8);
    expect(resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID, 'Basic').footprint).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* DMX kinematics                                                             */
/* -------------------------------------------------------------------------- */

describe('16-bit DMX to physical angle', () => {
  it('drives pan across its full -270..+270 range', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    expect(fixture.updateDMXChannels(patchUniverse({ pan16: 0 })).panDegrees).toBeCloseTo(
      PAN_FROM_DEG,
      4,
    );
    expect(fixture.updateDMXChannels(patchUniverse({ pan16: 65535 })).panDegrees).toBeCloseTo(
      PAN_TO_DEG,
      4,
    );

    // Mid-scale lands on centre. 32768/65535 is a hair over half, which is the
    // correct consequence of normalizing against the maximum representable
    // value rather than against 65536.
    expect(fixture.updateDMXChannels(patchUniverse({ pan16: 32768 })).panDegrees).toBeCloseTo(0, 1);

    fixture.dispose();
  });

  it('drives tilt across its full -120..+120 range', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    expect(fixture.updateDMXChannels(patchUniverse({ tilt16: 0 })).tiltDegrees).toBeCloseTo(
      TILT_FROM_DEG,
      4,
    );
    expect(fixture.updateDMXChannels(patchUniverse({ tilt16: 65535 })).tiltDegrees).toBeCloseTo(
      TILT_TO_DEG,
      4,
    );

    fixture.dispose();
  });

  it('resolves a quarter-scale reading to the matching quarter of the range', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    const quarter = Math.round(65535 * 0.25);
    const expected = PAN_FROM_DEG + (PAN_TO_DEG - PAN_FROM_DEG) * (quarter / 65535);

    expect(fixture.updateDMXChannels(patchUniverse({ pan16: quarter })).panDegrees).toBeCloseTo(
      expected,
      4,
    );

    fixture.dispose();
  });

  it('applies pan to the yoke and tilt to the head, not the other way round', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    fixture.updateDMXChannels(patchUniverse({ pan16: 65535, tilt16: 0 }));

    // GDTF axes rotate about their own local X.
    expect(fixture.yokeGroup.rotation.x).toBeCloseTo((PAN_TO_DEG * Math.PI) / 180, 6);
    expect(fixture.headGroup.rotation.x).toBeCloseTo((TILT_FROM_DEG * Math.PI) / 180, 6);

    fixture.dispose();
  });

  it('scales light intensity by the dimmer', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);
    const peak = fluxToCandela(LUMINOUS_FLUX_LM, FIELD_ANGLE_DEG);

    fixture.updateDMXChannels(patchUniverse({ dimmer: 255 }));
    expect(fixture.light.intensity).toBeCloseTo(peak, 3);

    fixture.updateDMXChannels(patchUniverse({ dimmer: 0 }));
    expect(fixture.light.intensity).toBe(0);

    fixture.dispose();
  });

  it('drives the light colour from the RGB channels', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    fixture.updateDMXChannels(patchUniverse({ rgb: [255, 0, 0] }));
    expect(fixture.light.color.r).toBeCloseTo(1, 6);
    expect(fixture.light.color.g).toBeCloseTo(0, 6);

    fixture.updateDMXChannels(patchUniverse({ rgb: [0, 0, 255] }));
    expect(fixture.light.color.b).toBeCloseTo(1, 6);

    fixture.dispose();
  });

  it('reads the fixture at its patch address, not always at channel 1', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    const universe = patchUniverse({ pan16: 65535, baseAddress: 100 });

    // At its real address the fixture sees full pan.
    expect(fixture.updateDMXChannels(universe, 100).panDegrees).toBeCloseTo(PAN_TO_DEG, 4);
    // Read at channel 1 it sees the empty part of the universe instead.
    expect(fixture.updateDMXChannels(universe, 1).panDegrees).toBeCloseTo(PAN_FROM_DEG, 4);

    fixture.dispose();
  });

  it('allocates nothing per update, so the telemetry tick stays GC-neutral', async () => {
    const resolver = await makeResolver();
    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);
    const universe = patchUniverse({});

    const first = fixture.updateDMXChannels(universe);
    const second = fixture.updateDMXChannels(universe);

    // The same scratch Color instance comes back every frame.
    expect(second.color).toBe(first.color);

    fixture.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Degraded profiles                                                          */
/* -------------------------------------------------------------------------- */

describe('profiles missing optional parts', () => {
  it('resolves a fixture whose profile declares no beam', async () => {
    const resolver = new GDTFAssetResolver();
    resolver.register(await parseGDTF(await buildGdtfArchive({ includeBeam: false })));

    const fixture = resolver.instantiateFixture(DEFAULT_FIXTURE_TYPE_ID);

    // No published flux means no intensity, but the chain still assembles so
    // the fixture can be positioned and clamped.
    expect(fixture.light.intensity).toBe(0);
    expect(fixture.emitterGroup.parent).toBe(fixture.headGroup);
    expect(fixture.root.userData.sockets).toHaveLength(1);

    fixture.dispose();
  });

  it('parses an archive that ships no GLB models', async () => {
    const profile = await parseGDTF(await buildGdtfArchive({ includeModels: false }));

    expect(profile.assets.models.size).toBe(0);
    expect(profile.geometry).not.toBeNull();
  });

  it('handles a single-mode profile', async () => {
    const profile = await parseGDTF(await buildGdtfArchive({ includeBasicMode: false }));

    expect(profile.dmxModes).toHaveLength(1);
    expect(findDmxMode(profile)?.name).toBe('Standard');
  });
});
