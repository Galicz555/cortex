import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Entry, Finding } from "./entries.ts";
import { TRUST_ORDER } from "./entries.ts";
import { bindKnowledge, KNOWLEDGE_SCHEMA } from "./knowledge.ts";
import { bindPractices, PRACTICE_SCHEMA } from "./practices.ts";
import { todayIn } from "./shared.ts";

export type Outcome = "bootstrap" | "rejected" | "accepted" | "failed";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS seen_entry (
    entry_id  TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    outcome   TEXT NOT NULL CHECK (outcome IN ('bootstrap', 'rejected', 'accepted', 'failed')),
    seen_on   TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS seen_entry_source ON seen_entry (source_id);

  -- A finding waits here, once per topic, until that topic's synthesis has run.
  CREATE TABLE IF NOT EXISTS pending_finding (
    entry_id TEXT NOT NULL,
    topic    TEXT NOT NULL,
    finding  TEXT NOT NULL,
    PRIMARY KEY (entry_id, topic)
  ) STRICT;

  -- A dated, checkable forecast. It is never edited: a revision voids it and adds a new one,
  -- so every probability ever stated stays on record for scoring.
  CREATE TABLE IF NOT EXISTS projection (
    id          INTEGER PRIMARY KEY,
    claim       TEXT NOT NULL,
    horizon     TEXT NOT NULL CHECK (horizon IN ('3m', '6m', '12m', '2-3y')),
    made_on     TEXT NOT NULL,
    due_on      TEXT NOT NULL,
    probability REAL NOT NULL CHECK (probability > 0 AND probability < 1),
    basis       TEXT NOT NULL,
    projects    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'true', 'false', 'void')),
    resolved_on TEXT,
    resolution  TEXT,
    CHECK ((status = 'open') = (resolved_on IS NULL))
  ) STRICT;
`;

const StoredFinding = z
  .object({
    entryId: z.string(),
    sourceTitle: z.string(),
    trust: z.enum(TRUST_ORDER),
    title: z.string(),
    url: z.string(),
    publishedOn: z.string(),
    summary: z.string(),
    claims: z.array(z.string()),
    topics: z.array(z.string()),
    projects: z.array(z.string()),
    sourceNote: z.string(),
    origin: z.string().optional(),
  })
  .transform((finding) => ({ ...finding, origin: finding.origin ?? finding.url }));

export const HORIZONS = ["3m", "6m", "12m", "2-3y"] as const;
export type Horizon = (typeof HORIZONS)[number];
export type ProjectionStatus = "open" | "true" | "false" | "void";

const Projection = z.object({
  id: z.number(),
  claim: z.string(),
  horizon: z.enum(HORIZONS),
  made_on: z.string(),
  due_on: z.string(),
  probability: z.number(),
  basis: z.string(),
  projects: z.string().transform((text) => z.array(z.string()).parse(JSON.parse(text))),
  status: z.enum(["open", "true", "false", "void"]),
  resolved_on: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type Projection = z.infer<typeof Projection>;

export type NewProjection = {
  claim: string;
  horizon: Horizon;
  dueOn: string;
  probability: number;
  basis: string;
  projects: string[];
};

export type Store = ReturnType<typeof openStore>;

export const openStore = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  db.exec(KNOWLEDGE_SCHEMA);
  db.exec(PRACTICE_SCHEMA);
  db.exec("PRAGMA foreign_keys = ON;");

  const hasHistory = (sourceId: string): boolean =>
    db.prepare("SELECT 1 FROM seen_entry WHERE source_id = ? LIMIT 1").get(sourceId) !== undefined;

  const isSeen = (entryId: string): boolean =>
    db.prepare("SELECT 1 FROM seen_entry WHERE entry_id = ?").get(entryId) !== undefined;

  const markSeen = (entries: Entry[], outcome: Outcome): void => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO seen_entry (entry_id, source_id, outcome, seen_on) VALUES (?, ?, ?, ?)",
    );
    for (const entry of entries) insert.run(entry.id, entry.source.id, outcome, todayIn());
  };

  /** For checks that track what they reported by key rather than by source entry. */
  const markSeenKey = (key: string, sourceId: string, outcome: Outcome): void => {
    db.prepare(
      "INSERT OR IGNORE INTO seen_entry (entry_id, source_id, outcome, seen_on) VALUES (?, ?, ?, ?)",
    ).run(key, sourceId, outcome, todayIn());
  };

  const queueFinding = (finding: Finding): void => {
    const insert = db.prepare(
      "INSERT OR REPLACE INTO pending_finding (entry_id, topic, finding) VALUES (?, ?, ?)",
    );
    for (const topic of finding.topics) insert.run(finding.entryId, topic, JSON.stringify(finding));
  };

  /** Topics with the most waiting findings first, so a capped run spends Opus where it matters. */
  const fetchPendingTopics = (limit: number): Map<string, Finding[]> => {
    const topics = db
      .prepare(
        "SELECT topic FROM pending_finding GROUP BY topic ORDER BY count(*) DESC, topic LIMIT ?",
      )
      .all(limit)
      .map((row) => z.object({ topic: z.string() }).parse(row).topic);
    return new Map(
      topics.map((topic) => [
        topic,
        db
          .prepare("SELECT finding FROM pending_finding WHERE topic = ? ORDER BY entry_id")
          .all(topic)
          .map((row) =>
            StoredFinding.parse(JSON.parse(z.object({ finding: z.string() }).parse(row).finding)),
          ),
      ]),
    );
  };

  const countPendingTopics = (): number =>
    z
      .object({ n: z.number() })
      .parse(db.prepare("SELECT count(DISTINCT topic) AS n FROM pending_finding").get()).n;

  const clearPendingTopic = (topic: string): void => {
    db.prepare("DELETE FROM pending_finding WHERE topic = ?").run(topic);
  };

  const fetchProjections = (): Projection[] =>
    db
      .prepare("SELECT * FROM projection ORDER BY due_on, id")
      .all()
      .map((row) => Projection.parse(row));

  const addProjection = (projection: NewProjection): number =>
    Number(
      db
        .prepare(
          `INSERT INTO projection (claim, horizon, made_on, due_on, probability, basis, projects)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projection.claim,
          projection.horizon,
          todayIn(),
          projection.dueOn,
          projection.probability,
          projection.basis,
          JSON.stringify(projection.projects),
        ).lastInsertRowid,
    );

  /** Only an open projection can be resolved; a second resolution of the same one is ignored. */
  const resolveProjection = (
    id: number,
    outcome: Exclude<ProjectionStatus, "open">,
    resolution: string,
  ): boolean =>
    db
      .prepare(
        "UPDATE projection SET status = ?, resolved_on = ?, resolution = ? WHERE id = ? AND status = 'open'",
      )
      .run(outcome, todayIn(), resolution, id).changes === 1;

  return {
    ...bindKnowledge(db),
    ...bindPractices(db),
    fetchProjections,
    addProjection,
    resolveProjection,
    hasHistory,
    isSeen,
    markSeen,
    markSeenKey,
    queueFinding,
    fetchPendingTopics,
    countPendingTopics,
    clearPendingTopic,
    close: () => {
      db.close();
    },
  };
};
