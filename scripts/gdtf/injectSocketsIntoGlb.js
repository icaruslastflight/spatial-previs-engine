/**
 * Read a GLB extracted from a `.gdtf` archive, write `extras.sockets` (plus
 * any additional extras) onto every root-level node, and return the
 * re-serialized bytes. Mirrors `scripts/build-asset-library.js`'s own
 * `root.setExtras({ sockets, ... })` pattern, so a GDTF-derived asset and a
 * procedural one embed the socket contract identically.
 *
 * Lives under `scripts/`, not `src/engine/`, and stays plain JS rather than
 * TypeScript, deliberately: gltf-transform's `NodeIO` depends on `node:fs`/
 * `node:path` and has no browser build. `src/engine/GDTFParser.ts` is part of
 * the browser bundle's import graph (via `GDTFAssetResolver.ts` -> `main.ts`),
 * and Vite's tree-shaking did NOT eliminate `NodeIO` when this lived there --
 * it built successfully but silently pulled `node:fs`/`node:path` into the
 * client bundle. Keeping every gltf-transform NodeIO consumer under
 * `scripts/`, alongside `build-asset-library.js`, makes "never reachable from
 * the browser bundle" a property of the directory, not something a future
 * import has to remember.
 *
 * `sockets` is a plain array of the same JSON-shaped socket objects
 * `SocketDefinition` (src/engine/SocketSnappingEngine.ts) and this repo's own
 * `scripts/assetlib/sockets.js` `socket()` helper both already produce --
 * there is no TypeScript type to import here, only the shape both sides
 * already agree on.
 */

import { NodeIO } from '@gltf-transform/core';

export async function injectSocketsIntoGlb(glbBytes, sockets, extras = {}) {
  const io = new NodeIO();
  const doc = await io.readBinary(glbBytes);
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      const existing = node.getExtras() ?? {};
      node.setExtras({ ...existing, ...extras, sockets });
    }
  }
  return io.writeBinary(doc);
}
