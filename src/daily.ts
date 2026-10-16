import { checkAdvisoriesInto } from "./advisories.ts";
import { MAX_TOPICS_PER_RUN, SOURCES } from "./config.ts";
import type { Entry, Finding, Source } from "./entries.ts";
import { reviewPracticesIn } from "./practice-review.ts";
import { logLine, toOriginKey } from "./shared.ts";
import { ADAPTERS } from "./sources/adapters.ts";
import { fetchDependencySources } from "./sources/dependencies.ts";
import type { Outcome, Store } from "./store.ts";
import { synthesizeTopicWith } from "./synthesize.ts";
import type { TopicUpdate } from "./synthesize.ts";
import { applyTopicUpdateTo } from "./topics.ts";
import { isAccepted, triageEntriesWith } from "./triage.ts";
import type { JudgedEntry } from "./triage.ts";
import {
  appendImpact,
  readProjectContexts,
  readRecentImpacts,
  writeIndex,
  writeRunLog,
  toLinkFrom,
  writeSourceNote,
} from "./vault.ts";

/**
 * Check our locked dependencies against known advisories, then collect what is new, judge it,
 * file what is useful, fold it into the topic notes, and read the new claims for practices.
 */
export const runDaily = (store: Store): Promise<void> =>
  checkAdvisoriesInto(store)
    .then(() => collectNewEntriesFrom(store))
    .then(judgeEntriesInto(store))
    .then(() => synthesizePendingTopicsFrom(store))
    .then(reportRun)
    .then(() => reviewPracticesIn(store));

// --- collect -------------------------------------------------------------------------------

const collectNewEntriesFrom = (store: Store): Promise<Entry[]> =>
  listAllSources().then(fetchUnseenEntriesInto(store)).then(expandEntriesInto(store));

/** A failing registry lookup costs the dependency feeds for one run, never the whole run. */
const listAllSources = async (): Promise<Source[]> => {
  const dependencySources = await fetchDependencySources().catch((error: unknown) => {
    logLine(`dependency sources failed, static sources only: ${String(error)}`);
    return [];
  });
  return [...SOURCES, ...dependencySources];
};

// ~150 sources, most of them github.com release feeds: a few at a time, not all at once.
const SOURCES_IN_FLIGHT = 10;

const fetchUnseenEntriesInto =
  (store: Store) =>
  async (sources: Source[]): Promise<Entry[]> => {
    const unseen: Entry[] = [];
    for (let i = 0; i < sources.length; i += SOURCES_IN_FLIGHT) {
      const chunk = sources.slice(i, i + SOURCES_IN_FLIGHT);
      const results = await Promise.allSettled(chunk.map(fetchUnseenEntriesFrom(store)));
      results.forEach((result, j) => {
        if (result.status === "fulfilled") unseen.push(...result.value);
        else logLine(`source ${chunk[j]?.id ?? "?"} failed: ${String(result.reason)}`);
      });
    }
    return unseen;
  };

/**
 * On a source's first run everything but its newest `bootstrapKeep` entries is marked seen:
 * Cortex starts from today, not from the source's whole history.
 */
const fetchUnseenEntriesFrom =
  (store: Store) =>
  async (source: Source): Promise<Entry[]> => {
    const entries = await ADAPTERS[source.kind].fetchEntries(source);
    if (!store.hasHistory(source.id)) {
      store.markSeen(entries.slice(source.bootstrapKeep), "bootstrap");
      return entries.slice(0, source.bootstrapKeep);
    }
    return entries.filter((entry) => !store.isSeen(entry.id));
  };

/** One at a time: transcription holds the GPU and audio downloads should not burst. */
const expandEntriesInto =
  (store: Store) =>
  async (entries: Entry[]): Promise<Entry[]> => {
    const expanded: Entry[] = [];
    for (const entry of entries) {
      try {
        const full = await ADAPTERS[entry.source.kind].expandEntry(entry);
        logLine(`expanded ${entry.id}: ${full.text.split(/\s+/).length} words`);
        expanded.push(full);
      } catch (error) {
        logLine(`expand ${entry.id} failed, marked failed: ${String(error)}`);
        await markEntrySeenIn(store)(entry, "failed");
      }
    }
    logLine(`collected ${expanded.length} new entries`);
    return expanded;
  };

