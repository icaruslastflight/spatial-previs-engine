#!/usr/bin/env node
/**
 * Language-neutral CORE-01 inputs shared by TypeScript and native UE runners.
 * Expected outcomes are authored here, independently of either validator.
 * Run: node scripts/generate-r0-conformance.mjs [--check]
 * JSON cannot encode NaN/Infinity; runner-local tests must cover those values.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const fixtureUrl = new URL('../tests/fixtures/r0/production-project.v1.json', import.meta.url);
const outputUrl = new URL('../tests/fixtures/r0/project-conformance.v1.json', import.meta.url);
const original = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const cases = [];
const ids = new Set();
const get = (project, id) => {
  const record = project.records.find(record => record.id === id);
  if (!record) throw new Error(`Missing generator record: ${id}`);
  return record;
};
const known = (value, unit = 'm', provenance = 'measured') => ({
  status: 'known', unit, value, provenance, source: 'Synthetic conformance measurement',
});
const connect = project => {
  const record = { id: 'connection:video', kind: 'connection', label: 'Independent video link',
    locked: false, domain: 'video', sourcePortId: 'port:send', targetPortId: 'port:receive' };
  project.records.push(record);
  return record;
};
const anotherInstance = project => {
  const instance = { ...structuredClone(get(project, 'inst_0001')), id: 'instance:third' };
  project.records.push(instance);
  return instance;
};
function add(id, valid, mutate = () => {}, source = original) {
  if (ids.has(id)) throw new Error(`Duplicate conformance ID: ${id}`);
  ids.add(id);
  const project = structuredClone(source);
  mutate(project);
  // Native runners must consume these bytes directly: serializing a parsed
  // corpus object first can round doubles before the implementation is tested.
  cases.push({ id, valid, project, json: JSON.stringify(project) });
}

add('valid.original', true);
add('valid.empty-project', true, project => { project.records = []; });
add('valid.all-record-kinds', true, project => { connect(project); });
add('valid.known-values-and-provenance', true, project => {
  const specs = get(project, 'def:truss').specifications;
  for (const provenance of ['placeholder', 'user', 'manufacturer', 'measured', 'checked']) {
    specs[provenance] = known(12.75, 'kg', provenance);
  }
  // General specifications deliberately have no implicit positivity/unit rule.
  specs.offset = known(-3.25, 'custom-unit');
  specs.zero = known(0, 'W');
  get(project, 'surface:screen').height = known(1.25);
});
add('valid.unknown-quantities-and-null-metadata', true, project => {
  get(project, 'stock:panel1').serialNumber = null;
  get(project, 'inst_0002').inventoryItemId = null;
  get(project, 'surface:screen').width = { status: 'unknown', unit: 'm' };
  get(project, 'def:panel').specifications.custom = { status: 'unknown', unit: 'arbitrary/unit' };
  connect(project);
});
add('valid.unicode-and-untrimmed-content', true, project => {
  project.projectId = '  Scène 日本語 / เวที 🎛  ';
  get(project, 'def:panel').label = '  Panneau «écran»\n舞台 🎚  ';
  get(project, 'def:panel').category = '映像';
  get(project, 'surface:screen').width.source = '  測定 / ป้าย / \"quoted\" \\ source  ';
  const panel = get(project, 'inst_0002');
  const priorId = panel.id;
  panel.id = '  instance:舞台🎚  ';
  get(project, 'assembly:wall').instanceIds = [panel.id];
  get(project, 'port:receive').instanceId = panel.id;
  get(project, 'attach:1').childInstanceId = panel.id;
  get(project, 'doc:draft').includedRecordIds = [priorId, panel.id];
});
add('valid.case-sensitive-ids-and-specification-keys', true, project => {
  const definition = { ...structuredClone(get(project, 'def:truss')), id: 'def:Truss' };
  definition.specifications = { mass: known(1, 'kg'), Mass: known(2, 'kg'), MASS: known(3, 'kg') };
  const instance = { ...structuredClone(get(project, 'inst_0001')), id: 'INST_0001', definitionId: definition.id };
  project.records.push(definition, instance);
  get(project, 'assembly:wall').instanceIds = ['inst_0001', instance.id];
});
add('valid.high-precision-finite-numbers', true, project => {
  get(project, 'inst_0001').transform.position = [0.12345678901234566, 123456789.01234567, -1.2345678901234566e-7];
  const specs = get(project, 'def:truss').specifications;
  specs.nextAfterOne = known(1.0000000000000002, 'ratio');
  specs.smallestPositive = known(Number.MIN_VALUE, 'custom-unit');
  specs.largestFinite = known(Number.MAX_VALUE, 'custom-unit');
  get(project, 'surface:screen').width = known(1.2345678901234567);
});
add('valid.arbitrary-transforms', true, project => {
  const norm = Math.sqrt(30);
  for (const record of project.records) if ('transform' in record) {
    record.transform = { position: [1.25, -2.5, 3.75], rotation: [1, 2, 3, 4].map(x => x / norm) };
  }
});
add('valid.negative-quaternion-hemisphere', true, project => {
  get(project, 'inst_0001').transform.rotation = [0, -Math.SQRT1_2, 0, -Math.SQRT1_2];
});
add('valid.quaternion-inside-norm-tolerance', true, project => {
  get(project, 'inst_0001').transform.rotation = [0, 0, 0, 1 + 0.5e-6];
});
add('valid.maximum-safe-integers', true, project => {
  project.revision = Number.MAX_SAFE_INTEGER;
  get(project, 'pool:panels').quantity = Number.MAX_SAFE_INTEGER;
  get(project, 'doc:draft').projectRevision = Number.MAX_SAFE_INTEGER;
});
add('valid.locks-and-ordered-membership', true, project => {
  project.records.forEach(record => { record.locked = true; });
  get(project, 'assembly:wall').instanceIds = ['inst_0002', 'inst_0001'];
  project.records.reverse();
});
add('valid.empty-membership-and-specifications', true, project => {
  get(project, 'assembly:wall').instanceIds = [];
  get(project, 'doc:draft').includedRecordIds = [];
  get(project, 'def:truss').specifications = {};
});
add('valid.historical-issued-snapshot', true, project => {
  project.revision = 7;
  Object.assign(get(project, 'doc:draft'), {
    projectRevision: 3, status: 'issued', includedRecordIds: ['historically-deleted-record'],
  });
});
add('valid.all-service-statuses-and-zone-roles', true, project => {
  for (const serviceStatus of ['available', 'unavailable', 'unknown']) {
    project.records.push({ ...get(project, 'stock:panel1'), id: `inventory:${serviceStatus}`, serviceStatus });
  }
  for (const role of ['audience', 'keep_out', 'listening', 'target', 'termination', 'routing']) {
    project.records.push({ ...structuredClone(get(project, 'zone:audience')), id: `zone:${role}:extra`, role });
  }
  // The codec preserves service data; it does not introduce reservation policy.
  get(project, 'stock:panel1').serviceStatus = 'unavailable';
});
for (const domain of ['power', 'video', 'audio', 'data']) add(`valid.connection-${domain}`, true, project => {
  get(project, 'port:send').domain = get(project, 'port:receive').domain = domain;
  connect(project).domain = domain;
});
add('valid.bidirectional-port-connection', true, project => {
  get(project, 'port:send').direction = get(project, 'port:receive').direction = 'bidirectional';
  connect(project);
});
add('valid.known-protocol-different-connectors', true, project => {
  get(project, 'port:send').connector = 'RJ45';
  get(project, 'port:receive').connector = 'optical';
  get(project, 'port:send').protocol = get(project, 'port:receive').protocol = 'fixture-protocol';
  connect(project);
});
add('valid.one-unknown-protocol', true, project => {
  get(project, 'port:send').protocol = 'fixture-protocol';
  connect(project);
});
add('valid.mechanical-chain', true, project => {
  anotherInstance(project);
  project.records.push({ ...get(project, 'attach:1'), id: 'attachment:chain', parentInstanceId: 'inst_0002',
    childInstanceId: 'instance:third', parentSocketId: 'chain-out', childSocketId: 'mount' });
});
add('valid.socket-tuple-identity', true, project => {
  // Concatenating endpoint components would alias these two distinct tuples.
  const a = { ...structuredClone(get(project, 'inst_0001')), id: 'socket:a:b' };
  const b = { ...structuredClone(get(project, 'inst_0001')), id: 'socket:a' };
  project.records.push(a, b, { ...get(project, 'attach:1'), id: 'attachment:tuple',
    parentInstanceId: a.id, childInstanceId: b.id, parentSocketId: 'c', childSocketId: 'b:c' });
});

for (const [name, value] of [['null', null], ['array', []], ['string', 'project'], ['number', 1], ['boolean', true]]) {
  add(`invalid.root-${name}`, false, () => {}, value);
}
for (const field of Object.keys(original)) add(`invalid.root-missing-${field}`, false, project => { delete project[field]; });
add('invalid.root-extra-field', false, project => { project.extra = true; });
for (const value of [0, 2, -1, '1', null, true]) add(`invalid.schema-${String(value)}`, false, project => { project.schemaVersion = value; });
for (const [name, value] of [['negative', -1], ['fractional', 0.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '0'], ['null', null], ['boolean', false]]) {
  add(`invalid.revision-${name}`, false, project => { project.revision = value; });
  add(`invalid.stock-quantity-${name}`, false, project => { get(project, 'pool:panels').quantity = value; });
  add(`invalid.snapshot-revision-${name}`, false, project => { get(project, 'doc:draft').projectRevision = value; });
}
for (const [name, value] of [['empty', ''], ['whitespace', ' \t\n'], ['number', 7], ['null', null]]) {
  add(`invalid.project-id-${name}`, false, project => { project.projectId = value; });
}
for (const [name, value] of [['nbsp', '\u00a0'], ['bom', '\ufeff']]) {
  add(`invalid.project-id-${name}`, false, project => { project.projectId = value; });
  add(`invalid.label-${name}`, false, project => { get(project, 'def:truss').label = value; });
  add(`invalid.quantity-unit-${name}`, false, project => { get(project, 'def:truss').specifications.mass.unit = value; });
  add(`invalid.quantity-source-${name}`, false, project => { get(project, 'surface:screen').width.source = value; });
  add(`invalid.specification-key-${name}`, false, project => { get(project, 'def:truss').specifications[value] = known(1); });
}
add('invalid.coordinate-frame', false, project => { project.coordinateFrame = 'left_handed_z_up_centimeters'; });
add('invalid.records-object', false, project => { project.records = {}; });
add('invalid.records-null', false, project => { project.records = null; });
add('invalid.record-null', false, project => { project.records[0] = null; });
add('invalid.record-array', false, project => { project.records[0] = []; });
add('invalid.record-kind', false, project => { project.records[0].kind = 'unrecognized'; });
add('invalid.record-id-empty', false, project => { project.records[0].id = ''; });
add('invalid.record-label-whitespace', false, project => { project.records[0].label = '\t\n'; });
add('invalid.record-lock-string', false, project => { project.records[0].locked = 'false'; });
add('invalid.record-lock-number', false, project => { project.records[0].locked = 0; });

const allKinds = structuredClone(original);
connect(allKinds);
const representative = new Map(allKinds.records.map(record => [record.kind, record]));
for (const [kind, record] of representative) {
  for (const field of Object.keys(record)) add(`invalid.${kind}-missing-${field}`, false,
    project => { delete get(project, record.id)[field]; }, allKinds);
  add(`invalid.${kind}-extra-field`, false, project => { get(project, record.id).unsupported = true; }, allKinds);
}

const fieldCases = [
  ['catalog-number', 'def:truss', 'catalogId', 4],
  ['category-empty', 'def:truss', 'category', ''],
  ['definition-id-null', 'inst_0001', 'definitionId', null],
  ['serial-number-number', 'stock:panel1', 'serialNumber', 1],
  ['serial-number-empty', 'stock:panel1', 'serialNumber', ''],
  ['inventory-item-id-number', 'inst_0002', 'inventoryItemId', 1],
  ['connector-boolean', 'port:send', 'connector', false],
  ['protocol-empty', 'port:send', 'protocol', ''],
  ['service-status', 'stock:panel1', 'serviceStatus', 'ready'],
  ['port-domain', 'port:send', 'domain', 'mechanical'],
  ['port-direction', 'port:send', 'direction', 'out'],
  ['surface-shape', 'surface:screen', 'shape', 'box'],
  ['zone-shape', 'zone:audience', 'shape', 'plane'],
  ['zone-role', 'zone:audience', 'role', 'stage'],
  ['snapshot-status', 'doc:draft', 'status', 'approved'],
  ['snapshot-template-empty', 'doc:draft', 'templateId', ''],
  ['snapshot-template-version-number', 'doc:draft', 'templateVersion', 1],
  ['socket-id-empty', 'attach:1', 'parentSocketId', ''],
];
for (const [name, id, field, value] of fieldCases) add(`invalid.${name}`, false, project => { get(project, id)[field] = value; });
for (const [name, value] of [['object', {}], ['null', null], ['short', [1, 2]], ['long', [1, 2, 3, 4]], ['string-element', [1, '2', 3]], ['null-element', [1, null, 3]], ['zero', [1, 0, 1]], ['negative', [-1, 2, 3]]]) {
  add(`invalid.zone-size-${name}`, false, project => { get(project, 'zone:audience').sizeMeters = value; });
}
for (const [name, value] of [['null', null], ['array', []], ['extra-field', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }], ['missing-position', { rotation: [0, 0, 0, 1] }], ['missing-rotation', { position: [0, 0, 0] }]]) {
  add(`invalid.transform-${name}`, false, project => { get(project, 'inst_0001').transform = value; });
}
for (const [name, value] of [['null', null], ['short', [0, 0]], ['long', [0, 0, 0, 0]], ['string', ['0', 0, 0]], ['boolean', [false, 0, 0]], ['null-component', [null, 0, 0]]]) {
  add(`invalid.position-${name}`, false, project => { get(project, 'inst_0001').transform.position = value; });
}
for (const [name, value] of [['null', null], ['short', [0, 0, 1]], ['zero', [0, 0, 0, 0]], ['nonunit', [1, 1, 1, 1]], ['outside-tolerance', [0, 0, 0, 1 + 2e-6]], ['string', [0, 0, 0, '1']], ['boolean', [0, 0, 0, true]]]) {
  add(`invalid.rotation-${name}`, false, project => { get(project, 'inst_0001').transform.rotation = value; });
}
for (const [name, value] of [['null', null], ['array', []], ['status', { status: 'estimated', unit: 'kg' }], ['unknown-extra-value', { status: 'unknown', unit: 'kg', value: 0 }], ['unknown-missing-unit', { status: 'unknown' }], ['empty-unit', { status: 'unknown', unit: '' }], ['unit-number', { status: 'unknown', unit: 1 }], ['value-null', known(null)], ['value-string', known('1')], ['value-boolean', known(true)], ['provenance', known(1, 'kg', 'verified')], ['source-empty', { ...known(1), source: '' }], ['source-null', { ...known(1), source: null }], ['known-extra-field', { ...known(1), extra: true }]]) {
  add(`invalid.quantity-${name}`, false, project => { get(project, 'def:truss').specifications.mass = value; });
}
for (const field of ['status', 'unit', 'value', 'provenance', 'source']) add(`invalid.known-quantity-missing-${field}`, false, project => {
  const quantity = known(1); delete quantity[field]; get(project, 'def:truss').specifications.mass = quantity;
});
add('invalid.specifications-null', false, project => { get(project, 'def:truss').specifications = null; });
add('invalid.specifications-array', false, project => { get(project, 'def:truss').specifications = []; });
add('invalid.specifications-empty-key', false, project => { get(project, 'def:truss').specifications[' '] = known(1); });
for (const field of ['width', 'height']) {
  for (const [name, value] of [['zero', known(0)], ['negative', known(-1)], ['wrong-unit', known(1, 'cm')], ['unknown-wrong-unit', { status: 'unknown', unit: 'cm' }]]) {
    add(`invalid.surface-${field}-${name}`, false, project => { get(project, 'surface:screen')[field] = value; });
  }
}
for (const [id, field] of [['assembly:wall', 'instanceIds'], ['doc:draft', 'includedRecordIds']]) {
  for (const [name, value] of [['null', null], ['object', {}], ['duplicate', ['inst_0002', 'inst_0002']], ['empty-string', ['']], ['number', [1]]]) {
    add(`invalid.${field}-${name}`, false, project => { get(project, id)[field] = value; });
  }
}

add('invalid.duplicate-record-id', false, project => { project.records.push(structuredClone(project.records[0])); });
add('invalid.definition-dangling', false, project => { get(project, 'inst_0001').definitionId = 'absent'; });
add('invalid.definition-wrong-kind', false, project => { get(project, 'inst_0001').definitionId = 'stock:panel1'; });
add('invalid.inventory-dangling', false, project => { get(project, 'inst_0002').inventoryItemId = 'absent'; });
add('invalid.inventory-wrong-kind', false, project => { get(project, 'inst_0002').inventoryItemId = 'def:panel'; });
add('invalid.inventory-definition-mismatch', false, project => { get(project, 'stock:panel1').definitionId = 'def:truss'; });
add('invalid.inventory-double-allocation', false, project => {
  project.records.push({ ...structuredClone(get(project, 'inst_0002')), id: 'instance:duplicate-allocation' });
});
add('invalid.assembly-dangling', false, project => { get(project, 'assembly:wall').instanceIds = ['absent']; });
add('invalid.assembly-wrong-kind', false, project => { get(project, 'assembly:wall').instanceIds = ['def:truss']; });
add('invalid.port-owner-dangling', false, project => { get(project, 'port:send').instanceId = 'absent'; });
add('invalid.port-owner-wrong-kind', false, project => { get(project, 'port:send').instanceId = 'def:truss'; });
for (const endpoint of ['sourcePortId', 'targetPortId']) {
  add(`invalid.connection-${endpoint}-dangling`, false, project => { connect(project)[endpoint] = 'absent'; });
  add(`invalid.connection-${endpoint}-wrong-kind`, false, project => { connect(project)[endpoint] = 'inst_0001'; });
}
add('invalid.connection-self', false, project => { connect(project).targetPortId = 'port:send'; });
add('invalid.connection-domain-enum', false, project => { connect(project).domain = 'mechanical'; });
add('invalid.connection-domain-mismatch', false, project => { connect(project).domain = 'power'; });
add('invalid.connection-target-domain-mismatch', false, project => { get(project, 'port:receive').domain = 'power'; connect(project); });
add('invalid.connection-source-direction', false, project => { get(project, 'port:send').direction = 'input'; connect(project); });
add('invalid.connection-target-direction', false, project => { get(project, 'port:receive').direction = 'output'; connect(project); });
add('invalid.connection-known-protocol-mismatch', false, project => {
  get(project, 'port:send').protocol = 'protocol-one'; get(project, 'port:receive').protocol = 'protocol-two'; connect(project);
});
for (const endpoint of ['parentInstanceId', 'childInstanceId']) {
  add(`invalid.attachment-${endpoint}-dangling`, false, project => { get(project, 'attach:1')[endpoint] = 'absent'; });
  add(`invalid.attachment-${endpoint}-wrong-kind`, false, project => { get(project, 'attach:1')[endpoint] = 'def:truss'; });
}
add('invalid.attachment-multiple-parents', false, project => {
  anotherInstance(project);
  project.records.push({ ...get(project, 'attach:1'), id: 'attachment:second-parent',
    parentInstanceId: 'instance:third', parentSocketId: 'other-parent', childSocketId: 'other-child' });
});
add('invalid.attachment-parent-socket-occupied', false, project => {
  anotherInstance(project);
  project.records.push({ ...get(project, 'attach:1'), id: 'attachment:occupied', childInstanceId: 'instance:third' });
});
add('invalid.attachment-child-socket-occupied', false, project => {
  anotherInstance(project);
  project.records.push({ ...get(project, 'attach:1'), id: 'attachment:occupied',
    parentInstanceId: 'inst_0002', parentSocketId: 'mount', childInstanceId: 'instance:third' });
});
add('invalid.attachment-self-cycle', false, project => { get(project, 'attach:1').childInstanceId = 'inst_0001'; });
add('invalid.attachment-two-node-cycle', false, project => {
  project.records.push({ ...get(project, 'attach:1'), id: 'attachment:cycle', parentInstanceId: 'inst_0002',
    childInstanceId: 'inst_0001', parentSocketId: 'other-parent', childSocketId: 'other-child' });
});
add('invalid.snapshot-future-revision', false, project => { get(project, 'doc:draft').projectRevision = 1; });

const originalJson = JSON.stringify(original);
const invalidRevisionToken = token => originalJson.replace('"revision":0', `"revision":${token}`);
// Grammar failures are raw text, never parsed/re-encoded while building the corpus.
const syntaxCases = [
  ['empty', ''],
  ['whitespace-only', ' \t\r\n '],
  ['object-trailing-comma', `${originalJson.slice(0, -1)},}`],
  ['array-trailing-comma', `${originalJson.slice(0, -2)},]}`],
  ['nan-literal', invalidRevisionToken('NaN')],
  ['infinity-literal', invalidRevisionToken('Infinity')],
  ['negative-infinity-literal', invalidRevisionToken('-Infinity')],
  ['undefined-literal', invalidRevisionToken('undefined')],
  ['capitalized-boolean', originalJson.replace('"locked":false', '"locked":False')],
  ['leading-plus', invalidRevisionToken('+1')],
  ['leading-zero', invalidRevisionToken('01')],
  ['hexadecimal-number', invalidRevisionToken('0x10')],
  ['missing-integer-part', invalidRevisionToken('.5')],
  ['missing-fractional-part', invalidRevisionToken('1.')],
  ['missing-exponent-digits', invalidRevisionToken('1e+')],
  ['bad-string-escape', originalJson.replace('r0-conformance-fixture', String.raw`bad\qescape`)],
  ['bad-unicode-escape', originalJson.replace('r0-conformance-fixture', String.raw`bad\u12G4escape`)],
  ['unescaped-control-character', originalJson.replace('r0-conformance-fixture', 'bad\nlabel')],
  ['single-quoted-key', originalJson.replace('"schemaVersion"', "'schemaVersion'")],
  ['unquoted-key', originalJson.replace('"schemaVersion"', 'schemaVersion')],
  ['line-comment', `// comment\n${originalJson}`],
  ['block-comment', `/* comment */${originalJson}`],
  ['trailing-content', `${originalJson} garbage`],
  ['second-document', `${originalJson}${originalJson}`],
  ['unterminated-object', originalJson.slice(0, -1)],
  ['leading-byte-order-mark', `\ufeff${originalJson}`],
].map(([name, json]) => ({ id: `syntax.${name}`, valid: false, json }));
for (const value of syntaxCases) {
  if (ids.has(value.id)) throw new Error(`Duplicate conformance ID: ${value.id}`);
  ids.add(value.id);
}

// One complete case per line keeps generated diffs attributable to case IDs.
const header = '{\n  "format": "spatial-previs-project-conformance",\n  "version": 1,\n  "cases": [\n';
const contents = `${header}${cases.map(value => `    ${JSON.stringify(value)}`).join(',\n')}\n  ],\n  "syntaxCases": [\n${syntaxCases.map(value => `    ${JSON.stringify(value)}`).join(',\n')}\n  ]\n}\n`;
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/generate-r0-conformance.mjs [--check]');
}
if (args[0] === '--check') {
  if (readFileSync(outputUrl, 'utf8') !== contents) {
    throw new Error('R0 conformance corpus is stale; run node scripts/generate-r0-conformance.mjs');
  }
} else {
  writeFileSync(outputUrl, contents, 'utf8');
}
console.log(`R0 conformance corpus: ${cases.length} semantic cases (${cases.filter(value => value.valid).length} valid), ${syntaxCases.length} invalid syntax cases, ${args[0] === '--check' ? 'reproducible' : 'generated'}.`);
