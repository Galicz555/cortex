# Cortex

A knowledge base about AI engineering and the AI industry that maintains itself, written for a
coding agent (Claude) to read before it makes technical decisions in a given set of projects.

Every day it collects new entries from about 170 sources (vendor changelogs and docs, release
feeds of the projects' own dependencies, papers, newsletters, Hacker News, conference talks).
Sonnet scores each entry against short profiles of the projects, and Opus folds the accepted
findings into living topic notes in an Obsidian vault: current state, guidance, evidence with
independent origins, superseded claims and open questions. Deterministic lanes run beside the
models: OSV advisories for every project lockfile, and line diffs of watched pages (pricing,
deprecations, terms). Once a week Opus writes dated, scored forecasts.

- `docs/design.md`: the decisions and their reasons, known weaknesses, planned work.
- `AGENTS.md`: commands, the code map, and the rules that are easy to break.

## Design in brief

- **The model gets no tools.** Prompts carry untrusted web text, so every model call is
  `claude -p` in safe mode with no tools and no MCP servers. The model returns JSON checked
  with Zod; the code writes every file, and every model-produced name that reaches a path must
  pass a slug check.
- **Claims are data, notes are renders.** Opus returns operations (add, corroborate,
  supersede) whose sources must be this run's findings; code applies them in one transaction
  and renders the note. A claim is superseded only by evidence at least as trusted.
- **Trust tiers:** field reports from the projects themselves > primary sources > analysis >
  practitioners > news > the model's training knowledge. Aggregators' repetition counts as
  echo, not corroboration.
- **Crash-safe runs.** An entry is marked seen only once it has a verdict, and a topic leaves
  the queue only after its note is written.

## Threat model

- **The vault is untrusted input.** Every note is distilled by a model from web content. The
  pipeline's own model has no tools, but an agent with tools that reads the vault (its intended
  reader) must treat the notes as data, never as instructions.
- **Prose is not checked against claims.** Claims are tied to sources by code; the Current
  state, Guidance and Open questions prose is only asked to cite them.
- **Dependency release feeds are trusted by source kind, not authenticity.** A release note
  from a project's dependency counts as a primary source, whoever wrote it.
- **Fetches stay on the public internet.** Links taken from feeds and Hacker News are fetched
  only over http(s), to hosts that resolve to public addresses, redirects included.

## Requirements

- Node 26 (runs the TypeScript directly) and pnpm 11.
- The Claude Code CLI, logged in: models are called through `claude -p`.
- `uv` for the two Python helpers in `tools/` (page text extraction; video transcription with
  faster-whisper, which also needs `yt-dlp`, `ffmpeg` and an NVIDIA GPU).

## Setup

```bash
pnpm install
cp cortex.config.example.json cortex.config.json   # then list your projects
pnpm context      # profile each project from its own docs (Opus)
pnpm seed         # optional: starting topic notes from training knowledge, lowest trust
pnpm daily        # one full run
pnpm check        # format, lint, types, tests
```

`cortex.config.json` is gitignored. It holds:

- `projects`: each with a `name` (lowercase slug; it becomes a file name in the vault), a
  `path` to the project's checkout (relative to the config file), and optional `extraFiles`
  (documents outside the checkout that describe the project, relative to its path).
- `toolEnv` (optional): environment variables for the Python helpers, for example
  `UV_CACHE_DIR` or `HF_HOME` to move their caches.
- `sources` (optional): extra GitHub repositories whose commits on a branch are watched as
  primary sources, each with an `id` (slug), a `title`, the `repo` (`owner/name`) and the
  `branch`.

Every command stops at start when the file is missing or invalid. `CORTEX_CONFIG` points to a
different file; the tests use the example one. The static source list and the thresholds are
code, in `src/config.ts`.

## Scheduling

`deploy/` holds systemd user units: the daily run at 04:30 and the projections on Sunday
mornings, each followed by a commit of what changed in `vault/`. Set the checkout path in
`WorkingDirectory`, the log paths and `ExecStopPost`, copy the units to
`~/.config/systemd/user/`, and enable the two timers.

`deploy/commit-vault.sh` commits `vault/` into the checkout it runs in, and the vault describes
your projects. It does nothing while `vault/` is gitignored; if you un-ignore it to keep the
history, never push that checkout to a public remote (a fork must not carry it).

## Not in this repository

The vault itself, the run database (`data/`) and the skill that tells the reading agent how to
use the vault. The vault is generated, and its content is about the projects it was built for.

## License

The code is under the [MIT License](LICENSE).
