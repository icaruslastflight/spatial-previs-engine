---
name: phased-plan
description: Draft a CLAUDE.md §13-compliant phased implementation plan (phases+steps, tier-per-phase with a reason, verification-per-phase) for any spatial-previs-engine change spanning three-plus steps or multiple modules. Load this before starting such work, or when explicitly asked to plan.
---

# Phased planning for spatial-previs-engine

CLAUDE.md §13 requires every non-trivial AI-driven change in this repo — three
or more distinct steps, or work spanning multiple modules — to start with a
written plan, stated inline in the PR or commit body. This skill turns that
rule into something directly runnable instead of prose to reinterpret each
time.

## The three mandatory parts

A plan missing any one of these is not a plan, it's speculation (CLAUDE.md
§13.1):

1. **Phases and steps in order.** Small number of phases; each step names its
   file(s) and the change type (read / edit / add / delete / verify). Don't
   pad with steps that don't correspond to a real file touched or a real
   check run.
2. **Tier choice per phase, with a reason.** Default tier (the fast, capable
   workhorse) for routine work — mechanical refactors, doc edits, following an
   existing plan, single-file fixes with a clear symptom, glue code. Reserve
   the deep-reasoning tier for phases whose success genuinely depends on it:
   root-cause hunts where the symptom doesn't point at the cause, real
   architecture trade-offs, cross-file refactors needing the whole call graph
   held in mind, or algorithms being derived rather than adapted. "Default
   tier" is a completely valid line — the point is that reaching for the
   deep-reasoning tier is always a stated decision, never a silent default
   (CLAUDE.md §13.2).
3. **Verification per phase.** A specific test name, a build target, a named
   tool run, or a specific artifact to inspect — not "confirm it works."

## Canonical wording

The exact instructional wording for drafting a plan in this shape already
exists in `scripts/ai-tools/metaprompt.py`'s `phased_plan` few-shot example
(`_project_examples()`, `metaprompt.py:229–255`). Read that example rather
than re-deriving the phrasing here — it's deliberately the same wording used
to prompt an external model for this exact task, and letting this skill and
that file diverge is a drift bug, not a style choice. If the two ever
disagree, `metaprompt.py` is the source of truth to fix, since it's also the
one used to draft plans for tasks this session's own agent isn't handling
directly.

## Cost discipline

Per CLAUDE.md §13.3: a short plan beats a long trial-and-error tool loop, and
default-tier work (reading a file, running a known command, applying a named
edit) never needs deep-reasoning rates. Trivial one-file, one-symptom changes
are exempt from all of this — write the fix, not the plan.
