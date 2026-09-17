# Remote UE5 workstation plan

## Verified workstation update on 17 September 2026

The owner has provisioned the workstation and authorized administrative setup and
development. Desktop Commander is online. Actual hardware differs from the original
proposal: Windows 11 Pro, approximately 16 GiB RAM, AMD Radeon RX 9060 XT and a
200 GiB system drive. Visual Studio Community 2026 and C++ tools are installed.
Epic launcher installation succeeded after Windows elevation; the owner signed in
and downloaded UE5.8.2, then restarted the PC. The engine build remains unverified.

The native source checkout is `C:\Users\user\Documents\SpatialPrevisEngine`.
The separate browser acceptance checkout is `C:\Users\user\Documents\SpatialPrevisWebEvidence\repo`.
Both use the actual shared web baseline. Portable native coordinate checks pass with
MSVC; the browser suite passes 23 scenarios. No new provider purchase was made.

The total USD 30 budget remains a user constraint. Provider balance and billing were
not accessed. Keep the machine running during the requested installation; stop it
through the provider when work is finished and the owner no longer needs the stream.

## Original rental proposal retained for context

The following pricing and configuration were planning assumptions, not the actual
rental receipt or machine specification.

## Preferred provider after usability comparison

Recommendation: AirGPU prepaid for a short setup pilot. Target around USD 20 in initial credit, with a hard checkout ceiling of USD 30 including all taxes and fees. The public pricing page confirms prepaid credit, but the available top-up amounts and the user's final regional quote have not been verified. Do not assume an advertised hourly rate is the complete price.

Preferred configuration to quote: NVIDIA L4, from 8 vCPUs and 32 GB RAM at USD 0.90/hour, with 200 GB SSD. At the listed USD 3.50 per 50 GB per month, a conservative full-month disk allowance is USD 14. Six running hours add USD 5.40, for USD 19.40 before tax. Installation, downloads and compilation consume the same paid hours. Storage billing granularity and available configurations still require confirmation in the provider console.

This is a limited pilot, not a month of regular development. Use one binary UE version and small fixtures. Verify free disk before installing the engine, compiler and cache; 200 GB may need careful component selection. Avoid engine-source builds and large scans. Retained disk has a separate cost; verify the stopped state after each work session and preserve project source before any disk deletion.

Shadow is excluded: the user reports that the actual checkout exceeds USD 30 after tax. The advertised Neo Lite promotion is not a verified usable quote for this user. Power Lite also exceeds the budget. Vagon's larger-disk plan leaves too little room for compute under the revised cash limit.

Paperspace advertises A4000 at USD 0.76/hour with 45 GB RAM and 8 vCPUs, but a complete compatible desktop-image/storage quote was not verified. No claim that it is the cheapest usable option is made.

User will perform the rental. No provider account or payment action is requested from the assistant.

## Codex connection preference

A current directory search found Remote Desktop Commander, which relays authorized file and terminal access from ChatGPT to a Windows or macOS machine. It can support source edits, Git and build commands on the rented workstation. Its connection to an actual AirGPU host has not been tested; it is not a UE5 editor-control or GPU-provisioning plugin. Install and link it from the rented Windows desktop, then verify a harmless file/terminal read before project work.

DigitalOcean also has a plugin described as provisioning a Droplet for a remote Codex workspace. GPU provisioning, Windows desktop streaming and a complete UE5 configuration were not established by that description. Do not purchase a generic CPU Droplet as the UE5 workstation based only on the plugin name.

Preferred candidate combination: AirGPU for the interactive desktop plus Remote Desktop Commander for authorized code/build access. Desktop Commander lists a free remote plan with 10,000 tool calls per month; use that plan within the cash limit. The plugin is installed in ChatGPT; its device commands have not surfaced in this session, so access to a rented machine and provider compatibility remain unverified.

Setup reference: https://desktopcommander.app/mcp/chatgpt/

## Setup sequence after account and rental configuration are available

1. Confirm the provider's OS image, GPU driver and DirectX support against the pinned UE version; do not assume every server image meets Epic's documented Windows requirements.
2. Confirm the existing UE5 project repository and exact engine/plugin versions before installation. If there is no desktop project, create it separately after defining the UE target. Do not upgrade an existing project implicitly.
3. Install one binary engine version using Epic's supported installer and the matching C++ toolchain. Source-engine compilation, multiple target platforms and large venue scans can exceed the proposed disk/hour allowance.
4. Clone the web review branch and the desktop repository. Keep generated build caches and binaries out of Git. Store editable source in Git; use Drive for briefs, review notes and bounded handoff files, not as a live UE project-sync directory.
5. Port the experimental R0 record contract. Run the fixture in both runtimes. Test ID retention, unknown quantities, separate relationship kinds, frames/units and rejected invalid graphs. Record engine version, plugin versions, both commits and test output.
6. Build and open a small synthetic venue in UE5. Verify touch/remote input separately from the browser app and confirm render features against the actual GPU/driver. Do not claim UE parity from a successful remote login.
7. Commit source, preserve test evidence, close the editor, stop the machine in the provider console and verify stopped state. Retained storage may still be billed.

## Initial planning blockers

At planning time: provider account/checkout, desktop repository, pinned engine and
verified total including tax. Current setup is recorded at the top of this document.
No credentials should be pasted into project documents or Git.

## Sources checked on 2026-09-16

- AirGPU pricing and supported client platforms: https://airgpu.com/
- AirGPU desktop connection help: https://help.airgpu.com/
- Shadow plan and session limits: https://shadow.tech/us/lp-new-lite/
- Remote Desktop Commander pricing: https://desktopcommander.app/pricing/
- Shadow hardware: https://support.shadow.tech/hc/en-us/articles/31001157820049-Shadow-PC-Gaming-Offers-Hardware-Specifications
- Vagon pricing: https://vagon.io/cloud-computer/pricing
- Vagon access: https://vagon.io/cloud-computer
- Epic UE hardware/software guidance: https://dev.epicgames.com/documentation/en-us/unreal-engine/hardware-and-software-specifications-for-unreal-engine
- Paperspace advertised compute: https://www.paperspace.com/pricing

Epic's current general recommendation includes 32 GB RAM and at least 8 GB graphics memory. The disk and usage configurations above are project planning choices, not Epic requirements or provider performance guarantees.
