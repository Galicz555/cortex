import type { Store } from "./store.ts";
import type { TopicUpdate } from "./synthesize.ts";
import { toProseWithClaimIds } from "./synthesize.ts";
import { renderTopicNote } from "./topic-note.ts";
import { writeTopicFile } from "./vault.ts";

/** One topic's checked update, applied atomically, then the note re-rendered from the database. */
export const applyTopicUpdateTo =
  (store: Store) =>
  async (slug: string, update: TopicUpdate): Promise<void> => {
    store.inTransaction(() => {
      const ids = new Map<string, number>();
      store.saveTopic(slug, update.prose);
      for (const add of update.adds) ids.set(add.ref, store.addClaim(slug, add));
      for (const item of update.corroborations) store.addSources(item.claimId, item.sources);
      for (const item of update.supersessions) {
        const by = item.by.startsWith("N") ? ids.get(item.by) : Number(item.by.slice(1));
        if (by !== undefined) store.supersedeClaim(item.claimId, by, item.reason);
      }
      store.saveTopic(slug, {
        ...update.prose,
        currentState: toProseWithClaimIds(update.prose.currentState, ids),
        guidance: toProseWithClaimIds(update.prose.guidance, ids),
        openQuestions: toProseWithClaimIds(update.prose.openQuestions, ids),
      });
    });
    await renderTopicInto(store)(slug);
  };

export const renderTopicInto =
  (store: Store) =>
  async (slug: string): Promise<void> => {
    const topic = store.fetchTopic(slug);
    if (topic === null) throw new Error(`no topic ${slug} in the database`);
    await writeTopicFile(slug, renderTopicNote(topic, store.fetchClaims(slug)));
  };
