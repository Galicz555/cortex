import { describe, expect, it } from "vitest";
import type { Finding } from "../src/entries.ts";
import type { Claim } from "../src/knowledge.ts";
import { toOriginKey } from "../src/shared.ts";
import type { SynthesisAnswer } from "../src/synthesize.ts";
import { toProseWithClaimIds, toTopicUpdate } from "../src/synthesize.ts";
import { toEvidenceLine } from "../src/topic-note.ts";

const finding = (trust: Finding["trust"], origin: string): Finding => ({
  entryId: "e",
  sourceTitle: "S",
  trust,
  title: "T",
  url: "https://x.test",
  publishedOn: "2026-10-01",
  summary: "",
  claims: [],
  topics: ["t"],
  projects: [],
  sourceNote: `sources/2026-10/${origin}`,
  origin,
});

const claim = (id: number, trust: Finding["trust"]): Claim => ({
  id,
  topic: "t",
  text: `claim ${id}`,
  statedOn: "2026-09-01",
  status: "active",
  supersededBy: null,
  supersededOn: null,
  reason: null,
  sources: [{ sourceNote: `n${id}`, title: "N", trust, origin: `o${id}` }],
});

const answer = (changes: Partial<SynthesisAnswer>): SynthesisAnswer => ({
  title: "T",
  summary: "s",
  currentState: "",
  guidance: "",
  openQuestions: "",
  related: [],
  add: [],
  corroborate: [],
  supersede: [],
  impacts: [],
  ...changes,
});

const input = (findings: Finding[], claims: Claim[]) => ({
  slug: "t",
  topic: null,
  claims,
  findings,
  recentImpacts: "",
  allTopics: ["t", "other"],
});

describe("checking a synthesis answer", () => {
  it("drops a new claim whose only source is a finding that does not exist", () => {
    const update = toTopicUpdate(
      answer({ add: [{ ref: "N1", text: "x", statedOn: "2026-10-01", findings: ["F9"] }] }),
      input([finding("news", "a")], []),
    );
    expect(update.adds).toEqual([]);
    expect(update.rejected).toContain("N1 has no valid source");
  });

  it("refuses to let weaker evidence supersede a stronger claim", () => {
    const update = toTopicUpdate(
      answer({
        add: [{ ref: "N1", text: "x", statedOn: "2026-10-01", findings: ["F1"] }],
        supersede: [{ claim: 7, by: "N1", reason: "newer" }],
      }),
      input([finding("news", "a")], [claim(7, "primary")]),
    );
    expect(update.supersessions).toEqual([]);
    expect(update.rejected[0]).toMatch(/weaker evidence/);
  });

  it("lets any real source replace a training-knowledge claim", () => {
    const update = toTopicUpdate(
      answer({
        add: [{ ref: "N1", text: "x", statedOn: "2026-10-01", findings: ["F1"] }],
        supersede: [{ claim: 7, by: "N1", reason: "real source" }],
      }),
      input([finding("news", "a")], [claim(7, "training")]),
    );
    expect(update.supersessions).toEqual([{ claimId: 7, by: "N1", reason: "real source" }]);
  });

  it("only corroborates active claims of this topic, and keeps related to known topics", () => {
    const update = toTopicUpdate(
      answer({
        corroborate: [
          { claim: 7, findings: ["F1"] },
          { claim: 99, findings: ["F1"] },
        ],
        related: ["other", "t", "missing", "../x"],
      }),
      input([finding("analysis", "a")], [claim(7, "primary")]),
    );
    expect(update.corroborations.map((item) => item.claimId)).toEqual([7]);
    expect(update.prose.related).toEqual(["other"]);
  });

  it("swaps placeholders in prose for the new claim ids, dropping unknown ones", () => {
    expect(toProseWithClaimIds("as shown ({{N1}}, {{N2}})", new Map([["N1", 41]]))).toBe(
      "as shown (C41, )",
    );
  });
});

describe("independent origins", () => {
  it("counts copies of one origin once", () => {
    const line = toEvidenceLine({
      ...claim(3, "news"),
      sources: [
        { sourceNote: "a", title: "A", trust: "news", origin: "blog.google/argon" },
        { sourceNote: "b", title: "B", trust: "news", origin: "blog.google/argon" },
        { sourceNote: "c", title: "C", trust: "primary", origin: "ai.google.dev/changelog" },
      ],
    });
    expect(line).toContain("primary, 2 independent origins");
  });

  it("normalises origin URLs so syndicated links match", () => {
    expect(toOriginKey("https://www.Blog.google/argon/?utm_source=x#top")).toBe(
      "blog.google/argon",
    );
    expect(toOriginKey("training:opus")).toBe("training:opus");
  });
});
