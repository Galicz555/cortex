import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Entry, Source } from "../entries.ts";
import { todayIn } from "../shared.ts";
import { expandWithPageText, toPlainText, toWebUrl } from "./page.ts";

/** Below this, the feed carried a teaser, not the post: the page itself is fetched. */
const MIN_FEED_WORDS = 250;

const Text = z
  .union([z.string(), z.number(), z.object({ "#text": z.coerce.string() })])
  .transform((value) => (typeof value === "object" ? value["#text"] : String(value)));
const AtomLink = z.object({ "@_href": z.string(), "@_rel": z.string().optional() });

const RssItem = z.object({
  title: Text,
  link: z.string(),
  guid: Text.optional(),
  pubDate: z.string().optional(),
  description: Text.optional(),
  "content:encoded": Text.optional(),
});
const AtomEntry = z.object({
  id: Text,
  title: Text,
  link: z.union([AtomLink, z.array(AtomLink)]),
  published: z.string().optional(),
  updated: z.string().optional(),
  summary: Text.optional(),
  content: Text.optional(),
});
const Feed = z.union([
  z.object({ rss: z.object({ channel: z.object({ item: z.unknown().optional() }) }) }),
  z.object({ feed: z.object({ entry: z.unknown().optional() }) }),
]);

/** Any RSS 2.0 or Atom feed, newest first. */
export const fetchFeedEntries = async (source: Source): Promise<Entry[]> => {
  const response = await fetch(source.location, { headers: { "user-agent": "cortex/0.1" } });
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  return parseFeedEntries(source, await response.text());
};

export const parseFeedEntries = (source: Source, xml: string): Entry[] => {
  const parsed = Feed.parse(new XMLParser({ ignoreAttributes: false }).parse(xml));
  const entries =
    "rss" in parsed
      ? [parsed.rss.channel.item ?? []]
          .flat()
          .map((item) => fromRssItem(source, RssItem.parse(item)))
      : [parsed.feed.entry ?? []]
          .flat()
          .map((item) => fromAtomEntry(source, AtomEntry.parse(item)));
  // A link is fetched and rendered into the vault: anything but http(s) is dropped, not followed.
  return entries
    .filter((entry) => toWebUrl(entry.url) !== undefined)
    .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn));
};

export const expandShortFeedEntry = (entry: Entry): Promise<Entry> =>
  entry.text.split(/\s+/).length >= MIN_FEED_WORDS
    ? Promise.resolve(entry)
    : expandWithPageText(entry);

const fromRssItem = (source: Source, item: z.infer<typeof RssItem>): Entry => ({
  id: `${source.id}:${item.guid ?? item.link}`,
  source,
  title: item.title,
  url: item.link,
  publishedOn: toCalendarDay(item.pubDate),
  text: toPlainText(item["content:encoded"] ?? item.description ?? ""),
});

const fromAtomEntry = (source: Source, entry: z.infer<typeof AtomEntry>): Entry => {
  const links = [entry.link].flat();
  const link =
    links.find((candidate) => (candidate["@_rel"] ?? "alternate") === "alternate") ?? links[0];
  return {
    id: `${source.id}:${entry.id}`,
    source,
    title: entry.title,
    url: link?.["@_href"] ?? "",
    publishedOn: toCalendarDay(entry.published ?? entry.updated),
    text: toPlainText(entry.content ?? entry.summary ?? ""),
  };
};

const toCalendarDay = (date: string | undefined): string => {
  const parsed = date === undefined ? Number.NaN : Date.parse(date);
  return Number.isNaN(parsed) ? todayIn() : new Date(parsed).toISOString().slice(0, 10);
};
