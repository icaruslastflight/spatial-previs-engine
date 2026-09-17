import type { ProductionProject, Transform } from './ProductionProject.ts';
import type { Operation } from './ProjectStore.ts';

/** Translation carries all mechanically attached descendants using stored world metre coordinates. */
export function translateInstanceOperations(project: ProductionProject, id: string, position: Transform['position']): Operation[] {
  const root = project.records.find(r => r.id === id);
  if (root?.kind !== 'asset_instance') throw new Error('Select an equipment instance');
  if (position.some(x => !Number.isFinite(x))) throw new Error('Position requires finite metres');
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of project.records) if (record.kind === 'mechanical_attachment'
      && ids.has(record.parentInstanceId) && !ids.has(record.childInstanceId)) {
      ids.add(record.childInstanceId); grew = true;
    }
  }
  const delta = position.map((x, i) => x - root.transform.position[i]!);
  const operations: Operation[] = project.records.filter(r => r.kind === 'asset_instance' && ids.has(r.id)).map(record => {
    if (record.kind !== 'asset_instance') throw new Error('Invalid mechanical descendant');
    return { type: 'put', record: { ...record, transform: { ...record.transform,
      position: record.transform.position.map((x, i) => x + delta[i]!) as Transform['position'] } } };
  });
  if (delta.some(x => x !== 0)) {
    const upstream = project.records.find(r => r.kind === 'mechanical_attachment' && r.childInstanceId === id);
    if (upstream) operations.push({ type: 'remove', id: upstream.id });
  }
  return operations;
}
