# Desktop development environment setup

A phased runbook for bringing up a full-stack development environment for
spatial-previs-engine on a new Windows workstation — the web/TS client, the
native UE5 component, local open-weight LLM inference, and the project's
customized prompt-engineering tool. Written for a cloud PC (Shadow PC) but
applies to any fresh Windows box.

This is phase-agnostic infrastructure — it outlives any single feature phase
(R0, alpha, etc.), which is why it lives here rather than under `docs/r0/`.
Account/credential rows for anything set up below go into the existing
[`docs/r0/ACCOUNTS_AND_APIS.md`](r0/ACCOUNTS_AND_APIS.md), which stays the
single source of truth CLAUDE.md §1 already points at.

Every command below was checked against what's actually in this repo
(`package.json`, `tsconfig.json`, `vite.config.ts`, the `.uproject`, the
PowerShell verify scripts, CI workflow files, `.gitignore`) rather than
assumed — not a generic "how to set up a game dev box" guide.

**One flagged discrepancy, not a blocker:** `docs/r0/ACCOUNTS_AND_APIS.md` /
`docs/r0/REMOTE_UE5_WORKSTATION.md` previously excluded Shadow as a cloud PC
provider — but that evaluation was against a hard **$30 one-time pilot
ceiling** for a short-lived R0 rental, a different constraint than a standing
development box. Worth noting so the record doesn't look inconsistent; not a
reason to reconsider the choice.

Each phase follows this project's own §13 planning convention: what it does,
and how you know it worked.

**Fast path:** [`scripts/workflows/bootstrap_dev_workstation.ps1`](../scripts/workflows/bootstrap_dev_workstation.ps1)
automates Phases 1, 3, 4, 5, 6, 8 and 9 end to end (every command below is
copied into it verbatim, not re-derived), and reports Phase 0's host info
into a JSON evidence file instead of you reading `dxdiag` output by hand.
Run it with `-WhatIf` first to preview every mutating step. It deliberately
leaves Phase 2 (interactive account auth), Phase 7 (multi-GB interactive
installers with real choices to make) and Phase 11 (verification, not
provisioning) as manual steps — the phases below remain the reference for
what each of those actually does and why. It also adds two things not in the
prose runbook: an optional `-InstallContinueExtension` switch that wires the
pulled Ollama model into VS Code via the Continue.dev extension, so the
local model is something you actually use for in-editor assistance rather
than a process idling behind `ollama run`; and an optional
`-CreateDesktopShortcut` switch (see also Phase 5 below) that puts a real
Windows Desktop icon on `launch-desktop.cmd`, via
[`scripts/create-desktop-shortcut.ps1`](../scripts/create-desktop-shortcut.ps1)
— idempotent, safe to re-run.

```powershell
.\scripts\workflows\bootstrap_dev_workstation.ps1 -WhatIf
.\scripts\workflows\bootstrap_dev_workstation.ps1 -OllamaModel qwen2.5-coder:14b -InstallContinueExtension -CreateDesktopShortcut
```

---

## Phase 0 — Baseline identification

Do this first, before installing anything. A previous cloud box on this
project actually provisioned different hardware than its quote (AMD instead
of the quoted NVIDIA GPU) — confirm what you actually got rather than
planning around the sales page.

```powershell
dxdiag                                                  # GPU, driver, DirectX level
wmic path win32_VideoController get name,AdapterRAM     # GPU model + VRAM
systeminfo                                              # OS build, CPU, RAM
nvidia-smi                                              # if NVIDIA — VRAM, driver, CUDA version
```

**Record:** OS build, GPU model + VRAM, CPU, RAM, free disk. The GPU vendor
specifically changes Phase 8 below (Ollama's Windows GPU acceleration is
CUDA-first).

---

## Phase 1 — Base Windows tooling

```powershell
winget install Git.Git
winget install 7zip.7zip
winget install Microsoft.VisualStudioCode
```

**Verify:** `git --version` and `code --version` resolve in a fresh shell.

---

## Phase 2 — Remote pairing (Desktop Commander)

Lets an AI coding session (this one, or a future one) drive files and builds
on the box directly, the same way it already worked on this project's
previous remote box. Run after Node is installed (Phase 3 — this is an `npx`
package):

```powershell
npx.cmd -y @wonderwhy-er/desktop-commander@latest remote
```

The first run may prompt for one-time account authentication in the console.
Install it as a Startup-folder shortcut (standard user) by default — that's
the verified default on this project's other remote box; the elevated Task
Scheduler variant is available later if you specifically need commands to
inherit administrator rights, but don't default to it.

This only gives file/terminal control, not a screen stream — Shadow PC's own
native client is the interactive-screen path; nothing extra is needed for
that.

**Verify:** the device shows up as online in the paired session's device
list; a trivial round-trip command executes and returns output.

---

## Phase 3 — Node.js toolchain

