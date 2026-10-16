import { describe, expect, it } from "vitest";
import type { Trust } from "../src/entries.ts";
import type { Claim } from "../src/knowledge.ts";
import { renderComparison } from "../src/practice-note.ts";
import type { PracticeAnswer } from "../src/practice-review.ts";
import { applyPracticeUpdateTo, toPracticeUpdate } from "../src/practice-review.ts";
import type { Practice, Stance } from "../src/practices.ts";
import { compareVersions, findStanceAt, parseModelRef } from "../src/practices.ts";
import { openStore } from "../src/store.ts";

const claim = (id: number, trust: Trust): Claim => ({
  id,
  topic: "claude-model-releases",
  text: `claim ${id}`,
  statedOn: "2026-10-01",
  status: "active",
  supersededBy: null,
  supersededOn: null,
  reason: null,
  sources: [{ sourceNote: `n${id}`, title: "N", trust, origin: `o${id}` }],
});

const prefill: Practice = {
  slug: "assistant-prefill",
  title: "Assistant prefill",
  kind: "api",
  summary: "Starting the assistant turn with fixed text.",
};

const stance = (changes: Partial<Stance>): Stance => ({
  id: 1,
  practice: prefill.slug,
  since: "3",
  lines: [],
  surface: "any",
  stance: "recommended",
  note: "n",
  evidence: [1],
  addedOn: "2026-10-01",
  replacedBy: null,
  trust: "primary",
  ...changes,
});

const answer = (stances: PracticeAnswer["stances"]): PracticeAnswer => ({
  practices: [],
  stances,
  support: [],
});

const newStance = (
  changes: Partial<PracticeAnswer["stances"][number]>,
): PracticeAnswer["stances"][number] => ({
  practice: prefill.slug,
  since: "5.5",
  lines: [],
  surface: "api",
  stance: "unsupported",
  note: "The API returns 400.",
  claims: [10],
  ...changes,
});

const input = { claims: [claim(10, "primary")], practices: [prefill], stances: [] };

describe("practice review guards", () => {
  it("refuses a stance resting on a claim that was not under review", () => {
    const update = toPracticeUpdate(answer([newStance({ claims: [99] })]), input);
    expect(update.stances).toEqual([]);
    expect(update.rejected.join(" ")).toContain("C99");
  });

  it("refuses a stance naming an unknown model line instead of widening it to every line", () => {
    const update = toPracticeUpdate(answer([newStance({ lines: ["gpt"] })]), input);
    expect(update.stances).toEqual([]);
  });

  it("refuses a stance for a practice that neither exists nor is added", () => {
    const update = toPracticeUpdate(answer([newStance({ practice: "made-up" })]), input);
    expect(update.stances).toEqual([]);
  });

  it("refuses a new practice whose slug could not be a path", () => {
    const update = toPracticeUpdate(
      { ...answer([]), practices: [{ ...prefill, slug: "../x" }] },
      input,
    );
    expect(update.practices).toEqual([]);
  });

  it("refuses a since that is not a version number", () => {
    const update = toPracticeUpdate(answer([newStance({ since: "latest" })]), input);
    expect(update.stances).toEqual([]);
  });

  it("keeps only the first of two stances for the same models in one review", () => {
    const update = toPracticeUpdate(answer([newStance({}), newStance({ stance: "avoid" })]), input);
    expect(update.stances.map((item) => item.stance)).toEqual(["unsupported"]);
  });

  it("lets weaker evidence add beside a stance but not replace it", () => {
    const old = stance({ id: 7, since: "5.5", surface: "api", stance: "avoid", trust: "primary" });
    const update = toPracticeUpdate(answer([newStance({})]), {
      ...input,
      claims: [claim(10, "news")],
      stances: [old],
    });
    expect(update.stances).toEqual([]);
  });

  it("replaces a stance resting on training knowledge with any real source", () => {
    const old = stance({ id: 7, since: "5.5", surface: "api", stance: "avoid", trust: "training" });
    const update = toPracticeUpdate(answer([newStance({})]), {
      ...input,
      claims: [claim(10, "news")],
      stances: [old],
    });
    expect(update.stances[0]?.replaces).toBe(7);
  });

  it("refuses support for a stance that is not active", () => {
    const update = toPracticeUpdate(
      { ...answer([]), support: [{ stance: 3, claims: [10] }] },
      { ...input, stances: [stance({ id: 3, replacedBy: 4 })] },
    );
    expect(update.support).toEqual([]);
  });
});

