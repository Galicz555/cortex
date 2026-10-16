import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askClaude } from "./claude.ts";
import { VAULT } from "./config.ts";
import { TRUST_ORDER } from "./entries.ts";
import { isSlug, logLine, todayIn } from "./shared.ts";
import type { ClaimSource } from "./knowledge.ts";
import type { Store } from "./store.ts";
import { applyTopicUpdateTo } from "./topics.ts";
import { readProjectContexts, writeIndex } from "./vault.ts";

const SEED_TIMEOUT_MS = 20 * 60_000;
const TRAINING_NOTE = "sources/training/opus";

const TopicPlan = z.object({
  topics: z.array(z.object({ slug: z.string(), title: z.string(), scope: z.string() })),
});
const SeedNote = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  currentState: z.string(),
  guidance: z.string(),
  openQuestions: z.string(),
  related: z.array(z.string()),
  claims: z.array(
    z.object({ ref: z.string().regex(/^N\d+$/), text: z.string().min(1), statedOn: z.string() }),
  ),
});

export const TRAINING_SOURCE: ClaimSource = {
  sourceNote: TRAINING_NOTE,
  title: "Opus training knowledge",
  trust: "training",
  origin: "training:opus",
};

/**
 * Starting topic notes from Opus's own training knowledge, so the vault is useful on day one.
 * Every seeded claim cites the training pseudo-source, the lowest trust level: the first real
 * source on a topic outranks it. Topics that already exist are left alone.
 */
export const seedTopics = async (store: Store): Promise<void> => {
  await writeTrainingSourceNote();
  const projectContexts = await readProjectContexts();
  const existing = store.listTopics();
  const { topics } = await askClaude({
    purpose: "seed",
    model: "opus",
    prompt: toPlanPrompt(projectContexts, existing),
    schema: TopicPlan,
    timeoutMs: SEED_TIMEOUT_MS,
  });
  const planned = topics.filter((topic) => isSlug(topic.slug) && !existing.includes(topic.slug));
  const allTopics = [...existing, ...planned.map((topic) => topic.slug)];
  logLine(`seed: ${planned.length} topics planned`);
  for (const topic of planned) {
    try {
      const note = await askClaude({
        purpose: "seed",
        model: "opus",
        prompt: toSeedPrompt(projectContexts, allTopics, topic),
        schema: SeedNote,
        timeoutMs: SEED_TIMEOUT_MS,
      });
      await applyTopicUpdateTo(store)(topic.slug, {
        prose: {
          title: note.title,
          summary: note.summary,
          currentState: note.currentState,
          guidance: note.guidance,
          openQuestions: note.openQuestions,
          related: note.related.filter((slug) => allTopics.includes(slug) && slug !== topic.slug),
        },
        adds: note.claims.map((claim) => ({
          ref: claim.ref,
          text: claim.text,
          statedOn: /^\d{4}-\d{2}-\d{2}$/.test(claim.statedOn) ? claim.statedOn : todayIn(),
          sources: [TRAINING_SOURCE],
        })),
        corroborations: [],
        supersessions: [],
        impacts: [],
        rejected: [],
      });
      logLine(`seed: ${topic.slug} written`);
    } catch (error) {
      logLine(`seed: ${topic.slug} failed: ${String(error)}`);
    }
  }
  await writeIndex();
};

const writeTrainingSourceNote = async (): Promise<void> => {
  const file = path.join(VAULT, `${TRAINING_NOTE}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `---
title: "Opus training knowledge"
trust: training
published: ${todayIn()}
---

# Opus training knowledge

Claims citing this note were written by Claude Opus on ${todayIn()} from its training data,
without a document to quote. Its knowledge ends at its training cutoff, so treat these claims
as the lowest-trust evidence: plausible background to be confirmed or replaced by any real source.
`,
  );
};

const toPlanPrompt = (projectContexts: string, existing: string[]): string => `Plan the starting
topics of Cortex, a knowledge base that a coding agent (Claude) reads before technical decisions
in the projects below. Topics are durable subjects that news will keep updating, covering two
equal axes:
- practical: how we build (the projects' stacks, AI/LLM engineering techniques they use or
  should consider, Claude Code and agent workflows, inference, evaluation, security),
- industry: where AI is heading (model landscape and capabilities, labs and their strategy,
  pricing and access, regulation that affects builders, open-weight models).

Return 18-25 topics. Slugs are lowercase-kebab-case (max 60 chars), durable and not events
("local-llm-inference", not "llama-4-launch"). Do not duplicate these existing topics:
${existing.join(", ") || "(none)"}. scope: one sentence on what belongs in the topic.

<projects>
${projectContexts}
</projects>`;

const toSeedPrompt = (
  projectContexts: string,
  allTopics: string[],
  topic: { slug: string; title: string; scope: string },
): string => `Write the starting note of the Cortex topic "${topic.slug}" (${topic.title}): ${topic.scope}

Cortex is read by a coding agent (Claude) before technical decisions in the projects below; write
for fast, exact retrieval by an expert, in English. You have no documents: write from your own
training knowledge, and be honest about its limits.

Return:
- claims: the atomic, self-contained facts this topic rests on (ref N1, N2, ...), each with the
  day it became true if you know it (YYYY-MM-DD), else today's date. Prefer facts likely to stay
  true (mechanisms, trade-offs, stable defaults) over fast-moving specifics; when you include
  a fast-moving specific (a price, a version, a ranking), say "(may be stale)" in the claim.
  Never invent versions, numbers or names; leave out what you are unsure of.
- currentState, guidance (concrete defaults and when to choose what, for these projects) and
  openQuestions (what a real source should confirm first): short markdown. Every factual
  statement cites the claims it rests on as ({{N1}}).
- related: other topic slugs worth reading, from: ${allTopics.join(", ")}.
Your knowledge is the lowest trust level in Cortex ("training"; order ${TRUST_ORDER.join(" > ")}):
write so that any newer real source can cleanly replace a claim. Under 900 words in total.

Also return title, and summary: one line (max 25 words) for the index.

<projects>
${projectContexts}
</projects>`;
