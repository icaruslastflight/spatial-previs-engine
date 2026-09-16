# R0 first increment

Status: experimental CORE-01 foundation, prepared for review. R0 is not complete.
Baseline: 37b1f3b74ccb8b16c97c69521ed0190edffa4f95.

## What this increment provides

`src/domain/ProductionProject.ts` defines renderer-independent records for asset definitions, serialized inventory, bulk stock, placed instances, ordered assemblies, planar surfaces, box zones, ports, logical connections, mechanical attachments and document snapshot identities. IDs persist verbatim through JSON; new IDs can use namespaced UUIDs. Catalog IDs remain distinct from record and inventory IDs. Unknown quantities carry explicit units and remain unknown after serialization.

`src/domain/ProjectCodec.ts` validates the full input before returning it. It rejects unsupported schema versions and fields, duplicate IDs, dangling or wrongly typed references, conflicting serialized inventory allocation, invalid transforms, connection direction/domain/protocol conflicts, mechanical cycles, occupied sockets and future document revisions. Mechanical attachments never create power or signal links.

This is a pure JSON boundary, not implemented project storage or a scene restore UI. Unknown connection metadata may be retained but does not establish equipment compatibility. Socket existence, gender and physical mating remain the existing engine's responsibility. The fixture's connection candidates and mechanical attachment are synthetic, not an equipment design.

## Next bounded work

1. CORE-02: atomic commands with revision checks, idempotency, lock enforcement, preview/cancel, and undo of relationships and inventory allocation.
2. CORE-03: version migrations, durable storage, renderer reconciliation, dependency invalidation and immutable issued document bytes.
3. CORE-04: calculations, evidence, review authority and exact-input invalidation.
4. UI-01: adopt the reviewed responsive shell and shared selection after state behavior is proven.

Cable runs, mappings, calculations and approval records require their own domain contracts. The first schema intentionally rejects unsupported kinds rather than accepting opaque payloads. No existing editor code, sockets, coordinates, events, bridge, assets or dependencies were changed. The current counter-based spawn IDs remain until command-backed scene creation is integrated.

## Open UE5 conformance checkpoint

The current repository is the web client; no UE5 project was available for execution. This contract is experimental and must not be advertised as cross-platform conforming or activated as the shared production format until the desktop implementation passes the same fixtures. No parity requirement is relaxed.

Use `tests/fixtures/r0/production-project.v1.json` as the portable contract input. A UE5 adapter must retain IDs, unknown quantities, units, locks, ordered membership and relationship kinds exactly. Convert the declared right-handed Y-up metre frame explicitly at the UE boundary; do not reinterpret positions as UE centimetres or reuse quaternion components without a tested basis conversion. Compare canonical JSON semantically, not by whitespace or property order.

The existing site-anchor divergence in CLAUDE.md remains open. This work changes no anchor values. See `REMOTE_UE5_WORKSTATION.md` for the requested rented development host.

## Executed verification

- Baseline: 284 tests passed.
- Updated: 301 tests passed, including 17 new domain contract tests.
- TypeScript typecheck and production build passed.
- No UE5 build, hosted GPU session, browser integration, actual-phone test or visual approval is claimed.

## Source trail

- PRODUCTION_WORKSPACE_SPEC.md: sections 3, 4, 14, 15; IMPLEMENTATION_BACKLOG.json: CORE-01 through CORE-04, supplied project artifacts dated 2026-09-16.
- COMMERCIAL_DESIGN_STANDARD.md: visual direction remains pending owner review.
- Drive project entry: https://drive.google.com/file/d/1zgcVljTe_2G5Pnrx1YfY_3DV7IX3AtfG/view
- Drive conflict register: https://drive.google.com/file/d/1Evkce9P_ZfeABD4-egH7tgjuQOGE__Du/view
