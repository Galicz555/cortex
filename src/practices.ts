import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { TRUST_ORDER } from "./entries.ts";
import type { Trust } from "./entries.ts";
import { todayIn } from "./shared.ts";

export const MODEL_LINES = ["opus", "sonnet", "haiku", "fable", "mythos"] as const;
export type ModelLine = (typeof MODEL_LINES)[number];

/** Where a practice is applied: the raw API, Claude Code, or both. */
export const SURFACES = ["api", "claude-code", "any"] as const;
export type Surface = (typeof SURFACES)[number];

export const PRACTICE_KINDS = ["prompt", "api", "agent", "skill"] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

export const STANCES = ["recommended", "neutral", "avoid", "unsupported"] as const;
export type StanceValue = (typeof STANCES)[number];

/**
 * A practice is a way of prompting, configuring or using Claude ("assistant prefill",
 * "emphatic MUST/CRITICAL wording"). Its stances say how Anthropic's guidance on it stood from
 * a model version on; a stance holds for every later version until a later stance replaces it.
 * Every stance rests on claims, so the practice history is as checkable as a topic note.
 */
export const PRACTICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS practice (
    slug    TEXT PRIMARY KEY,
    title   TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('prompt', 'api', 'agent', 'skill')),
    summary TEXT NOT NULL
  ) STRICT;

  -- lines is a sorted JSON array of model lines; [] means every line.
  CREATE TABLE IF NOT EXISTS practice_stance (
    id          INTEGER PRIMARY KEY,
    practice    TEXT NOT NULL REFERENCES practice (slug),
    since       TEXT NOT NULL,
    lines       TEXT NOT NULL,
    surface     TEXT NOT NULL CHECK (surface IN ('api', 'claude-code', 'any')),
    stance      TEXT NOT NULL CHECK (stance IN ('recommended', 'neutral', 'avoid', 'unsupported')),
    note        TEXT NOT NULL,
    added_on    TEXT NOT NULL,
    replaced_by INTEGER REFERENCES practice_stance (id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS stance_evidence (
    stance_id INTEGER NOT NULL REFERENCES practice_stance (id),
    claim_id  INTEGER NOT NULL REFERENCES claim (id),
    PRIMARY KEY (stance_id, claim_id)
  ) STRICT;

  -- Claims up to this id have been through the practice review.
  CREATE TABLE IF NOT EXISTS practice_review (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_claim_id INTEGER NOT NULL
  ) STRICT;
`;

export type Practice = { slug: string; title: string; kind: PracticeKind; summary: string };

export type Applicability = { since: string; lines: ModelLine[]; surface: Surface };

export type NewStance = Applicability & {
  practice: string;
  stance: StanceValue;
  note: string;
  evidence: number[];
};

export type Stance = NewStance & {
  id: number;
  addedOn: string;
  replacedBy: number | null;
  /** The best trust among the sources of the claims behind the stance. */
  trust: Trust;
};

export type ModelRef = { line: ModelLine; version: string };

const VERSION = /^\d+(\.\d+)?$/;

export const isVersion = (text: string): boolean => VERSION.test(text);

export const isModelLine = (text: string): text is ModelLine =>
  MODEL_LINES.some((line) => line === text);

/** "opus-5.5", "opus-5-5" and "claude-opus-5-5" all name { line: "opus", version: "5.5" }. */
export const parseModelRef = (text: string): ModelRef => {
  const match = /^(?:claude-)?([a-z]+)-(\d+)(?:[.-](\d+))?$/.exec(text.trim().toLowerCase());
  const [, line = "", major = "", minor] = match ?? [];
  if (match === null || !isModelLine(line))
    throw new Error(
      `not a model: ${JSON.stringify(text)}; expected e.g. opus-5.5, lines: ${MODEL_LINES.join(", ")}`,
    );
  return { line, version: minor === undefined ? major : `${major}.${minor}` };
};

/** Numeric, not lexical: 4.10 comes after 4.9, and 5 equals 5.0. */
export const compareVersions = (a: string, b: string): number => {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
};

/** The key under which a newer stance replaces an older one instead of standing beside it. */
export const toStanceKey = (stance: Applicability & { practice: string }): string =>
  JSON.stringify([stance.practice, stance.since, toCanonicalLines(stance.lines), stance.surface]);

export const toCanonicalLines = (lines: ModelLine[]): ModelLine[] => [...new Set(lines)].sort();

/**
 * The stance that governs a practice for one model. The latest `since` at or below the model's
 * version wins; on a tie the narrower stance (named lines, one surface) wins over the general.
 */
export const findStanceAt = (
  stances: Stance[],
  model: ModelRef,
  surface: Surface,
): Stance | undefined =>
  stances
    .filter(
      (stance) =>
        stance.replacedBy === null &&
        (stance.lines.length === 0 || stance.lines.includes(model.line)) &&
        (stance.surface === "any" || surface === "any" || stance.surface === surface) &&
        compareVersions(stance.since, model.version) <= 0,
    )
    .sort(
      (a, b) =>
        compareVersions(b.since, a.since) ||
        Number(b.lines.length > 0) - Number(a.lines.length > 0) ||
        Number(b.surface !== "any") - Number(a.surface !== "any"),
    )[0];

const PracticeRow = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.enum(PRACTICE_KINDS),
  summary: z.string(),
});
const StanceRow = z.object({
  id: z.number(),
  practice: z.string(),
  since: z.string(),
  lines: z.string(),
  surface: z.enum(SURFACES),
  stance: z.enum(STANCES),
  note: z.string(),
  added_on: z.string(),
  replaced_by: z.number().nullable(),
});
const EvidenceRow = z.object({
  stance_id: z.number(),
  claim_id: z.number(),
  trust: z.enum(TRUST_ORDER),
});

export const bindPractices = (db: DatabaseSync) => {
  const listPractices = (): Practice[] =>
    db
      .prepare("SELECT * FROM practice ORDER BY kind, slug")
      .all()
      .map((row) => PracticeRow.parse(row));

  const fetchStances = (): Stance[] => {
    const evidence = db
      .prepare(
        `SELECT e.stance_id, e.claim_id, s.trust FROM stance_evidence e
         JOIN claim_source s ON s.claim_id = e.claim_id`,
      )
      .all()
      .map((row) => EvidenceRow.parse(row));
    return db
      .prepare("SELECT * FROM practice_stance ORDER BY practice, id")
      .all()
      .map((row) => {
        const stance = StanceRow.parse(row);
        const own = evidence.filter((item) => item.stance_id === stance.id);
        return {
          id: stance.id,
          practice: stance.practice,
          since: stance.since,
          lines: z.array(z.enum(MODEL_LINES)).parse(JSON.parse(stance.lines)),
          surface: stance.surface,
          stance: stance.stance,
          note: stance.note,
          addedOn: stance.added_on,
          replacedBy: stance.replaced_by,
          evidence: [...new Set(own.map((item) => item.claim_id))],
          trust:
            TRUST_ORDER[Math.min(...own.map((item) => TRUST_ORDER.indexOf(item.trust)))] ??
            "training",
        };
      });
  };

  const savePractice = (practice: Practice): void => {
    db.prepare(
      `INSERT INTO practice (slug, title, kind, summary) VALUES (?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET title = excluded.title, kind = excluded.kind,
         summary = excluded.summary`,
    ).run(practice.slug, practice.title, practice.kind, practice.summary);
  };

  const addStance = (stance: NewStance): number => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_stance (practice, since, lines, surface, stance, note, added_on)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stance.practice,
          stance.since,
          JSON.stringify(toCanonicalLines(stance.lines)),
          stance.surface,
          stance.stance,
          stance.note,
          todayIn(),
        ).lastInsertRowid,
    );
    addEvidence(id, stance.evidence);
    return id;
  };

  const addEvidence = (stanceId: number, claimIds: number[]): void => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO stance_evidence (stance_id, claim_id) VALUES (?, ?)",
    );
    for (const claimId of claimIds) insert.run(stanceId, claimId);
  };

  const replaceStance = (stanceId: number, by: number): void => {
    db.prepare(
      "UPDATE practice_stance SET replaced_by = ? WHERE id = ? AND replaced_by IS NULL",
    ).run(by, stanceId);
  };

  const fetchReviewedUpTo = (): number =>
    z
      .object({ last_claim_id: z.number() })
      .optional()
      .parse(db.prepare("SELECT last_claim_id FROM practice_review WHERE id = 1").get())
      ?.last_claim_id ?? 0;

  const saveReviewedUpTo = (claimId: number): void => {
    db.prepare(
      `INSERT INTO practice_review (id, last_claim_id) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET last_claim_id = excluded.last_claim_id`,
    ).run(claimId);
  };

  const listClaimIdsAfter = (claimId: number, limit: number): number[] =>
    db
      .prepare("SELECT id FROM claim WHERE id > ? ORDER BY id LIMIT ?")
      .all(claimId, limit)
      .map((row) => z.object({ id: z.number() }).parse(row).id);

  return {
    listPractices,
    fetchStances,
    savePractice,
    addStance,
    addEvidence,
    replaceStance,
    fetchReviewedUpTo,
    saveReviewedUpTo,
    listClaimIdsAfter,
  };
};
