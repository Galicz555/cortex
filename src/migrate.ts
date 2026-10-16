import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askClaude } from "./claude.ts";
import { VAULT } from "./config.ts";
import { TRUST_ORDER } from "./entries.ts";
import type { ClaimSource } from "./knowledge.ts";
import { logLine, todayIn, toOriginKey } from "./shared.ts";
import type { Store } from "./store.ts";
import { applyTopicUpdateTo } from "./topics.ts";
import { fetchTopicNote, listTopicSlugs, writeIndex } from "./vault.ts";

const MIGRATION_TIMEOUT_MS = 15 * 60_000;
const UNSOURCED_NOTE = "sources/training/migration";

const UNSOURCED: ClaimSource = {
  sourceNote: UNSOURCED_NOTE,
  title: "No resolvable source after migration",
  trust: "training",
  origin: "training:migration",
};

const Extracted = z.object({
  currentState: z.string(),
  guidance: z.string(),
  openQuestions: z.string(),
  related: z.array(z.string()),
  claims: z.array(
    z.object({
      text: z.string().min(1),
      statedOn: z.string(),
      sourceLinks: z.array(z.string()),
    }),
  ),
});

/**
 * One-off: turns topic notes written before claims were stored as data into topic rows and
 * claims. Sonnet only splits the note; every source link it reports is checked against the
 * source notes on disk, and a claim whose links resolve to nothing gets the lowest trust.
 */
export const migrateTopicNotes = async (store: Store): Promise<void> => {
  await writeUnsourcedNote();
  const allTopics = await listTopicSlugs();
  for (const slug of allTopics.filter((candidate) => store.fetchTopic(candidate) === null)) {
    const note = (await fetchTopicNote(slug)) ?? "";
    try {
      const extracted = await askClaude({
        purpose: "migration",
        model: "sonnet",
        prompt: toMigrationPrompt(note),
        schema: Extracted,
        timeoutMs: MIGRATION_TIMEOUT_MS,
      });
      const claims = await Promise.all(
        extracted.claims.map(async (claim, i) => ({
          ref: `N${i + 1}`,
          text: claim.text,
          statedOn: /^\d{4}-\d{2}-\d{2}$/.test(claim.statedOn) ? claim.statedOn : todayIn(),
          sources: await resolveSources(claim.sourceLinks),
        })),
      );
      await applyTopicUpdateTo(store)(slug, {
        prose: {
          title: frontmatterValue(note, "title") ?? slug,
          summary: frontmatterValue(note, "summary") ?? "",
          currentState: extracted.currentState,
          guidance: extracted.guidance,
          openQuestions: extracted.openQuestions,
          related: extracted.related.filter((other) => allTopics.includes(other) && other !== slug),
        },
        adds: claims,
        corroborations: [],
        supersessions: [],
        impacts: [],
        rejected: [],
      });
      logLine(`migrate: ${slug}, ${claims.length} claims`);
    } catch (error) {
      logLine(`migrate: ${slug} failed, note left as it was: ${String(error)}`);
    }
  }
  await writeIndex();
};

const resolveSources = async (links: string[]): Promise<ClaimSource[]> => {
  const resolved = (await Promise.all(links.map(resolveSource))).flatMap((source) =>
    source === null ? [] : [source],
  );
  return resolved.length > 0 ? resolved : [UNSOURCED];
};

/** A wikilink target counts only if it names a source note that exists in the vault. */
const resolveSource = async (link: string): Promise<ClaimSource | null> => {
  const target =
    link
      .replace(/^\[\[|\]\]$/g, "")
      .split("|")[0]
      ?.trim() ?? "";
  if (!/^sources\/[\w./-]+$/.test(target) || target.includes("..")) return null;
  const text = await readFile(path.join(VAULT, `${target}.md`), "utf8").catch(() => null);
  if (text === null) return null;
  const trust = z.enum(TRUST_ORDER).safeParse(frontmatterValue(text, "trust"));
  return {
    sourceNote: target,
    title: frontmatterValue(text, "title") ?? target,
    trust: trust.success ? trust.data : "training",
    origin: toOriginKey(frontmatterValue(text, "url") ?? target),
  };
};

const frontmatterValue = (markdown: string, key: string): string | undefined => {
  const raw = new RegExp(`^${key}: (.*)$`, "m").exec(markdown)?.[1]?.trim();
  if (raw === undefined) return undefined;
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw;
  }
};

const writeUnsourcedNote = async (): Promise<void> => {
  const file = path.join(VAULT, `${UNSOURCED_NOTE}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `---
title: "No resolvable source after migration"
trust: training
published: ${todayIn()}
---

# No resolvable source after migration

Claims citing this note came from a topic note written before claims were stored as data, and
none of their links pointed at a source note on disk. Treat them as unverified background.
`,
  );
};

const toMigrationPrompt = (note: string): string => `Split this knowledge-base topic note into
structured parts. Do not add, drop or change any fact; only restructure.

- claims: every factual claim in the note (usually the "Evidence" bullets, plus any fact stated
  only in other sections), each one self-contained, with the date it carries (YYYY-MM-DD; if
  none, use ${todayIn()}) and sourceLinks: the exact wikilink targets it cites, like
  "sources/2026-10/claude-code-changelog--2-1-285" or "sources/training/opus" (the part before
  "|", without brackets). Superseded claims are not claims: leave them out.
- currentState, guidance, openQuestions: the text of those sections, unchanged, as markdown.
- related: the topic slugs linked as [[topics/<slug>]] in the Related section.

<note>
${note}
</note>`;
