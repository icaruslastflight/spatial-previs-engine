---
name: domain-correctness-review
description: Review a diff against the extras.sockets schema (CLAUDE.md §3) or a GDTF DMX-mode/photometric change (CLAUDE.md §10) for this project's specific, easy-to-miss mistakes. Load this when a diff touches socket definitions, SocketSnappingEngine callers, GDTFParser, GDTFAssetResolver, or any SpotLight.intensity assignment.
---

# Domain-correctness review: sockets and GDTF/DMX

This skill's checklists are sourced from `scripts/ai-tools/metaprompt.py`'s
`_project_examples()` function (`metaprompt.py:172–227`) — the same content
that tool uses to draft a review prompt for an external model call. This
skill exists for the case where the reviewing model already has direct repo
access and doesn't need a second API round-trip through `metaprompt.py` to
re-derive the same checklist. **If either file's checklist changes, update
the other** — the two must not drift apart.

## `extras.sockets` review (CLAUDE.md §3)

Check every proposed or changed socket entry against each rule in turn,
explicitly, rather than skimming and approving:

1. `socket_type` must be a value `SOCKET_TYPES` recognizes — an unlisted type
   is a hard rejection, never a silent pass-through.
2. `gender` (`MALE`/`FEMALE`/`NEUTRAL`/`UNIVERSAL`) must be semantically
   sensible for the fixture — a hoist hook set `FEMALE` is more likely a
   copy-paste default than a deliberate choice; flag it.
3. `transform.normal` and `transform.up` must not be parallel (registration
   rejects a parallel pair) — actually compute whether they're within a
   degree or two of parallel, don't eyeball it.
4. **The single easiest mistake in the schema:** for radially-arrayed
   identical sockets on one asset (e.g. multiple chord sockets on a circular
   truss cross-section), each `up` must point radially outward toward that
   socket's *own* position — not share one fixed vector across all of them.
   Sharing a vector aligns the mated pair correctly and leaves every other
   chord crossed by several millimeters.
5. `tolerances.snap_angle` is the angular *capture window* (typically single
   digits of degrees), not the detent step size (typically 90). Confirm the
   value looks like a tolerance, not a detent step accidentally placed in the
   wrong field.
6. `kinematic_rules.can_child` should be `false` only for sockets that should
   genuinely never become the moving side of a joint (a load-bearing top
   hook, a fixture clamp) — flag it if it's set without that reasoning
   visible.

For each rule that fails, quote the specific field/value and explain why in
one sentence. If every rule passes, say so plainly.

## GDTF DMX-mode / photometric review (CLAUDE.md §10)

Look for any line that sets a Three.js `SpotLight.intensity`, references
`luminousFluxLumens`, or otherwise touches photometric conversion.

**The single easiest photometric mistake here:** handing the raw lumen figure
straight to `SpotLight.intensity`, which expects candela. That makes a
narrow-beam fixture read as dim as a wash of the same wattage — backwards
from reality. The correct pattern spreads flux over the beam's solid angle
first:

```
omega  = 2 * pi * (1 - cos(field_angle / 2))   // steradians
candela = flux / omega
```

before assignment. If the conversion function is called but not shown in the
diff, say so explicitly rather than assuming it's correct.

## Coordinate-frame reminder (context for both checklists)

GDTF is Z-up in metres; Three.js is Y-up. `gdtfToThree` performs the
conversion once (`x, y, z → x, z, −y`) inside `GDTFParser`. A diff that
re-applies an axis swap downstream of that call is a bug, not a defensive
safeguard — flag it the same way as the flux/candela mistake.
