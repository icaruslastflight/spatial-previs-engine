import { createProject, createRecordId } from '../domain/ProductionProject.ts';
import type { AssetDefinition, Port, ProductionRecord, AssetInstance, Surface, RasterMapping } from '../domain/ProductionProject.ts';
import { deleteInstanceOperations, ProjectStore } from '../domain/ProjectStore.ts';
import type { Operation, Principal, Preview } from '../domain/ProjectStore.ts';
import { IndexedDbStorage, WorkspaceRepository } from '../domain/WorkspaceRepository.ts';
import { serializeWorkspace } from '../domain/WorkspaceState.ts';
import { translateInstanceOperations } from '../domain/ProjectTransforms.ts';
import { technicalDataCheck } from '../domain/ProjectChecks.ts';
import { readSceneTool } from '../assistant/SceneTools.ts';
import { createDiagnosticBundle } from '../domain/DiagnosticBundle.ts';
import { ProductionViewport } from './ProductionViewport.ts';
import type { CatalogAsset } from './ProductionViewport.ts';
import './workspace.css';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const root = document.querySelector<HTMLDivElement>('#workspace')!;
root.innerHTML = `<header class="project-bar"><div class="wordmark"><span class="mark">SP</span><div><strong>Spatial Previs</strong><small>Production workspace</small></div></div>
  <div class="project-identity"><span id="project-name">Local production</span><span id="revision">Revision 0</span></div>
  <span class="mode">Design only</span></header>
  <nav class="workspace-nav" aria-label="Workspace">${['Build', 'Map', 'Connect', 'Check', 'Deliver'].map((name, i) => `<button data-workspace="${name}" aria-pressed="${i === 0}"><span>0${i + 1}</span>${name}</button>`).join('')}</nav>
  <div class="command-bar"><button id="save">Save project</button><button id="open">Open file</button><button id="export">Export project</button><span class="separator"></span><button id="undo" disabled>Undo</button><button id="redo" disabled>Redo</button><button id="equipment-toggle" aria-expanded="false">Equipment</button><button id="inspector-toggle" aria-expanded="false">Inspector</button><button id="continue-desktop" aria-haspopup="dialog">Continue on desktop</button></div>
  <main class="work-area"><aside class="equipment"><h2>Equipment</h2><label class="search-label">Search catalog<input id="search" type="search" placeholder="Truss, panel, speaker…"></label><label>Category<select id="category"><option value="">All categories</option></select></label><div id="catalog" class="catalog"></div><div class="section-heading"><h2>Scene</h2><span id="scene-count">0 objects</span></div><div id="scene-list" class="scene-list"></div></aside>
  <section class="center"><div class="view-heading"><div><h1 id="view-title">Build the production</h1><p id="view-subtitle">Local scene · metres · optional venue context</p></div><button id="frame">Frame all</button></div>
  <div class="viewport"><canvas id="scene-canvas" aria-label="Production 3D scene"></canvas><div id="empty-scene"><strong>A venue starts with your design</strong><span>Add equipment from the catalog. A map or point cloud can come later.</span></div><span class="view-note">Catalog geometry is a planning placeholder</span><span id="render-status" role="status"></span></div>
  <section id="workspace-panel" class="workspace-panel"></section></section>
  <aside class="inspector"><h2>Inspector</h2><div id="inspector-content"></div></aside></main>
  <section id="proposal" hidden aria-label="Proposed changes"></section>
  <footer><span id="notice" role="status">Opening local project…</span><span id="save-status">Unsaved</span><span class="gate">R0 preview · desktop conformance pending</span></footer>
  <input id="file-input" type="file" accept=".json,application/json" hidden>
  <dialog id="desktop-handoff" aria-labelledby="desktop-handoff-title" aria-describedby="desktop-handoff-summary">
    <div class="handoff-heading"><h2 id="desktop-handoff-title">Continue on desktop</h2><button id="close-desktop-handoff" aria-label="Close desktop handoff" autofocus>Close</button></div>
    <p id="desktop-handoff-summary">Keep working here, or connect to your desktop for the tools and scene detail available there.</p>
    <ol class="handoff-steps"><li><h3>Keep a complete backup</h3><p>Export the current project, checks, edit history and stored issued snapshots. Your edits stay here.</p><button id="handoff-export">Export project backup</button></li>
    <li><h3>Connect to your computer</h3><p>Open Moonlight on your phone and connect to your paired PC, or use your desktop access link below.</p></li>
    <li><h3>Bring your project with you</h3><p>Files do not transfer automatically. Move the backup to your PC, then use <strong>Open file</strong> in the desktop browser workspace. Native UE5 import of this complete workspace is still in development; keep the original backup and its history.</p></li></ol>
    <form id="desktop-url-form" novalidate><label for="desktop-url">Your desktop access URL <span class="muted">(optional)</span></label><input id="desktop-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://your-desktop-portal.example/" aria-describedby="desktop-url-help desktop-url-status"><p id="desktop-url-help">Use an HTTPS address without a password, sign-in token, query string or fragment. Saved only in this browser; excluded from project exports.</p><div class="handoff-actions"><button type="submit">Save desktop URL</button><button id="open-desktop-url" type="button" disabled>Open desktop link</button><button id="clear-desktop-url" type="button" hidden>Forget link</button></div><p id="desktop-url-status" role="status"></p></form>
    <details class="handoff-provider"><summary>Already using AirGPU?</summary><p><a href="https://app.airgpu.com/" target="_blank" rel="noopener noreferrer">Open AirGPU dashboard</a> to manage your existing cloud PC. Your project is not sent to AirGPU.</p></details>
    <div class="desktop-capability"><span class="capability-badge">Desktop-only · planned</span><p>Full-fidelity rendering, dense scenes and advanced production tools belong on the desktop roadmap. Web and mobile support a subset; they do not limit desktop capability. These native features are still in development.</p></div>
  </dialog>`;

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id)! as T; }
const human: Principal = { id: 'local-operator', kind: 'human' };
// Local editing is available offline. Specialist review/issuance deliberately require a host
// authorization integration; neither a text field nor imported JSON grants those capabilities.
const authorizer = { can: (_principal: Principal, action: string) => action === 'edit' || action === 'unlock' };
const repository = new WorkspaceRepository(new IndexedDbStorage());
let store = new ProjectStore(createProject('local-production'), authorizer);
let generation: number | null = null, selected: string | null = null, workspace = 'Build';
let catalog: CatalogAsset[] = [], viewport: ProductionViewport | null = null;
let preview: Preview | null = null, dirty = false, serial = 0, busy = false;
let detach = () => {};
let opening = false;
let renderSequence = 0;

