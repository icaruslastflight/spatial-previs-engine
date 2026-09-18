# Lighting and interacting with Gaussian splat venue captures

Research memo, 18 September 2026. Status: **Phase 0 spike run; naive depth-pass
approach found broken, real cause identified, fix deferred to Phase 1** (§10,
Phase 0 results below). Nothing in this memo changes product behaviour; it
records findings and a phased plan under CLAUDE.md §13.

Question, as the owner put it: *can splats be lit and interacted with?*

**Short answer.** Yes, for previz purposes, but not by relighting the splats
themselves. The workable route is: give the splat a depth buffer, give it a
proxy mesh for shadows and occlusion, and apply fixture light as a screen-space
pass over the splat image. The web half of that is small and partly written
already. The native half is blocked on the anchor-height port and on a plugin
evaluation that only a hand-verified Windows build can settle.

Every fact below is labelled: **repo** (read from this checkout or `origin/main`),
**library** (read from the installed `@mkkellogg/gaussian-splats-3d` 0.4.7
build), **web** (sources listed at the end), or **general** (published rendering
technique).

---

## 1. Scope and assumptions

- Web stack: `three` 0.186, `@mkkellogg/gaussian-splats-3d` 0.4.7 on WebGL,
  `cesium` 1.145. The show layer stays on WebGL because Cesium is WebGL-only
  (repo, `src/main.ts`).
- `src/assets/SplatSceneLoader.ts` is the live path from `main.ts`. It hands the
  library `Viewer` the whole Three scene and lets it own the draw call (repo).
- `src/components/SplatViewport.ts` holds a screen-space-normal-from-depth shader,
  beam clipping planes, an additive cone beam and frustum culling, but **is not
  imported by `main.ts`**. Its `tDepth` uniform has no producer (repo).
- `src/render/` is empty by design until Phase 6; `src/shaders/volumetric_beam.wgsl`
  samples a depth texture and is not wired (repo).
- `public/assets/scans/manifest.json` registers `point_state_park_clean.splat` at
  184.963 m; the binary is git-ignored and does not exist. No real capture has ever
  gone through the loader (repo, loader header comment).
- Native (`native/SpatialPrevis`) is CORE-01 only: codec, record inspector,
  coordinate adapter, conformance commandlet. No scene actors, no georeferencing
  code, no render configuration. The UE build has never been recorded as passing
  (repo, `docs/r0/UE5_CONFORMANCE.md`).
- `origin/main` passes 742 tests in 23 files (run 18 September 2026 in a
  throwaway worktree).
- No real capture exists. Phase 0 uses the pipeline's synthesized scene.

## 2. Primer: what a Gaussian splat is and is not

(general) A splat scene is a set of anisotropic Gaussians with position,
covariance, opacity and spherical-harmonic colour, rasterized as sorted,
alpha-blended 2D ellipses. Radiance is baked at capture time, there is no surface
normal, and there is no first-class depth. Every solution below manufactures one
of those missing quantities.

(library) One fact sharpens this for our stack: the vertex shader builds each
splat quad as `vec4(ndcCenter.xy + ndcOffset, ndcCenter.z, 1.0)`, so the hardware
depth of every fragment is already the depth of that splat's centre. The depth
exists per fragment; the material simply never writes it.

## 3. Interaction problems, one at a time

### (a) Depth and mutual occlusion

(library) Both splat materials are `transparent`, `depthTest: true`,
`depthWrite: false`, normal blending. `Viewer.render()` draws the Three scene
first, then the splat mesh with `autoClear` off. Consequences: opaque meshes
occlude splats correctly; nothing is ever occluded *by* a splat in a later pass;
transparent beam cones drawn in the Three scene are painted over by splats
regardless of depth.

**Own method, decided:** a depth-only toggle on the library's own splat material.
Add one uniform, patch the fragment shader to `discard` when opacity is below 0.5
in depth-only mode, and draw the splat mesh twice per frame: once with colour
writes off and depth writes on before the opaque scene, once as today. For a
depth-only pass with the default less-than-or-equal depth test, sort order is
irrelevant, so the second draw reuses the same sorted buffers.

```
float opacity = exp(-0.5 * A) * vColor.a;
if (uDepthOnly == 1 && opacity < 0.5) discard;   // front-most "solid" splat wins the depth test
```

