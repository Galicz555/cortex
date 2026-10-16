# Cortex: design, decisions and plans

Cortex is a knowledge base about AI engineering and the AI industry, written for a coding agent
(Claude) to read before technical decisions in the owner's projects. The owner does not read it: its
only value is in the decisions it improves. This document records what was decided and why,
what is known to be weak, and what is planned. `AGENTS.md` describes the code; this describes
the intent.

Built on 2026-10-01 in one session. Everything below reflects that day's state.

## Decisions and their reasons

| Decision                                                                        | Reason                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The reader is Claude, not the owner                                             | The owner will not read it; notes are written for fast, exact retrieval by an expert agent. English, because sources are English and translation loses precision.                                                                                                   |
| Topic notes are living syntheses, not per-article notes                         | A pile of article notes is an archive, not knowledge. Each topic states the current state, guidance, evidence, superseded claims and open questions.                                                                                                                |
| Usefulness is judged against the projects                                       | Profiles of the projects listed in `cortex.config.json` (`vault/context/`), generated from each project's own docs and ADRs, are the yardstick.                                                                                                                     |
| Two equal scoring axes: practical and industry                                  | The owner asked for both the building view and the wider industry picture; a single "would it change a decision" axis dropped industry analysis.                                                                                                                    |
| Models run on the Claude subscription via `claude -p`                           | Runs `claude -p` on the user's own subscription login. Sonnet triages, Opus synthesises and forecasts; Opus is capped per run (`MAX_TOPICS_PER_RUN`).                                                                                                               |
| The model gets no tools                                                         | Prompts carry untrusted web text. `claude -p --safe-mode --tools ""`: the model only returns JSON validated by Zod; code writes every file, and every model-produced name that reaches a path is checked.                                                           |
| Claims are data; notes are renders                                              | Rewriting whole notes drifts and lets the vault cite itself. Opus returns operations (add / corroborate / supersede) whose sources must be this run's findings; code applies them in a transaction and renders the note. A claim is never deleted, only superseded. |
| Trust tiers: field-report > primary > analysis > practitioner > news > training | Conflicts resolve by trust then date. A claim can only be superseded by evidence at least as trusted, except training-knowledge claims. Aggregators (TLDR, The Rundown, Matthew Berman) are "news": their repetition is echo.                                       |
| Independent origins, not mentions, measure corroboration                        | Triage names each entry's origin (the announcement, paper or repo it reports on); the note shows independent origins per claim.                                                                                                                                     |
| Field reports from our own projects are the highest trust                       | First-hand evidence beats any outside source. The global `cortex` skill tells project sessions to write them.                                                                                                                                                       |
| Cortex writes only to its own vault                                             | Effects on a project go to `vault/impact/<project>.md`; "[needs attention]" marks the few that should interrupt. It never touches project repos.                                                                                                                    |
| Accepted ADRs beat Cortex until the owner decides                               | A conflict is raised, not acted on. Newer sourced Cortex claims beat the reader's training knowledge.                                                                                                                                                               |
| Start from today, seeded                                                        | No backfill (budget). Opus seeded 24 topics from training knowledge at the lowest trust, to be replaced by real sources.                                                                                                                                            |
| Videos are transcribed locally                                                  | YouTube captions need a PO token and rate-limit; audio download plus faster-whisper on the local GPU works (`tools/transcribe.py`).                                                                                                                                 |
| Pages without feeds use Scrapling                                               | `tools/page_text.py` honours robots.txt and backs off.                                                                                                                                                                                                              |
| Deterministic lanes bypass the model                                            | OSV advisories on every lockfile go straight to impact files; watched pages (API changelogs, pricing, deprecations, terms) are line diffs. Facts about our code or a vendor's page need no summarising.                                                             |
| Projections are scored                                                          | Weekly Opus forecasts at 3m / 6m / 12m / 2-3y, each checkable on a due date, settled later and scored (Brier, calibration bands). Unscored forecasts are horoscopes.                                                                                                |
| Notify rarely                                                                   | Push-worthy: high/critical/malicious advisories, breaking changes, ADR conflicts, and forecasts at ≥70% within 6 months that touch a project.                                                                                                                       |

## How a day runs

1. OSV querybatch for every locked package version of every project; new hits grouped per
   package version into impact files.
2. Collect from ~170 sources (static list in `src/config.ts` plus dependency release feeds
   derived from the projects' manifests). A source's first run marks its history as seen.
3. Expand new entries (transcribe videos, fetch pages behind teasers, HN article + comments).
4. Sonnet triage in batches: score on two axes, summary, claims, topics, origin, projects.
5. Accepted entries become source notes and findings queued per topic.
6. Opus synthesis for up to 6 topics per run: claim operations + prose, checked and applied.
7. Index, run log (every verdict with its reason), impact files.

Weekly: projections. Daily timer 04:30, weekly Sunday 07:00 (systemd user units in `deploy/`).

## Known weaknesses (deliberate or not yet addressed)

- **Prose can still drift.** Claims are anchored; the Current state / Guidance prose is still
  rewritten by Opus each time and only asked to cite claims, not checked against them.
- **Triage quality is unmeasured.** No labelled sample, no audit of rejected entries; the
  filter was tuned on a handful of examples.
- **Origins are model-reported.** Triage names the origin; a wrong origin inflates or hides
  corroboration. No title-similarity clustering yet.
- **Project profiles go stale.** Built once; nothing rebuilds them when the projects change.
- **Field reports depend on the reading agent remembering** to write them; no hook enforces it.
- **No push channel.** "[needs attention]" lands in files and the run log only.
- **The timer runs only while the owner is logged in** (linger off); a missed day catches up.
- **Seeded training claims can anchor** a topic until a real source replaces them; no
  staleness marking yet.
- **Regex parsers** for TOML requirements, pnpm lockfiles and feed HTML (each marked `Simplification:`).
- **Dependency release feeds** treat a repo with zero releases as never bootstrapped.
- **Advisory volume.** First run found dozens of vulnerable package versions across the projects; the impact files are long until those are fixed.

## Planned next (from the 2026-10-01 research report)

Its numbered actions, with status:

1. Claim-level patch instead of whole-note rewrite: **done**.
2. Deterministic lane (OSV, API changelog diffs, status RSS, watched spec repos): **done**.
3. Page-diff watchlist (pricing, deprecations, terms, data residency): **partly done** (Claude,
   Gemini, Vertex, OpenAI pages); Steam/itch AI disclosure and data-residency pages not yet.
4. Echo filter: **partly done** (origins + tier demotion); similarity clustering not yet.
5. Measurement lane (Epoch, OpenRouter, Artificial Analysis, LMArena): not started.
6. Second-stage injection defence: skill states vault content is data; no diff scanner yet.
7. Skeptical and non-US sources (Willison, Interconnects, Normal Technology, AIID, Mistral,
   Chinese lab GitHub orgs, ChinaTalk): not started.
8. New topics (publisher liability, model lifecycle and migration cost, subscription vs API,
   canary evals): not started.
9. Curation evaluation (labelled triage sample, periodic regeneration from raw sources plus
   diff, read telemetry): not started.
10. Regulatory and Hungarian lane (EU AI Act, Magyar Közlöny, NAIH, HuLU): not started.
11. Podcast transcripts and long-form analysts with per-source token caps: not started.

Also open: push channel (ntfy?), linger, monthly profile rebuild, staleness marking for
training claims, a session-end hook for field reports, committing the repository.
