import { PROJECT_SCHEMA_VERSION } from './ProductionProject.ts';
import type { ProductionProject, ProductionRecord } from './ProductionProject.ts';
import { PHASER_EASINGS } from '../engine/Phaser.ts';

type ObjectValue = Record<string, unknown>;
export class ProjectValidationError extends Error {
  override name = 'ProjectValidationError';
}
function fail(path: string, message: string): never {
  throw new ProjectValidationError(`${path}: ${message}`);
}
function object(value: unknown, path: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as ObjectValue;
}
function keys(value: ObjectValue, fields: string[], path: string): void {
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing field');
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected nonempty string');
}
function oneOf(value: unknown, options: readonly unknown[], path: string): void {
  if (!options.includes(value)) fail(path, `expected one of ${options.join(', ')}`);
}
function natural(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'expected nonnegative safe integer');
}
function tuple(value: unknown, length: number, path: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== length || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    fail(path, `expected ${length} finite numbers`);
  }
}
function strings(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) fail(path, 'expected array');
  value.forEach((x, i) => text(x, `${path}[${i}]`));
  if (new Set(value).size !== value.length) fail(path, 'duplicate reference');
}
function transform(value: unknown, path: string): void {
  const v = object(value, path);
  keys(v, ['position', 'rotation'], path);
  tuple(v.position, 3, `${path}.position`);
  tuple(v.rotation, 4, `${path}.rotation`);
  if (Math.abs(Math.hypot(...v.rotation) - 1) > 1e-6) fail(`${path}.rotation`, 'expected unit quaternion');
}
function quantity(value: unknown, path: string): void {
  const v = object(value, path);
  oneOf(v.status, ['known', 'unknown'], `${path}.status`);
  keys(v, v.status === 'known' ? ['status', 'unit', 'value', 'provenance', 'source'] : ['status', 'unit'], path);
  text(v.unit, `${path}.unit`);
  if (v.status === 'known') {
    if (typeof v.value !== 'number' || !Number.isFinite(v.value)) fail(`${path}.value`, 'expected finite number');
    oneOf(v.provenance, ['placeholder', 'user', 'manufacturer', 'measured', 'checked'], `${path}.provenance`);
    text(v.source, `${path}.source`);
  }
}
function fraction(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(path, 'expected a number between 0 and 1');
  }
}
/** A phaser's steps and clock -- shared shape between an attribute phaser and a colour phaser. */
function phaserClock(v: ObjectValue, path: string): void {
  if (typeof v.speedBpm !== 'number' || !Number.isFinite(v.speedBpm) || v.speedBpm <= 0) {
    fail(`${path}.speedBpm`, 'expected positive BPM');
  }
  oneOf(v.easing, PHASER_EASINGS, `${path}.easing`);
}
function attributePhaser(value: unknown, path: string): void {
  const v = object(value, path);
  keys(v, ['steps', 'speedBpm', 'easing'], path);
  if (!Array.isArray(v.steps) || v.steps.length === 0) fail(`${path}.steps`, 'expected at least one step');
  v.steps.forEach((step, i) => {
    const s = object(step, `${path}.steps[${i}]`);
    keys(s, ['value', 'transition'], `${path}.steps[${i}]`);
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) fail(`${path}.steps[${i}].value`, 'expected finite number');
    fraction(s.transition, `${path}.steps[${i}].transition`);
  });
  phaserClock(v, path);
}
function colorPhaser(value: unknown, path: string): void {
  const v = object(value, path);
  keys(v, ['steps', 'speedBpm', 'easing'], path);
  if (!Array.isArray(v.steps) || v.steps.length === 0) fail(`${path}.steps`, 'expected at least one step');
  v.steps.forEach((step, i) => {
    const s = object(step, `${path}.steps[${i}]`);
    keys(s, ['value', 'transition'], `${path}.steps[${i}]`);
    tuple(s.value, 3, `${path}.steps[${i}].value`);
    if ((s.value as number[]).some(c => c < 0 || c > 1)) fail(`${path}.steps[${i}].value`, 'expected RGB channels between 0 and 1');
    fraction(s.transition, `${path}.steps[${i}].transition`);
  });
  phaserClock(v, path);
}

