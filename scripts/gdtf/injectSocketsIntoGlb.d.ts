/**
 * Hand-written type declaration for the plain-JS module of the same name.
 *
 * The implementation stays JS (see injectSocketsIntoGlb.js's own header for
 * why -- gltf-transform's NodeIO must never be reachable from the browser
 * bundle), but its one test lives in src/engine/GDTFParser.test.ts under
 * strict TypeScript, which needs a declaration to import it without
 * `noImplicitAny` rejecting the module.
 */
export function injectSocketsIntoGlb(
  glbBytes: Uint8Array,
  sockets: readonly unknown[],
  extras?: Record<string, unknown>,
): Promise<Uint8Array>;