function notice(message: string, error = false): void { el('notice').textContent = message; el('notice').classList.toggle('error', error); }
function run(action: () => void | Promise<void>): void { void Promise.resolve().then(action).catch(e => notice(e instanceof Error ? e.message : String(e), true)); }
function markDirty(): void { dirty = true; serial++; el('save-status').textContent = 'Unsaved changes'; }
function select(id: string): void {
  if (!store.project.records.some(r => r.id === id)) { notice('That record was removed; its check remains in the history.'); return; }
  selected = id; viewport?.select(id); renderLists(); renderInspector(); renderPanel();
  if (matchMedia('(max-width: 760px)').matches) {
    root.classList.remove('show-equipment'); el('equipment-toggle').setAttribute('aria-expanded', 'false');
    root.classList.add('show-inspector'); el('inspector-toggle').setAttribute('aria-expanded', 'true');
  }
}
function connectStore(): void {
  detach(); detach = store.subscribe(() => {
    markDirty();
    if (!store.project.records.some(r => r.id === selected)) selected = null;
    render(); void reconcile();
  });
}
async function reconcile(): Promise<void> {
  if (!viewport) return;
  const sequence = ++renderSequence;
  el('render-status').textContent = 'Updating scene…';
  try {
    const updated = await viewport.sync(store.project);
    if (updated) el('render-status').textContent = '';
  } catch (e) {
    if (sequence === renderSequence) el('render-status').textContent = `Scene update failed: ${e instanceof Error ? e.message : String(e)}. Previous scene retained.`;
  }
}
function transact(label: string, operations: Operation[]): void {
  store.execute({ key: crypto.randomUUID(), label, baseRevision: store.project.revision, operations }, human);
  notice(label);
}
function propose(label: string, operations: Operation[]): void {
  if (preview) store.cancel(preview.id);
  preview = store.preview({ key: crypto.randomUUID(), label, baseRevision: store.project.revision, operations }, human);
  const box = el('proposal'); box.hidden = false;
  box.innerHTML = `<div><strong>${escape(label)}</strong><p>${preview.changedIds.length} records change together. Current scene and allocations are unchanged until you apply.</p></div><button id="apply-proposal">Apply changes</button><button id="cancel-proposal">Cancel</button>`;
  el('apply-proposal').onclick = () => run(() => { if (preview) store.accept(preview.id, human); closeProposal(); notice('Changes applied'); });
  el('cancel-proposal').onclick = () => { closeProposal(); notice('Proposal canceled; project unchanged'); };
  el('cancel-proposal').focus();
}
function closeProposal(): void { if (preview) store.cancel(preview.id); preview = null; el('proposal').hidden = true; }
function selectedRecord(): ProductionRecord | undefined { return store.project.records.find(r => r.id === selected); }
function renderLists(): void {
  const records = store.project.records;
  const visible = records.filter(r => ['asset_instance', 'surface', 'zone', 'assembly'].includes(r.kind));
  el('scene-count').textContent = `${visible.length} objects`;
  el('scene-list').innerHTML = visible.length ? visible.map(r => `<button class="scene-item ${r.id === selected ? 'selected' : ''}" data-id="${escape(r.id)}" aria-pressed="${r.id === selected}"><span>${escape(r.label)}</span><small>${r.locked ? 'Locked' : r.kind.replaceAll('_', ' ')}</small></button>`).join('')
    : '<p class="empty-copy">No equipment placed yet.</p>';
  el('scene-list').querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button => button.onclick = () => select(button.dataset['id']!));
  el('empty-scene').hidden = visible.some(r => r.kind === 'asset_instance');
}
function renderCatalog(): void {
  const query = el<HTMLInputElement>('search').value.toLowerCase(), category = el<HTMLSelectElement>('category').value;
  const matches = catalog.filter(a => (!category || a.category === category) && `${a.name} ${a.id}`.toLowerCase().includes(query));
  el('catalog').innerHTML = matches.map(a => `<button class="catalog-item" data-asset="${escape(a.id)}"><span>${escape(a.name)}</span><small>${escape(a.category)} <span aria-hidden="true">＋</span></small></button>`).join('') || '<p class="empty-copy">No matching equipment.</p>';
  el('catalog').querySelectorAll<HTMLButtonElement>('[data-asset]').forEach(button => button.onclick = () => run(() => addAsset(button.dataset['asset']!)));
}
function addAsset(id: string): void {
  const asset = catalog.find(a => a.id === id)!;
  let definition = store.project.records.find(r => r.kind === 'asset_definition' && r.catalogId === id) as AssetDefinition | undefined;
  const operations: Operation[] = [];
  if (!definition) {
    definition = { id: createRecordId('asset_definition'), kind: 'asset_definition', catalogId: id, category: asset.category,
      label: asset.name, locked: false, specifications: { mass: { status: 'unknown', unit: 'kg' }, power: { status: 'unknown', unit: 'W' } } };
    operations.push({ type: 'put', record: definition });
  }
  const count = store.project.records.filter(r => r.kind === 'asset_instance').length;
  const instanceId = createRecordId('asset_instance');
  operations.push({ type: 'put', record: { id: instanceId, kind: 'asset_instance', label: `${asset.name} ${count + 1}`, locked: false,
    definitionId: definition.id, inventoryItemId: null, transform: { position: [(count % 4) * 2, 0, Math.floor(count / 4) * 2], rotation: [0, 0, 0, 1] } } });
  transact('Equipment added', operations); select(instanceId);
}
function renderInspector(): void {
  const record = selectedRecord(), panel = el('inspector-content');
  if (!record) { panel.innerHTML = '<p class="empty-copy">Select equipment in the scene or list to inspect and edit it.</p>'; return; }
  const editable = record.kind === 'asset_instance';
  panel.innerHTML = `<p class="eyebrow">${escape(record.kind.replaceAll('_', ' '))}</p><h3>${escape(record.label)}</h3><p class="record-id">${escape(record.id)}</p>
    <button id="lock-record">${record.locked ? 'Unlock' : 'Lock'} selection</button>
    ${editable ? `<form id="position-form"><label>Name<input name="label" value="${escape(record.label)}" required ${record.locked ? 'disabled' : ''}></label><h4>World position</h4><div class="coordinates">${['X', 'Y', 'Z'].map((axis, i) => `<label>${axis} <span>m</span><input name="${axis}" type="number" step="0.01" value="${record.transform.position[i]}" required ${record.locked ? 'disabled' : ''}></label>`).join('')}</div><button type="submit" ${record.locked ? 'disabled' : ''}>Apply position</button></form><p class="muted">Attached children move with their parent. Origin positions are not collision bounds.</p><button id="preview-delete" class="danger" ${record.locked ? 'disabled' : ''}>Preview removal</button>` : '<p class="muted">This record is available for inspection. Its specialized editor is not part of this R0 preview.</p>'}
    ${editable ? `<button id="preview-snap" ${record.locked ? 'disabled' : ''}>Preview nearby socket snap</button><button id="unlink" ${record.locked || !store.project.records.some(r => r.kind === 'mechanical_attachment' && r.childInstanceId === record.id) ? 'disabled' : ''}>Preview unlink</button>` : ''}
    <div class="section-heading"><h4>Technical data</h4></div><p class="muted">Missing specifications remain unknown. Placing equipment does not reserve stock or certify a design.</p><button id="run-check">Check recorded data</button><button id="inspect-evidence">Inspect evidence</button><div id="selection-evidence"></div>`;
  el('lock-record').onclick = () => run(() => transact(record.locked ? 'Selection unlocked' : 'Selection locked', [{ type: 'lock', id: record.id, locked: !record.locked }]));
  el('run-check').onclick = () => run(async () => {
    const target = store;
    await target.recordCheck(technicalDataCheck(target.project, record, `check:${crypto.randomUUID()}`), target.project.revision);
    if (target !== store) return;
    markDirty(); setWorkspace('Check'); notice('Recorded data checked');
  });
  el('inspect-evidence').onclick = () => run(async () => {
    const target = store, inputRevision = target.project.revision;
    const evidence = await readSceneTool(target.state, { name: 'scene.inspect', recordId: record.id });
    if (target !== store || selected !== record.id || store.project.revision !== inputRevision) return;
    el('selection-evidence').innerHTML = `<h4>Evidence · revision ${evidence.revision}</h4><p class="muted">${evidence.records.length} records in scope. Source: current project. Geometry uses stored origins in metres.</p>` +
      evidence.quantities.map(q => `<p class="muted">${escape(q.field)}: ${q.status === 'unknown' ? `Unknown (${escape(q.unit)})` : `${q.value} ${escape(q.unit)} · ${escape(q.provenance)} · ${escape(q.source)}`}</p>`).join('') +
      `<p class="muted">${evidence.checks.length} recorded checks. Structural, electrical, optical, acoustic and laser-safety calculations: not evaluated.</p>`;
  });
  if (editable) {
    el('preview-snap').onclick = () => run(() => {
      if (!viewport) throw new Error('Socket preview requires loaded geometry');
      propose('Snap to nearby socket', viewport.snap(record.id).operations);
    });
    el('unlink').onclick = () => run(() => {
      const attachment = store.project.records.find(r => r.kind === 'mechanical_attachment' && r.childInstanceId === record.id);
      if (attachment) propose('Unlink selected equipment', [{ type: 'remove', id: attachment.id }]);
    });
    el<HTMLFormElement>('position-form').onsubmit = event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
      run(() => {
        const position = ['X', 'Y', 'Z'].map(axis => Number(data.get(axis))) as [number, number, number];
        const operations = translateInstanceOperations(store.project, record.id, position);
        const rootOperation = operations.find(op => op.type === 'put' && op.record.id === record.id);
        if (rootOperation?.type === 'put') rootOperation.record.label = String(data.get('label'));
        transact('Position updated', operations);
      });
    };
    el('preview-delete').onclick = () => run(() => propose('Remove selected equipment', deleteInstanceOperations(store.project, record.id)));
  }
}
function renderPanel(): void {
  const panel = el('workspace-panel'), state = store.state;
  if (workspace === 'Build') {
    panel.innerHTML = `<p>Drag equipment to move and snap. Drag empty space to orbit; two fingers pan or zoom. A second touch or Escape cancels a move. Use the inspector for exact coordinates and socket previews.</p>`;
  } else if (workspace === 'Map') {
    const instances = state.project.records.filter((r): r is AssetInstance => r.kind === 'asset_instance');
    const surfaces = state.project.records.filter((r): r is Surface => r.kind === 'surface');
    const mappings = state.project.records.filter((r): r is RasterMapping => r.kind === 'raster_mapping');
    
    panel.innerHTML = `<h2>Content Mapping</h2>
      <p>Plan view shares the selected equipment and its exact metre coordinates. Group LED panels to define a surface, then map a video raster to it.</p>
      
      <h3>1. Define Surface</h3>
      <form id="create-surface">
        <p class="muted">Select equipment to group into a display surface.</p>
        <div class="checkbox-list">
          ${instances.map(r => `<label style="display:block"><input type="checkbox" name="instances" value="${escape(r.id)}"> ${escape(r.label)}</label>`).join('')}
        </div>
        <button type="submit" ${!instances.length ? 'disabled' : ''}>Group into Surface</button>
      </form>
      
      <h3>2. Map Raster</h3>
      <form id="create-raster">
        <label>Surface
          <select name="surfaceId" required>
            ${surfaces.map(s => `<option value="${escape(s.id)}">${escape(s.label)}</option>`).join('')}
          </select>
        </label>
        <div class="coordinates">
          <label>Width <span>px</span><input name="width" type="number" min="1" step="1" value="1920" required></label>
          <label>Height <span>px</span><input name="height" type="number" min="1" step="1" value="1080" required></label>
        </div>
        <button type="submit" ${!surfaces.length ? 'disabled' : ''}>Map Video Raster</button>
      </form>
      
      <h3>Mapped Rasters</h3>
      ${mappings.length ? mappings.map(m => `<div class="data-row"><span>${escape(m.label)} · ${m.width}x${m.height}px</span><button data-remove="${escape(m.id)}">Remove</button></div>`).join('') : '<p class="empty-copy">No video rasters mapped yet.</p>'}
    `;

    panel.querySelector<HTMLFormElement>('#create-surface')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const selectedInstances = data.getAll('instances') as string[];
      if (selectedInstances.length === 0) return notice('Select at least one instance to group', true);
      
      run(() => {
        const surfaceId = createRecordId('surface');
        const assemblyId = createRecordId('assembly');
        const ops: Operation[] = [
          { type: 'put', record: { id: assemblyId, kind: 'assembly', label: 'LED Wall Assembly', locked: false, instanceIds: selectedInstances } },
          { type: 'put', record: { id: surfaceId, kind: 'surface', label: 'Display Surface', locked: false, shape: 'plane', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, width: { status: 'unknown', unit: 'm' }, height: { status: 'unknown', unit: 'm' } } }
        ];
        transact('Surface defined', ops);
      });
    });

    panel.querySelector<HTMLFormElement>('#create-raster')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      run(() => {
        const rasterId = createRecordId('raster_mapping');
        transact('Raster mapped', [{ type: 'put', record: { id: rasterId, kind: 'raster_mapping', label: 'Video Raster', locked: false, surfaceId: String(data.get('surfaceId')), width: Number(data.get('width')), height: Number(data.get('height')) } }]);
      });
    });

    panel.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.onclick = () => run(() => transact('Raster mapping removed', [{ type: 'remove', id: b.dataset['remove']! }])));
  } else if (workspace === 'Connect') {
    const ports = state.project.records.filter((r): r is Port => r.kind === 'port');
    panel.innerHTML = `<h2>Logical connections</h2><p>Mechanical attachments, signal and power remain separate. Connector compatibility is not inferred.</p>
      ${selectedRecord()?.kind === 'asset_instance' ? '<form id="add-port"><label>Port name<input name="name" required placeholder="Video input"></label><label>Domain<select name="domain"><option>video</option><option>audio</option><option>data</option><option>power</option></select></label><label>Direction<select name="direction"><option>input</option><option>output</option><option>bidirectional</option></select></label><button>Add port to selection</button></form>' : '<p>Select equipment to add a port.</p>'}
      <form id="connect-ports"><label>From<select name="source">${ports.filter(p => p.direction !== 'input').map(p => `<option value="${escape(p.id)}">${escape(p.label)} · ${p.domain}</option>`).join('')}</select></label><label>To<select name="target">${ports.filter(p => p.direction !== 'output').map(p => `<option value="${escape(p.id)}">${escape(p.label)} · ${p.domain}</option>`).join('')}</select></label><button ${ports.length < 2 ? 'disabled' : ''}>Preview connection</button></form>
      ${state.project.records.filter(r => r.kind === 'connection').map(r => `<div class="data-row"><span>${escape(r.label)} · ${r.domain}</span><button data-remove="${escape(r.id)}">Remove connection</button></div>`).join('')}`;
    panel.querySelector<HTMLFormElement>('#add-port')?.addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
      run(() => transact('Port added', [{ type: 'put', record: { id: createRecordId('port'), kind: 'port', label: String(data.get('name')),
        locked: false, instanceId: selected!, domain: data.get('domain') as Port['domain'], direction: data.get('direction') as Port['direction'], connector: null, protocol: null } }]));
    });
    el<HTMLFormElement>('connect-ports').onsubmit = event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
      run(() => {
        const from = ports.find(p => p.id === data.get('source')); if (!from) throw new Error('Choose a source port');
        propose('Add logical connection', [{ type: 'put', record: { id: createRecordId('connection'), kind: 'connection', label: `${from.label} connection`,
          locked: false, sourcePortId: from.id, targetPortId: String(data.get('target')), domain: from.domain } }]);
      });
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.onclick = () => run(() => transact('Connection removed', [{ type: 'remove', id: b.dataset['remove']! }])));
  } else if (workspace === 'Check') {
    panel.innerHTML = '<h2>Scoped checks</h2><p>Checks describe a named model and its inputs. Specialist approval is unavailable until a reviewer authority is configured.</p>' +
      (state.checks.length ? state.checks.map(c => `<button class="check-row" data-scope="${escape(c.scope[0])}"><strong class="check-status ${c.status}">${escape(c.status.replaceAll('_', ' '))}</strong><span>${escape(c.summary)}<small>${escape(c.model)} v${escape(c.modelVersion)} · input revision ${c.inputRevision}</small></span></button>`).join('') : '<p class="empty-copy">No checks yet. Select equipment and choose Check recorded data.</p>');
    panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach(b => b.onclick = () => select(b.dataset['scope']!));
  } else {
    const rows = state.project.records.filter(r => r.kind === 'asset_instance');
    panel.innerHTML = `<h2>Current draft · revision ${state.project.revision}</h2><p>Local design quantities, not warehouse availability. Export project includes the exact graph, checks, history and any previously issued snapshots.</p><table><thead><tr><th>Placed equipment</th><th>Inventory allocation</th></tr></thead><tbody>${rows.map(r => `<tr><td><button data-scope="${escape(r.id)}">${escape(r.label)}</button></td><td>${r.inventoryItemId ? escape(r.inventoryItemId) : 'Unallocated'}</td></tr>`).join('')}</tbody></table><p>${state.issued.length} immutable issued snapshots stored. Crew-pack generation is a later release.</p><div class="export-actions"><button id="export-evidence">Export scene evidence</button><button id="export-diagnostics">Export diagnostics</button></div><p>Diagnostics replace names, sources and identities with aliases; geometry and numeric values remain. Both exports download locally.</p>`;
    el('export-evidence').onclick = () => run(async () => {
      const evidence = await readSceneTool(store.state, { name: 'scene.summary' });
      downloadJson(JSON.stringify(evidence, null, 2), `spatial-evidence-r${evidence.revision}.json`);
    });
    el('export-diagnostics').onclick = () => run(() => {
      const bundle = createDiagnosticBundle(store.state, catalog.map(a => a.id));
      downloadJson(JSON.stringify(bundle, null, 2), `spatial-diagnostics-r${store.project.revision}.json`);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach(b => b.onclick = () => select(b.dataset['scope']!));
  }
}
function render(): void {
  el('project-name').textContent = store.project.projectId;
  el('revision').textContent = `Revision ${store.project.revision}`;
  el<HTMLButtonElement>('undo').disabled = !store.state.undo.length;
  el<HTMLButtonElement>('redo').disabled = !store.state.redo.length;
  renderLists(); renderInspector(); renderPanel();
}
function setWorkspace(name: string): void {
  workspace = name;
  document.querySelectorAll<HTMLButtonElement>('[data-workspace]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset['workspace'] === name)));
  el('view-title').textContent = ({ Build: 'Build the production', Map: 'Inspect the plan', Connect: 'Connect equipment', Check: 'Review the inputs', Deliver: 'Prepare the handoff' } as Record<string, string>)[name]!;
  root.dataset['workspace'] = name; viewport?.plan(name === 'Map'); renderPanel();
}
function downloadJson(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Download prepared');
}
function exportProject(): void { downloadJson(serializeWorkspace(store.state), `spatial-previs-r${store.project.revision}.json`); }

// Access is a local preference, never project data or a remote-control integration.
const desktopUrlKey = 'spatial-previs.desktop-url.v1';
let desktopUrl = '';
function validateDesktopUrl(value: string): string {
  const address = value.trim();
  if (!address) return '';
  if (address.length > 2048 || /\s/.test(address) || !/^https:\/\//i.test(address)) throw new Error('Enter an absolute HTTPS desktop address.');
  const parsed = new URL(address);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Use HTTPS without a password, sign-in token, query string or fragment.');
  }
  return parsed.href;
}
function desktopUrlStatus(message: string, error = false): void {
  el('desktop-url-status').textContent = message;
  el('desktop-url-status').classList.toggle('error', error);
}
function renderDesktopUrl(): void {
  el<HTMLInputElement>('desktop-url').value = desktopUrl;
  el<HTMLButtonElement>('open-desktop-url').disabled = !desktopUrl;
  el('clear-desktop-url').hidden = !desktopUrl;
}
el('continue-desktop').onclick = () => {
  desktopUrl = '';
  try {
    desktopUrl = validateDesktopUrl(localStorage.getItem(desktopUrlKey) ?? '');
    desktopUrlStatus(desktopUrl ? 'Desktop link saved in this browser.' : 'No desktop link saved. Moonlight can be opened separately.');
  } catch { desktopUrlStatus('Saved desktop link is unavailable. Enter an HTTPS address to replace it.', true); }
  renderDesktopUrl();
  el<HTMLDialogElement>('desktop-handoff').showModal();
  el('desktop-handoff').scrollTop = 0;
};
el('close-desktop-handoff').onclick = () => el<HTMLDialogElement>('desktop-handoff').close();
el('handoff-export').onclick = () => run(exportProject);
el<HTMLFormElement>('desktop-url-form').onsubmit = event => {
  event.preventDefault();
  try {
    const candidate = validateDesktopUrl(el<HTMLInputElement>('desktop-url').value);
    if (candidate) localStorage.setItem(desktopUrlKey, candidate); else localStorage.removeItem(desktopUrlKey);
    desktopUrl = candidate; renderDesktopUrl(); desktopUrlStatus(candidate ? 'Desktop link saved in this browser.' : 'Desktop link removed.');
  } catch (e) { desktopUrlStatus(e instanceof Error ? e.message : 'Desktop link could not be saved.', true); }
};
el('clear-desktop-url').onclick = () => {
  try { localStorage.removeItem(desktopUrlKey); desktopUrl = ''; renderDesktopUrl(); desktopUrlStatus('Desktop link removed.'); }
  catch { desktopUrlStatus('This browser could not remove the saved link.', true); }
};
el('open-desktop-url').onclick = () => {
  try {
    const address = validateDesktopUrl(desktopUrl);
    if (!address) throw new Error('Save a desktop URL first.');
    window.open(address, '_blank', 'noopener,noreferrer');
    desktopUrlStatus('Desktop link requested in a new tab. Your project has not been transferred.');
  } catch (e) { desktopUrlStatus(e instanceof Error ? e.message : 'Desktop link could not be opened.', true); }
};
el('save').onclick = () => run(async () => {
  if (busy || opening) return; busy = true; const savedSerial = serial; el('save-status').textContent = 'Saving…';
  try {
    generation = await repository.save(store.state, generation);
    dirty = serial !== savedSerial; el('save-status').textContent = dirty ? 'Unsaved changes' : 'Saved on this device';
    notice('Project saved');
  } catch (e) { el('save-status').textContent = 'Save failed · export to keep changes'; throw e; }
  finally { busy = false; }
});
el('export').onclick = () => run(exportProject);
el('open').onclick = () => el<HTMLInputElement>('file-input').click();
el<HTMLInputElement>('file-input').onchange = () => run(async () => {
  const file = el<HTMLInputElement>('file-input').files?.[0]; if (!file) return;
  if (busy || opening) { el<HTMLInputElement>('file-input').value = ''; throw new Error('Wait for the current save or open operation'); }
  opening = true;
  const priorStore = store, priorSerial = serial;
  try {
    const state = await repository.import(await file.text());
    const existing = await repository.load(state.project.projectId);
    if (store !== priorStore || serial !== priorSerial) throw new Error('Project changed while the file was opening. Current edits are intact; open the file again.');
    if (dirty && !confirm('Replace unsaved changes? Export the current project first if you need to keep them.')) return;
    closeProposal(); generation = existing?.generation ?? null;
    store = new ProjectStore(state, authorizer); selected = null; connectStore(); markDirty(); render(); await reconcile();
    notice('Project opened; save to retain it on this device');
  } finally { opening = false; el<HTMLInputElement>('file-input').value = ''; }
});
el('undo').onclick = () => run(() => { store.undo(crypto.randomUUID(), store.project.revision, human); notice('Edit undone'); });
el('redo').onclick = () => run(() => { store.redo(crypto.randomUUID(), store.project.revision, human); notice('Edit restored'); });
el('frame').onclick = () => viewport?.frame();
el('search').oninput = renderCatalog; el('category').onchange = renderCatalog;
for (const [id, className] of [['equipment-toggle', 'show-equipment'], ['inspector-toggle', 'show-inspector']]) {
  el(id!).onclick = () => {
    const expanded = !root.classList.contains(className!);
    root.classList.remove('show-equipment', 'show-inspector');
    el('equipment-toggle').setAttribute('aria-expanded', 'false'); el('inspector-toggle').setAttribute('aria-expanded', 'false');
    root.classList.toggle(className!, expanded); el(id!).setAttribute('aria-expanded', String(expanded));
  };
}
document.querySelectorAll<HTMLButtonElement>('[data-workspace]').forEach(b => b.onclick = () => setWorkspace(b.dataset['workspace']!));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (el<HTMLDialogElement>('desktop-handoff').open) return;
  if (preview) { closeProposal(); notice('Proposal canceled; project unchanged'); }
  else {
    const wasInspector = root.classList.contains('show-inspector');
    root.classList.remove('show-equipment', 'show-inspector');
    el('equipment-toggle').setAttribute('aria-expanded', 'false'); el('inspector-toggle').setAttribute('aria-expanded', 'false');
    if (matchMedia('(max-width: 760px)').matches) el(wasInspector ? 'inspector-toggle' : 'equipment-toggle').focus();
  }
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function initialize(): Promise<void> {
  try {
    const saved = await repository.load(await repository.lastProjectId() ?? 'local-production');
    if (saved) { store = new ProjectStore(saved.state, authorizer); generation = saved.generation; el('save-status').textContent = 'Saved on this device'; }
  } catch (e) { notice(`Saved project could not be opened: ${e instanceof Error ? e.message : String(e)}. Export before replacing it.`, true); }
  connectStore(); render();
  const response = await fetch(`${import.meta.env.BASE_URL}assets/manifest.json`);
  if (!response.ok) throw new Error('Equipment catalog could not be loaded; reload to retry');
  const manifest = await response.json() as { assets: CatalogAsset[] }; catalog = manifest.assets;
  el('category').innerHTML += [...new Set(catalog.map(a => a.category))].map(c => `<option>${escape(c)}</option>`).join('');
  renderCatalog();
  try {
    viewport = new ProductionViewport(el<HTMLCanvasElement>('scene-canvas'), catalog, select, (move, baseRevision) => run(() => {
      store.execute({ key: crypto.randomUUID(), label: move.snapped ? 'Equipment snapped' : 'Equipment moved', baseRevision, operations: move.operations }, human);
      notice(move.snapped ? 'Equipment snapped' : 'Equipment moved');
    }), message => notice(message));
    await reconcile();
  }
  catch (e) { el('render-status').textContent = `3D unavailable. Use the equipment list and numeric inspector. ${e instanceof Error ? e.message : ''}`; }
  if (!el('notice').classList.contains('error')) notice('Ready · local scene · no model or API required');
  document.body.dataset['ready'] = 'true';
}
run(initialize);
