import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA } from "../config.ts";
import type { Entry, Source } from "../entries.ts";
import { todayIn } from "../shared.ts";
import { fetchPageText } from "./page.ts";

const SNAPSHOTS = path.join(DATA, "pages");
const MAX_DIFF_LINES = 1_000;

/**
 * Pages that change quietly: changelogs, price lists, deprecation tables, terms. The entry is
 * the line diff against the last version we processed. The snapshot only advances when the
 * entry is committed (seen), so a run that fails before triage loses nothing.
 */
export const fetchPageDiffEntries = async (source: Source): Promise<Entry[]> => {
  await mkdir(SNAPSHOTS, { recursive: true });
  const current = await fetchPageSnapshot(source.location);
  const baseline = await readFile(baselinePath(source), "utf8").catch(() => null);
  if (baseline === null) {
    await writeFile(baselinePath(source), current);
    return [];
  }
  const diff = toLineDiff(baseline, current);
  if (diff.added.length === 0 && diff.removed.length === 0) return [];
  const hash = createHash("sha256").update(current).digest("hex").slice(0, 16);
  await writeFile(nextPath(source, hash), current);
  return [
    {
      id: `${source.id}:${hash}`,
      source,
      title: `${source.title}: changed`,
      url: source.location.replace(/\.md(\.txt)?$/, ""),
      publishedOn: todayIn(),
      text: [
        "Lines added or changed:",
        ...diff.added.slice(0, MAX_DIFF_LINES),
        "",
        "Lines removed:",
        ...diff.removed.slice(0, MAX_DIFF_LINES),
      ].join("\n"),
    },
  ];
};

export const commitPageDiffEntry = async (entry: Entry): Promise<void> => {
  const hash = entry.id.slice(entry.id.lastIndexOf(":") + 1);
  await rename(nextPath(entry.source, hash), baselinePath(entry.source)).catch(() => undefined);
};

/** Markdown exports are fetched raw; anything else goes through the page-text tool. */
const fetchPageSnapshot = async (url: string): Promise<string> => {
  if (!/\.(md|txt)$/.test(url)) return fetchPageText(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
};

/**
 * Lines present in one version and not the other, in page order. Not a positional diff: a
 * moved line does not count as a change, which is what a "what is new" reader wants.
 */
export const toLineDiff = (
  before: string,
  after: string,
): { added: string[]; removed: string[] } => {
  const beforeLines = new Set(before.split("\n").map((line) => line.trim()));
  const afterLines = new Set(after.split("\n").map((line) => line.trim()));
  return {
    added: [...afterLines].filter((line) => line !== "" && !beforeLines.has(line)),
    removed: [...beforeLines].filter((line) => line !== "" && !afterLines.has(line)),
  };
};

const baselinePath = (source: Source): string => path.join(SNAPSHOTS, `${source.id}.txt`);
const nextPath = (source: Source, hash: string): string =>
  path.join(SNAPSHOTS, `${source.id}.${hash}.next.txt`);
