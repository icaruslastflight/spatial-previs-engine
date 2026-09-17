/**
 * Comparator unit tests using deliberately synthetic reports. These execute no
 * Unreal code and produce no native conformance evidence. Temporary reports are
 * removed after every assertion and must never be used as desktop gate results.
 * Run: node --test scripts/test-r0-native-comparator.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'tests/fixtures/r0/project-conformance.v1.json'), 'utf8'));
const comparator = join(root, 'scripts/compare-r0-native.mjs');

function syntheticReport() {
  return {
    format: 'spatial-previs-native-conformance',
    version: 1,
    engineVersion: '5.8.0-SYNTHETIC-COMPARATOR-TEST-NOT-NATIVE-EVIDENCE',
    coordinatesPassed: true,
    failures: 0,
    cases: corpus.cases.map(item => ({
      id: item.id, accepted: item.valid, passed: true, error: '',
      ...(item.valid ? { projectJson: JSON.stringify(item.project) } : {}),
    })),
    syntaxCases: corpus.syntaxCases.map(item => ({ id: item.id, accepted: false, passed: true })),
  };
}

function run(report) {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-synthetic-comparator-test-'));
  try {
    const filename = join(directory, 'SYNTHETIC-TEST-NOT-NATIVE-EVIDENCE.json');
    writeFileSync(filename, JSON.stringify(report));
    const result = spawnSync(process.execPath, [comparator, filename], { encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function editProject(report, id, edit) {
  const result = report.cases.find(item => item.id === id);
  assert.ok(result, `fixture case exists: ${id}`);
  const project = JSON.parse(result.projectJson);
  edit(project);
  result.projectJson = JSON.stringify(project);
}

function rejects(name, mutation, expectedMessage) {
  test(`synthetic comparator: rejects ${name}`, () => {
    const report = syntheticReport();
    mutation(report);
    const result = run(report);
    assert.notEqual(result.status, 0, 'corrupted evidence must not pass');
    if (expectedMessage) assert.match(result.stderr, expectedMessage);
  });
}

test('synthetic comparator: accepts matching data without creating native evidence', () => {
  const result = run(syntheticReport());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /separate gates/);
});

test('synthetic comparator: ignores object key order while retaining values', () => {
  const report = syntheticReport();
  function reorder(value) {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
    return value;
  }
  report.cases.find(item => item.id === 'valid.original').projectJson = JSON.stringify(
    reorder(corpus.cases.find(item => item.id === 'valid.original').project));
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
});

rejects('lost null metadata', report => editProject(report, 'valid.original', project => {
  delete project.records.find(item => item.kind === 'port').protocol;
}), /semantic round-trip mismatch/);

rejects('lost unknown quantity unit', report => editProject(report, 'valid.original', project => {
  delete project.records.find(item => item.kind === 'asset_definition').specifications.mass.unit;
}), /semantic round-trip mismatch/);

rejects('one-ULP numeric precision loss', report => editProject(report, 'valid.high-precision-finite-numbers', project => {
  project.records.find(item => item.kind === 'asset_definition').specifications.nextAfterOne.value = 1;
}), /semantic round-trip mismatch/);

rejects('subnormal underflow', report => editProject(report, 'valid.high-precision-finite-numbers', project => {
  project.records.find(item => item.kind === 'asset_definition').specifications.smallestPositive.value = 0;
}), /semantic round-trip mismatch/);

rejects('numeric values changed to strings', report => editProject(report, 'valid.original', project => {
  project.revision = String(project.revision);
}), /semantic round-trip mismatch/);

rejects('record array reordering', report => editProject(report, 'valid.original', project => {
  project.records.reverse();
}), /semantic round-trip mismatch/);

rejects('assembly membership reordering', report => editProject(report, 'valid.locks-and-ordered-membership', project => {
  project.records.find(item => item.kind === 'assembly').instanceIds.reverse();
}), /semantic round-trip mismatch/);

rejects('record identity casing changes', report => editProject(report, 'valid.original', project => {
  project.records.find(item => item.kind === 'asset_instance').id = 'INST_0001';
}), /semantic round-trip mismatch/);

rejects('dropped project cases', report => { report.cases.pop(); }, /Incomplete/);
rejects('duplicate project cases', report => { report.cases[1] = structuredClone(report.cases[0]); }, /Duplicate result/);
rejects('substituted unknown project case IDs', report => { report.cases[0].id = 'invented.case'; }, /acceptance mismatch/);
rejects('wrong project acceptance', report => { report.cases[0].accepted = false; }, /acceptance mismatch/);
rejects('failed project cases', report => { report.cases[0].passed = false; }, /acceptance mismatch/);
rejects('missing exported JSON', report => { delete report.cases[0].projectJson; }, /semantic round-trip mismatch/);
rejects('malformed exported JSON', report => { report.cases[0].projectJson = '{'; });

rejects('dropped syntax cases', report => { report.syntaxCases.pop(); }, /syntax-rejection evidence/);
rejects('duplicate syntax cases', report => { report.syntaxCases[1] = structuredClone(report.syntaxCases[0]); }, /Duplicate native syntax/);
rejects('substituted unknown syntax case IDs', report => { report.syntaxCases[0].id = 'invented.syntax'; }, /syntax rejection mismatch/);
rejects('accepted invalid syntax', report => { report.syntaxCases[0].accepted = true; }, /syntax rejection mismatch/);
rejects('failed syntax state preservation', report => { report.syntaxCases[0].passed = false; }, /syntax rejection mismatch/);

for (const value of [false, 'false', 1, null, undefined]) {
  rejects(`non-true coordinate evidence (${String(value)})`, report => { report.coordinatesPassed = value; }, /Incomplete/);
}
rejects('nonzero aggregate failures', report => { report.failures = 1; }, /Incomplete/);
rejects('string aggregate failure count', report => { report.failures = '0'; }, /Incomplete/);
for (const value of ['', '   ', 58, {}, null]) {
  rejects(`invalid engine identity (${JSON.stringify(value)})`, report => { report.engineVersion = value; }, /Incomplete/);
}