Use **nvm-windows**, not a floating "LTS" winget package. This repo's CI
(`.github/workflows/ci.yml`, `deploy.yml`) pins exactly **Node 22** via
`actions/setup-node@v7`; a floating LTS package would silently drift to
whatever's newest and break parity with CI.

```powershell
# https://github.com/coreybutler/nvm-windows/releases -> nvm-setup.exe
nvm install 22.20.0
nvm use 22.20.0
```

**Verify:** `node -v` → `v22.x`, `npm -v` resolves.

---

## Phase 4 — Python toolchain

Python **3.11**, matching CI's `actions/setup-python@v7` pin (the repo's own
`scripts/memory/requirements.txt` only needs 3.10+, but match CI exactly for
parity).

```powershell
winget install Python.Python.3.11
python -m pip install -r scripts\memory\requirements.txt
```

**Verify:** `python --version` → 3.11.x; `python scripts\memory\ingest.py`
completes (~30s on this repo) and populates `.memory\chroma\` +
`.memory\graph.pickle`. (First run also silently downloads the ~80 MB ONNX
embedder into `%USERPROFILE%\.cache\chroma\`.)

---

## Phase 5 — Repo clone, ffmpeg, Playwright, web verify

```powershell
winget install Gyan.FFmpeg
git clone <repo-url> C:\Users\user\Documents\SpatialPrevisEngine
cd C:\Users\user\Documents\SpatialPrevisEngine
npm ci
npx playwright install chromium
npm run build
npm test
npm run verify
```

**Verify:** all of the above exit 0. Also run `scripts\verify-r0-windows.ps1`
— it separately checks `node --version` and the UE5.8 editor path, bridging
into Phase 7 below.

Optionally, put a Desktop icon on the launcher menu (Production Workspace,
Development Dashboard, UE5 Editor) instead of finding `launch-desktop.cmd`
inside the clone every time:

```powershell
.\scripts\create-desktop-shortcut.ps1
```

**Verify:** a `Spatial Previs Desktop Launcher.lnk` appears on the Desktop
and double-clicking it opens the same menu `launch-desktop.cmd` does when
run directly.

---

## Phase 6 — Editor: VS Code, skip Rider

The native surface here is genuinely small and stock — `SpatialPrevis.uproject`
declares exactly two modules (`SpatialPrevisCore`, `SpatialPrevisEditor`)
built entirely on stock UE5 modules (Core, CoreUObject, Engine, Json,
UnrealEd, Slate, SlateCore, InputCore, ToolMenus, DesktopPlatform) — no
third-party engine plugins, no Blueprint-heavy iteration loop. The actual
build/verify path (`scripts\verify-r0-native.ps1`) is fully CLI-driven via
`Build.bat` and headless commandlets, not interactive Play-In-Editor
debugging. That's exactly the case where Rider for Unreal's strengths (deep
Blueprint integration, huge-codebase UE indexing) aren't the bottleneck,
while it's a paid product VS Code isn't.

```powershell
code --install-extension ms-vscode.cpptools
```

Visual Studio (Phase 7) remains available for interactive native debugging
if that's ever actually needed — nothing is lost by skipping Rider now.
Revisit only if native work grows into heavy engine-plugin authoring beyond
this repo's current stock-module scope.

**Verify:** VS Code resolves `tsconfig.json` (`es2023`, strict) cleanly;
cpptools gives working IntelliSense on `native/SpatialPrevis/Source/**/*.cpp`.

---

## Phase 7 — UE5.8 + Visual Studio (native toolchain)

Mirrors the exact configuration `docs/r0/VERIFICATION.md` and
`docs/r0/REMOTE_UE5_WORKSTATION.md` record as an actual successful build on
this project's other remote box — not a generic recommendation.

| Component | Pin | Install |
|---|---|---|
| Epic Games Launcher | current | `winget install EpicGames.EpicGamesLauncher` |
| Unreal Engine | **5.8.2**, binary install (no source build — stock modules only need it) | Epic Launcher → Library → 5.8 → default path `C:\Program Files\Epic Games\UE_5.8` |
| Visual Studio | Community 2026, "Desktop development with C++" workload | visualstudio.microsoft.com installer — confirm the current winget package id via `winget search "Visual Studio 2026"` rather than assuming one exists yet |

Once the engine install completes:

```powershell
scripts\verify-r0-native.ps1
```

This script **hard-fails** on anything other than exactly major 5 / minor 8
("This project is pinned to UE5.8; refusing another engine version.") — don't
let Epic auto-update the engine past 5.8 on this box.

**Verify:** `native/tests/coordinates.cpp` compiles under
`cl /std:c++17 /W4 /WX`; `Build.bat SpatialPrevisEditor Win64 Development`
succeeds; both `-run=SpatialPrevisConformance` and
`-run=SpatialPrevisWorkspaceConformance` commandlets pass under
`-NullRHI -nosplash -nop4 -unattended`; evidence lands under
`test-results/native/<timestamp>/`.

---

## Phase 8 — Local LLM stack

**Ollama, primary runner.** Chosen over llama.cpp / KoboldCpp / LM Studio /
oobabooga TextGen / Jan / GPT4All / LocalAI / llamafile for: a native Windows
installer with CUDA auto-detection, `ollama pull` registry-based model
management (no manual GGUF hunting for common models), an OpenAI-compatible
API at `localhost:11434/v1` (trivial to point scripts, editor extensions, or
future tooling at), and idle auto-unload (`OLLAMA_KEEP_ALIVE`, default
5 min) — which matters because this GPU is also doing UE5 Editor rendering
and Playwright/Chromium work, so the LLM shouldn't permanently pin VRAM.

```powershell
winget install Ollama.Ollama
```

Optional: [Open WebUI](https://openwebui.com/) as a browser chat frontend on
top of Ollama — the same cloudflared/ngrok/Tailscale quick-tunnel pattern
already whitelisted in this repo's `vite.config.ts`
(`server.allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.loca.lt', '.ts.net']`)
extends naturally to exposing it for phone access, the same way the Vite dev
server already is.

