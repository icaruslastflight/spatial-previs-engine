import { defineConfig } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The installed CesiumJS distribution. Cesium fetches these trees at RUNTIME
 * relative to CESIUM_BASE_URL, so they cannot be bundled -- they have to exist
 * as real files both in the dev server and in the build output.
 */
const cesiumSource = join(dirname(require.resolve('cesium')), 'Build/Cesium');
const CESIUM_ASSET_DIRS = ['Workers', 'Assets', 'Widgets', 'ThirdParty'] as const;

/** URL prefix (relative to the deploy base) that Cesium's assets are served from. */
const cesiumBaseUrl = 'cesium';

/**
 * Deployment base path.
 *  - Vercel / local dev  -> '/'
 *  - GitHub Pages        -> '/<repo-name>/' (project pages live on a subpath)
 */
const GITHUB_PAGES_BASE = '/spatial-previs-engine/';
const base =
  process.env.BASE_PATH ??
  (process.env.DEPLOY_TARGET === 'gh-pages' ? GITHUB_PAGES_BASE : '/');

const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.xml': 'application/xml',
  '.czml': 'application/json',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Serves Cesium's runtime asset trees in dev and copies them in build.
 *
 * This replaces vite-plugin-static-copy, which reproduced the full source path
 * under the destination (`dist/cesium/node_modules/cesium/Build/Cesium/Assets`)
 * rather than `dist/cesium/Assets`, so Cesium 404'd on
 * `Assets/approximateTerrainHeights.json` at runtime. Doing the copy directly
 * makes the output layout explicit, and the dev middleware means the dev server
 * and the build resolve assets identically.
 */
function cesiumAssets(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'festival-cesium-assets',

    configResolved(resolved) {
      config = resolved;
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url;
        if (url === undefined) return next();

        const prefix = `/${cesiumBaseUrl}/`;
        const index = url.indexOf(prefix);
        if (index === -1) return next();

        const relative = decodeURIComponent(url.slice(index + prefix.length).split('?')[0] ?? '');
        // Contain the path inside the Cesium tree; never let '..' escape it.
        const target = resolve(cesiumSource, normalize(relative));
        if (!target.startsWith(cesiumSource + sep)) {
          res.statusCode = 403;
          return res.end('Forbidden');
        }

        try {
          const info = await stat(target);
          if (!info.isFile()) return next();
          res.setHeader('Content-Type', contentTypeFor(target));
          res.setHeader('Content-Length', info.size);
          createReadStream(target).pipe(res);
        } catch {
          next();
        }
      });
    },

    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      await Promise.all(
        CESIUM_ASSET_DIRS.map((dir) =>
          cp(join(cesiumSource, dir), join(outDir, cesiumBaseUrl, dir), { recursive: true }),
        ),
      );
    },
  };
}

export default defineConfig({
  base,
  define: {
    // Base-aware so it resolves under a GitHub Pages subpath too.
    CESIUM_BASE_URL: JSON.stringify(`${base}${cesiumBaseUrl}/`),
  },
  plugins: [cesiumAssets()],
  optimizeDeps: {
    // Cesium is a large CJS-interop bundle; pre-bundling keeps dev reloads fast.
    include: ['cesium'],
  },
  build: {
    target: 'es2022',
    // Cesium, Three and the splat renderer are individually large by nature.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Rollup 5 accepts only the function form of manualChunks.
        manualChunks(id: string) {
          // The `cesium` package is a thin re-export shell: the actual modules
          // resolve under @cesium/engine and @cesium/widgets, so matching only
          // 'node_modules/cesium' silently misses all ~1100 of them.
          if (id.includes('node_modules/@cesium/') || id.includes('node_modules/cesium/')) {
            return 'cesium';
          }
          if (id.includes('node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: {
    host: true, // expose on the LAN so the viewport can be tested from a phone
    port: 5173,
  },
});