Cost: one extra vertex-bound draw of the splat mesh and roughly thirty lines.
The material is reachable through `viewer.getSplatMesh().material`, but only
after every `addSplatScene` has resolved, because `SplatMesh.build` reassigns the
material (library).

### (b) Receiving light and shadow

Deferred post-lighting over the splat image using the existing
`SCREEN_SPACE_NORMAL_SHADER`, which becomes live the moment (a) produces depth.
Fixture cone, N·L, falloff and gobo per fixture, batched into one full-screen
pass (general).

### (c) Casting shadow and occluding beams

Proxy mesh only. A depth-only, invisible, decimated mesh from the capture is the
shadow caster; rendering light-view splat depth per fixture does not scale to a
rig. The beam clipping planes in `SplatViewport.ts` already cut at throw distance;
the depth from (a) makes the remainder occlude correctly.

### (d) Volumetric media

`volumetric_beam.wgsl` samples a depth texture. The merged depth from (a) plus
the proxy is what it reads when the Phase 6 render layer lands. No consumer yet.

### (e) Relighting baked radiance

Decided: previz shading is `splat colour × (ambient % + Σ fixture terms)` with
proxy shadows. Research relightable-splat variants exist (web: DeferredGS, BiGS,
image-based relighting for virtual production) but need a training pipeline and
are not a $0 fit today. Capture under flat light (overcast or dusk) to minimise
baked shadows; that is a workflow rule, not code.

## 4. Web path (`src/`)

- Consolidate `SplatSceneLoader.ts` and `SplatViewport.ts` into one path first;
  they construct the viewer twice with duplicated options (repo).
- Depth pass as in 3(a).
- Render order after the change: splat depth-only → opaque meshes and proxy →
  splat colour → transparent beams. The library's `render()` hard-codes
  scene-then-splats, so the composite moves into our frame tick in
  `TICK_PRIORITY.RENDER` and renders the splat mesh directly.
- Fixture pass: one full-screen `ShaderMaterial` reading colour, depth,
  reconstructed normals and a per-fixture uniform array; shadow lookup from
  Three's spot shadow maps on the proxy.
- Phone budget: DPR cap 2, no shared memory, one capture at a time, fixtures
  batched into a single pass.
- Manifest wobble to fix on the way: the scans README example writes `height_m`;
  the manifest and loader use `height` (repo).

## 5. UE5 5.8.2 path (`native/`)

Everything here is hand-verified on the Windows workstation per
`docs/r0/UE5_CONFORMANCE.md`. None of it is CI.

- **First-party support:** the UE 5.8 release notes fetched on 18 September 2026
  did not mention Gaussian splatting, and an April 2026 industry write-up said
  there was no shipping first-party module in 5.7 (web). Treat 5.8.2 as having
  none.
- **Decision, plugin route before own method:**
  1. Proxy mesh first. Import the same decimated GLB as a static mesh through the
     coordinate adapter. Lit, shadowed, occluding venue geometry with zero custom
     rendering; this is the desktop-authoritative occlusion CLAUDE.md §1.1 promises.
  2. Splat appearance, candidate A: MLSLabsRenderer-Lite. Apache-2.0, source
     included, custom render pipeline, Windows DX12, NVIDIA Turing or newer,
     documented for 5.5 through 5.7, 5.8 unconfirmed; lighting and self-shadowing
     are on the paid Pro roadmap only (web).
  3. Candidate B: NanoGS. Free binaries, source promised, 5.6 and later,
     Nanite-style LOD clusters and GPU radix sort, described as a proof of
     concept; depth and lighting integration undocumented (web).
  4. Own method: deferred until both candidates have been built against 5.8.2
     by hand. If neither writes scene depth, the web depth-only pass becomes the
     specification for a native scene proxy.

## 6. Parity and conformance

**Capability split.** Web: splat appearance, depth pass, proxy shadows,
screen-space fixture pools. Desktop: proxy-based occlusion and engine shadows and
fog, splat appearance if a plugin proves out. Web shows **Continue on desktop**
for anything it cannot render. Basemap-versus-show-layer occlusion stays
impossible on web (repo, `src/geo/CesiumGlobe.ts`).