const fields: Record<ProductionRecord['kind'], string[]> = {
  asset_definition: ['catalogId', 'category', 'specifications'],
  inventory_item: ['definitionId', 'serialNumber', 'serviceStatus', 'ownership', 'vendorId', 'containerId'],
  container: ['containerType', 'weightKg', 'dimensionsMm'],
  personnel: ['personnelType', 'name', 'roles', 'skills', 'email', 'phone', 'dayRate'],
  vendor: ['vendorType', 'name', 'contactName', 'email', 'phone'],
  stock_pool: ['definitionId', 'quantity'],
  asset_instance: ['definitionId', 'inventoryItemId', 'transform'],
  assembly: ['instanceIds'],
  surface: ['shape', 'transform', 'width', 'height'],
  zone: ['role', 'shape', 'transform', 'sizeMeters'],
  port: ['instanceId', 'domain', 'direction', 'connector', 'protocol'],
  connection: ['domain', 'sourcePortId', 'targetPortId'],
  mechanical_attachment: ['parentInstanceId', 'childInstanceId', 'parentSocketId', 'childSocketId'],
  document_snapshot: ['projectRevision', 'templateId', 'templateVersion', 'status', 'includedRecordIds'],
  raster_mapping: ['surfaceId', 'width', 'height'],
  cue: ['instanceIds', 'mirroredInstanceIds', 'aimTargetMeters', 'pan', 'tilt', 'dimmer', 'color'],
};
const domains = ['power', 'video', 'audio', 'data'];

function record(value: unknown, path: string): void {
  const v = object(value, path);
  text(v.kind, `${path}.kind`);
  if (!Object.hasOwn(fields, v.kind)) fail(`${path}.kind`, 'unsupported record kind');
  const kind = v.kind as ProductionRecord['kind'];
  keys(v, ['id', 'kind', 'label', 'locked', ...fields[kind]], path);
  text(v.id, `${path}.id`);
  text(v.label, `${path}.label`);
  if (typeof v.locked !== 'boolean') fail(`${path}.locked`, 'expected boolean');
  for (const field of fields[kind]) {
    const p = `${path}.${field}`, val = v[field];
    if (['transform'].includes(field)) transform(val, p);
    else if (field === 'instanceIds') {
      strings(val, p);
      if (kind === 'cue' && (val as string[]).length === 0) fail(p, 'expected at least one fixture');
    }
    else if (['mirroredInstanceIds', 'includedRecordIds'].includes(field)) strings(val, p);
    else if (['quantity', 'projectRevision'].includes(field)) natural(val, p);
    else if (['width', 'height'].includes(field)) {
      if (kind === 'raster_mapping') {
        natural(val, p);
        if (val === 0) fail(p, 'expected positive dimension');
      } else {
        quantity(val, p);
        const q = object(val, p);
        if (q.unit !== 'm' || (q.status === 'known' && (q.value as number) <= 0)) fail(p, 'expected positive metres or unknown metres');
      }
    } else if (field === 'sizeMeters') {
      tuple(val, 3, p);
      if (val.some(x => x <= 0)) fail(p, 'expected positive dimensions');
    } else if (field === 'specifications') {
      const specs = object(val, p);
      for (const [name, q] of Object.entries(specs)) { text(name, p); quantity(q, `${p}.${name}`); }
    } else if (field === 'domain') oneOf(val, domains, p);
    else if (field === 'direction') oneOf(val, ['input', 'output', 'bidirectional'], p);
    else if (field === 'serviceStatus') oneOf(val, ['available', 'prepped', 'outbound', 'show', 'returning', 'maintenance', 'missing', 'unavailable', 'unknown'], p);
    else if (field === 'ownership') oneOf(val, ['owned', 'subrented'], p);
    else if (field === 'containerType') oneOf(val, ['roadcase', 'meatrack', 'trunk', 'bag'], p);
    else if (field === 'personnelType') oneOf(val, ['in-house', 'overhire'], p);
    else if (field === 'vendorType') oneOf(val, ['rental', 'supplier', 'freelance_agency'], p);
    else if (field === 'status') oneOf(val, ['draft', 'issued'], p);
    else if (field === 'shape') oneOf(val, [kind === 'surface' ? 'plane' : 'box'], p);
    else if (field === 'role') oneOf(val, ['audience', 'keep_out', 'listening', 'target', 'termination', 'routing'], p);
    else if (['roles', 'skills'].includes(field)) strings(val, p);
    else if (field === 'dimensionsMm') { if (val !== null) { tuple(val, 3, p); if (val.some(x => x <= 0)) fail(p, 'expected positive dimension'); } }
    else if (field === 'aimTargetMeters') { if (val !== null) tuple(val, 3, p); }
    else if (['pan', 'tilt', 'dimmer'].includes(field)) { if (val !== null) attributePhaser(val, p); }
    else if (field === 'color') { if (val !== null) colorPhaser(val, p); }
    else if (field === 'weightKg' || field === 'dayRate') { if (val !== null) { if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) fail(p, 'expected positive number'); } }
    else if (['inventoryItemId', 'serialNumber', 'connector', 'protocol', 'vendorId', 'containerId', 'email', 'phone', 'contactName'].includes(field) && val === null) { /* Explicit unknown/unallocated. */ }
    else text(val, p);
  }
}

