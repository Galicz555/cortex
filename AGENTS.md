# AGENTS.md

Cortex: a knowledge base about AI engineering and the AI industry, written for Claude to read
before decisions in the owner's projects. A daily run collects sources, Sonnet judges each new entry
against the project profiles, and Opus folds the accepted findings into living topic notes in
`vault/` (an Obsidian vault). The reader-facing contract is a Claude Code skill kept outside this repository.

## Commands

```bash
pnpm install
pnpm daily       # one run: collect → triage → source notes → topic synthesis → index
pnpm context [project]  # rebuild vault/context/<project>.md from the project's own docs (Opus)
pnpm practices   # review claims not yet read for practice changes (also part of the daily run)
pnpm compare opus-3 opus-5.5 [api|claude-code]  # render vault/compare/<from>--<to>.md
pnpm seed        # one-off: Opus writes starting topic notes from training knowledge (lowest trust)
pnpm check       # format → lint → types → tests; must be green before any commit
uv run --script tools/test_page_text.py  # page_text.py's address guard, offline
uv run --script tools/test_transcribe.py  # transcribe.py's piece size, model stubbed
```

Node 26 runs the `.ts` files directly (type stripping): only erasable syntax. Relative imports
carry the `.ts` extension.

Two Python helpers run through `uv`: `tools/transcribe.py` (faster-whisper on the GPU, for
videos) and `tools/page_text.py` (Scrapling, robots.txt and backoff, for pages without a feed).
The daily run is the systemd user timer in `deploy/`.

Sources are data in `src/config.ts`; dependency release feeds are derived at run time from the
projects' `package.json` / `pyproject.toml` (repo lookups cached in `data/repos.json`).

The projects themselves, extra watched GitHub repositories (`sources`), and the Python tools'
extra environment are this machine's settings:
`cortex.config.json` (gitignored; shape in `cortex.config.example.json`, schema in
`src/config.ts`). Every command fails at start when it is missing or invalid. The tests run
against the example file (`CORTEX_CONFIG` in `vitest.config.ts`).

## Flow

| Path                     | What                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `src/config.ts`          | Sources, thresholds, paths; loads the projects from `cortex.config.json`   |
| `src/daily.ts`           | The daily run, top to bottom                                               |
| `src/sources/`           | One adapter per source kind: cheap `fetchEntries`, expensive `expandEntry` |
| `src/seed.ts`            | Starting topic notes from Opus's training knowledge                        |
| `src/triage.ts`          | Sonnet verdicts per entry                                                  |
| `src/synthesize.ts`      | Opus decides claim operations (add/corroborate/supersede) + prose; checked |
| `src/knowledge.ts`       | Topics, claims and claim sources in the database                           |
| `src/topic-note.ts`      | Renders a topic note from the database (notes are never edited in place)   |
| `src/practices.ts`       | Practices and their stances by model version, in the database              |
| `src/practice-review.ts` | Opus reads new claims for practice changes; checked like synthesis         |
| `src/practice-note.ts`   | Renders `vault/practices.md` and `pnpm compare` notes                      |
| `src/advisories.ts`      | OSV check of every project's lockfile: deterministic, no model             |
| `src/projections.ts`     | Weekly scored forecasts                                                    |
| `src/vault.ts`           | Every file write into `vault/`                                             |
| `src/store.ts`           | `data/cortex.db` (node:sqlite): seen entries, findings queued per topic    |
| `src/claude.ts`          | The only way to call a model                                               |

## Rules that are easy to break

- Model calls go through `askClaude` only: `claude -p` in safe mode with **no tools**. Prompts
  carry untrusted web text; the model returns JSON and our code writes the files. Never give
  the pipeline's model a tool.
- Every model-produced name that reaches a path passes `isSlug`; every project name is checked
  against `PROJECTS`. A new guard gets a test that fails when the guard is removed.
- Topic notes are a render of `topic` / `claim` / `claim_source`. A model never writes a note:
  it returns operations whose sources must be this run's findings, and a claim can only be
  superseded by evidence at least as trusted (training claims excepted).
- Independent origins, not mentions, measure corroboration: triage names each entry's origin.
- An entry is marked seen only once it has a verdict (or failed to expand); a topic leaves the
  queue only after its note is written. A crash mid-run loses nothing.
- Untrusted text in prompts sits inside tagged blocks the prompt declares as data.
- A URL taken from fetched content is fetched only through `fetchPageText`, which refuses
  anything but http(s) to public addresses (`tools/page_text.py` re-checks every redirect hop).
- No role-play or persona text in code, comments, prompts or commit messages.