**Registry shape, decided.** The scans manifest stays the asset registry and
holds what is intrinsic to the file: url, format, proxy url, source anchor. The
project record references a scan by id and owns what the operator authored:
anchor override, `enu_offset_m`, rotation. Operator decisions land inside the
codec and the R0 conformance corpus; binaries and their metadata stay outside it.
Adding the proxy field bumps the manifest schema version with an explicit
migration per §1.1.

**Native georeferencing placement, decided.** It lands in `SpatialPrevisCore`
beside the existing coordinate adapter, as the anchor constant mirrored verbatim
from `GeoAnchor.ts`, with a corpus case that round-trips the CP-1 fountain-apex
landmark. It is written before any scene actor.

**Anchor-height caveat (CLAUDE.md §1.1, §2).** The web anchor is 184.963 m
ellipsoidal and is the source of truth. Native has not taken it, so the platforms
sit 1.637 m apart vertically until it is ported. In this checkout there is no
native georeferencing at all, so this is a build-it-right task. If native were
built to the old figure: the scanned ground lands flush with the deck on one
platform and buries the deck 1.6 m deep on the other; beams terminate on
different surfaces; proxy shadows fall in different places; and the error is 11
times the 0.15 m snap threshold, so ground-snapped assets fail to snap across
platforms.

**Hand-verification list:** fountain-apex landmark at the same local coordinate
as the web self-test; splat and proxy sharing one alignment; metre-to-centimetre
and axis mapping applied to the proxy transform; evidence folder with commit, UE
version and GPU.

## 7. Lighting-domain impact

On `origin/main` (repo): `src/engine/FixtureAiming.ts` is a closed-form inverse
pan/tilt solve from the GDTF kinematic chain; `DmxPatch.ts` is a 1-based DMX512
patch allocator; `Phaser.ts` is a grandMA3-style phaser with BPM speed, 0 to 360
degree phase spread, transition fraction, and pan mirroring with symmetric-pair
ranking so stage-left and stage-right move together.

- DMX patch, phaser, cue values: untouched. Splats receive and occlude; they do
  not change addressing, chase timing or values.
- Aiming solver: untouched if the target is a local-frame point. If a target ever
  sits on scanned ground, the 1.637 m divergence becomes tilt error:

  | Throw | Tilt error |
  | --- | --- |
  | 10 m | 9.3° |
  | 20 m | 4.7° |
  | 40 m | 2.3° |

- Pan mirroring and symmetric pairs: untouched.
- Beam rendering: the additive cone in `SplatViewport.ts` is dormant and is what
  the depth pass fixes.

## 8. Risks and unknowns

- **Performance:** a second splat draw per frame; profiled on a phone in Phase 0.
- **Memory:** hundreds of megabytes for a park-scale capture; the one-scene rule
  stands.
- **Training and capture (decided):** the Shadow PC is the training box: NVIDIA
  RTX A4500 20 GB, AMD EPYC 7543P, 30 GB RAM, driver 565.90, Python 3.11, no
  PyTorch installed (measured 18 September 2026). Train with Brush first
  (Apache-2.0, cross-platform, no CUDA toolchain), gsplat second (Apache-2.0,
  needs PyTorch and CUDA) (web). Postshot's free tier is non-commercial and
  watermarked, so it is out. RealityScan may supply alignment for metric scale;
  confirm its licence before commercial use.
- **Licensing:** the library is MIT (library). The Inria reference code is
  non-commercial (general). MLSLabs Lite is Apache-2.0; NanoGS's licence is
  unstated beyond "free" (web).
- **Native unknowns:** 5.8.2 compatibility of either plugin, their depth
  behaviour, and the still-unrecorded native build.
- **Capture rights and privacy:** permission at the park and transient stripping
  apply when a real capture is made.

## 9. Confidence

| Claim or decision | Reasoning | Confidence |
| --- | --- | --- |
| Library never writes depth; scene drawn before splats | Read from the 0.4.7 build | Established |
| Fragment depth already equals splat-centre depth | Vertex shader sets quad z to `ndcCenter.z` | Established |
| Depth-only toggle yields a usable depth buffer | Standard alpha-threshold trick; Phase 0 tests it | Likely |
| Proxy mesh is the only shadow caster that scales to a rig | Cost reasoning | Likely |
| Ambient-plus-additive shading is enough for previz | Owner delegated; judgement call | Speculative |
| UE 5.8.2 has no first-party splat support | Release notes and April 2026 report | Likely |
| MLSLabs Lite builds on 5.8.2 | Documented to 5.7 only | Speculative |
| 1.637 m divergence corrupts registration | Arithmetic on documented figures | Established |
| origin/main passes 742 tests | Run 18 September 2026 | Established |
| Brush and gsplat are Apache-2.0 | Web sources | Likely |