/** Validate the whole graph before returning any state to a caller. */
export function validateProject(value: unknown): asserts value is ProductionProject {
  const p = object(value, 'project');
  if (p.schemaVersion !== PROJECT_SCHEMA_VERSION) fail('project.schemaVersion', 'unsupported version; migration required');
  keys(p, ['schemaVersion', 'projectId', 'revision', 'coordinateFrame', 'records'], 'project');
  text(p.projectId, 'project.projectId');
  natural(p.revision, 'project.revision');
  oneOf(p.coordinateFrame, ['right_handed_y_up_meters'], 'project.coordinateFrame');
  if (!Array.isArray(p.records)) fail('project.records', 'expected array');
  p.records.forEach((v, i) => record(v, `project.records[${i}]`));
  const records = p.records as ProductionRecord[];
  const byId = new Map<string, ProductionRecord>();
  for (const r of records) {
    if (byId.has(r.id)) fail(r.id, 'duplicate record ID');
    byId.set(r.id, r);
  }
  function reference<K extends ProductionRecord['kind']>(id: string, kind: K, path: string): Extract<ProductionRecord, {kind: K}> {
    const target = byId.get(id);
    if (target?.kind !== kind) fail(path, `expected ${kind} reference: ${id}`);
    return target as Extract<ProductionRecord, {kind: K}>;
  }
  const allocatedItems = new Set<string>();
  const parentOf = new Map<string, string>();
  const sockets = new Set<string>();
  for (const r of records) {
    if ('definitionId' in r) reference(r.definitionId, 'asset_definition', r.id);
    if (r.kind === 'inventory_item') {
      if (r.vendorId !== null) reference(r.vendorId, 'vendor', r.id);
      if (r.containerId !== null) reference(r.containerId, 'container', r.id);
    }
    if (r.kind === 'asset_instance' && r.inventoryItemId !== null) {
      const item = reference(r.inventoryItemId, 'inventory_item', r.id);
      if (item.definitionId !== r.definitionId) fail(r.id, 'inventory definition mismatch');
      if (allocatedItems.has(item.id)) fail(r.id, 'inventory item already allocated');
      allocatedItems.add(item.id);
    }
    if (r.kind === 'assembly') for (const id of r.instanceIds) reference(id, 'asset_instance', r.id);
    if (r.kind === 'port') reference(r.instanceId, 'asset_instance', r.id);
    if (r.kind === 'connection') {
      const from = reference(r.sourcePortId, 'port', r.id);
      const to = reference(r.targetPortId, 'port', r.id);
      if (from.id === to.id) fail(r.id, 'cannot connect a port to itself');
      if (from.domain !== r.domain || to.domain !== r.domain) fail(r.id, 'connection domain mismatch');
      if (from.direction === 'input' || to.direction === 'output') fail(r.id, 'connection direction mismatch');
      // Unknown metadata stays unknown. Matching domains alone is not compatibility approval.
      if (from.protocol !== null && to.protocol !== null && from.protocol !== to.protocol) fail(r.id, 'protocol mismatch');
    }
    if (r.kind === 'mechanical_attachment') {
      reference(r.parentInstanceId, 'asset_instance', r.id);
      reference(r.childInstanceId, 'asset_instance', r.id);
      if (parentOf.has(r.childInstanceId)) fail(r.id, 'child already attached');
      parentOf.set(r.childInstanceId, r.parentInstanceId);
      for (const endpoint of [[r.parentInstanceId, r.parentSocketId], [r.childInstanceId, r.childSocketId]]) {
        const key = JSON.stringify(endpoint);
        if (sockets.has(key)) fail(r.id, 'socket already occupied');
        sockets.add(key);
      }
    }
    if (r.kind === 'document_snapshot') {
      if (r.projectRevision > (p.revision as number)) fail(r.id, 'snapshot references a future revision');
      // Snapshot IDs describe the historical revision, so deleted records need not still exist.
    }
    if (r.kind === 'raster_mapping') {
      reference(r.surfaceId, 'surface', r.id);
    }
    if (r.kind === 'cue') {
      for (const id of r.instanceIds) reference(id, 'asset_instance', r.id);
      for (const id of r.mirroredInstanceIds) {
        if (!r.instanceIds.includes(id)) fail(r.id, 'mirrored fixture must be one of the cue\'s own instances');
      }
    }
  }
  for (const child of parentOf.keys()) {
    const seen = new Set<string>();
    let id: string | undefined = child;
    while (id !== undefined) {
      if (seen.has(id)) fail(child, 'mechanical attachment cycle');
      seen.add(id);
      id = parentOf.get(id);
    }
  }
}

/** Pure codec only: no storage, migration, scene restore or issuance side effects. */
export function serializeProject(project: ProductionProject): string {
  validateProject(project);
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): ProductionProject {
  let value: unknown;
  try { value = JSON.parse(json); } catch { fail('project', 'invalid JSON'); }
  validateProject(value);
  return value;
}
