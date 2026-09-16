# Remote UE5 workstation plan

User direction: rent a remote server for UE5 development. Monthly budget: under USD 50. Status: proposed configuration; no rental, payment, account access or UE5 installation has occurred.

## Proposed first rental

AirGPU L4 with at least 8 vCPUs, 32 GB RAM and 250 GB persistent SSD. Start with a nearby available US region after a connection test. Use the provider's desktop streaming workflow from Chromebook or Android with keyboard and mouse for editor work. This is an interactive development workstation; the static web client remains a separate runtime.

Advertised L4 pricing starts at USD 0.90 per running hour. SSD is USD 3.50 per 50 GB per month. At those rates, 250 GB is USD 17.50 per month and 30 running hours is USD 27.00: USD 44.50 before applicable tax. The USD 5.50 remainder is a planning reserve, not a guarantee. Installation, downloads, compilation and idle time while running consume the same hour budget. Storage continues to incur charges while retained. Verify region/configuration pricing, taxes, credits, billing increments and disk capacity at checkout; reduce hours to keep the total below USD 50. Do not assume closing a streaming client stops billing. Check the provider machine state after every session. Configure automatic shutdown only after confirming the provider supports it and its behavior.

Alternative reviewed: Paperspace advertises A4000 at USD 0.76/hour with 45 GB RAM and 8 vCPUs. The compatible desktop image, storage and account-specific total were not verified, so this is not a complete cheaper quote.

## Setup sequence after account and rental configuration are available

1. Confirm the provider's OS image, GPU driver and DirectX support against the pinned UE version; do not assume every server image meets Epic's documented Windows requirements.
2. Confirm the existing UE5 project repository and exact engine/plugin versions before installation. If there is no desktop project, create it separately after defining the UE target. Do not upgrade an existing project implicitly.
3. Install one binary engine version using Epic's supported installer and the matching C++ toolchain. Source-engine compilation, multiple target platforms and large venue scans can exceed the proposed disk/hour allowance.
4. Clone the web review branch and the desktop repository. Keep generated build caches and binaries out of Git. Store editable source in Git; use Drive for briefs, review notes and bounded handoff files, not as a live UE project-sync directory.
5. Port the experimental R0 record contract. Run the fixture in both runtimes. Test ID retention, unknown quantities, separate relationship kinds, frames/units and rejected invalid graphs. Record engine version, plugin versions, both commits and test output.
6. Build and open a small synthetic venue in UE5. Verify touch/remote input separately from the browser app and confirm render features against the actual GPU/driver. Do not claim UE parity from a successful remote login.
7. Commit source, preserve test evidence, close the editor, stop the machine in the provider console and verify stopped state. Retained storage may still be billed.

## Current blockers

Provider account and checkout configuration; exact desktop repository; pinned UE version; verified total including tax. No credentials should be pasted into project documents or Git.

## Sources checked on 2026-09-16

- AirGPU pricing and supported client platforms: https://airgpu.com/
- AirGPU desktop connection help: https://help.airgpu.com/
- Epic UE hardware/software guidance: https://dev.epicgames.com/documentation/en-us/unreal-engine/hardware-and-software-specifications-for-unreal-engine
- Paperspace advertised compute: https://www.paperspace.com/pricing

Epic's current general recommendation includes 32 GB RAM and at least 8 GB graphics memory. The 250 GB disk and 30-hour limit above are project planning choices, not Epic requirements or provider performance guarantees.
