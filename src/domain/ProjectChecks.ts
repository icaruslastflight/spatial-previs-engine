import type { ProductionProject, ProductionRecord } from './ProductionProject.ts';
import type { CheckResult } from './WorkspaceState.ts';

type CheckProposal = Omit<CheckResult, 'inputHash' | 'inputRevision'>;
/** These are data-quality checks, never physical capacity or compatibility certification. */
export function technicalDataCheck(project: ProductionProject, record: ProductionRecord, id: string): CheckProposal {
  const definitions = record.kind === 'asset_instance'
    ? project.records.filter(r => r.id === record.definitionId)
    : [record];
  const unknowns: string[] = [];
  for (const target of definitions) {
    if (target.kind === 'asset_definition') {
      if (!Object.keys(target.specifications).length) unknowns.push('technical specifications');
      for (const [name, q] of Object.entries(target.specifications)) {
        if (q.status === 'unknown' || q.provenance === 'placeholder') unknowns.push(name);
      }
    }
    if (target.kind === 'port') {
      if (target.connector === null) unknowns.push('connector');
      if (target.protocol === null) unknowns.push('protocol');
    }
    if (target.kind === 'surface') {
      if (target.width.status === 'unknown' || target.width.provenance === 'placeholder') unknowns.push('width');
      if (target.height.status === 'unknown' || target.height.provenance === 'placeholder') unknowns.push('height');
    }
  }
  const applicable = ['asset_instance', 'asset_definition', 'port', 'surface'].includes(record.kind);
  return { id, scope: [record.id], model: 'technical-data-presence', modelVersion: '1',
    status: !applicable ? 'not_evaluated' : unknowns.length ? 'needs_data' : 'pass',
    summary: !applicable ? 'No technical-data check is defined for this record type'
      : unknowns.length ? `Needs data: ${unknowns.join(', ')}` : 'Recorded fields are populated; engineering performance is not evaluated',
    assumptions: ['Checks recorded data presence only; source authenticity and physical suitability are not verified'],
    uncertainty: ['No electrical, structural, acoustic, optical or laser safety calculation is performed'],
    evidence: applicable ? ['Current project records'] : [] };
}