**Don't pick a model size until Phase 0's GPU is known.** Size it with:
- [LLM Model VRAM Calculator](https://huggingface.co/spaces/NyxKrage/LLM-Model-VRAM-Calculator)
- [canirun.ai](https://www.canirun.ai/) / [whatmodelscanirun.com](https://whatmodelscanirun.com/)

Starting-point candidates once VRAM is confirmed:

| VRAM tier | Coding-capable defaults |
|---|---|
| ~12–16 GB | Qwen2.5-Coder-14B-Instruct (Q4_K_M, ~9–10 GB) or gpt-oss-20b (native MXFP4, ~13–14 GB, Apache-licensed) |
| ~20–24 GB | Qwen3-Coder-30B-A3B-Instruct (MoE, ~3B active params/token, Q4_K_M ≈ 18 GB) or Qwen2.5-Coder-32B-Instruct (Q4_K_M ≈ 20 GB) |
| 48 GB+ | gpt-oss-120b (MoE, ~5B active) as a stretch agentic-coding option |

```powershell
ollama pull qwen2.5-coder:14b   # replace per the sized choice above
```

**Verify:** `ollama list` shows the pulled model; `curl http://localhost:11434/api/tags`
responds; `ollama run <model> "write a hello world in TypeScript"` returns
coherent output; GPU utilization visible in Task Manager / `nvidia-smi`
during the call.

---

## Phase 9 — Metaprompt tool

Already built and committed at [`scripts/ai-tools/metaprompt.py`](../scripts/ai-tools/metaprompt.py)
— a customized fork of Anthropic's cookbook `metaprompt.ipynb`, adapted to
this project (CLAUDE.md injection, `.memory/` grounding, three of five
few-shot examples swapped for this codebase's own domain). Full usage in
[`scripts/ai-tools/README.md`](../scripts/ai-tools/README.md).

```powershell
pip install -r scripts\ai-tools\requirements.txt
setx ANTHROPIC_API_KEY "sk-ant-..."    # store the value in your password manager, not a file
```

**Verify:**
```powershell
python scripts\ai-tools\metaprompt.py draft --task "review a new extras.sockets entry"
```
Confirm the constructed prompt contains the injected CLAUDE.md block (search
the saved output in `scripts/ai-tools/prompts/` for `snap_angle`) and, once
`.memory/` is built (Phase 4), at least one `path:line` citation.

---

## Phase 10 — Repo state on this box

Nothing further to do here beyond Phase 5's clone — `scripts/ai-tools/` and
this document are already committed to the repository you cloned. New
account/credential rows for what you set up above (Shadow PC itself, Ollama,
`ANTHROPIC_API_KEY` location) go into
[`docs/r0/ACCOUNTS_AND_APIS.md`](r0/ACCOUNTS_AND_APIS.md)'s existing table.

---

## Phase 11 — Final full-stack smoke pass

One sitting, no reboot between steps — this is what actually proves the
layers work *together*, not five isolated passes:

1. `npm run dev` serves on port 5173.
2. `scripts\verify-r0-windows.ps1` passes.
3. `scripts\verify-r0-native.ps1` passes.
4. `ollama run <model> "..."` returns a coherent completion while the UE5
   Editor or Playwright/Chromium is also running — confirms no VRAM
   contention crash.
5. `python scripts\ai-tools\metaprompt.py draft --task "<a real project task>"`
   produces a well-formed, CLAUDE.md-respecting, memory-grounded prompt.
6. The Desktop Commander device is still online and responsive to a fresh
   command afterward.

---

## Left as on-the-day judgment calls

- **Exact GPU vendor/VRAM**, and therefore the exact model pick — only
  knowable at first login. Phase 0 names the tools to check it; Phase 8
  names the tools to size a model once it's known.
- **Ollama's idle-unload timing** — the 5-minute default is recommended
  given shared GPU use with UE5/Playwright. Switch to always-warm
  (`OLLAMA_KEEP_ALIVE=-1`) only if latency becomes an actual bottleneck in
  practice, not preemptively.
