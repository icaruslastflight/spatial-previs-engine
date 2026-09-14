/**
 * GDTF runtime resolver checks: registration, hierarchy construction, and the
 * photometric helpers that turn GDTF Beam attributes into a THREE.SpotLight.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { parseDescriptionXml } from './GDTFParser.ts';
import { colorTemperatureToRgb, GDTFAssetResolver, luminousFluxToCandela } from './GDTFAssetResolver.ts';
import { readSockets } from './SocketSnappingEngine.ts';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Test Wash 300" ShortName="TW300" Manufacturer="Acme Lighting"
      FixtureTypeID="11111111-2222-3333-4444-555555555555">
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
    <DMXModes/>
  </FixtureType>
</GDTF>`;

const FIXTURE_TYPE_ID = '11111111-2222-3333-4444-555555555555';

function buildResolverWithSample(): GDTFAssetResolver {
  const resolver = new GDTFAssetResolver();
  resolver.registerProfile(parseDescriptionXml(SAMPLE_XML));
  return resolver;
}

/* -------------------------------------------------------------------------- */
/* [1] Registration                                                           */
/* -------------------------------------------------------------------------- */

describe('[1] profile registration', () => {
  it('indexes a profile by FixtureTypeID and returns it by that id', () => {
    const resolver = buildResolverWithSample();
    expect(resolver.getProfile(FIXTURE_TYPE_ID)?.name).toBe('Test Wash 300');
    expect(resolver.registeredProfiles).toHaveLength(1);
  });

  it('rejects a profile with no FixtureTypeID', () => {
    const resolver = new GDTFAssetResolver();
    const profile = parseDescriptionXml(SAMPLE_XML);
    resolver.registerProfile({ ...profile, fixtureTypeId: '' });
    expect(resolver.registeredProfiles).toHaveLength(0);
  });

  it('returns null instantiating an unregistered id', () => {
    const resolver = new GDTFAssetResolver();
    expect(resolver.instantiateFixture('not-registered')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* [2] Hierarchy construction                                                 */
/* -------------------------------------------------------------------------- */

describe('[2] instantiateFixture', () => {
  it('mirrors the Geometries tree as nested Object3D groups, not a flat list', () => {
    const root = buildResolverWithSample().instantiateFixture(FIXTURE_TYPE_ID)!;
    expect(root.name).toBe('Test Wash 300');
    expect(root.children).toHaveLength(1);

    const yoke = root.children[0]!;
    expect(yoke.name).toBe('Yoke');
    // The placeholder mesh is one child; the nested Head axis is another.
    const head = yoke.children.find((c) => c.name === 'Head')!;
    expect(head).toBeDefined();
    expect(head.children.find((c) => c.name === 'Beam')).toBeDefined();
  });

  it('places the Yoke and Head groups at the same composed positions the socket injector derives', () => {
    const root = buildResolverWithSample().instantiateFixture(FIXTURE_TYPE_ID)!;
    const yoke = root.children[0]!;
    expect(yoke.position.y).toBeCloseTo(0.3, 9);

    const head = yoke.children.find((c) => c.name === 'Head')!;
    // Head's position is LOCAL to Yoke here (0.15 m), not world -- the 0.45 m
    // composed figure belongs to the socket transforms, checked separately.
    expect(head.position.y).toBeCloseTo(0.15, 9);

    root.updateMatrixWorld(true);
    const worldPosition = new THREE.Vector3();
    head.getWorldPosition(worldPosition);
    expect(worldPosition.y).toBeCloseTo(0.45, 9);
  });

  it('attaches a SpotLight to the Beam node and nowhere else', () => {
    const root = buildResolverWithSample().instantiateFixture(FIXTURE_TYPE_ID)!;
    const lights: THREE.Light[] = [];
    root.traverse((obj) => {
      if (obj instanceof THREE.SpotLight) lights.push(obj);
    });
    expect(lights).toHaveLength(1);
  });

  it('sizes placeholder meshes from the linked Model, not a fixed default', () => {
    const root = buildResolverWithSample().instantiateFixture(FIXTURE_TYPE_ID)!;
    const yoke = root.children[0]!;
    const yokeMesh = yoke.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    const box = yokeMesh.geometry as THREE.BoxGeometry;
    // base_model: Length 0.4 (X), Width 0.3 (Y-in-GDTF -> Z-in-Three), Height 0.35 (Z-in-GDTF -> Y-in-Three).
    expect(box.parameters.width).toBeCloseTo(0.4, 9);
    expect(box.parameters.height).toBeCloseTo(0.35, 9);
    expect(box.parameters.depth).toBeCloseTo(0.3, 9);
  });

  it('writes extras.sockets on the root, readable through the standard socket contract', () => {
    const root = buildResolverWithSample().instantiateFixture(FIXTURE_TYPE_ID)!;
    const sockets = readSockets(root);
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.some((s) => s.socket_type === 'FIXTURE_YOKE_AXIS')).toBe(true);
    expect(sockets.some((s) => s.socket_type === 'PIPE_CLAMP_2IN')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* [3] Photometry                                                             */
/* -------------------------------------------------------------------------- */

describe('[3] luminousFluxToCandela', () => {
  it('matches the cone solid-angle formula for a known angle', () => {
    // 90 deg beam angle -> 45 deg half-angle -> solid angle 2*pi*(1-cos45) ~= 1.8403 sr.
    const candela = luminousFluxToCandela(1840.3, 90);
    expect(candela).toBeCloseTo(1000, 0);
  });

  it('concentrates the same lumens into more candela for a narrower beam', () => {
    const narrow = luminousFluxToCandela(10000, 10);
    const wide = luminousFluxToCandela(10000, 60);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('does not divide by ~0 for a degenerate beam angle', () => {
    expect(Number.isFinite(luminousFluxToCandela(5000, 0))).toBe(true);
  });
});

describe('[4] colorTemperatureToRgb', () => {
  it('produces valid [0,1] color components across the working range', () => {
    for (const kelvin of [1500, 2700, 4000, 6500, 10000, 20000]) {
      const c = colorTemperatureToRgb(kelvin);
      for (const channel of [c.r, c.g, c.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
        expect(Number.isFinite(channel)).toBe(true);
      }
    }
  });

  it('reads warm (red-dominant, blue-suppressed) at low temperatures', () => {
    const warm = colorTemperatureToRgb(2000);
    expect(warm.r).toBeCloseTo(1, 6);
    expect(warm.b).toBeLessThan(warm.r);
  });

  it('reads cool (blue-dominant, red-reduced) at high temperatures', () => {
    const cool = colorTemperatureToRgb(20000);
    expect(cool.b).toBeCloseTo(1, 6);
    expect(cool.r).toBeLessThan(cool.b);
  });

  it('is monotonically no-warmer as Kelvin rises (red non-increasing, blue non-decreasing) past 6600 K', () => {
    const lower = colorTemperatureToRgb(7000);
    const higher = colorTemperatureToRgb(15000);
    expect(higher.r).toBeLessThanOrEqual(lower.r + 1e-9);
    expect(higher.b).toBeGreaterThanOrEqual(lower.b - 1e-9);
  });
});
