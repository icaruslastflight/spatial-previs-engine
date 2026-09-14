/**
 * Loads Gaussian splat captures registered in public/assets/scans/manifest.json.
 *
 * There are no captures yet -- the survey of every reachable repository turned
 * up no Pittsburgh point cloud -- so today this resolves to `{ loaded: 0 }` and
 * the viewport falls through to its normal render path. It exists so that
 * dropping a capture into `public/assets/scans/` and adding a manifest entry is
 * the whole integration, exactly as that directory's README promises.
 *
 * NOTE: this path has not been exercised against a real capture. Treat the
 * first scan drop as a bring-up, not a no-op.
 */

import * as THREE from 'three';
// Type-only: the ~250 kB splat runtime is dynamically imported below, so it is
// never fetched on a site with no registered captures -- which is every load
// today. Static-importing it would put it in the critical path for nothing.
import type { Viewer as SplatViewer } from '@mkkellogg/gaussian-splats-3d';
import { SITE_FRAME, enuToScene } from '../geo/GeoAnchor.ts';
import type { Geodetic } from '../geo/GeoAnchor.ts';

interface ScanEntry {
  id?: string;
  url?: string;
  format?: string;
  anchor?: Partial<Geodetic>;
  /** Manual nudge in local East/North/Up meters. */
  enu_offset_m?: [number, number, number];
}

interface ScanManifest {
  scans?: ScanEntry[];
}

export interface SplatLoadResult {
  /** Number of captures successfully loaded. */
  loaded: number;
  /** Non-null only when at least one capture loaded; drive it from the frame loop. */
  viewer: SplatViewer | null;
  detail: string;
}

export interface SplatLoaderContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  threeScene: THREE.Scene;
  manifestUrl: string;
  /** Resolves a manifest-relative asset url against the deploy base path. */
  resolveUrl: (url: string) => string;
}

export async function loadRegisteredSplatScenes(
  context: SplatLoaderContext,
): Promise<SplatLoadResult> {
  let manifest: ScanManifest;
  try {
    const response = await fetch(context.manifestUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    manifest = (await response.json()) as ScanManifest;
  } catch (error) {
    console.warn('[SplatSceneLoader] Scan manifest unreadable.', error);
    return { loaded: 0, viewer: null, detail: 'scan manifest unreadable' };
  }

  const scans = (manifest.scans ?? []).filter((scan) => typeof scan.url === 'string');
  if (scans.length === 0) {
    return { loaded: 0, viewer: null, detail: 'no scans registered (placeholder bounds only)' };
  }

  const { Viewer } = await import('@mkkellogg/gaussian-splats-3d');
  const viewer = new Viewer({
    selfDrivenMode: false,
    renderer: context.renderer,
    camera: context.camera,
    threeScene: context.threeScene,
    useBuiltInControls: false,
    // Shared memory needs COOP/COEP cross-origin-isolation headers, which
    // GitHub Pages cannot set. Keep this off so $0 static hosting works.
    sharedMemoryForWorkers: false,
  });

  let loaded = 0;
  for (const scan of scans) {
    try {
      // Place the capture by its own georeference, so several scans with
      // different anchors still land correctly relative to one another.
      const anchor = scan.anchor;
      let position: [number, number, number] = [0, 0, 0];
      if (
        anchor !== undefined &&
        typeof anchor.latitude === 'number' &&
        typeof anchor.longitude === 'number'
      ) {
        position = SITE_FRAME.geodeticToScene({
          latitude: anchor.latitude,
          longitude: anchor.longitude,
          height: anchor.height ?? SITE_FRAME.origin.height,
        }) as [number, number, number];
      }

      const offset = scan.enu_offset_m;
      if (offset !== undefined) {
        const [ox, oy, oz] = enuToScene(offset);
        position = [position[0] + ox, position[1] + oy, position[2] + oz];
      }

      await viewer.addSplatScene(context.resolveUrl(scan.url as string), {
        position,
        showLoadingUI: false,
        progressiveLoad: true,
      });
      loaded += 1;
    } catch (error) {
      console.error(`[SplatSceneLoader] Failed to load scan "${scan.id ?? scan.url}".`, error);
    }
  }

  if (loaded === 0) {
    await viewer.dispose().catch(() => undefined);
    return { loaded: 0, viewer: null, detail: 'all registered scans failed to load' };
  }

  return {
    loaded,
    viewer,
    detail: `${loaded} capture${loaded === 1 ? '' : 's'} loaded`,
  };
}
