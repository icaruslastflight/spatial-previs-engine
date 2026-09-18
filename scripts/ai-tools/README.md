# Metaprompt — project-customized prompt drafting

A project-customized fork of Anthropic's cookbook notebook
([`misc/metaprompt.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb),
fetched 2026-09-18). Solves the "blank page problem": give it a task, it
drafts a full Claude prompt template for that task, then optionally
test-drives the result. Ported to a plain CLI rather than a notebook for the
same reason `scripts/memory/` is a CLI — no Jupyter dependency for a fresh
workstation, and notebook JSON diffs badly against this repo's otherwise
clean text-diff discipline.

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

Pinned to upstream's current choices as of the fetch date above:
`claude-sonnet-4-6` to draft (upstream's own comment: don't swap in a newer
chat-tier model here without checking it still accepts `temperature=0`),
`claude-haiku-4-5` (fast/cheap) to test-drive the result. Override with the
`METAPROMPT_DRAFT_MODEL` / `METAPROMPT_TEST_MODEL` env vars if you need to.

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