const markEntrySeenIn =
  (store: Store) =>
  async (entry: Entry, outcome: Outcome): Promise<void> => {
    store.markSeen([entry], outcome);
    await ADAPTERS[entry.source.kind].commitEntry?.(entry);
  };

// --- judge ---------------------------------------------------------------------------------

const judgeEntriesInto =
  (store: Store) =>
  async (entries: Entry[]): Promise<void> => {
    if (entries.length === 0) return;
    const judged = await triageEntriesWith({
      projectContexts: await readProjectContexts(),
      topicIndex: await writeIndex(),
    })(entries);
    for (const item of judged) await fileJudgedEntryInto(store)(item);
    await writeRunLog(["## Triage", "", ...judged.map(toVerdictLine)]);
    logLine(`judged ${judged.length}, accepted ${judged.filter(isAccepted).length}`);
  };

/** Rejections are logged with their reason too: they are how the filter gets calibrated. */
const toVerdictLine = (judged: JudgedEntry): string =>
  `- ${judged.verdict.score}/10 ${isAccepted(judged) ? "kept" : "dropped"} [${judged.entry.title}](${toLinkFrom("log", judged.entry.url)}): ${judged.verdict.reason}`;

const fileJudgedEntryInto =
  (store: Store) =>
  async (judged: JudgedEntry): Promise<void> => {
    if (!isAccepted(judged)) {
      await markEntrySeenIn(store)(judged.entry, "rejected");
      return;
    }
    store.queueFinding(toFinding(judged, await writeSourceNote(judged.entry, judged.verdict)));
    await markEntrySeenIn(store)(judged.entry, "accepted");
  };

const toFinding = ({ entry, verdict }: JudgedEntry, sourceNote: string): Finding => ({
  entryId: entry.id,
  sourceTitle: entry.source.title,
  trust: entry.source.trust,
  title: entry.title,
  url: entry.url,
  publishedOn: entry.publishedOn,
  summary: verdict.summary,
  claims: verdict.claims,
  topics: verdict.topics,
  projects: verdict.projects,
  sourceNote,
  origin: toOriginKey(verdict.origin || entry.url),
});

// --- synthesize ----------------------------------------------------------------------------

type SynthesizedTopic = TopicUpdate & { slug: string };

/** A topic leaves the queue only after its update is applied, so a failed one retries tomorrow. */
const synthesizePendingTopicsFrom = async (store: Store): Promise<SynthesizedTopic[]> => {
  const pending = store.fetchPendingTopics(MAX_TOPICS_PER_RUN);
  const synthesize = synthesizeTopicWith({
    projectContexts: await readProjectContexts(),
    allTopics: [...new Set([...store.listTopics(), ...pending.keys()])],
  });
  const written: SynthesizedTopic[] = [];
  for (const [slug, findings] of pending) {
    try {
      const update = await synthesize({
        slug,
        topic: store.fetchTopic(slug),
        claims: store.fetchClaims(slug),
        findings,
        recentImpacts: await readRecentImpacts(),
      });
      await applyTopicUpdateTo(store)(slug, update);
      for (const impact of update.impacts)
        await appendImpact(impact.project, { link: `topics/${slug}`, ...impact });
      store.clearPendingTopic(slug);
      written.push({ ...update, slug });
    } catch (error) {
      logLine(`synthesis of ${slug} failed, stays queued: ${String(error)}`);
    }
  }
  await writeIndex();
  logLine(`synthesized ${written.length} topics, ${store.countPendingTopics()} still queued`);
  return written;
};

// --- report --------------------------------------------------------------------------------

const reportRun = (topics: SynthesizedTopic[]): Promise<void> =>
  writeRunLog([
    `## Run ${new Date().toISOString()}`,
    "",
    ...topics.map(
      (topic) =>
        `- [[topics/${topic.slug}]]: +${topic.adds.length} claims, ${topic.corroborations.length} corroborated, ${topic.supersessions.length} superseded. ${topic.prose.summary}`,
    ),
    ...topics.flatMap((topic) =>
      topic.rejected.map((reason) => `- rejected in ${topic.slug}: ${reason}`),
    ),
    ...topics.flatMap((topic) =>
      topic.impacts
        .filter((impact) => impact.severity === "notify")
        .map((impact) => `- **needs attention** (${impact.project}): ${impact.note}`),
    ),
  ]);
