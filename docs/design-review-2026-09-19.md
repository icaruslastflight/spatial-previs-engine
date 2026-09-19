# Design Review — R0 Production Workspace (2026-09-19)

Live audit of `r0.html` (dev server, localhost) covering four dimensions:
design critique, WCAG 2.1 AA accessibility, design-system/token consistency,
and UX copy. Also see `docs/competitor-research-claims-2026-09-19.json` for
raw competitive-landscape research claims (live-event previs competitors),
gathered separately and not yet synthesized into a report.

---

## 1. Design Critique

### Overall Impression
The information architecture is genuinely strong — a linear Build → Map →
Connect → Check → Operations → Deliver pipeline maps cleanly onto how a
production actually gets planned, and the dark, high-contrast theme suits a
tool meant for load-in/rehearsal environments. The biggest opportunity is
that the "Prompt Forge" AI panel currently dominates screen real estate on
*every* tab and pushes the thing each tab is actually for (the 3D viewport,
the checks, the handoff artifacts) into a cramped top strip.

### Usability
| Finding | Severity | Recommendation |
|---------|----------|----------------|
| The 3D viewport — the primary workspace — is capped to ~40% of vertical height, with the AI prompt panel taking the rest below the fold | 🔴 Critical | Give the viewport the dominant share of the screen; make Prompt Forge a collapsible drawer/sidebar, not permanently-open inline real estate |
| Placing a truss put it at the exact scene origin, invisible/overlapping the grid center marker, with no visual "just added" feedback (no highlight ring, no camera nudge) | 🟡 Moderate | Briefly highlight/pulse new equipment on add, or auto-frame the selection |
| Tab subtitles are the only content differentiating Check/Deliver from Build until data exists — they look like empty duplicates of each other | 🟡 Moderate | Show an explicit empty-state illustration/copy per tab rather than relying on a one-line subtitle to carry the tab's identity |
| Footer status bar mixes unrelated signals in one line ("Ready · local scene · no model or API required" / "Unsaved changes" / "R0 preview · desktop conformance pending") | 🟢 Minor | Group into distinct zones (save state, environment/mode, build status) |
| "Save project" uses the same amber accent as active-tab underline and other primary actions, so it doesn't read as *the* urgent action when there are unsaved changes | 🟡 Moderate | Reserve amber for "needs attention" states, or add a pulsing/badge indicator tied to "Unsaved changes" |

### Visual Hierarchy
- **What draws the eye first**: On load, "A venue starts with your design" — correct. Once equipment exists, the Prompt Forge panel's border/heading competes directly with the viewport and wins, since it sits where the eye rests after scanning the top.
- **Reading flow**: nav → toolbar → viewport → Prompt Forge → Scene list (left) → Inspector (right) is roughly correct, but the Inspector panel is visually quiet despite being where the user goes immediately after every selection.
- **Emphasis**: "Scene 1 objects" pluralization bug is a small polish papercut.

### Consistency
| Element | Issue | Recommendation |
|---------|-------|----------------|
| Prompt Forge panel | Near-identical layout/copy repeats across all six tabs with only the title/one field changing | Fine as a pattern, but each tab needs a stronger visual anchor (icon, color accent) |
| "Frame all" button | Same dark-gray fill as inactive toggle buttons, but it's a distinct action, not a toggle | Differentiate action buttons from toggle/state buttons |
| World position X/Y/Z inputs | No visual grouping signaling they're one coordinate | Group into a single bordered row |

### Accessibility (critique-level observations — see §2 for full audit)
- Muted gray labels are borderline low-contrast against the dark background.
- Catalog `+` controls initially looked small in a screenshot, but measured out fine (see §2) — the actual clickable target is the full 183×66px row.
- Prompt Forge helper text embeds raw technical IDs (`asset_instance:517ea1bd-…`) directly in user-facing copy — a readability burden for non-technical operators.

### What Works Well
- The Build/Map/Connect/Check/Operations/Deliver tab metaphor is a clean, honest model of the actual production workflow.
- Scoped, contextual empty states guide first-time use without a separate onboarding flow.
- The revision/status strip (`local-production`, `Revision 1`, `Design only`) keeps the user oriented without digging into a menu.
- Reusing the Inspector panel consistently across all six tabs keeps the mental model stable.

