/**
 * The palette's sample fixture archive, run through the real parse/register/
 * instantiate path -- the same integration `main.ts` exercises, just without
 * a DOM. Existing `tests/gdtf.test.ts` covers `buildGdtfArchive`/`parseGDTF`/
 * `GDTFAssetResolver` thoroughly in isolation; this file only checks the
 * thin wrapper around them (the name/manufacturer/fixtureTypeId overrides,
 * and that the id this module exports is the one a built archive actually
 * carries) rather than re-covering their own contract.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { buildSampleFixtureArchive, SAMPLE_FIXTURE_TYPE_ID } from './SampleGdtfProfile.ts';
import { parseGDTF } from '../engine/GDTFParser.ts';
import { GDTFAssetResolver } from '../engine/GDTFAssetResolver.ts';
import { readSockets } from '../engine/SocketSnappingEngine.ts';

describe('[1] buildSampleFixtureArchive', () => {
  it('parses to a profile carrying SAMPLE_FIXTURE_TYPE_ID, clearly marked synthetic', async () => {
    const profile = await parseGDTF(await buildSampleFixtureArchive());
    expect(profile.fixtureTypeId).toBe(SAMPLE_FIXTURE_TYPE_ID);
    expect(profile.manufacturer).toContain('synthetic');
  });

  it('resolves to a scene-ready instance registered with the standard socket contract', async () => {
    const resolver = new GDTFAssetResolver();
    resolver.register(await parseGDTF(await buildSampleFixtureArchive()));

    const instance = resolver.instantiateFixture(SAMPLE_FIXTURE_TYPE_ID);
    expect(instance.root).toBeInstanceOf(THREE.Group);
    expect(instance.light).toBeInstanceOf(THREE.SpotLight);

    const sockets = readSockets(instance.root);
    expect(sockets.some((s) => s.socket_type === 'PIPE_CLAMP_2IN')).toBe(true);
  });

  it('drives pan/tilt without throwing, given a plausible DMX universe', async () => {
    const resolver = new GDTFAssetResolver();
    resolver.register(await parseGDTF(await buildSampleFixtureArchive()));
    const instance = resolver.instantiateFixture(SAMPLE_FIXTURE_TYPE_ID);

    const universe = new Uint8Array(512);
    universe[4] = 255; // dimmer channel, Standard mode offset 5 (1-indexed)
    expect(() => instance.updateDMXChannels(universe)).not.toThrow();
  });
});
