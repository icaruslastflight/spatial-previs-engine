import { describe, it, expect, beforeEach } from 'vitest';
import { VectorMemoryStore, CORE_DOMAIN_KNOWLEDGE } from './VectorMemoryStore';

describe('VectorMemoryStore', () => {
  let store: VectorMemoryStore;

  beforeEach(() => {
    store = new VectorMemoryStore(true);
  });

  it('initializes with core domain knowledge seeded', () => {
    expect(store.count()).toBeGreaterThanOrEqual(CORE_DOMAIN_KNOWLEDGE.length);
  });

  it('retrieves Point State Park WGS84 anchor via semantic search', () => {
    const results = store.search('Point State Park WGS84 spatial anchor');
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.document.text).toContain('Point State Park');
    expect(top.document.text).toContain('184.963 m');
    expect(top.score).toBeGreaterThan(0.2);
  });

  it('retrieves GDTF and MVR units via query', () => {
    const results = store.search('GDTF DIN SPEC position units');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.metadata.tags).toContain('gdtf');
    expect(results[0].document.text).toContain('meters');
  });

  it('filters results by category', () => {
    const results = store.search('safety', { category: 'safety_manual' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.document.metadata.category).toBe('safety_manual');
    }
  });

  it('adds custom documents and searches them', () => {
    store.addDocument({
      id: 'doc_custom_lut',
      text: 'Custom 3D LUT camera color calibration for ARRI Alexa 35 and RED V-Raptor',
      metadata: {
        category: 'planning',
        tags: ['camera', 'lut', 'color']
      }
    });

    const results = store.search('ARRI Alexa color calibration');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe('doc_custom_lut');
  });

  it('serializes and deserializes cleanly via JSON', () => {
    const json = store.toJSON();
    const newStore = new VectorMemoryStore(false);
    expect(newStore.count()).toBe(0);
    newStore.fromJSON(json);
    expect(newStore.count()).toBe(store.count());

    const results = newStore.search('ESTA rigging deflection span');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.text).toContain('span / 180');
  });
});