### Priority Recommendations
1. Rebalance viewport vs. Prompt Forge real estate — collapse the AI panel to a toggleable drawer so the viewport can take ~70% of vertical space by default.
2. Differentiate Check/Deliver's empty states from Build's.
3. Audit small interactive targets against the project's own stated 40px touch minimum (see §2 for the actual measured results — mostly fine, with specific exceptions below).

---

## 2. Accessibility Audit (WCAG 2.1 AA)

**Tested:** live at localhost:5174, Chrome, automated DOM/contrast probes + manual keyboard pass.

**Summary:** Issues found: 5 | Critical: 0 | Major: 2 | Minor: 3

### Perceivable
| # | Issue | Criterion | Severity | Recommendation |
|---|-------|-----------|----------|-----------------|
| 1 | Sampled text/background pairs across header, nav, catalog, inspector all measured ≥6:1 contrast | 1.4.3 | ✅ Pass | — |
| 2 | The 3D viewport `<canvas>` has `aria-label="Production 3D scene"` but no live-region/text alternative for *what's in* the scene | 1.1.1 / 1.3.1 | 🟢 Minor | Mirror the "Scene" list as the canvas's `aria-describedby` |

### Operable
| # | Issue | Criterion | Severity | Recommendation |
|---|-------|-----------|----------|-----------------|
| 1 | Keyboard Tab order and focus ring work correctly — visible amber focus outline | 2.4.7 | ✅ Pass | — |
| 2 | Camera preset buttons (40–65×32px) and Prompt Forge action buttons (~40px tall) fall under the 44×44 CSS px minimum — 9 of 99 interactive elements measured undersized | 2.5.5 | 🟡 Major | Bump to ≥44px height |
| 3 | Core interaction (drag-to-move/snap equipment) is pointer/touch-only per the docs; no stated keyboard equivalent for placing/moving equipment | 2.1.1 | 🟡 Major | Confirm/document the numeric X/Y/Z inspector fields as the keyboard alternative to dragging |

### Understandable
| # | Issue | Criterion | Severity | Recommendation |
|---|-------|-----------|----------|-----------------|
| 1 | World-position X/Y/Z inputs are correctly wrapped in `<label>` elements | 3.3.2 | ✅ Pass | — |
| 2 | Catalog "add" control's accessible name concatenates visually-separate text: `"F34 Box Truss 0.5 mtrussing ＋"` | 4.1.2 / 3.3.2 | 🟢 Minor | Add explicit `aria-label="Add F34 Box Truss 0.5 m to scene"` |

### Robust
| # | Issue | Criterion | Severity | Recommendation |
|---|-------|-----------|----------|-----------------|
| 1 | Semantic landmarks all present and correct: `<header>`, `<nav>`, `<main>`, two `<aside>`, `<footer>` | 1.3.1 / 4.1.2 | ✅ Pass | — |
| 2 | One unlabeled `<input type="file">` (the "Open file" control) | 4.1.2 | 🟢 Minor | Add `aria-label="Open project file"` |

### Color Contrast Check
| Element | Foreground | Background | Ratio | Required | Pass? |
|---------|-----------|------------|-------|----------|-------|
| Synthesize button | rgb(255,255,255) | rgb(64,107,82) | 6.1:1 | 4.5:1 | ✅ |
| "asset instance" label | rgb(181,188,181) | rgb(56,56,45) | 6.11:1 | 4.5:1 | ✅ |
| Camera preset text | rgb(181,188,181) | rgb(39,45,41) | 7.25:1 | 4.5:1 | ✅ |
| "Continue on desktop" | rgb(228,191,121) | rgb(39,45,41) | 8.05:1 | 4.5:1 | ✅ |
| Catalog labels | rgb(181,188,181) | rgb(32,36,35) | 8.09:1 | 4.5:1 | ✅ |
| Purple showcase CTA subtext | rgb(176,184,200) | rgb(157,78,221) | 2.31:1 | 4.5:1 | ❌ |
| Purple showcase CTA heading | rgb(226,202,255) | rgb(157,78,221) | 3.09:1 | 4.5:1 | ❌ (borderline at large-text 3:1 threshold, fails at body size) |

