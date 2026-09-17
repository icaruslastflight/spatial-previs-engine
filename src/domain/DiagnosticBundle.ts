import { canonical, parseWorkspace, validateWorkspace } from './WorkspaceState.ts';
import type { WorkspaceState } from './WorkspaceState.ts';

// Only protocol vocabulary and dimensional units are retained verbatim. All
// free-form strings (including labels, URLs, sources and identities) are aliased.
const vocabulary = new Set([
  'spatial-previs-workspace', 'right_handed_y_up_meters', 'known', 'unknown',
  'placeholder', 'user', 'manufacturer', 'measured', 'checked', 'available', 'unavailable',
  'prepped', 'outbound', 'show', 'returning', 'maintenance', 'missing',
  'asset_definition', 'inventory_item', 'stock_pool', 'asset_instance', 'assembly',
  'surface', 'zone', 'port', 'connection', 'mechanical_attachment', 'document_snapshot',
  'container', 'personnel', 'vendor',
  'plane', 'box', 'audience', 'keep_out', 'listening', 'target', 'termination', 'routing',
  'power', 'video', 'audio', 'data', 'input', 'output', 'bidirectional', 'draft', 'issued',
  'pass', 'fail', 'needs_data', 'not_evaluated', 'stale', 'current', 'application/json',
  'm', 'cm', 'mm', 'kg', 'g', 'W', 'kW', 'V', 'A', 'Hz', 'deg', 'rad', 'lm', 'cd',
  'owned', 'subrented', 'roadcase', 'meatrack', 'trunk', 'bag', 'in-house', 'overhire',
  'rental', 'supplier', 'freelance_agency'
]);

/** Local export only; never uploads anything. Geometry and numbers remain diagnostic inputs. */
export function createDiagnosticBundle(state: WorkspaceState, publicCatalogIds: readonly string[] = []) {
  validateWorkspace(state);
  const aliases = new Map<string, string>();
  const alias = (value: string) => {
    if (!aliases.has(value)) aliases.set(value, `redacted:${aliases.size + 1}`);
    return aliases.get(value)!;
  };
  const scrub = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (key === 'content') return JSON.stringify(scrub(JSON.parse(value)));
      if (key === 'inputHash') return '0'.repeat(64); // Redaction changes inputs; never retain a current badge.
      if (key === 'reviewedAt' || key === 'issuedAt') return '2000-01-01T00:00:00.000Z';
      if (key === 'catalogId' && publicCatalogIds.includes(value)) return value;
      // Values in identifiers, labels, evidence, sources and protocols always stay opaque.
      if (['kind', 'format', 'coordinateFrame', 'status', 'provenance', 'serviceStatus', 'shape', 'role', 'domain', 'direction', 'unit', 'mediaType', 'ownership', 'containerType', 'personnelType', 'vendorType'].includes(key)
        && vocabulary.has(value)) return value;
      return alias(value);
    }
    if (Array.isArray(value)) return value.map(v => scrub(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      key === 'specifications' ? alias(k) : k, scrub(v, k),
    ]));
    return value;
  };
  const workspace = scrub(state) as WorkspaceState;
  workspace.checks.forEach(c => { c.status = 'stale'; });
  workspace.reviews.forEach(r => { r.status = 'stale'; });
  validateWorkspace(workspace);
  return {
    format: 'spatial-previs-diagnostic' as const, version: 1 as const,
    runtime: { application: 'spatial-previs-engine', implementation: 'r0-web-preview.2', workspaceVersion: 1, projectSchemaVersion: state.project.schemaVersion },
    redaction: 'Free text and identities aliased; numbers, transforms, graph kinds and approved catalog IDs retained. Checks require rerun. Issued content is a redacted copy, not the issued original.',
    workspace,
    replay: { kind: 'validated_snapshot_history', entries: workspace.undo.length, redoEntries: workspace.redo.length,
      limitation: 'Snapshot history reproduces graph states, not pointer gestures or original network timing.' },
    platformEvidence: { web: 'diagnostic_snapshot_only', ue5: 'not_run', actualPhone: 'not_run' },
  };
}

/** Verify every retained transition, then return the exact redacted current graph. */
export function replayDiagnosticBundle(json: string): WorkspaceState {
  const bundle = JSON.parse(json) as ReturnType<typeof createDiagnosticBundle>;
  if (bundle.format !== 'spatial-previs-diagnostic' || bundle.version !== 1) throw new Error('Unsupported diagnostic bundle');
  const state = parseWorkspace(JSON.stringify(bundle.workspace));
  let records = state.undo[0]?.before ?? state.project.records;
  for (const entry of state.undo) {
    if (canonical(records) !== canonical(entry.before)) throw new Error('Disconnected diagnostic history');
    records = entry.after;
  }
  if (canonical(records) !== canonical(state.project.records)) throw new Error('Diagnostic replay did not reproduce the project');
  return state;
}
