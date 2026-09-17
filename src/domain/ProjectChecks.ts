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

export function weightRiggingCheck(project: ProductionProject, record: ProductionRecord, id: string): CheckProposal {
  if (record.kind !== 'asset_instance') {
    return { id, scope: [record.id], model: 'weight-rigging-evaluation', modelVersion: '1',
      status: 'not_evaluated', summary: 'Weight rigging evaluation requires an asset instance',
      assumptions: [], uncertainty: [], evidence: [] };
  }

  const attached = new Set<string>([record.id]);
  let added = true;
  while (added) {
    added = false;
    for (const r of project.records) {
      if (r.kind === 'mechanical_attachment' && attached.has(r.parentInstanceId) && !attached.has(r.childInstanceId)) {
        attached.add(r.childInstanceId);
        added = true;
      }
    }
  }

  let totalMass = 0;
  let missingData = false;
  const evidence: string[] = [];
  const scope = Array.from(attached);

  for (const instanceId of attached) {
    const instance = project.records.find(r => r.id === instanceId);
    if (instance?.kind === 'asset_instance') {
      const def = project.records.find(r => r.id === instance.definitionId);
      if (def?.kind === 'asset_definition') {
        const mass = def.specifications['mass'];
        if (mass && mass.status === 'known' && mass.unit === 'kg') {
          totalMass += mass.value;
          evidence.push(`${def.label} mass: ${mass.value} kg`);
        } else if (!mass || mass.status !== 'known') {
          missingData = true;
        }
      }
    }
  }

  return {
    id, scope, model: 'weight-rigging-evaluation', modelVersion: '1',
    status: missingData ? 'needs_data' : 'pass',
    summary: missingData ? 'Cannot calculate total weight; missing mass data on some attached equipment.' : `Total attached weight: ${totalMass.toFixed(2)} kg`,
    assumptions: ['Static load only', 'Center of mass calculations not yet evaluated'],
    uncertainty: ['Dynamic rigging forces not included', 'Safety factors not applied', 'ALPHA BUILD NOTATION: Calculations cannot be guaranteed. The program is not liable for miscalculations or damage.'],
    evidence
  };
}

export function electricalPowerLoadCheck(project: ProductionProject, record: ProductionRecord, id: string): CheckProposal {
  if (record.kind !== 'asset_instance') {
    return { id, scope: [record.id], model: 'electrical-power-load', modelVersion: '1',
      status: 'not_evaluated', summary: 'Electrical power load check requires an asset instance',
      assumptions: [], uncertainty: [], evidence: [] };
  }

  const powered = new Set<string>([record.id]);
  let added = true;
  while (added) {
    added = false;
    for (const r of project.records) {
      if (r.kind === 'connection' && r.domain === 'power') {
        const sourcePort = project.records.find(p => p.id === r.sourcePortId);
        const targetPort = project.records.find(p => p.id === r.targetPortId);
        if (sourcePort?.kind === 'port' && targetPort?.kind === 'port') {
          if (powered.has(sourcePort.instanceId) && !powered.has(targetPort.instanceId)) {
            powered.add(targetPort.instanceId);
            added = true;
          }
          if (powered.has(targetPort.instanceId) && !powered.has(sourcePort.instanceId)) {
            powered.add(sourcePort.instanceId);
            added = true;
          }
        }
      }
    }
  }

  let totalPower = 0;
  let missingData = false;
  const evidence: string[] = [];
  const scope = Array.from(powered);

  for (const instanceId of powered) {
    const instance = project.records.find(r => r.id === instanceId);
    if (instance?.kind === 'asset_instance') {
      const def = project.records.find(r => r.id === instance.definitionId);
      if (def?.kind === 'asset_definition') {
        const power = def.specifications['power'];
        if (power && power.status === 'known' && power.unit === 'W') {
          totalPower += power.value;
          evidence.push(`${def.label} power: ${power.value} W`);
        } else if (!power || power.status !== 'known') {
          missingData = true;
        }
      }
    }
  }

  return {
    id, scope, model: 'electrical-power-load', modelVersion: '1',
    status: missingData ? 'needs_data' : 'pass',
    summary: missingData ? 'Cannot calculate total power; missing power data on some connected equipment.' : `Total electrical load: ${totalPower.toFixed(2)} W`,
    assumptions: ['Peak power draw assumed', 'Power factor and phase balancing not evaluated'],
    uncertainty: ['Voltage drop and cable resistance not calculated', 'ALPHA BUILD NOTATION: Calculations cannot be guaranteed. The program is not liable for miscalculations or damage.'],
    evidence
  };
}