Both failures live in the "Stage Showcase" promo card, not the core workspace chrome.

### Keyboard Navigation
| Element | Tab Order | Enter/Space | Escape | Arrow Keys |
|---------|-----------|-------------|--------|------------|
| Nav tabs (Build…Deliver) | ✅ reachable, visible focus ring | Not tested | — | — |
| Catalog "add" buttons | ✅ native `<button>`, tabindex 0 | Should activate | — | — |
| 3D viewport object placement/move | ⚠️ No keyboard path found for drag-to-move; numeric inspector fields likely fallback, untested end-to-end | — | Docs confirm Escape cancels a *drag* | — |

### Priority Fixes
1. Confirm and document a full keyboard path for moving equipment (via X/Y/Z inspector) — the primary interaction (drag) is pointer-only, blocking keyboard-only/switch-device users from the core task.
2. Enlarge the 9 undersized controls (camera presets, Prompt Forge action buttons) to ≥44px.
3. Fix the purple Stage Showcase CTA contrast (2.31:1 and 3.09:1, both fail AA).

---

## 3. Design System Audit

**Score: 62/100.** Real token layer exists (`--panel`, `--border`, `--muted`,
`--accent`, `--field` in `:root`, `src/ui/workspace.css:1`), used consistently
for the core neutral palette (57 `var(--token)` references vs. 44 hardcoded
hex values). The gap is entirely in **semantic accent/status colors** and
**typography/spacing scale** — neither has tokens, so one-off shades and
sizes were hand-picked per rule.

### Token Coverage
| Category | Defined | Hardcoded Values Found |
|----------|---------|-------------------------|
| Colors (neutral) | 4 tokens, well-reused | Low drift |
| Colors (accent/amber) | 1 token (`--accent: #e4bf79`) | 4 competing amber values: `#e4bf79` (token), `#d6b476` ×5, `#bc9f6b` ×2, `#f6cd87` ×1 |
| Colors (status/error) | 0 tokens | 2 near-identical reds never reconciled: `#f6b5a8` (`.danger`), `#ffb4a4` (`.error`) |
| Colors (misc dark variants) | 0 tokens beyond `--border`/`--panel` | 8+ one-off dark shades (`#343b36`, `#38382d`, `#353528`, `#657065`, `#59615a`, `#87947d`...) |
| Typography (size scale) | 0 tokens | 12 distinct font-sizes (9–21px); `12px` alone appears 24 times, several sizes appear only once |
| Spacing | 0 tokens | All literal px values, no 4/8px scale |

### Component Completeness
| Component | States | Variants | Docs | Score |
|-----------|--------|----------|------|-------|
| Button (base) | default/hover/disabled/focus-visible all defined | 1 documented — 3 undocumented ad hoc variants exist | ❌ | 5/10 |
| `.button-group` button (camera presets, sub-tabs) | default/hover/active | 1 | ❌ — **silently overrides base button's 44px `min-height` down to 32/34px**, the direct cause of the accessibility 2.5.5 findings | 5/10 |
| Catalog item | default only, no "already in scene"/"loading" state | 1 | ❌ | 4/10 |
| Scene item | default/selected | 1 | ❌ | 6/10 |
| Coordinate/number inputs | default/focus-visible | 1 | ❌ | 6/10 |
| Modal (`#desktop-handoff`) | default only | 1 | ❌ | 5/10 |

### Naming Consistency
| Issue | Components | Recommendation |
|-------|------------|-----------------|
| Three unrelated selectors all mean "primary/confirm action, amber-filled" | `#save`, `#handoff-export`, `.active-vsrc`, `.sub-tab.selected` | Extract one `.btn-primary` class instead of re-declaring `background`/`color`/`border-color` per ID/class |
| `.danger` vs `.error` — same visual role, different name, different color | `.danger` (`#f6b5a8`), `.error` (`#ffb4a4`) | Merge into one `--danger` token, or name the intentional distinction if there is one |