describe("model versions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("4.10", "4.9")).toBeGreaterThan(0);
    expect(compareVersions("5", "5.0")).toBe(0);
    expect(compareVersions("3.5", "4")).toBeLessThan(0);
  });

  it("reads the usual ways of naming a model and refuses unknown lines", () => {
    for (const name of ["opus-5.5", "opus-5-5", "claude-opus-5-5", "Opus-5.5"])
      expect(parseModelRef(name)).toEqual({ line: "opus", version: "5.5" });
    expect(parseModelRef("sonnet-3")).toEqual({ line: "sonnet", version: "3" });
    expect(() => parseModelRef("gpt-5")).toThrow();
  });
});

describe("the stance that governs a model", () => {
  const stances = [
    stance({ id: 1, since: "3", stance: "recommended" }),
    stance({ id: 2, since: "4.5", stance: "avoid" }),
    stance({ id: 3, since: "4.5", lines: ["haiku"], stance: "unsupported" }),
  ];

  it("is the latest one at or below the model's version", () => {
    expect(findStanceAt(stances, { line: "opus", version: "3.5" }, "any")?.id).toBe(1);
    expect(findStanceAt(stances, { line: "opus", version: "5.5" }, "any")?.id).toBe(2);
  });

  it("prefers the stance limited to the model's line over the general one", () => {
    expect(findStanceAt(stances, { line: "haiku", version: "5.5" }, "any")?.id).toBe(3);
  });

  it("ignores replaced stances", () => {
    const replaced = stances.map((item) => (item.id === 2 ? { ...item, replacedBy: 9 } : item));
    expect(findStanceAt(replaced, { line: "opus", version: "5.5" }, "any")?.id).toBe(1);
  });
});

describe("comparing two models", () => {
  it("lists a practice that became discouraged under stop doing", () => {
    const note = renderComparison({
      before: { line: "opus", version: "3" },
      after: { line: "opus", version: "5.5" },
      surface: "any",
      practices: [prefill],
      stances: [stance({ id: 1 }), stance({ id: 2, since: "4.5", stance: "avoid" })],
      claims: new Map(),
    });
    expect(note).toMatch(/## Stop doing\n\n- \*\*Assistant prefill\*\*/);
  });
});

describe("applying a practice review", () => {
  it("records the stance, replaces the old one and advances the review mark together", () => {
    const store = openStore(":memory:");
    store.saveTopic("claude-model-releases", {
      title: "T",
      summary: "s",
      currentState: "",
      guidance: "",
      openQuestions: "",
      related: [],
    });
    const claimId = store.addClaim("claude-model-releases", {
      text: "Haiku 5.5 rejects prefill",
      statedOn: "2026-10-09",
      sources: [{ sourceNote: "n", title: "N", trust: "primary", origin: "o" }],
    });
    store.savePractice(prefill);
    const oldId = store.addStance({
      practice: prefill.slug,
      since: "5.5",
      lines: ["haiku"],
      surface: "api",
      stance: "avoid",
      note: "old",
      evidence: [claimId],
    });
    applyPracticeUpdateTo(store)(
      {
        practices: [],
        stances: [
          {
            practice: prefill.slug,
            since: "5.5",
            lines: ["haiku"],
            surface: "api",
            stance: "unsupported",
            note: "new",
            evidence: [claimId],
            replaces: oldId,
          },
        ],
        support: [],
        rejected: [],
      },
      claimId,
    );
    const stances = store.fetchStances();
    expect(stances.find((item) => item.id === oldId)?.replacedBy).not.toBeNull();
    expect(stances.find((item) => item.replacedBy === null)?.trust).toBe("primary");
    expect(store.fetchReviewedUpTo()).toBe(claimId);
    store.close();
  });
});
