import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: node scripts/compare-r0-native.mjs <native-report.json>');
const corpus = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/r0/project-conformance.v1.json'), 'utf8'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (report.format !== 'spatial-previs-native-conformance' || report.version !== 1
  || report.coordinatesPassed !== true || report.failures !== 0
  || typeof report.engineVersion !== 'string' || !report.engineVersion.trim()
  || !Array.isArray(report.cases) || report.cases.length !== corpus.cases.length)
  throw new Error('Incomplete, failed, or unsupported native report');
const byId = new Map();
for (const result of report.cases) {
  if (byId.has(result.id)) throw new Error(`Duplicate result: ${result.id}`);
  byId.set(result.id, result);
}
for (const expected of corpus.cases) {
  const actual = byId.get(expected.id);
  if (!actual || actual.accepted !== expected.valid || actual.passed !== true)
    throw new Error(`Native acceptance mismatch: ${expected.id}`);
  // Object key order is insignificant; arrays, types, every original value and
  // explicit null/unknown fields must survive native import, export and reopen.
  if (expected.valid && (typeof actual.projectJson !== 'string'
      || !isDeepStrictEqual(JSON.parse(actual.projectJson), expected.project)))
    throw new Error(`Native semantic round-trip mismatch: ${expected.id}`);
}
if (!Array.isArray(report.syntaxCases) || report.syntaxCases.length !== corpus.syntaxCases.length)
  throw new Error('Missing native syntax-rejection evidence');
const syntax = new Map(report.syntaxCases.map(result => [result.id, result]));
if (syntax.size !== corpus.syntaxCases.length) throw new Error('Duplicate native syntax result');
for (const expected of corpus.syntaxCases) {
  const actual = syntax.get(expected.id);
  if (!actual || actual.accepted !== false || actual.passed !== true)
    throw new Error(`Native syntax rejection mismatch: ${expected.id}`);
}
console.log(`PASS ${corpus.cases.length} native CORE-01 cases and engine coordinate tests (${report.engineVersion})`);
console.log(`PASS ${corpus.syntaxCases.length} syntax rejections with active-state preservation`);
console.log('Workspace commands, persistence, rendering and release acceptance remain separate gates.');
