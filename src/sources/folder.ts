import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Entry, Source } from "../entries.ts";
import { todayIn } from "../shared.ts";

/**
 * Markdown files dropped into a vault folder: field reports a project session wrote back, or
 * research reports. Each file is one entry, keyed by its name: editing a file after it was
 * processed does not re-run it.
 */
export const fetchFolderEntries = async (source: Source): Promise<Entry[]> => {
  const names = (await readdir(source.location)).filter((name) => name.endsWith(".md"));
  return Promise.all(
    names.map(async (name) => ({
      id: `${source.id}:${name}`,
      source,
      title: `${source.title}: ${name.replace(/\.md$/, "")}`,
      url: `${path.basename(source.location)}/${name}`,
      publishedOn: name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? todayIn(),
      text: await readFile(path.join(source.location, name), "utf8"),
    })),
  );
};
