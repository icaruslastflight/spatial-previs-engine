import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProject, ProjectValidationError, serializeProject, validateProject } from './ProjectCodec.ts';

interface ConformanceCase { id: string; valid: boolean; project: unknown; json: string }
interface SyntaxCase { id: string; valid: false; json: string }
interface ConformanceCorpus { format: string; version: number; cases: ConformanceCase[]; syntaxCases: SyntaxCase[] }
const corpus = JSON.parse(readFileSync(new URL('../../tests/fixtures/r0/project-conformance.v1.json', import.meta.url), 'utf8')) as ConformanceCorpus;

describe('language-neutral native project conformance corpus', () => {
  it('has an explicit version and unique case identities', () => {
    expect(corpus.format).toBe('spatial-previs-project-conformance');
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThan(100);
    const allCases = [...corpus.cases, ...corpus.syntaxCases];
    expect(new Set(allCases.map(value => value.id)).size).toBe(allCases.length);
    for (const value of allCases) {
      expect(value.id.trim()).not.toBe('');
      expect(typeof value.valid).toBe('boolean');
    }
  });

  it('includes every record kind in an accepted project', () => {
    const project = corpus.cases.find(value => value.id === 'valid.all-record-kinds')?.project;
    validateProject(project);
    expect([...new Set(project.records.map(record => record.kind))].sort()).toEqual([
      'assembly', 'asset_definition', 'asset_instance', 'connection', 'document_snapshot',
      'inventory_item', 'mechanical_attachment', 'port', 'stock_pool', 'surface', 'zone',
    ]);
  });

  it.each(corpus.cases)('$id', ({ project, valid, json }) => {
    const before = JSON.stringify(project);
    expect(json).toBe(before);
    expect(JSON.parse(json)).toStrictEqual(project);
    if (valid) {
      validateProject(project);
      expect(parseProject(json)).toStrictEqual(project);
      expect(parseProject(serializeProject(project))).toStrictEqual(project);
    } else {
      expect(() => validateProject(project)).toThrow(ProjectValidationError);
      expect(() => parseProject(json)).toThrow(ProjectValidationError);
    }
    // Validation and rejection must not normalize, truncate or partially restore input.
    expect(JSON.stringify(project)).toBe(before);
  });

  it.each(corpus.syntaxCases)('$id', ({ valid, json }) => {
    expect(valid).toBe(false);
    expect(() => JSON.parse(json)).toThrow(SyntaxError);
    expect(() => parseProject(json)).toThrow('invalid JSON');
  });

  it('is reproducible from the original shared fixture', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/generate-r0-conformance.mjs', import.meta.url)), '--check'], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('reproducible');
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite in-memory numbers omitted from JSON (%s)', value => {
    const project = parseProject(JSON.stringify(corpus.cases.find(testCase => testCase.id === 'valid.original')!.project));
    const instance = project.records.find(record => record.kind === 'asset_instance');
    if (instance?.kind !== 'asset_instance') throw new Error('Shared fixture is missing equipment');
    instance.transform.position[0] = value;
    expect(() => serializeProject(project)).toThrow('finite');
  });
});