## 10. Phased plan (CLAUDE.md §13)

Implementer starts from `origin/main`, loads `.claude/skills/phased-plan`, and
gates on `npm test` and `npm run build`. Default tier throughout; Phase 1's
composite reorder may warrant the deep-reasoning tier if the library's frame
ownership fights back. Each phase ends with an owner sign-off gate; none is
skipped.

| Phase | Objective | Deliverable | Verification | Gate |
| --- | --- | --- | --- | --- |
| 0 | Prove or disprove the depth-only toggle on a synthesized capture | **Done.** `showcase/splat-occlusion.html` with before/after/depth modes; finding above: the naive external-composite approach doesn't render splats at all (uniform-priming gap), root cause traced to `SplatMesh.updateUniforms()`, no production code touched | Interactive captures in this session; `before` saved to `showcase/splat-occlusion-before.png` | **Owner reviews this finding and approves proceeding to Phase 1 with the revised approach (monkey-patch `Viewer.prototype.render`), or redirects** |
| 1 | One merged depth buffer on the web, fixing the Phase 0 uniform gap | Loader and viewport consolidated; depth pass implemented by patching `Viewer.prototype.render` (not by driving `renderer.render(mesh, camera)` externally); composite reorder; manifest `height` fix; README and CLAUDE.md synced | Showcase re-captured with a visible splat layer in all three modes; manifest parser test; suite and build green | Screenshots and manifest contract approved |
| 2 | Proxy mesh through the pipeline | Pipeline emits a decimated proxy GLB; manifest schema v2 with migration; web loads it depth-only with shadows | Showcase with proxy shadows; pipeline self-test extended | Schema bump approved |
| 3 | Fixture pools on the web | Batched deferred fixture pass in `TICK_PRIORITY.RENDER` | Showcase with GDTF fixtures at solved pan/tilt, reviewed on a phone | Look accepted or routed to flat-light capture |
| 4 | Native anchor port (precondition for all native scan work) | Anchor constant in `SpatialPrevisCore`; landmark corpus case; §1.1 note deleted | `scripts/verify-r0-native.ps1` by hand; evidence in `test-results/native/` | Evidence folder reviewed |
| 5 | Native proxy and plugin evaluation | Proxy import through the adapter; MLSLabs Lite and NanoGS built on 5.8.2 by hand with findings; Continue on desktop wired; `PLATFORM_CAPABILITIES.md` updated | Hand-verified alignment against web self-test | Plugin picked or own method authorised |
| 6 | First real capture | Phone video walk under flat light, trained with Brush on the Shadow PC, cleaned and georeferenced through §8, registered with proxy | CP-1 landmark check | Capture and its rights approved |
| 7 | Volumetrics against merged depth | Phase 6 render layer consumes the Phase 1 depth | Starts only after that layer exists | Owner sign-off |

## 11. Owner inputs still required

Only two, at their phases: the capture and its permission at the park (Phase 6),
and the look-and-feel verdicts at the Phase 0 and Phase 3 gates.

---

## Phase 0 results

**Run 18 September 2026.** Built `showcase/splat-occlusion.html` /
`.ts`: the synthesized park capture (178,500 splats,
`python scripts/cleanup_splat.py --synthesize public/assets/scans/point_state_park/synthetic_raw.splat`,
5.7 MB, not committed), loaded through the real
`@mkkellogg/gaussian-splats-3d` `Viewer`, with three beam cones from
`SplatViewport.createBeamMesh` positioned in front of, behind, and through a
synthesized pavilion wall, and two truss sticks. Three modes: `before` (the
library's own `Viewer.render()`, unmodified), `after` (the depth-only toggle
from §3(a) of this memo), `depth` (the depth-only pass alone, visualised).

