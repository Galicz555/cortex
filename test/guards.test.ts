import { describe, expect, it } from "vitest";
import { usageRecords } from "../src/claude.ts";
import { parseLocalConfig, SOURCES } from "../src/config.ts";
import type { Entry } from "../src/entries.ts";
import { isSlug, todayIn, toSlug } from "../src/shared.ts";
import { extractChangelogVersions } from "../src/sources/changelog.ts";
import { splitIntoBatches, toCheckedVerdict } from "../src/triage.ts";
import { toLinkFrom, toSourceNoteLink } from "../src/vault.ts";

const source = SOURCES.find((candidate) => candidate.kind === "youtube");
if (source === undefined) throw new Error("config has no youtube source");
const entryOf = (id: string, words: number): Entry => ({
  id,
  source,
  title: id,
  url: "https://example.test",
  publishedOn: "2026-10-01",
  text: Array.from({ length: words }, () => "w").join(" "),
});

describe("slugs that become vault paths", () => {
  it("refuses path traversal, separators and uppercase", () => {
    for (const bad of ["../etc", "a/b", "A-b", "", "-a", "a--b", "a".repeat(61)]) {
      expect(isSlug(bad)).toBe(false);
    }
    expect(isSlug("claude-code-workflow")).toBe(true);
  });

  it("turns any entry id into a slug that passes the check", () => {
    for (const raw of ["../../x", "2.1.286", "R9momwXV9w4", "2026-10-01 report.md"]) {
      expect(isSlug(toSlug(raw))).toBe(true);
    }
  });

  it("keeps a hostile entry id inside its source folder", () => {
    const link = toSourceNoteLink({ ...entryOf("ai-explained:../../../.ssh/id", 1) });
    expect(link).toBe("sources/2026-10/ai-explained--ssh-id");
  });

  it("files an entry with a malformed publication date under this month", () => {
    const thisMonth = todayIn().slice(0, 7);
    for (const publishedOn of ["../../../.ssh/x", "2026-1", "20261001", "2026-10-01T00:00", ""]) {
      const link = toSourceNoteLink({ ...entryOf("ai-explained:abc", 1), publishedOn });
      expect(link, publishedOn).toBe(`sources/${thisMonth}/ai-explained--abc`);
    }
  });
});

describe("the local project list", () => {
  const configWith = (projects: unknown[]) => JSON.stringify({ projects });

  it("resolves project paths against the config file's folder", () => {
    const config = parseLocalConfig(configWith([{ name: "app", path: "../app" }]), "/srv/cortex");
    expect(config.projects).toEqual([{ name: "app", path: "/srv/app", extraFiles: [] }]);
    expect(config.toolEnv).toEqual({});
  });

  it("refuses project names that could leave the vault folder", () => {
    for (const name of ["../app", "a/b", "App", ""]) {
      expect(() => parseLocalConfig(configWith([{ name, path: "." }]), "/")).toThrow();
    }
  });

  it("refuses two projects with one name, and an empty list", () => {
    const twice = [
      { name: "app", path: "a" },
      { name: "app", path: "b" },
    ];
    expect(() => parseLocalConfig(configWith(twice), "/")).toThrow(/unique/);
    expect(() => parseLocalConfig(configWith([]), "/")).toThrow();
  });

  it("adds the configured repositories as commit feeds, and refuses unsafe ids and repos", () => {
    const withSources = (sources: unknown[]) =>
      JSON.stringify({ projects: [{ name: "app", path: "." }], sources });
    const spec = { id: "spec", title: "Spec", repo: "org/spec", branch: "main" };
    expect(parseLocalConfig(withSources([spec]), "/").sources).toEqual([spec]);
    expect(parseLocalConfig(configWith([{ name: "app", path: "." }]), "/").sources).toEqual([]);
    for (const bad of [
      { ...spec, id: "../x" },
      { ...spec, repo: "org/spec/../x" },
      { ...spec, repo: "https://evil.test/x" },
      { ...spec, branch: "main?x=1" },
    ]) {
      expect(() => parseLocalConfig(withSources([bad]), "/"), JSON.stringify(bad)).toThrow();
    }
    expect(SOURCES.find((candidate) => candidate.id === "example-spec")?.location).toBe(
      "https://github.com/example-org/api-spec/commits/main.atom",
    );
  });
});

describe("triage verdicts from the model", () => {
  const verdict = {
    entryId: "x",
    score: 8,
    reason: "",
    summary: "",
    claims: [],
    topics: ["good-topic", "../escape", "good-topic", "Bad Topic"],
    projects: ["notes-app", "not-a-project"],
    origin: "https://example.test",
  };

  it("drops topics that are not slugs, and duplicates", () => {
    expect(toCheckedVerdict(verdict).topics).toEqual(["good-topic"]);
  });

  it("drops projects we do not have", () => {
    expect(toCheckedVerdict(verdict).projects).toEqual(["notes-app"]);
  });
});

describe("batching entries for one triage call", () => {
  it("counts an entry only up to the words triage will see, and splits on overflow", () => {
    const batches = splitIntoBatches([
      entryOf("a", 30_000),
      entryOf("b", 15_000),
      entryOf("c", 15_000),
    ]);
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("never returns an empty batch, even for one oversized entry", () => {
    expect(splitIntoBatches([entryOf("huge", 100_000)])).toEqual([
      [expect.objectContaining({ id: "huge" })],
    ]);
    expect(splitIntoBatches([])).toEqual([]);
  });
});

describe("changelog parsing", () => {
  it("yields one version per section, newest first, skipping empty ones", () => {
    const markdown = "# Changelog\n\n## 2.0.1\n\n- fix\n\n## 2.0.0\n\n## 1.9.9\n- old\n";
    expect(extractChangelogVersions(markdown)).toEqual([
      { version: "2.0.1", body: "- fix" },
      { version: "1.9.9", body: "- old" },
    ]);
  });
});

describe("usageRecords", () => {
  it("records each model's tokens with cache reads and writes counted as input", () => {
    expect(
      usageRecords(
        {
          is_error: false,
          structured_output: {},
          modelUsage: {
            "claude-sonnet-5-5": {
              inputTokens: 2,
              outputTokens: 40,
              cacheReadInputTokens: 500,
              cacheCreationInputTokens: 2000,
              costUSD: 0.01,
            },
          },
        },
        "triage",
        new Date("2026-10-10T02:50:00.000Z"),
      ),
    ).toEqual([
      {
        at: "2026-10-10T02:50:00.000Z",
        purpose: "triage",
        model: "claude-sonnet-5-5",
        inputTokens: 2502,
        outputTokens: 40,
        costUsd: 0.01,
      },
    ]);
  });

  it("records nothing for a call without usage data", () => {
    expect(usageRecords({ is_error: true, structured_output: undefined }, "x", new Date())).toEqual(
      [],
    );
  });
});

describe("toLinkFrom", () => {
  it("makes a vault-relative url relative to the linking note's folder", () => {
    expect(toLinkFrom("sources/2026-10", "field-reports/2026-10-09-x.md")).toBe(
      "../../field-reports/2026-10-09-x.md",
    );
    expect(toLinkFrom("log", "research/2026-10-01-y.md")).toBe("../research/2026-10-01-y.md");
  });

  it("leaves web urls alone", () => {
    expect(toLinkFrom("sources/2026-10", "https://example.com/a")).toBe("https://example.com/a");
  });
});
