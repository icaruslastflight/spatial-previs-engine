import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/r0/production-project.v1.json';
import { createProject, createRecordId } from './ProductionProject.ts';
import type { ProductionProject, ProductionRecord } from './ProductionProject.ts';
import { parseProject, serializeProject, validateProject } from './ProjectCodec.ts';

function project(): ProductionProject { return parseProject(JSON.stringify(fixture)); }
function find<K extends ProductionRecord['kind']>(p: ProductionProject, kind: K): Extract<ProductionRecord, {kind: K}> {
  return p.records.find(r => r.kind === kind) as Extract<ProductionRecord, {kind: K}>;
}
describe('R0 production contract', () => {
  it('round-trips stable IDs, unknown quantities, frames, locks and ordered references', () => {
    const p = project();
    p.records[0]!.locked = true;
    const reopened = parseProject(serializeProject(p));
    expect(reopened).toEqual(p);
    expect(find(reopened, 'asset_definition').specifications.mass).toEqual({status: 'unknown', unit: 'kg'});
    expect(find(reopened, 'asset_instance').id).toBe('inst_0001');
  });
  it('does not infer power or signal edges from mechanical attachments', () => {
    const p = project();
    expect(p.records.filter(r => r.kind === 'mechanical_attachment')).toHaveLength(1);
    expect(p.records.filter(r => r.kind === 'connection')).toHaveLength(0);
  });
  it('keeps catalog, stock and placed identities distinct', () => {
    const p = project();
    const instance = p.records.find(r => r.kind === 'asset_instance' && r.inventoryItemId !== null)!;
    expect(new Set([instance.id, find(p, 'inventory_item').id, find(p, 'asset_definition').id]).size).toBe(3);
    find(p, 'asset_instance').definitionId = find(p, 'inventory_item').id;
    expect(() => validateProject(p)).toThrow('asset_definition reference');
  });
  it('creates namespaced identities without a session counter', () => {
    expect(createRecordId('asset_instance', () => 'test-uuid')).toBe('asset_instance:test-uuid');
    expect(createRecordId('asset_instance')).not.toBe(createRecordId('asset_instance'));
    expect(() => createRecordId('asset_instance', () => '')).toThrow('empty');
    expect(parseProject(serializeProject(createProject('new-project'))).records).toEqual([]);
  });
  it.each([0, 2, -1, '1', null])('rejects unsupported schema %s without assuming a migration', version => {
    expect(() => parseProject(JSON.stringify({...fixture, schemaVersion: version}))).toThrow('migration required');
  });
  it('rejects malformed JSON and unknown fields without silently discarding data', () => {
    expect(() => parseProject('{')).toThrow('invalid JSON');
    expect(() => parseProject(JSON.stringify({...fixture, extra: true}))).toThrow('unsupported field');
  });
  it('rejects duplicate IDs and dangling graph references', () => {
    const p = project();
    p.records.push(structuredClone(p.records[0]!));
    expect(() => validateProject(p)).toThrow('duplicate record ID');
    p.records.pop();
    find(p, 'port').instanceId = 'absent';
    expect(() => validateProject(p)).toThrow('asset_instance reference');
  });
  it('rejects conflicting allocations and wrong stock definitions', () => {
    const p = project();
    const panel = p.records.find(r => r.kind === 'asset_instance' && r.inventoryItemId !== null)!;
    p.records.push({...panel, id: 'second-panel'});
    expect(() => validateProject(p)).toThrow('already allocated');
    p.records.pop();
    find(p, 'inventory_item').definitionId = 'def:truss';
    expect(() => validateProject(p)).toThrow('definition mismatch');
  });
  it('validates typed logical edges independently of physical attachments', () => {
    const p = project();
    p.records.push({kind:'connection', id:'video:1', label:'Test link', locked:false,
      domain:'video', sourcePortId:'port:send', targetPortId:'port:receive'});
    expect(() => validateProject(p)).not.toThrow();
    find(p, 'connection').domain = 'power';
    expect(() => validateProject(p)).toThrow('domain mismatch');
    find(p, 'connection').domain = 'video';
    find(p, 'port').direction = 'input';
    expect(() => validateProject(p)).toThrow('direction mismatch');
  });
  it('rejects a known protocol mismatch even with equal connectors', () => {
    const p = project();
    const ports = p.records.filter(r => r.kind === 'port');
    ports[0]!.connector = ports[1]!.connector = 'RJ45';
    ports[0]!.protocol = 'one-protocol'; ports[1]!.protocol = 'another-protocol';
    p.records.push({kind:'connection', id:'video:1', label:'Test link', locked:false,
      domain:'video', sourcePortId:'port:send', targetPortId:'port:receive'});
    expect(() => validateProject(p)).toThrow('protocol mismatch');
  });
  it('rejects mechanical cycles and multiple parents', () => {
    const p = project(), a = find(p, 'mechanical_attachment');
    p.records.push({...a, id:'cycle', parentInstanceId:a.childInstanceId, childInstanceId:a.parentInstanceId,
      parentSocketId:'other', childSocketId:'other'});
    expect(() => validateProject(p)).toThrow('cycle');
    p.records.pop(); p.records.push({...a, id:'duplicate-parent'});
    expect(() => validateProject(p)).toThrow('already attached');
  });
  it('rejects invalid physical values, rotations and fractional stock', () => {
    const p = project();
    find(p, 'asset_instance').transform.position[0] = NaN;
    expect(() => serializeProject(p)).toThrow('finite');
    find(p, 'asset_instance').transform.position[0] = 0;
    find(p, 'asset_instance').transform.rotation = [0,0,0,0];
    expect(() => validateProject(p)).toThrow('unit quaternion');
    find(p, 'asset_instance').transform.rotation = [0,0,0,1];
    find(p, 'stock_pool').quantity = 0.5;
    expect(() => validateProject(p)).toThrow('safe integer');
  });
  it('rejects future document revisions but retains historical references', () => {
    const p = project(), d = find(p, 'document_snapshot');
    d.includedRecordIds = ['previously-deleted-instance'];
    expect(() => validateProject(p)).not.toThrow();
    d.projectRevision = 1;
    expect(() => validateProject(p)).toThrow('future revision');
  });
});
