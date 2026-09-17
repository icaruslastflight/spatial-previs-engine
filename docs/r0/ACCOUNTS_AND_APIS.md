# Accounts and APIs

Updated: 17 September 2026. Core R0 editing, saves, undo, checks and evidence tools
require **no paid API and no model connection**. No new purchase is required.

| Item | Setup | Verification |
| --- | --- | --- |
| GitHub | Existing repository access and Git Credential Manager/CLI sign-in on the development PC. No tokens in source. | Fetch the R0 review branch; run `git status`. |
| Node.js / npm / Git | Install the repository-compatible toolchain. These are software, not API accounts. | Check versions, then `npm ci`. |
| AirGPU | Use the existing rental; check credit before lengthy builds. | Windows desktop reachable and remote agent online. Current connector status: offline. |
| Epic Games / UE | Existing Epic sign-in and reported UE 5.8 installation. No Epic API key is required by this web editor. | Open and build the actual native project; not yet executed. |
| Visual Studio | Use the compiler/workloads supported by the actual UE project. | Record compiler version and a successful native build. |
| Remote Desktop Commander | Start the paired agent on the remote PC and keep it running during development. | Online device plus successful Windows preflight. |
| Codex | Existing ChatGPT sign-in for the CLI. | Run the CLI on the PC. The R0 app needs no model API key. |

## Optional integrations

| Integration | Configuration | When needed |
| --- | --- | --- |
| Google 3D Tiles | `.env.local`: `VITE_GOOGLE_MAPS_API_KEY` | Optional legacy basemap; review provider setup/billing before enabling. |
| Cesium ion | `.env.local`: `VITE_CESIUM_ION_TOKEN` | Optional terrain/hosted assets; restrict scope. |
| GDTF Share | Process environment: `GDTF_SHARE_USER`, `GDTF_SHARE_PASSWORD` | Authenticated fixture download script only. Core catalog/tests work without it. |
| In-product model provider | None configured | Scene tools are local read-only functions; no provider is contacted. |
| Specialist review authority | Not configured | Local edits/unlocks only. Imported metadata never grants review/issue rights. |
| Hosting | Not needed locally | Use HTTPS for a phone accessing a remote build. Publication is separate. |

Browser `VITE_` variables are public bundle values. Never put private provider/admin
credentials in them. `.env.example` contains placeholders only.

## First-run sequence

1. Confirm the PC and remote agent are online.
2. Fetch the review branch; run `npm ci`, `npm run build`, and `npm test`.
3. Run `npx playwright install chromium` and `npm run test:r0:browser`.
4. Run `npm run dev`; open `http://localhost:5173/r0.html` on that PC.
5. Place, edit, undo, save and reopen. Keep an exported JSON backup.
6. Open the real native project and execute `UE5_CONFORMANCE.md` before marking parity complete.

Record new services only when implemented features introduce them, including purpose,
permissions, cost implications, credential location and an actual verification result.
