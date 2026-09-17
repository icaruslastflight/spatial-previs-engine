import JSZip from 'jszip';
import type { ProductionProject, AssetInstance, AssetDefinition } from '../domain/ProductionProject.ts';
import * as THREE from 'three';

export async function exportMVR(project: ProductionProject): Promise<Blob> {
  const zip = new JSZip();

  const instances = project.records.filter(r => r.kind === 'asset_instance') as AssetInstance[];
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<GeneralSceneDescription xmlns="http://www.gdtf-share.com/mvr">\n`;
  xml += `  <UserData>\n    <Data name="SpatialPrevisEngine" />\n  </UserData>\n`;
  xml += `  <Scene>\n    <Layers>\n      <Layer name="DefaultLayer" uuid="${crypto.randomUUID()}">\n        <ChildList>\n`;

  for (const instance of instances) {
    const def = project.records.find(r => r.id === instance.definitionId) as AssetDefinition | undefined;
    
    // MVR Matrix (Column-major 4x4)
    const pos = instance.transform.position;
    const rot = instance.transform.rotation; // XYZW
    const quaternion = new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]);
    const position = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
    const m = matrix.elements;
    // MVR uses a comma or space separated matrix, 16 floats (column-major in XML, but let's just dump elements)
    const mvrMatrix = `{${m.map(v => v.toFixed(6)).join(',')}}`;

    const gdtfSpec = def?.catalogId || 'Unknown';
    const name = escapeXml(instance.label);
    
    xml += `          <Fixture name="${name}" uuid="${instance.id}">\n`;
    xml += `            <Matrix>${mvrMatrix}</Matrix>\n`;
    xml += `            <GDTFSpec>${escapeXml(gdtfSpec)}</GDTFSpec>\n`;
    
    // If it's a lighting fixture, we would extract DMX here
    xml += `          </Fixture>\n`;
  }

  xml += `        </ChildList>\n      </Layer>\n    </Layers>\n  </Scene>\n`;
  xml += `</GeneralSceneDescription>`;

  zip.file('GeneralSceneDescription.xml', xml);
  
  // Create empty directories to satisfy strict MVR parsers
  zip.folder('GDTF');
  zip.folder('Textures');
  zip.folder('Meshes');

  return await zip.generateAsync({ type: 'blob' });
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}
