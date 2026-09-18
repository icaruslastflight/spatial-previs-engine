# Metaprompt — project-customized prompt drafting

A project-customized fork of Anthropic's cookbook notebook
([`misc/metaprompt.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb),
fetched 2026-09-18). Solves the "blank page problem": give it a task, it
drafts a full Claude prompt template for that task, then optionally
test-drives the result. Ported to a plain CLI rather than a notebook for the
same reason `scripts/memory/` is a CLI — no Jupyter dependency for a fresh
workstation, and notebook JSON diffs badly against this repo's otherwise
clean text-diff discipline.

Only the drafting step is provider-specific (it calls the Anthropic API). The
templates it produces are plain text: use them from any agent, CLI or model
API, and read them without any particular tool installed.

## What's customized versus upstream

- **CLAUDE.md injection** (on by default). Every `draft` call prepends this
  project's own `CLAUDE.md` as fixed context, so a prompt template drafted
  here already respects this codebase's rules — coordinate frames, the
  `extras.sockets` schema, the $0 budget, strict TS — without the caller
  restating them. Disable with `--no-project-context`.
- **`.memory/` grounding** (on by default, silently skipped if the index
  isn't built yet). Shells out to `scripts/memory/query.py --with-neighbors`
  for the task text and folds the `path:line` citations in as
  `<repo_context>`. Disable with `--no-memory`.
- **Three of five few-shot examples swapped** for project-specific ones,
  keeping the same instructional *pattern* each original taught:
  - upstream's document-QA (quote-then-answer) → checking a GDTF DMX-mode
    diff for the flux→candela unit mistake (CLAUDE.md §10)
  - upstream's math tutor (iterative self-checking) → reviewing a new
    `extras.sockets` entry against the §3 schema, rule by rule
  - upstream's function-calling example → drafting a §13-compliant phased
    plan for a cross-module change

  The FAQ-agent and sentence-comparison examples are kept verbatim for
  structural diversity — this is a deliberate 3-of-5 swap, not a rewrite.

## Install

```bash
pip install -r scripts/ai-tools/requirements.txt
```

## API key

**Not** `.env.local` — that's Vite's browser-facing surface (`VITE_`-prefixed
only); putting `ANTHROPIC_API_KEY` there risks it getting bundled into the
public build. Recommended:

```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."
```

once on the workstation (persists across sessions, never touches a file
under the repo tree). Store the actual value in your password manager, not
in a project file. If you'd rather use `python-dotenv`, copy `.env.example`
to `.env` (git-ignored) and fill it in — both paths work.

## Usage

```bash
# Draft a prompt template for a task.
python scripts/ai-tools/metaprompt.py draft --task "review a new extras.sockets entry"

# ...with explicit input variables instead of letting Claude choose them:
python scripts/ai-tools/metaprompt.py draft \
    --task "check a GDTF DMX-mode diff for the flux/candela mistake" \
    --variables DMX_MODE_DIFF

# Test-drive a saved draft.
python scripts/ai-tools/metaprompt.py test \
    --prompt-file scripts/ai-tools/prompts/20260918-120000-review-socket.md \
    --values SOCKET_JSON='{"socket_type": "TRUSS_CONICAL_F34", ...}'

# Draft and test in one call.
python scripts/ai-tools/metaprompt.py full --task "..." --values NAME=value
```

Every `draft` (and `full`) run saves the generated template to
`scripts/ai-tools/prompts/<timestamp>-<slug>.md` (git-ignored — these are
per-workstation outputs, analogous to `.memory/`), with a small JSON header
recording the task, requested/found variables, and the model used.

Flags: `--no-project-context` skips the CLAUDE.md injection; `--no-memory`
skips `.memory/` grounding; `--show-raw` also prints the model's full
`<Inputs>` / `<Instructions Structure>` / `<Instructions>` response before
extraction, useful when the extracted template looks wrong and you want to
see why.

## Models

`claude-sonnet-5` drafts the template (the fast, capable workhorse tier —
CLAUDE.md §13.2's "default tier"), `claude-haiku-4-5` test-drives the result
(cheap/fast). Override either with `METAPROMPT_DRAFT_MODEL` /
`METAPROMPT_TEST_MODEL`.

Upstream's notebook pins its own draft model with a warning not to swap in a
newer chat model without checking it still accepts `temperature=0`. That
check no longer applies here: sampling controls (temperature/top_p/top_k)
were removed outright starting with the Sonnet 5 / Opus 5 / Fable 5
generation — Sonnet 5 rejects a non-default temperature with a 400, and the
`anthropic` 1.x SDK doesn't even expose the keyword client-side anymore.
Adaptive extended thinking (on by default on every current model this tool
uses) plus `output_config.effort` is the current quality/determinism knob —
don't reintroduce `temperature=`.

**CLAUDE.md is prompt-cached.** It's by far the largest and most stable part
of every `draft` call, so it's sent as a separate `system` block with its own
5-minute cache breakpoint rather than folded into the user turn. A `draft`
run prints a one-line note to stderr once the cache has actually been
written to or read from, e.g. `(CLAUDE.md context: 14219 tokens served from
cache, 0 written, 340 billed at full price)` — repeated runs within the same
prompt-engineering session should show most of it coming from cache.

**Safety refusals are handled explicitly.** If the model declines to draft a
template (`stop_reason: "refusal"`), the tool exits with the refusal category
rather than crashing on an empty response — rephrase `--task` and re-run.

## What this is not

- **Not a general-purpose chat tool.** It writes prompt *templates* — reusable
  instructions with `{$VARIABLE}` placeholders — not one-off answers.
- **Not wired into `.memory/`'s internals.** It shells out to
  `scripts/memory/query.py` rather than importing ChromaDB directly, the same
  CLI boundary that module's own README asks callers to respect.
- **`examples/` isn't pre-populated with fabricated sample output.** This
  project's own showcase convention (CLAUDE.md §12) is "no mocked data, no
  stand-ins" — a real Anthropic API call is needed to produce genuine output,
  so that directory starts empty with a note, not a hand-written fake
  transcript. Populate it yourself by copying a real `draft` run you like.