### Priority Actions
1. Extract accent/status colors into tokens (`--accent-strong` or reconcile to one `--accent`, plus `--danger`) and replace all hardcoded amber/red values.
2. Give `.button-group button` and `.sub-tab` the same `min-height: 44px` as the base button rule — fixes the WCAG 2.5.5 findings at the source.
3. Introduce a small type scale (10/11/12/13/14/16/18/21px → a named 6–7-step scale) and a spacing scale (4/8/12/16/24px); migrate the highest-frequency literal values first (`12px` appears 24 times).

---

## 4. UX Copy Review

Findings drawn from real production strings in `src/ui/ProductionWorkspace.ts`,
not screen-scraped guesses.

1. **`#notice` initial state** — "Opening local project…" — fine, sets expectation.
2. **Save-status chain** — "Unsaved" → "Saving…" → "Saved on this device" / "Save failed · export to keep changes". Genuinely good: "Saved **on this device**" is specific about *where*, which matters for a local-first tool. Minor inconsistency: static footer label reads `"Unsaved"` on load but `markDirty()` sets `"Unsaved changes"` — pick one string (prefer `"Unsaved changes"`, parallel with `"Saved on this device"`).
3. **Render-status error** — `"Scene update failed: ${message}. Previous scene retained."` — good structure, but raw JS `e.message` is interpolated directly into user-facing text with no translation layer. Wrap known failure modes with human copy; keep raw message behind a "details" disclosure.
4. **WebGL failure** — `"3D unavailable. Use the equipment list and numeric inspector. ${e.message}"` — a strong message; names the fallback path explicitly. Same raw-message concern as #3.
5. **Empty scene state** — "A venue starts with your design" / "Add equipment from the catalog. A map or point cloud can come later." Reads well; slightly abstract as a first line. Alternatives considered:
   - A (current): aspirational/brand-forward.
   - B: "No equipment yet" / literal, task-first, spells out exact next action.
   - C: "Start building" / middle ground, verb-led headline.
6. **Scene-list empty state** — "No equipment placed yet." — good, terse, no change needed.
7. **Confirmation dialogs (native `confirm()`)** — three call sites, each phrasing the same "you'll lose unsaved work" warning differently:
   - "Synthesize full 7-department production rig? Current unsaved scene will be replaced."
   - "Load the concert stage showcase? Any unsaved changes to the current project will be replaced."
   - "Replace unsaved changes? Export the current project first if you need to keep them."
   Native `confirm()` can't relabel its OK/Cancel buttons, so action-specific consequences described in text aren't reflected in the buttons. Replace with one reusable in-app confirmation component (the codebase already has a modal pattern — `#desktop-handoff`) with explicit action-labeled buttons ("Replace scene" / "Keep current scene") and one consistent sentence template.
8. **Proposal banner** — "N records change together. Current scene and allocations are unchanged until you apply." / buttons "Apply changes" / "Cancel". Strong: proactively reassures nothing has happened yet. "Cancel" is generic — "Discard preview" would be more precise and avoid being misread as undoing something already applied.
9. **Cancellation feedback** — "Proposal canceled; project unchanged" / "Changes applied". Both good, terse, consistent with the reassurance theme.
10. **No-editor record fallback** — "This record is available for inspection. Its specialized editor is not part of this R0 preview." Honest about scope without sounding apologetic — matches the project's "name the gap explicitly" philosophy.

### Priority Fixes
1. Replace the three native `confirm()` calls with one reusable in-app confirmation component with action-labeled buttons and one consistent sentence template.
2. Stop interpolating raw `e.message` into primary error sentences — map known error types to human copy, put raw message behind a details disclosure.
3. Reconcile "Unsaved" vs. "Unsaved changes" to one string.

### Localization Notes
- Internal-jargon status strings ("R0 preview · desktop conformance pending", "R0", "desktop conformance") need a glossary note for translators — not standard UI vocabulary.
- Middle-dot separators (`·`) used throughout status strings — confirm they're not confused with decimal separators in RTL/CJK layouts.
