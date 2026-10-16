import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Entry, Source } from "../entries.ts";
import { todayIn } from "../shared.ts";

const Url = z.object({ loc: z.string(), lastmod: z.string().optional() });
const Sitemap = z.object({ urlset: z.object({ url: z.union([Url, z.array(Url)]) }) });

/**
 * For sites without a feed: every sitemap URL matching `source.match` is an entry, keyed by
 * URL. Sitemaps often omit dates, so "new" means "a URL we have not seen", not "recent".
 */
export const fetchSitemapEntries = async (source: Source): Promise<Entry[]> => {
  if (source.match === undefined) throw new Error(`${source.id}: sitemap source needs a match`);
  const pattern = new RegExp(source.match);
  const response = await fetch(source.location);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  const { urlset } = Sitemap.parse(new XMLParser().parse(await response.text()));
  return [urlset.url]
    .flat()
    .filter((url) => pattern.test(url.loc))
    .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))
    .map((url) => ({
      id: `${source.id}:${url.loc}`,
      source,
      title: decodeURIComponent(url.loc.split("/").filter(Boolean).at(-1) ?? url.loc).replace(
        /-/g,
        " ",
      ),
      url: url.loc,
      publishedOn: url.lastmod?.slice(0, 10) ?? todayIn(),
      text: "",
    }));
};
