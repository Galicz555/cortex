import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECTS, VAULT } from "./config.ts";
import type { Entry } from "./entries.ts";
import { isSlug, todayIn, toSlug } from "./shared.ts";

export type ProjectName = (typeof PROJECTS)[number]["name"];

const topicPath = (slug: string): string => {
  if (!isSlug(slug)) throw new Error(`refusing topic slug ${JSON.stringify(slug)}`);
  return path.join(VAULT, "topics", `${slug}.md`);
};

// Adapters copy the date from the source, and its month becomes a vault folder name.
const toPublishedDay = (entry: Entry): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(entry.publishedOn) ? entry.publishedOn : todayIn();

/** The vault-relative link target of an entry's source note, without the `.md`. */
export const toSourceNoteLink = (entry: Entry): string => {
  const key = toSlug(entry.id.slice(entry.id.indexOf(":") + 1)) || "entry";
  return `sources/${toPublishedDay(entry).slice(0, 7)}/${entry.source.id}--${key}`;
};

/**
 * How a note in vault folder `fromFolder` links to an entry's url. Web urls stay as they are; a
 * vault-relative url (a field report or research report, e.g. `field-reports/x.md`) is made
 * relative to the linking note, or it would resolve inside that note's own folder.
 */
export const toLinkFrom = (fromFolder: string, url: string): string =>
  /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : path.posix.relative(fromFolder, url);

export const writeSourceNote = async (
  entry: Entry,
  verdict: { score: number; summary: string; claims: string[] },
): Promise<string> => {
  const link = toSourceNoteLink(entry);
  const file = path.join(VAULT, `${link}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "---",
      `title: ${JSON.stringify(entry.title)}`,
      `source: ${entry.source.id}`,
      `trust: ${entry.source.trust}`,
      `url: ${entry.url}`,
      `published: ${toPublishedDay(entry)}`,
      `score: ${verdict.score}`,
      "---",
      "",
      `# ${entry.title}`,
      "",
      `[Original](${toLinkFrom(path.posix.dirname(link), entry.url)})`,
      "",
      verdict.summary,
      "",
      "## Claims",
      "",
      ...verdict.claims.map((claim) => `- ${claim}`),
      "",
    ].join("\n"),
  );
  return link;
};

export const fetchTopicNote = async (slug: string): Promise<string | null> => {
  try {
    return await readFile(topicPath(slug), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

export const writeTopicFile = async (slug: string, markdown: string): Promise<void> => {
  await writeFile(topicPath(slug), markdown);
};

export const listTopicSlugs = async (): Promise<string[]> =>
  (await readdir(path.join(VAULT, "topics")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();

/** One line per topic: what the skill reads first to decide which topic notes to open. */
export const writeIndex = async (): Promise<string> => {
  const slugs = await listTopicSlugs();
  const lines = await Promise.all(
    slugs.map(async (slug) => {
      const note = (await fetchTopicNote(slug)) ?? "";
      const summary = /^summary: (.*)$/m.exec(note)?.[1] ?? '""';
      const updated = /^updated: (.*)$/m.exec(note)?.[1] ?? "?";
      return `- [[topics/${slug}]] (${updated}) — ${String(JSON.parse(summary))}`;
    }),
  );
  const index = [
    "# Cortex index",
    "",
    "Generated after every run; do not edit. Each topic note is a living synthesis with dated,",
    "sourced claims. `impact/<project>.md` lists what touched each project.",
    "",
    "## Topics",
    "",
    ...lines,
    "",
  ].join("\n");
  await writeFile(path.join(VAULT, "index.md"), index);
  return index;
};

export const appendImpact = async (
  project: ProjectName,
  impact: { link: string; severity: "notify" | "note"; note: string },
): Promise<void> => {
  const marker = impact.severity === "notify" ? "**[needs attention]** " : "";
  await appendFile(
    path.join(VAULT, "impact", `${project}.md`),
    `- ${todayIn()} ${marker}${toLinkMarkup(impact.link)}: ${impact.note}\n`,
  );
};

/** Vault paths become wikilinks; external advisories stay plain URLs. */
const toLinkMarkup = (link: string): string =>
  link.startsWith("https://") ? `<${link}>` : `[[${link}]]`;

const RECENT_IMPACT_LINES = 40;

export const readRecentImpacts = async (): Promise<string> => {
  const dir = path.join(VAULT, "impact");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  const sections = await Promise.all(
    names.map(async (name) => {
      const lines = (await readFile(path.join(dir, name), "utf8")).trim().split("\n");
      return `${name.slice(0, -3)}:\n${lines.slice(-RECENT_IMPACT_LINES).join("\n")}`;
    }),
  );
  return sections.join("\n\n");
};

/** Every topic note in full, for the steps that reason across the whole vault. */
export const readAllTopicNotes = async (): Promise<string> => {
  const notes = await Promise.all(
    (await listTopicSlugs()).map(
      async (slug) => `<topic slug="${slug}">\n${(await fetchTopicNote(slug)) ?? ""}\n</topic>`,
    ),
  );
  return notes.join("\n\n");
};

export const writeVaultFile = async (relativePath: string, content: string): Promise<void> => {
  await writeFile(path.join(VAULT, relativePath), content);
};

export const readProjectContexts = async (): Promise<string> => {
  const dir = path.join(VAULT, "context");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  const texts = await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")));
  return texts.join("\n\n---\n\n");
};

export const writeProjectContext = async (project: ProjectName, profile: string): Promise<void> => {
  await writeFile(path.join(VAULT, "context", `${project}.md`), `${profile.trim()}\n`);
};

export const writeRunLog = async (lines: string[]): Promise<void> => {
  await appendFile(path.join(VAULT, "log", `${todayIn()}.md`), `${lines.join("\n")}\n\n`);
};
