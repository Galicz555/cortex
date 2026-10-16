import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { TRUST_ORDER } from "./entries.ts";
import type { Trust } from "./entries.ts";
import { todayIn } from "./shared.ts";

/**
 * Topic notes are rendered from these tables, never edited in place. A claim is an atomic,
 * dated statement; its sources say who said it, and their origins say how many independent
 * parties did. A claim is never deleted: newer evidence supersedes it.
 */
export const KNOWLEDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS topic (
    slug           TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    summary        TEXT NOT NULL,
    current_state  TEXT NOT NULL,
    guidance       TEXT NOT NULL,
    open_questions TEXT NOT NULL,
    related        TEXT NOT NULL,
    updated_on     TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS claim (
    id             INTEGER PRIMARY KEY,
    topic          TEXT NOT NULL REFERENCES topic (slug),
    text           TEXT NOT NULL,
    stated_on      TEXT NOT NULL,
    added_on       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    superseded_by  INTEGER REFERENCES claim (id),
    superseded_on  TEXT,
    reason         TEXT,
    CHECK ((status = 'superseded') = (superseded_on IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS claim_topic ON claim (topic, status);

  CREATE TABLE IF NOT EXISTS claim_source (
    claim_id    INTEGER NOT NULL REFERENCES claim (id),
    source_note TEXT NOT NULL,
    title       TEXT NOT NULL,
    trust       TEXT NOT NULL,
    origin      TEXT NOT NULL,
    PRIMARY KEY (claim_id, source_note)
  ) STRICT;
`;

export type ClaimSource = { sourceNote: string; title: string; trust: Trust; origin: string };

export type Claim = {
  id: number;
  topic: string;
  text: string;
  statedOn: string;
  status: "active" | "superseded";
  supersededBy: number | null;
  supersededOn: string | null;
  reason: string | null;
  sources: ClaimSource[];
};

export type TopicProse = {
  title: string;
  summary: string;
  currentState: string;
  guidance: string;
  openQuestions: string;
  related: string[];
};

export type Topic = TopicProse & { slug: string; updatedOn: string };

export type NewClaim = { text: string; statedOn: string; sources: ClaimSource[] };

const ClaimRow = z.object({
  id: z.number(),
  topic: z.string(),
  text: z.string(),
  stated_on: z.string(),
  status: z.enum(["active", "superseded"]),
  superseded_by: z.number().nullable(),
  superseded_on: z.string().nullable(),
  reason: z.string().nullable(),
});
const SourceRow = z.object({
  claim_id: z.number(),
  source_note: z.string(),
  title: z.string(),
  trust: z.enum(TRUST_ORDER),
  origin: z.string(),
});
const TopicRow = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  current_state: z.string(),
  guidance: z.string(),
  open_questions: z.string(),
  related: z.string(),
  updated_on: z.string(),
});

/** The best trust among a claim's sources is the claim's trust. */
export const toClaimTrust = (sources: ClaimSource[]): Trust =>
  TRUST_ORDER[Math.min(...sources.map((source) => TRUST_ORDER.indexOf(source.trust)))] ??
  "training";

export const countOrigins = (sources: ClaimSource[]): number =>
  new Set(sources.map((source) => source.origin)).size;

const toClaims = (claimRows: unknown[], sourceRows: unknown[]): Claim[] => {
  const sources = sourceRows.map((row) => SourceRow.parse(row));
  return claimRows.map((row) => {
    const claim = ClaimRow.parse(row);
    return {
      id: claim.id,
      topic: claim.topic,
      text: claim.text,
      statedOn: claim.stated_on,
      status: claim.status,
      supersededBy: claim.superseded_by,
      supersededOn: claim.superseded_on,
      reason: claim.reason,
      sources: sources
        .filter((source) => source.claim_id === claim.id)
        .map((source) => ({
          sourceNote: source.source_note,
          title: source.title,
          trust: source.trust,
          origin: source.origin,
        })),
    };
  });
};

export const bindKnowledge = (db: DatabaseSync) => {
  const fetchTopic = (slug: string): Topic | null => {
    const row = db.prepare("SELECT * FROM topic WHERE slug = ?").get(slug);
    if (row === undefined) return null;
    const topic = TopicRow.parse(row);
    return {
      slug: topic.slug,
      title: topic.title,
      summary: topic.summary,
      currentState: topic.current_state,
      guidance: topic.guidance,
      openQuestions: topic.open_questions,
      related: z.array(z.string()).parse(JSON.parse(topic.related)),
      updatedOn: topic.updated_on,
    };
  };

  const listTopics = (): string[] =>
    db
      .prepare("SELECT slug FROM topic ORDER BY slug")
      .all()
      .map((row) => z.object({ slug: z.string() }).parse(row).slug);

  const fetchClaims = (topic: string): Claim[] =>
    toClaims(
      db.prepare("SELECT * FROM claim WHERE topic = ? ORDER BY stated_on DESC, id").all(topic),
      db
        .prepare(
          "SELECT s.* FROM claim_source s JOIN claim c ON c.id = s.claim_id WHERE c.topic = ?",
        )
        .all(topic),
    );

  const fetchClaimsByIds = (ids: number[]): Claim[] =>
    toClaims(
      db
        .prepare("SELECT * FROM claim WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
        .all(JSON.stringify(ids)),
      db
        .prepare("SELECT * FROM claim_source WHERE claim_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids)),
    );

  const saveTopic = (slug: string, prose: TopicProse): void => {
    db.prepare(
      `INSERT INTO topic (slug, title, summary, current_state, guidance, open_questions, related, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET title = excluded.title, summary = excluded.summary,
         current_state = excluded.current_state, guidance = excluded.guidance,
         open_questions = excluded.open_questions, related = excluded.related,
         updated_on = excluded.updated_on`,
    ).run(
      slug,
      prose.title,
      prose.summary,
      prose.currentState,
      prose.guidance,
      prose.openQuestions,
      JSON.stringify(prose.related),
      todayIn(),
    );
  };

  const addClaim = (topic: string, claim: NewClaim): number => {
    const id = Number(
      db
        .prepare("INSERT INTO claim (topic, text, stated_on, added_on) VALUES (?, ?, ?, ?)")
        .run(topic, claim.text, claim.statedOn, todayIn()).lastInsertRowid,
    );
    addSources(id, claim.sources);
    return id;
  };

  const addSources = (claimId: number, sources: ClaimSource[]): void => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO claim_source (claim_id, source_note, title, trust, origin) VALUES (?, ?, ?, ?, ?)",
    );
    for (const source of sources)
      insert.run(claimId, source.sourceNote, source.title, source.trust, source.origin);
  };

  const supersedeClaim = (claimId: number, by: number, reason: string): void => {
    db.prepare(
      "UPDATE claim SET status = 'superseded', superseded_by = ?, superseded_on = ?, reason = ? WHERE id = ? AND status = 'active'",
    ).run(by, todayIn(), reason, claimId);
  };

  /** All of one topic's changes land together or not at all. */
  const inTransaction = <T>(work: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    fetchTopic,
    listTopics,
    fetchClaims,
    fetchClaimsByIds,
    saveTopic,
    addClaim,
    addSources,
    supersedeClaim,
    inTransaction,
  };
};