**Outcome: the naive implementation of the depth-only toggle does not work.**
`before` mode renders correctly — full ground, canopy, pavilion, all visible,
confirming the capture, loader, and viewer integration are sound end to end.
`after` and `depth` mode render the beam cones and truss sticks (proving those
draw calls run) but **no splats at all** — the splat layer is entirely absent,
not just occluded wrong.

**Root cause, traced to source, not guessed:** the splat vertex shader scales
each splat's screen-space quad by a `basisViewport` uniform
(`ndcOffset = ... * basisViewport * 2.0 * ...`). In every custom render
sequence tested — calling `Viewer.update()` every frame (as the product's own
`SplatSceneLoader`/`SplatViewport` do), then calling `Viewer.render()` once
directly, then calling `Viewer.updateForRendererSizeChanges()` directly — the
live splat mesh material's `viewport`, `basisViewport` and `focal` uniforms
all stayed `[0, 0]`. A zeroed `basisViewport` collapses every splat quad to a
single point, which is indistinguishable from "no splats" in a rasterizer.
Reading the library source (`node_modules/@mkkellogg/gaussian-splats-3d`,
0.4.7, MIT) confirms these uniforms are meant to be set by
`SplatMesh.updateUniforms()`, called from `Viewer.prototype.updateSplatMesh()`,
called from `Viewer.prototype.update(renderer, camera)` — the very method
called every frame here. Why the values did not stick in this custom
compositing sequence was not isolated within the Phase 0 budget; candidates
include a material/mesh rebuild replacing the patched reference, or an
undocumented dependency between `update()` and the library's own `render()`
closure. This is deferred to Phase 1, not resolved here — consistent with
Phase 0 being a cheap, abandonable spike rather than an implementation phase.

**What this changes for Phase 1:** driving `renderer.render(mesh, camera)`
directly, outside the library's own `Viewer.render()`, is not a safe
composition point — this spike proves it concretely rather than assuming it.
The more promising route for Phase 1 is monkey-patching
`Viewer.prototype.render` itself (the one place these uniforms are confirmed
valid) to inject the depth-only pre-pass immediately before the library's own
colour draw, rather than reimplementing the update/render sequence externally.
That keeps the same one-uniform, thirty-line shader patch from §3(a); only the
call site changes.

**What this does not change:** the underlying premise survives. The vertex
shader genuinely does carry usable per-splat depth (`ndcCenter.z`, constant
across each quad, confirmed by reading the source), the library is MIT
licensed and its fragment shader is patchable, and `before` mode proves the
whole load/render pipeline works. The obstacle found is a call-sequencing
integration detail, not a dead end.

**Environment note, unrelated to the finding above:** headless Playwright
capture (`scripts/capture_showcase.mjs`) was unreliable on this workstation for
this page, intermittently hitting `WEBGL_lose_context` under the sandboxed
SwiftShader software renderer, independent of viewport size or device-pixel
ratio. The interactive Browser pane did not show this. The `before` screenshot
was captured headlessly and saved to
`showcase/splat-occlusion-before.png`; the `after`/`depth` results above were
confirmed and screenshotted interactively but are not saved as files, since
headless capture of them was not reliable this session. Re-run
`showcase:capture` once Phase 1's fix lands, when there will be an actual
splat layer worth a saved screenshot.

---

## Sources (web)

- UE 5.8 release notes: https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes
- StraySpark, UE5 splat pipeline 2026: https://www.strayspark.studio/blog/gaussian-splatting-unreal-engine-5-capture-to-game-pipeline
- MLSLabs renderer for UE: https://github.com/mlslabs/MLSLabsGaussianSplattingRenderer-UE
- NanoGS on CG Channel: https://www.cgchannel.com/2026/03/free-plugin-nanogs-puts-nanite-style-gaussian-splatting-in-unreal-engine/
- DeferredGS: https://www.researchgate.net/publication/390774244_DeferredGS_Decoupled_and_Relightable_Gaussian_Splatting_with_Deferred_Shading
- Relightable splats for virtual production: https://arxiv.org/pdf/2605.09024
- Postshot pricing: https://radiancefields.com/platforms/postshot
- gsplat licence: https://github.com/nerfstudio-project/gsplat/blob/main/LICENSE
- Brush: https://github.com/ArthurBrussee/brush
