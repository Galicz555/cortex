import type { Entry, Source } from "../entries.ts";
import { todayIn } from "../shared.ts";

/** A Keep-a-Changelog style file: one entry per `## <version>` section, newest first. */
export const fetchChangelogEntries = async (source: Source): Promise<Entry[]> => {
  const response = await fetch(source.location);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  return extractChangelogVersions(await response.text()).map(({ version, body }) => ({
    id: `${source.id}:${version}`,
    source,
    title: `${source.title} ${version}`,
    url: toBrowsableUrl(source.location),
    // The file carries no release dates; the day we first saw a version is the closest we have.
    publishedOn: todayIn(),
    text: body,
  }));
};

export const extractChangelogVersions = (markdown: string): { version: string; body: string }[] =>
  markdown
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [heading = "", ...lines] = section.split("\n");
      return { version: heading.trim(), body: lines.join("\n").trim() };
    })
    .filter(({ version, body }) => version !== "" && body !== "");

const toBrowsableUrl = (rawUrl: string): string =>
  rawUrl
    .replace("raw.githubusercontent.com", "github.com")
    .replace(/\/(main|master)\//, "/blob/$1/");
