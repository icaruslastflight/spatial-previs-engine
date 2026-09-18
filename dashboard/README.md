# Development dashboard

A live coordination view for AI-agent-driven development on this repo:
roadmap progress, pull requests, commits, CI status and a standing decisions
ledger — one page, real data, no server.

```bash
npm run dev
# then open http://localhost:5173/dashboard/
```

On the desktop, `launch-desktop.cmd` has it as option **[4] Launch Development
Dashboard**, or run it directly with `launch-desktop.cmd --dashboard` (`-d`).
It only opens the browser tab — `npm run dev` still needs to be running
already, same as the launcher's other web entries.

## Remote access from a phone (no desktop required)

`dashboard/index.html` is a Vite build entry (`vite.config.ts`) and gets
deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to
`main` — same $0, keyless-by-default design as the dashboard itself, so
nothing extra to configure:

**https://icaruslastflight.github.io/spatial-previs-engine/dashboard/**

This is the real production build, not a separate copy — whatever's on
`main` is what's live there, usually within a minute of the push (the
workflow's `build` + `deploy` jobs together take well under a minute). No
desktop needs to be on or running `npm run dev` for this route; it's a
static page fetching public GitHub API data directly from the phone's
browser. Add it to your home screen for one-tap access.

## What it shows

| Panel | Source | Live? |
| --- | --- | --- |
| Roadmap | `docs/ROADMAP.md`'s milestone table, fetched from `raw.githubusercontent.com` and parsed by `src/dashboard/RoadmapStatus.ts` | Yes — the real committed file, not a copy |
| Pull requests | GitHub REST API, `GET /repos/{owner}/{repo}/pulls` | Yes |
| Recent commits | GitHub REST API, `GET /repos/{owner}/{repo}/commits`, with `Co-Authored-By: Claude …` / `Claude-Session:` trailers parsed into an agent badge | Yes |
| CI — latest commit | GitHub REST API, `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` | Yes |
| Recent workflow runs | GitHub REST API, `GET /repos/{owner}/{repo}/actions/runs` | Yes |
| Open decisions | `dashboard/data/decisions.json` | Hand-maintained |

Nothing here is mocked. `src/dashboard/GitHubActivity.ts` and
`src/dashboard/RoadmapStatus.ts` are unit-tested (`*.test.ts` beside each)
against real response shapes and the real `docs/ROADMAP.md` — see those
files for the same "no stand-ins" discipline CLAUDE.md §12 asks of
`showcase/` pages, applied here even though this isn't one.

## $0, keyless by default

`icaruslastflight/spatial-previs-engine` is a public repo, so the
unauthenticated GitHub REST API (60 requests/hour per IP) is enough for
occasional personal use — no key, no account, matching CLAUDE.md §1.2's
budget. Paste a [personal access token](https://github.com/settings/tokens)
(no scopes needed for public-repo reads) into the header field to raise the
ceiling to 5000/hour. The token:

- lives in `localStorage` in your own browser only,
- is sent to `api.github.com` and nowhere else,
- is never written to a file, committed, or logged.

Each of the four GitHub panels fails independently — a rate-limited pull
request list doesn't blank the commit feed. A rate-limited panel says so and
names when the limit resets, the same graceful-degradation shape as the
basemap tiers in `src/geo/CesiumGlobe.ts` (§4).

## The decisions ledger

`dashboard/data/decisions.json` is a small, hand-maintained log of owner
decisions raised across development sessions — the kind of thing that has
repeatedly gotten lost in chat history on this project. An entry:

```jsonc
{
  "id": "short-slug",
  "raised": "2026-09-18",
  "status": "open",       // or "resolved"
  "title": "One-line question",
  "detail": "Context a reader needs without scrolling back.",
  "resolvedNote": "...",  // only once status is "resolved"
  "relatedPRs": [17]
}
```

Whoever raises or resolves a decision — human or agent — edits this file
directly. It is not auto-generated and never will be: the point is a short,
honest list an owner can scan in ten seconds, not a complete audit trail.

## Layout

```
dashboard/
  index.html        page shell, HUD-panel styling matching showcase/
  main.ts           composition: fetch, render, document.body.dataset.ready
  data/
    decisions.json   hand-maintained decisions ledger
src/dashboard/
  GitHubActivity.ts       GitHub REST fetch + response parsing (tested)
  GitHubActivity.test.ts
  RoadmapStatus.ts        docs/ROADMAP.md milestone-table parser (tested)
  RoadmapStatus.test.ts
```

The fetch/parse logic lives under `src/dashboard/` rather than inside
`dashboard/` itself so `vitest.config.ts`'s existing `src/**/*.test.ts`
include picks the tests up without a config change, and so it sits beside
the code it covers per CLAUDE.md §7's convention — the same split
`showcase/*.ts` pages already use when they import from `src/`.

## Screenshotting

```bash
npm run dev
node scripts/capture_showcase.mjs --page dashboard/index.html --out dashboard/dashboard.png
```

`capture_showcase.mjs` isn't showcase-specific — it just waits on
`document.body.dataset.ready`, which this page sets once its first fetch
batch settles (`'error'` if the initial roadmap+decisions+GitHub fetch threw).
