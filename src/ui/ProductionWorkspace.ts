import { createProject, createRecordId } from '../domain/ProductionProject.ts';
import type { AssetDefinition, Port, ProductionRecord, AssetInstance, Surface, RasterMapping } from '../domain/ProductionProject.ts';
import { deleteInstanceOperations, ProjectStore } from '../domain/ProjectStore.ts';
import type { Operation, Principal, Preview } from '../domain/ProjectStore.ts';
import { IndexedDbStorage, WorkspaceRepository } from '../domain/WorkspaceRepository.ts';
import { serializeWorkspace } from '../domain/WorkspaceState.ts';
import { translateInstanceOperations } from '../domain/ProjectTransforms.ts';
import { technicalDataCheck, weightRiggingCheck, electricalPowerLoadCheck, laserSafetyCheck } from '../domain/ProjectChecks.ts';
import { readSceneTool } from '../assistant/SceneTools.ts';
import { createDiagnosticBundle } from '../domain/DiagnosticBundle.ts';
import { ProductionViewport } from './ProductionViewport.ts';
import { CablingInspector } from './CablingInspector.ts';
import type { CatalogAsset } from './ProductionViewport.ts';
import './workspace.css';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const root = document.querySelector<HTMLDivElement>('#workspace')!;
root.innerHTML = `<header class="project-bar"><div class="wordmark"><span class="mark">SP</span><div><strong>Spatial Previs</strong><small>Production workspace</small></div></div>
  <div class="project-identity"><span id="project-name">Local production</span><span id="revision">Revision 0</span></div>
  <span class="mode">Design only</span></header>
  <nav class="workspace-nav" aria-label="Workspace">${['Build', 'Map', 'Connect', 'Check', 'Operations', 'Deliver'].map((name, i) => `<button data-workspace="${name}" aria-pressed="${i === 0}"><span>0${i + 1}</span>${name}</button>`).join('')}</nav>
  <div class="command-bar"><button id="save">Save project</button><button id="open">Open file</button><button id="export">Export project</button><span class="separator"></span><button id="undo" disabled>Undo</button><button id="redo" disabled>Redo</button><button id="equipment-toggle" aria-expanded="false">Equipment</button><button id="inspector-toggle" aria-expanded="false">Inspector</button><button id="continue-desktop" aria-haspopup="dialog">Continue on desktop</button><button id="launch-showcase-btn" title="Launch concert stage showcase with Claypaky Sharpy rig and EDM video wall">Stage showcase</button></div>
  <main class="work-area"><aside class="equipment"><h2>Equipment</h2><label class="search-label">Search catalog<input id="search" type="search" placeholder="Truss, panel, speaker…"></label><label>Category<select id="category"><option value="">All categories</option></select></label><div id="catalog" class="catalog"></div><div class="section-heading"><h2>Scene</h2><span id="scene-count">0 objects</span></div><div id="scene-list" class="scene-list"></div></aside>
  <section class="center"><div class="view-heading"><div><h1 id="view-title">Build the production</h1><p id="view-subtitle">Local scene · metres · optional venue context</p></div><div class="view-controls"><div id="camera-presets" class="button-group"><button id="cam-orbit" type="button" title="3D Free Orbit Perspective">3D Orbit</button><button id="cam-front" type="button" title="Front Screen Elevation View">Front</button><button id="cam-screen" type="button" title="Frame Video Screens">Screens</button><button id="cam-top" type="button" title="Top Plan View">Top</button></div><button id="frame">Frame all</button></div></div>
  <div class="viewport"><canvas id="scene-canvas" aria-label="Production 3D scene"></canvas><div id="empty-scene"><strong>A venue starts with your design</strong><span>Add equipment from the catalog. A map or point cloud can come later.</span></div><span class="view-note">Catalog geometry is a planning placeholder</span><span id="render-status" role="status"></span></div>
  <section id="workspace-panel" class="workspace-panel"></section></section>
  <aside class="inspector"><h2>Inspector</h2><div id="inspector-content"></div></aside></main>
  <section id="proposal" hidden aria-label="Proposed changes"></section>
  <footer><span id="notice" role="status">Opening local project…</span><span id="save-status">Unsaved</span><span class="gate">R0 preview · desktop conformance pending</span></footer>
  <input id="file-input" type="file" accept=".json,application/json" hidden>
  <dialog id="desktop-handoff" closedby="any" aria-labelledby="desktop-handoff-title" aria-describedby="desktop-handoff-summary">
    <div class="handoff-heading"><h2 id="desktop-handoff-title">Continue on desktop</h2><button id="close-desktop-handoff" aria-label="Close desktop handoff" autofocus>Close</button></div>
    <p id="desktop-handoff-summary">Keep working here, or connect to your desktop for the tools and scene detail available there.</p>
    <ol class="handoff-steps"><li><h3>Keep a complete backup</h3><p>Export the current project, checks, edit history and stored issued snapshots. Your edits stay here.</p><button id="handoff-export">Export project backup</button></li>
    <li><h3>Connect to your computer</h3><p>Open Moonlight on your phone and connect to your paired PC, or use your desktop access link below.</p></li>
    <li><h3>Bring your project with you</h3><p>Files do not transfer automatically. Move the backup to your PC, then use <strong>Open file</strong> in the desktop browser workspace. Native UE5 import of this complete workspace is still in development; keep the original backup and its history.</p></li></ol>
    <form id="desktop-url-form" novalidate><label for="desktop-url">Your desktop access URL <span class="muted">(optional)</span></label><input id="desktop-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://your-desktop-portal.example/" aria-describedby="desktop-url-help desktop-url-status"><p id="desktop-url-help">Use an HTTPS address without a password, sign-in token, query string or fragment. Saved only in this browser; excluded from project exports.</p><div class="handoff-actions"><button type="submit">Save desktop URL</button><button id="open-desktop-url" type="button" disabled>Open desktop link</button><button id="clear-desktop-url" type="button" hidden>Forget link</button></div><p id="desktop-url-status" role="status"></p></form>
    <details class="handoff-provider"><summary>Already using AirGPU?</summary><p><a href="https://app.airgpu.com/" target="_blank" rel="noopener noreferrer">Open AirGPU dashboard</a> to manage your existing cloud PC. Your project is not sent to AirGPU.</p></details>
    <div class="desktop-showcase" style="margin-top:16px;padding:12px;background:rgba(157,78,221,0.12);border:1px solid rgba(157,78,221,0.35);border-radius:8px;">
      <h3 style="margin:0 0 6px;color:#e2caff;font-size:0.95rem;">Concert Stage Showcase</h3>
      <p style="margin:0 0 10px;font-size:0.8rem;color:#b0b8c8;line-height:1.4;">Launch the interactive concert stage showcase with the authored 4m&times;4.29m F34 box rig, Claypaky Sharpy moving heads, EDM video wall, volumetric beams, and live EN 60825-1 laser MPE safety evaluation.</p>
      <button id="handoff-launch-showcase" type="button" style="background:#9d4edd;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-weight:600;">Launch Stage Showcase</button>
    </div>
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
let operationsSubTab: 'Inventory' | 'Crew' | 'Vendors' = 'Inventory';
let mapSubTab: 'screens' | 'led' | 'dmx' = 'screens';
let selectedPitch = 3.91;
let cablingInspector: CablingInspector | null = null;
let preview: Preview | null = null, dirty = false, serial = 0, busy = false;
let isDemo = new URLSearchParams(window.location.search).has('demo');
let isShowcase = new URLSearchParams(window.location.search).has('showcase');
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
function checkDemoLimits(operations: Operation[]): void {
  if (!isDemo) return;
  const project = store.project;
  let instances = project.records.filter(r => r.kind === 'asset_instance').length;
  let connections = project.records.filter(r => r.kind === 'connection').length;
  let zones = project.records.filter(r => r.kind === 'zone').length;
  let ops = project.records.filter(r => r.kind === 'personnel' || r.kind === 'vendor').length;
  
  for (const op of operations) {
    if (op.type === 'put' && op.record) {
      if (op.record.kind === 'asset_instance' && !project.records.some(r => r.id === op.record!.id)) instances++;
      if (op.record.kind === 'connection' && !project.records.some(r => r.id === op.record!.id)) connections++;
      if (op.record.kind === 'zone' && !project.records.some(r => r.id === op.record!.id)) zones++;
      if ((op.record.kind === 'personnel' || op.record.kind === 'vendor') && !project.records.some(r => r.id === op.record!.id)) ops++;
    }
  }
  
  if (instances > 600) throw new Error('Demo Limit: Maximum 600 pieces of equipment allowed.');
  if (connections > 100) throw new Error('Demo Limit: Maximum 100 connections allowed.');
  if (zones > 15) throw new Error('Demo Limit: Maximum 15 zones allowed.');
  if (ops > 50) throw new Error('Demo Limit: Maximum 50 operations records allowed.');
}

function transact(label: string, operations: Operation[]): void {
  checkDemoLimits(operations);
  store.execute({ key: crypto.randomUUID(), label, baseRevision: store.project.revision, operations }, human);
  notice(label);
}
function propose(label: string, operations: Operation[]): void {
  checkDemoLimits(operations);
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
    if (record.kind === 'asset_instance') {
      await target.recordCheck(weightRiggingCheck(target.project, record, `check:${crypto.randomUUID()}`), target.project.revision);
      await target.recordCheck(electricalPowerLoadCheck(target.project, record, `check:${crypto.randomUUID()}`), target.project.revision);
      await target.recordCheck(laserSafetyCheck(target.project, record, `check:${crypto.randomUUID()}`), target.project.revision);
    }
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
    const currentVideo = viewport?.getVideoSource() ?? 'edm';

    const subTabs = [
      { id: 'screens', label: 'Screen & Video Mapping' },
      { id: 'led', label: 'LED Pitch & Modules' },
      { id: 'dmx', label: 'DMX Pixel Mapping' },
    ];

    let html = `
      <div class="map-tabs" style="display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:8px;">
        ${subTabs.map(t => `<button type="button" class="sub-tab ${mapSubTab === t.id ? 'selected' : ''}" data-map-tab="${t.id}" style="font-size:12px;padding:6px 10px;min-height:34px;background:${mapSubTab === t.id ? 'var(--accent)' : 'transparent'};color:${mapSubTab === t.id ? '#171b19' : 'inherit'};border:1px solid ${mapSubTab === t.id ? 'var(--accent)' : 'var(--border)'};font-weight:${mapSubTab === t.id ? '600' : 'normal'};border-radius:4px;">${t.label}</button>`).join('')}
      </div>
    `;

    if (mapSubTab === 'screens') {
      html += `
        <h2>Display Surfaces & Video Mapping</h2>
        <p>Map real-time video loops, calibration patterns, and raster resolutions onto 3D display surfaces in the movable viewport.</p>
        
        <div style="background:rgba(228,191,121,0.08);border:1px solid rgba(228,191,121,0.25);border-radius:6px;padding:10px;margin-bottom:14px;">
          <h4 style="margin:0 0 6px;color:var(--accent);">Live Screen Video Source / Test Pattern</h4>
          <p style="margin:0 0 8px;font-size:11px;color:var(--muted);">Select test pattern or visual feed rendering live on the 3D screens in the movable viewport:</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;" id="video-source-buttons">
            <button type="button" data-vsrc="edm" class="${currentVideo === 'edm' ? 'active-vsrc' : ''}" style="min-height:32px;font-size:11px;padding:4px 9px;border-radius:4px;border:1px solid ${currentVideo === 'edm' ? 'var(--accent)' : 'var(--border)'};background:${currentVideo === 'edm' ? '#d6b476' : '#272d29'};color:${currentVideo === 'edm' ? '#171b19' : 'inherit'};font-weight:600;">🎵 EDM Visual Loop</button>
            <button type="button" data-vsrc="smpte" class="${currentVideo === 'smpte' ? 'active-vsrc' : ''}" style="min-height:32px;font-size:11px;padding:4px 9px;border-radius:4px;border:1px solid ${currentVideo === 'smpte' ? 'var(--accent)' : 'var(--border)'};background:${currentVideo === 'smpte' ? '#d6b476' : '#272d29'};color:${currentVideo === 'smpte' ? '#171b19' : 'inherit'};font-weight:600;">📺 SMPTE Color Bars</button>
            <button type="button" data-vsrc="grid" class="${currentVideo === 'grid' ? 'active-vsrc' : ''}" style="min-height:32px;font-size:11px;padding:4px 9px;border-radius:4px;border:1px solid ${currentVideo === 'grid' ? 'var(--accent)' : 'var(--border)'};background:${currentVideo === 'grid' ? '#d6b476' : '#272d29'};color:${currentVideo === 'grid' ? '#171b19' : 'inherit'};font-weight:600;">📐 Pixel Grid & 1:1</button>
            <button type="button" data-vsrc="gradient" class="${currentVideo === 'gradient' ? 'active-vsrc' : ''}" style="min-height:32px;font-size:11px;padding:4px 9px;border-radius:4px;border:1px solid ${currentVideo === 'gradient' ? 'var(--accent)' : 'var(--border)'};background:${currentVideo === 'gradient' ? '#d6b476' : '#272d29'};color:${currentVideo === 'gradient' ? '#171b19' : 'inherit'};font-weight:600;">🌈 RGB Sweep</button>
          </div>
        </div>

        <h3>Active Display Surfaces</h3>
        ${surfaces.length ? surfaces.map(s => {
          const w = s.width.status === 'known' ? s.width.value : 4.0;
          const h = s.height.status === 'known' ? s.height.value : 2.5;
          const mapping = mappings.find(m => m.surfaceId === s.id);
          const ratio = (w / h).toFixed(2);
          return `
            <div class="data-row" style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
              <div>
                <strong>${escape(s.label)}</strong>
                <small style="color:var(--muted);">${w}m × ${h}m · ${ratio}:1 aspect · ${mapping ? `${mapping.width}×${mapping.height}px mapped` : 'No raster'}</small>
              </div>
              <div style="display:flex;gap:6px;">
                <button type="button" data-focus-surface="${escape(s.id)}" style="min-height:30px;font-size:11px;padding:4px 8px;">Frame</button>
              </div>
            </div>
          `;
        }).join('') : '<p class="empty-copy">No display surfaces defined yet. Group placed LED panels below.</p>'}

        <h3 style="margin-top:16px;">Map Video Raster</h3>
        <form id="create-raster" style="margin-top:8px;">
          <label>Target Surface
            <select name="surfaceId" required>
              ${surfaces.map(s => `<option value="${escape(s.id)}">${escape(s.label)}</option>`).join('')}
            </select>
          </label>
          <div style="width:100%;display:flex;gap:8px;margin-bottom:6px;">
            <button type="button" class="preset-res" data-w="1920" data-h="1080" style="min-height:28px;font-size:11px;padding:3px 8px;">1080p FHD</button>
            <button type="button" class="preset-res" data-w="3840" data-h="2160" style="min-height:28px;font-size:11px;padding:3px 8px;">4K UHD</button>
            <button type="button" class="preset-res" data-w="1024" data-h="640" style="min-height:28px;font-size:11px;padding:3px 8px;">P3.91 Native</button>
          </div>
          <div class="coordinates">
            <label>Width <span>px</span><input id="raster-w" name="width" type="number" min="1" step="1" value="1920" required></label>
            <label>Height <span>px</span><input id="raster-h" name="height" type="number" min="1" step="1" value="1080" required></label>
          </div>
          <button type="submit" ${!surfaces.length ? 'disabled' : ''} style="margin-top:10px;font-size:12px;">Map Video Raster</button>
        </form>

        <h3 style="margin-top:18px;">Group Equipment into Surface</h3>
        <form id="create-surface" style="margin-top:8px;">
          <p class="muted" style="margin:0 0 6px;">Select equipment instances to group into an LED display plane:</p>
          <div class="checkbox-list" style="max-height:140px;overflow:auto;border:1px solid var(--border);padding:6px;border-radius:4px;margin-bottom:8px;">
            ${instances.map(r => `<label style="display:block;padding:2px 0;"><input type="checkbox" name="instances" value="${escape(r.id)}"> ${escape(r.label)}</label>`).join('')}
          </div>
          <button type="submit" ${!instances.length ? 'disabled' : ''} style="font-size:12px;">Group into Display Surface</button>
        </form>
      `;
    } else if (mapSubTab === 'led') {
      const surface = surfaces[0];
      const w = surface && surface.width.status === 'known' ? surface.width.value : 4.0;
      const h = surface && surface.height.status === 'known' ? surface.height.value : 2.5;
      const area = (w * h).toFixed(2);
      const pitchM = selectedPitch / 1000;
      const nativeW = Math.round(w / pitchM);
      const nativeH = Math.round(h / pitchM);
      const totalPixels = nativeW * nativeH;
      const cabCols = Math.max(1, Math.round(w / 0.5));
      const cabRows = Math.max(1, Math.round(h / 0.5));
      const totalCabs = cabCols * cabRows;
      const cabPxW = Math.round(nativeW / cabCols);
      const cabPxH = Math.round(nativeH / cabRows);
      const gigPorts = Math.ceil(totalPixels / 650000);
      const avgPowerKw = ((totalCabs * 150) / 1000).toFixed(1);
      const maxPowerKw = ((totalCabs * 450) / 1000).toFixed(1);
      const totalMassKg = (totalCabs * 9.5).toFixed(0);

      html += `
        <h2>LED Pixel Pitch & Hardware Calculator</h2>
        <p>Calculate native LED resolutions, module matrices, controller data ports, and electrical specs.</p>
        
        <label>Pixel Pitch
          <select id="pitch-select" style="margin-top:4px;">
            <option value="1.9" ${selectedPitch === 1.9 ? 'selected' : ''}>P1.9 mm · Ultra Fine Pitch (Broadcast / Studio)</option>
            <option value="2.5" ${selectedPitch === 2.5 ? 'selected' : ''}>P2.5 mm · High Density (Indoor Corporate / DJ)</option>
            <option value="3.91" ${selectedPitch === 3.91 ? 'selected' : ''}>P3.91 mm · Concert Stage Touring Standard</option>
            <option value="4.81" ${selectedPitch === 4.81 ? 'selected' : ''}>P4.81 mm · Touring Outdoor / Daytime Stage</option>
            <option value="5.95" ${selectedPitch === 5.95 ? 'selected' : ''}>P5.95 mm · Large Arena / Festival Walls</option>
            <option value="10.0" ${selectedPitch === 10.0 ? 'selected' : ''}>P10.0 mm · Stadium Perimeter / Mesh Scrim</option>
          </select>
        </label>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;">
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">Physical Screen</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${w}m × ${h}m</strong>
            <small style="color:var(--muted);">${area} m² · ${(w/h).toFixed(2)}:1 aspect</small>
          </div>
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">Native Resolution</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${nativeW} × ${nativeH} px</strong>
            <small style="color:var(--muted);">${totalPixels.toLocaleString()} total LEDs</small>
          </div>
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">Cabinet Matrix</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${cabCols}W × ${cabRows}H (${totalCabs} cabs)</strong>
            <small style="color:var(--muted);">${cabPxW} × ${cabPxH} px per 500mm tile</small>
          </div>
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">1GbE Controller Ports</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${gigPorts} Gigabit Ports</strong>
            <small style="color:var(--muted);">NovaStar / Brompton 650k px/port</small>
          </div>
        </div>

        <div style="margin-top:14px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:10px;">
          <h4 style="margin:0 0 6px;">Power & Structural Load</h4>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
            <span style="color:var(--muted);">Average Draw:</span>
            <strong>${avgPowerKw} kW (${(Number(avgPowerKw)*1000/230).toFixed(1)}A @ 230V)</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
            <span style="color:var(--muted);">Peak Inrush:</span>
            <strong>${maxPowerKw} kW (${(Number(maxPowerKw)*1000/230).toFixed(1)}A @ 230V)</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;">
            <span style="color:var(--muted);">Total Panel Weight:</span>
            <strong>${totalMassKg} kg (${Math.round(Number(totalMassKg)*2.20462)} lbs)</strong>
          </div>
        </div>

        <div style="margin-top:14px;">
          <button id="export-mapping-csv" style="font-size:12px;width:100%;">Download Video Mapping Schedule (CSV)</button>
        </div>
      `;
    } else if (mapSubTab === 'dmx') {
      const mapping = mappings[0] || { width: 1920, height: 1080 };
      const fixtures = instances.filter(i => i.label.toLowerCase().includes('bar') || i.label.toLowerCase().includes('colorstrip') || i.definitionId.includes('strobe') || i.definitionId.includes('colorstrip'));
      const fixtureCount = Math.max(fixtures.length, 8);
      const zonesPerFixture = 4;
      const channelsPerZone = 3; // RGB
      const totalChannels = fixtureCount * zonesPerFixture * channelsPerZone;
      const universes = Math.ceil(totalChannels / 512);

      html += `
        <h2>DMX Pixel Mapping & Fixture Pixels</h2>
        <p>Map raster video pixels onto addressable LED bars, tubes, and multi-cell fixtures.</p>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">Mapped Fixtures</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${fixtureCount} Pixel Bars</strong>
            <small style="color:var(--muted);">${fixtureCount * zonesPerFixture} Addressable RGB Zones</small>
          </div>
          <div style="background:var(--field);border:1px solid var(--border);border-radius:6px;padding:10px;">
            <small style="color:var(--muted);text-transform:uppercase;">DMX Footprint</small>
            <strong style="font-size:16px;display:block;margin-top:4px;color:var(--accent);">${totalChannels} Channels</strong>
            <small style="color:var(--muted);">${universes} Art-Net / sACN Universe(s)</small>
          </div>
        </div>

        <h3>Pixel Patch Table</h3>
        <table style="margin-top:8px;font-size:11px;">
          <thead>
            <tr><th>Fixture</th><th>Universe</th><th>DMX Ch</th><th>Sample X,Y</th></tr>
          </thead>
          <tbody>
            ${Array.from({ length: Math.min(fixtureCount, 8) }, (_, i) => {
              const startCh = i * 12 + 1;
              const u = Math.floor((startCh - 1) / 512) + 1;
              const ch = ((startCh - 1) % 512) + 1;
              const sampleX = Math.round((i / Math.max(1, fixtureCount - 1)) * mapping.width);
              const sampleY = Math.round(mapping.height * 0.5);
              return `
                <tr>
                  <td>${fixtures[i]?.label ?? `COLORstrip Pixel Bar #${i + 1}`}</td>
                  <td>Univ ${u}</td>
                  <td>${ch} - ${ch + 11}</td>
                  <td>[${sampleX}, ${sampleY}]</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>

        <div style="margin-top:14px;">
          <button id="export-dmx-pixels" style="font-size:12px;width:100%;">Download DMX Pixel Patch (CSV)</button>
        </div>
      `;
    }

    panel.innerHTML = html;

    panel.querySelectorAll<HTMLButtonElement>('[data-map-tab]').forEach(b => b.onclick = () => {
      mapSubTab = b.dataset['mapTab'] as any;
      renderPanel();
    });

    panel.querySelectorAll<HTMLButtonElement>('[data-vsrc]').forEach(b => b.onclick = () => {
      viewport?.setVideoSource(b.dataset['vsrc'] as any);
      renderPanel();
      notice(`Live screen video source updated: ${b.dataset['vsrc']?.toUpperCase()}`);
    });

    panel.querySelectorAll<HTMLButtonElement>('.preset-res').forEach(b => b.onclick = () => {
      const wInput = panel.querySelector<HTMLInputElement>('#raster-w');
      const hInput = panel.querySelector<HTMLInputElement>('#raster-h');
      if (wInput && hInput) {
        wInput.value = b.dataset['w']!;
        hInput.value = b.dataset['h']!;
      }
    });

    panel.querySelectorAll<HTMLButtonElement>('[data-focus-surface]').forEach(b => b.onclick = () => {
      select(b.dataset['focusSurface']!);
      viewport?.setCameraView('screen');
    });

    const pitchSel = panel.querySelector<HTMLSelectElement>('#pitch-select');
    if (pitchSel) {
      pitchSel.onchange = () => {
        selectedPitch = Number(pitchSel.value);
        renderPanel();
      };
    }

    panel.querySelector<HTMLButtonElement>('#export-mapping-csv')?.addEventListener('click', () => run(() => {
      let csv = 'Surface Name,Shape,Width (m),Height (m),Area (m2),Pixel Pitch (mm),Native Width (px),Native Height (px),Total Pixels,Cabinet Matrix,Cabinet Count,Controller Ports (1GbE),Avg Power (kW),Peak Power (kW),Total Weight (kg)\n';
      for (const s of surfaces) {
        const w = s.width.status === 'known' ? s.width.value : 4.0;
        const h = s.height.status === 'known' ? s.height.value : 2.5;
        const pitchM = selectedPitch / 1000;
        const nw = Math.round(w / pitchM);
        const nh = Math.round(h / pitchM);
        const tp = nw * nh;
        const cols = Math.max(1, Math.round(w / 0.5));
        const rows = Math.max(1, Math.round(h / 0.5));
        const cabs = cols * rows;
        const ports = Math.ceil(tp / 650000);
        const avgKw = ((cabs * 150) / 1000).toFixed(1);
        const peakKw = ((cabs * 450) / 1000).toFixed(1);
        const mass = (cabs * 9.5).toFixed(0);
        csv += `"${s.label}","${s.shape}",${w},${h},${(w*h).toFixed(2)},${selectedPitch},${nw},${nh},${tp},"${cols}x${rows}",${cabs},${ports},${avgKw},${peakKw},${mass}\n`;
      }
      downloadCsv(csv, `video-mapping-schedule-r${state.project.revision}.csv`);
    }));

    panel.querySelector<HTMLButtonElement>('#export-dmx-pixels')?.addEventListener('click', () => run(() => {
      let csv = 'Fixture,Universe,DMX Start,DMX End,Zones,Channels,Sample X,Sample Y\n';
      const mapping = mappings[0] || { width: 1920, height: 1080 };
      const fixtures = instances.filter(i => i.label.toLowerCase().includes('bar') || i.label.toLowerCase().includes('colorstrip') || i.definitionId.includes('strobe') || i.definitionId.includes('colorstrip'));
      const count = Math.max(fixtures.length, 8);
      for (let i = 0; i < count; i++) {
        const startCh = i * 12 + 1;
        const u = Math.floor((startCh - 1) / 512) + 1;
        const ch = ((startCh - 1) % 512) + 1;
        const sx = Math.round((i / Math.max(1, count - 1)) * mapping.width);
        const sy = Math.round(mapping.height * 0.5);
        csv += `"${fixtures[i]?.label ?? `COLORstrip Pixel Bar #${i + 1}`}",${u},${ch},${ch + 11},4,12,${sx},${sy}\n`;
      }
      downloadCsv(csv, `dmx-pixel-patch-r${state.project.revision}.csv`);
    }));

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
          { type: 'put', record: { id: surfaceId, kind: 'surface', label: 'Display Surface', locked: false, shape: 'plane', transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1] }, width: { status: 'known', unit: 'm', value: 4.0, provenance: 'user', source: 'Grouped tiles' }, height: { status: 'known', unit: 'm', value: 2.5, provenance: 'user', source: 'Grouped tiles' } } }
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
      <form id="connect-ports"><label>From<select name="source">${ports.filter(p => p.direction !== 'input').map(p => `<option value="${escape(p.id)}">${escape(p.label)} Â· ${p.domain}</option>`).join('')}</select></label><label>To<select name="target">${ports.filter(p => p.direction !== 'output').map(p => `<option value="${escape(p.id)}">${escape(p.label)} Â· ${p.domain}</option>`).join('')}</select></label><button ${ports.length < 2 ? 'disabled' : ''}>Preview connection</button></form>
      ${state.project.records.filter(r => r.kind === 'connection').map(r => `<div class="data-row"><span>${escape(r.label)} Â· ${r.domain}</span><button data-remove="${escape(r.id)}">Remove connection</button></div>`).join('')}
      <hr style="margin: 1rem 0; border: 1px solid #444;" />
      <h3>A* 3D Truss Cable Router</h3>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
        <button id="render-cables">Render 3D Splines</button>
        <button id="export-cable-schedule">Export Cable Schedule</button>
      </div>`;
    
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
    
    el<HTMLButtonElement>('render-cables').onclick = () => {
      if (!viewport) return;
      if (cablingInspector) cablingInspector.destroy();
      cablingInspector = new CablingInspector(viewport.scene, viewport.camera, document.querySelector<HTMLCanvasElement>('#scene-canvas')!, store.project);
      cablingInspector.renderRoutes();
      notice('Cable splines rendered. Use handles to edit routing.');
    };
    el<HTMLButtonElement>('export-cable-schedule').onclick = () => {
      if (!cablingInspector) { notice('Render cables first'); return; }
      cablingInspector.exportCableSchedule();
    };

  } else if (workspace === 'Check') {
    panel.innerHTML = `<h2>Scoped checks</h2>
      <div class="alpha-disclaimer" style="color: #ff9900; font-size: 0.9em; margin-bottom: 1rem; border-left: 3px solid #ff9900; padding-left: 0.5rem;">
        <strong>ALPHA BUILD NOTATION:</strong> Any calculations performed cannot be guaranteed. The program is not liable for miscalculations, damage, or safety hazards.
      </div>
      <p>Checks describe a named model and its inputs. Specialist approval is unavailable until a reviewer authority is configured.</p>` +
      (state.checks.length ? state.checks.map(c => `<button class="check-row" data-scope="${escape(c.scope[0])}"><strong class="check-status ${c.status}">${escape(c.status.replaceAll('_', ' '))}</strong><span>${escape(c.summary)}<small>${escape(c.model)} v${escape(c.modelVersion)} · input revision ${c.inputRevision}</small></span></button>`).join('') : '<p class="empty-copy">No checks yet. Select equipment and choose Check recorded data.</p>');
    panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach(b => b.onclick = () => select(b.dataset['scope']!));
  } else if (workspace === 'Operations') {
    const renderOps = () => {
      const records = state.project.records;
      const subTabs = ['Inventory', 'Crew', 'Vendors'].map(t => `<button type="button" class="sub-tab ${operationsSubTab === t ? 'selected' : ''}" data-sub="${t}">${t}</button>`).join('');
      let html = `<div style="display:flex;gap:0.5rem;margin-bottom:1rem;border-bottom:1px solid #444;padding-bottom:0.5rem">${subTabs}</div>`;
      
      if (operationsSubTab === 'Inventory') {
        html += `<h2>Inventory Lifecycle & Containers</h2><p>Select placed equipment to manage allocation, status, and containers.</p>`;
        const record = selectedRecord();
        if (record && record.kind === 'asset_instance') {
          const def = records.find(r => r.id === record.definitionId);
          const inventoryItem = record.inventoryItemId ? records.find(r => r.id === record.inventoryItemId) as any : null;
          html += `<h3>${escape(record.label)}</h3><p class="muted">${def ? escape(def.label) : ''}</p>
          <form id="allocate-form">
            <label>Serial / Barcode<input name="serial" value="${escape(inventoryItem?.serialNumber || '')}"></label>
            <label>Service Status<select name="serviceStatus">${
              ['available', 'prepped', 'outbound', 'show', 'returning', 'maintenance', 'missing', 'unavailable', 'unknown'].map(s => `<option ${inventoryItem?.serviceStatus === s ? 'selected' : ''}>${s}</option>`).join('')
            }</select></label>
            <label>Ownership<select name="ownership">${
              ['owned', 'subrented'].map(s => `<option ${inventoryItem?.ownership === s ? 'selected' : ''}>${s}</option>`).join('')
            }</select></label>
            <button type="submit">Update Item</button>
          </form>`;
        }
      } else if (operationsSubTab === 'Crew') {
        const crew = records.filter(r => r.kind === 'personnel') as any[];
        html += `<h2>Crew Management</h2><p>In-house and overhire contacts.</p>
        <form id="add-crew"><div style="display:flex;gap:0.5rem"><input name="name" placeholder="Name" required><select name="type"><option>in-house</option><option>overhire</option></select><button type="submit">Add</button></div></form>
        <div style="margin-top:1rem">${crew.map(c => `<div class="data-row"><span>${escape(c.name)} (${c.personnelType})</span></div>`).join('')}</div>`;
      } else if (operationsSubTab === 'Vendors') {
        const vendors = records.filter(r => r.kind === 'vendor') as any[];
        html += `<h2>Vendors & Sub-rentals</h2><p>Rental houses and suppliers.</p>
        <form id="add-vendor"><div style="display:flex;gap:0.5rem"><input name="name" placeholder="Company Name" required><select name="type"><option>rental</option><option>supplier</option><option>freelance_agency</option></select><button type="submit">Add</button></div></form>
        <div style="margin-top:1rem">${vendors.map(v => `<div class="data-row"><span>${escape(v.name)} (${v.vendorType})</span></div>`).join('')}</div>`;
      }
      panel.innerHTML = html;
      
      panel.querySelectorAll<HTMLButtonElement>('.sub-tab').forEach(b => b.onclick = () => { operationsSubTab = b.dataset['sub'] as any; renderOps(); });
      
      if (operationsSubTab === 'Crew') {
        el<HTMLFormElement>('add-crew').onsubmit = (e) => {
          e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement);
          run(() => transact('Crew added', [{ type: 'put', record: { id: createRecordId('personnel'), kind: 'personnel', label: String(fd.get('name')), locked: false, name: String(fd.get('name')), personnelType: String(fd.get('type')) as any, roles: [], skills: [], email: null, phone: null, dayRate: null } }]));
        };
      } else if (operationsSubTab === 'Vendors') {
        el<HTMLFormElement>('add-vendor').onsubmit = (e) => {
          e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement);
          run(() => transact('Vendor added', [{ type: 'put', record: { id: createRecordId('vendor'), kind: 'vendor', label: String(fd.get('name')), locked: false, name: String(fd.get('name')), vendorType: String(fd.get('type')) as any, contactName: null, email: null, phone: null } }]));
        };
      } else if (operationsSubTab === 'Inventory') {
        const form = panel.querySelector<HTMLFormElement>('#allocate-form');
        if (form) form.onsubmit = (e) => {
          e.preventDefault();
          const fd = new FormData(e.target as HTMLFormElement);
          const serial = String(fd.get('serial')).trim();
          run(() => {
            const record = selectedRecord()!;
            let itemId = (record as any).inventoryItemId || createRecordId('inventory_item');
            const ops: Operation[] = [];
            ops.push({ type: 'put', record: { id: itemId, kind: 'inventory_item', label: 'Item ' + serial, locked: false, definitionId: (record as any).definitionId, serialNumber: serial || null, serviceStatus: String(fd.get('serviceStatus')) as any, ownership: String(fd.get('ownership')) as any, vendorId: null, containerId: null } });
            if ((record as any).inventoryItemId !== itemId) ops.push({ type: 'put', record: { ...(record as any), inventoryItemId: itemId } });
            transact('Item updated', ops);
          });
        };
      }
    };
    renderOps();
  } else {
    const rows = state.project.records.filter(r => r.kind === 'asset_instance');
    panel.innerHTML = `<h2>Current draft · revision ${state.project.revision}</h2><p>Local design quantities, not warehouse availability. Export project includes the exact graph, checks, history and any previously issued snapshots.</p><table><thead><tr><th>Placed equipment</th><th>Inventory allocation</th></tr></thead><tbody>${rows.map(r => {
      const item = r.inventoryItemId ? state.project.records.find(i => i.id === r.inventoryItemId) as any : null;
      return `<tr><td><button data-scope="${escape(r.id)}">${escape(r.label)}</button></td><td>${item ? escape(item.serialNumber || item.id) : 'Unallocated'}</td></tr>`;
    }).join('')}</tbody></table>
    <div class="section-heading"><h4>Crew-pack Generation</h4></div>
    <div class="export-actions" style="margin-bottom: 1rem">
      <button id="export-pullsheet">Download Pull Sheet (CSV)</button>
      <button id="export-patchsheet">Download Patch Sheet (CSV)</button>
      <button id="export-weightreport">Download Weight Report (CSV)</button>
    </div>
    <div class="section-heading"><h4>Console / Show Control Handoff</h4></div>
    <div class="export-actions" style="margin-bottom: 1rem">
      <button id="export-mvr">Export MVR (Lighting/Laser/Audio Consoles)</button>
      <button id="export-disguise">Export Disguise (CSV)</button>
    </div>
    <p>${state.issued.length} immutable issued snapshots stored.</p>
    <div class="section-heading"><h4>Engine Artifacts</h4></div>
    <div class="export-actions"><button id="export-evidence">Export scene evidence</button><button id="export-diagnostics">Export diagnostics</button></div>
    <p>Diagnostics replace names, sources and identities with aliases; geometry and numeric values remain. Both exports download locally.</p>`;
    
    el('export-pullsheet').onclick = () => run(() => {
      let csv = 'Category,Item Name,Catalog ID,Quantity Needed\n';
      const instances = state.project.records.filter(r => r.kind === 'asset_instance');
      const counts = new Map<string, number>();
      for (const instance of instances) counts.set(instance.definitionId, (counts.get(instance.definitionId) || 0) + 1);
      for (const [defId, count] of counts.entries()) {
        const def = state.project.records.find(r => r.id === defId);
        if (def && def.kind === 'asset_definition') csv += `"${def.category}","${def.label}","${def.catalogId}",${count}\n`;
      }
      downloadCsv(csv, `pull-sheet-r${state.project.revision}.csv`);
    });
    
    el('export-patchsheet').onclick = () => run(() => {
      let csv = 'Domain,Source Item,Source Port,Target Item,Target Port\n';
      const connections = state.project.records.filter(r => r.kind === 'connection');
      for (const conn of connections) {
        if (conn.kind !== 'connection') continue;
        const sourcePort = state.project.records.find(r => r.id === conn.sourcePortId);
        const targetPort = state.project.records.find(r => r.id === conn.targetPortId);
        if (sourcePort?.kind === 'port' && targetPort?.kind === 'port') {
          const sourceItem = state.project.records.find(r => r.id === sourcePort.instanceId);
          const targetItem = state.project.records.find(r => r.id === targetPort.instanceId);
          csv += `"${conn.domain}","${sourceItem?.label || 'Unknown'}","${sourcePort.label}","${targetItem?.label || 'Unknown'}","${targetPort.label}"\n`;
        }
      }
      downloadCsv(csv, `patch-sheet-r${state.project.revision}.csv`);
    });
    
    el('export-weightreport').onclick = () => run(() => {
      let csv = 'Root Item,Total Mass (kg),Data Completeness\n';
      const instances = state.project.records.filter(r => r.kind === 'asset_instance');
      for (const instance of instances) {
        const isChild = state.project.records.some(r => r.kind === 'mechanical_attachment' && r.childInstanceId === instance.id);
        if (!isChild) {
           const check = weightRiggingCheck(state.project, instance, 'temp');
           csv += `"${instance.label}","${check.summary.replace(/"/g, '""')}","${check.status === 'pass' ? 'Complete' : 'Missing Data'}"\n`;
        }
      }
      downloadCsv(csv, `weight-report-r${state.project.revision}.csv`);
    });

    el('export-mvr').onclick = () => run(async () => {
      const { exportMVR } = await import('../io/MVRExporter.ts');
      const blob = await exportMVR(store.project);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `spatial-previs-r${state.project.revision}.mvr`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); notice('MVR Download prepared');
    });

    el('export-disguise').onclick = () => run(async () => {
      const { Euler, Quaternion, MathUtils } = await import('three');
      let csv = 'Name,X,Y,Z,Rx,Ry,Rz\n';
      const instances = state.project.records.filter(r => r.kind === 'asset_instance');
      for (const instance of instances) {
        if (instance.kind !== 'asset_instance') continue;
        const pos = instance.transform.position;
        const q = instance.transform.rotation;
        const euler = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
        const rx = MathUtils.radToDeg(euler.x);
        const ry = MathUtils.radToDeg(euler.y);
        const rz = MathUtils.radToDeg(euler.z);
        csv += `"${instance.label}",${pos[0].toFixed(3)},${pos[1].toFixed(3)},${pos[2].toFixed(3)},${rx.toFixed(3)},${ry.toFixed(3)},${rz.toFixed(3)}\n`;
      }
      downloadCsv(csv, `disguise-mapping-r${state.project.revision}.csv`);
    });

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
  el('view-title').textContent = ({
    Build: 'Build the production',
    Map: 'Video & Pixel Mapping',
    Connect: 'Connect equipment',
    Check: 'Review the inputs',
    Operations: 'Manage operations',
    Deliver: 'Prepare the handoff',
  } as Record<string, string>)[name] ?? name;
  el('view-subtitle').textContent = ({
    Build: 'Local scene · metres · optional venue context',
    Map: 'Map video to display surfaces · pixel pitch · DMX pixel fixtures',
    Connect: 'Signal routing · power distro · truss cable pathways',
    Check: 'Safety evaluations · structural calculations · rigging limits',
    Operations: 'Inventory allocation · crew management · rental vendors',
    Deliver: 'Crew pull sheets · console handoffs · scene exports',
  } as Record<string, string>)[name] ?? 'Local scene · metres';
  root.dataset['workspace'] = name;
  viewport?.plan(name === 'Map');
  renderPanel();
}
function downloadJson(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Download prepared');
}
function downloadCsv(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notice('CSV Download prepared');
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
const handoffDialog = el<HTMLDialogElement>('desktop-handoff');
el('continue-desktop').onclick = () => {
  desktopUrl = '';
  try {
    desktopUrl = validateDesktopUrl(localStorage.getItem(desktopUrlKey) ?? '');
    desktopUrlStatus(desktopUrl ? 'Desktop link saved in this browser.' : 'No desktop link saved. Moonlight can be opened separately.');
  } catch { desktopUrlStatus('Saved desktop link is unavailable. Enter an HTTPS address to replace it.', true); }
  renderDesktopUrl();
  handoffDialog.showModal();
  handoffDialog.scrollTop = 0;
};
el('close-desktop-handoff').onclick = () => handoffDialog.close();
el('handoff-export').onclick = () => run(exportProject);
handoffDialog.addEventListener('close', () => el('continue-desktop').focus());
if (!('closedBy' in HTMLDialogElement.prototype)) {
  handoffDialog.addEventListener('click', event => {
    if (event.target !== handoffDialog) return;
    const rect = handoffDialog.getBoundingClientRect();
    const isInside = (
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width
    );
    if (!isInside) handoffDialog.close();
  });
}
async function loadStageShowcase(): Promise<void> {
  if (dirty && !confirm('Load the concert stage showcase? Any unsaved changes to the current project will be replaced.')) return;
  notice('Loading concert stage showcase…');
  const res = await fetch(`${import.meta.env.BASE_URL}stage-showcase.json`);
  if (!res.ok) throw new Error('Stage showcase file could not be loaded');
  const { parseWorkspace } = await import('../domain/WorkspaceState.ts');
  const state = parseWorkspace(await res.text());
  store = new ProjectStore(state, authorizer);
  generation = null; selected = null;
  connectStore(); markDirty(); render();
  await reconcile();
  viewport?.frame();
  notice('Concert stage showcase loaded! (157 stage objects)');
  if (el<HTMLDialogElement>('desktop-handoff').open) el<HTMLDialogElement>('desktop-handoff').close();
}
el('launch-showcase-btn').onclick = () => run(loadStageShowcase);
el('handoff-launch-showcase').onclick = () => run(loadStageShowcase);
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
  if (isDemo) return notice('Saving is disabled in Demo Mode.', true);
  if (busy || opening) return; busy = true; const savedSerial = serial; el('save-status').textContent = 'Saving…';
  try {
    generation = await repository.save(store.state, generation);
    dirty = serial !== savedSerial; el('save-status').textContent = dirty ? 'Unsaved changes' : 'Saved on this device';
    notice('Project saved');
  } catch (e) { el('save-status').textContent = 'Save failed · export to keep changes'; throw e; }
  finally { busy = false; }
});
el('export').onclick = () => run(exportProject);
el('handoff-export').onclick = () => run(exportProject);
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
el('cam-orbit').onclick = () => viewport?.setCameraView('orbit');
el('cam-front').onclick = () => viewport?.setCameraView('front');
el('cam-screen').onclick = () => viewport?.setCameraView('screen');
el('cam-top').onclick = () => viewport?.setCameraView('top');
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
    
    if (isShowcase) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}stage-showcase.json`);
        if (res.ok) {
          const { parseWorkspace } = await import('../domain/WorkspaceState.ts');
          const state = parseWorkspace(await res.text());
          store = new ProjectStore(state, authorizer);
          generation = null; dirty = true;
          notice('Concert stage showcase loaded! (157 stage objects)');
        }
      } catch (e) {
        console.warn('Stage showcase load failed', e);
      }
    } else if (isDemo) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}demo.json`);
        if (res.ok) {
          const { parseWorkspace } = await import('../domain/WorkspaceState.ts');
          const state = parseWorkspace(await res.text());
          store = new ProjectStore(state, authorizer);
          generation = null; dirty = true;
          notice('Demo project loaded! (Unsaved)');
        }
      } catch (e) {
        console.warn('Demo load failed', e);
      }
    }
    if ((!isDemo && !isShowcase) || dirty === false) {
      const saved = await repository.load(await repository.lastProjectId() ?? 'local-production');
      if (saved) { store = new ProjectStore(saved.state, authorizer); generation = saved.generation; el('save-status').textContent = 'Saved on this device'; }
    }
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
    if (isShowcase) viewport.frame();
  }
  catch (e) { el('render-status').textContent = `3D unavailable. Use the equipment list and numeric inspector. ${e instanceof Error ? e.message : ''}`; }
  if (!el('notice').classList.contains('error')) notice('Ready · local scene · no model or API required');
  document.body.dataset['ready'] = 'true';
}
run(initialize);


