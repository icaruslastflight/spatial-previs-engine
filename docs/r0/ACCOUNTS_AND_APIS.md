# Accounts and APIs

Updated: 17 September 2026. Core R0 editing, saves, undo, checks and evidence tools
require **no paid API and no model connection**. No new purchase is required.

| Item | Setup | Verification |
| --- | --- | --- |
| GitHub | Existing repository access and Git Credential Manager/CLI sign-in on the development PC. No tokens in source. | Fetch the R0 review branch; run `git status`. |
| Node.js / npm / Git | Install the repository-compatible toolchain. These are software, not API accounts. | Check versions, then `npm ci`. |
| AirGPU | Use the existing rental; check credit before lengthy builds. | Online; Windows commands and Chrome browser acceptance executed. |
| Epic Games / UE | Epic launcher installed and user signed in. UE5.8.2 files are downloaded; PC restart in progress. No Epic API key is required. | After reboot, verify installation and build `native/SpatialPrevis/SpatialPrevis.uproject`. |
| Visual Studio | Visual Studio Community 2026 and C++ workload are installed. | MSVC compiled and passed 358 coordinate assertions. Full Unreal build still pending. |
| Remote Desktop Commander | Start the paired agent on the remote PC and keep it running during development. | Online device plus successful Windows preflight. |
| Codex | Existing ChatGPT sign-in for the CLI. | Run the CLI on the PC. The R0 app needs no model API key. |
| Shadow PC | New cloud Windows workstation, provisioning as of 18 September 2026. Setup runbook: [`docs/DESKTOP_DEV_SETUP.md`](../DESKTOP_DEV_SETUP.md). Note: an earlier evaluation in this document excluded Shadow as a provider, but that was against a hard $30 one-time pilot ceiling for a short R0 rental — a different constraint than this standing dev box. | Pending first login (Phase 0 of the runbook: record actual OS/GPU/RAM, since the prior remote box's actual hardware differed from its quote). |

## Optional integrations

| Integration | Configuration | When needed |
| --- | --- | --- |
| Google 3D Tiles | `.env.local`: `VITE_GOOGLE_MAPS_API_KEY` | Optional legacy basemap; review provider setup/billing before enabling. |
| Cesium ion | `.env.local`: `VITE_CESIUM_ION_TOKEN` | Optional terrain/hosted assets; restrict scope. |
| GDTF Share | Process environment: `GDTF_SHARE_USER`, `GDTF_SHARE_PASSWORD` | Authenticated fixture download script only. Core catalog/tests work without it. |
| Ollama (local LLM) | `winget install Ollama.Ollama` on the dev workstation; no account/API key. OpenAI-compatible API at `localhost:11434`. | Local model inference on a workstation with enough GPU/VRAM. See `docs/DESKTOP_DEV_SETUP.md` Phase 8 for model sizing. Not required for any web-app or native-build workflow. |
| Anthropic API (metaprompt tool) | Process environment: `ANTHROPIC_API_KEY`, set via `setx` on the workstation (not a project file). Credential stored in NordPass, per Password handling below. | `scripts/ai-tools/metaprompt.py` only — drafting/testing prompt templates. Nothing else in the repo calls the Anthropic API or requires this key. |
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

## Password handling

Unlock NordPass directly on the workstation when autofill is needed. Do not store its
master password in project environment files. Administrative setup is authorized by
the owner; Windows may still present its own elevation prompt. No private credentials
are required by the local native record inspector or the web R0 workspace.

Record new services only when implemented features introduce them, including purpose,
permissions, cost implications, credential location and an actual verification result.
