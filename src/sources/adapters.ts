import type { Entry, Source, SourceKind } from "../entries.ts";
import { fetchChangelogEntries } from "./changelog.ts";
import { expandShortFeedEntry, fetchFeedEntries } from "./feed.ts";
import { expandWithArticleAndComments, fetchHackerNewsEntries } from "./hacker-news.ts";
import { fetchHfPaperEntries } from "./hf-papers.ts";
import { expandWithPageText } from "./page.ts";
import { commitPageDiffEntry, fetchPageDiffEntries } from "./page-diff.ts";
import { fetchSitemapEntries } from "./sitemap.ts";
import { fetchSnapshotEntries } from "./snapshot.ts";
import { fetchFolderEntries } from "./folder.ts";
import { expandWithTranscript, fetchYoutubeEntries } from "./youtube.ts";

type SourceAdapter = {
  /** Cheap: lists what the source has published, so seen entries are dropped before any work. */
  fetchEntries: (source: Source) => Promise<Entry[]>;
  /** Expensive: fills in the full text of an entry that is new. */
  expandEntry: (entry: Entry) => Promise<Entry>;
  /** Called once the entry is marked seen, for sources that track state of their own. */
  commitEntry?: (entry: Entry) => Promise<void>;
};

const asIs = (entry: Entry): Promise<Entry> => Promise.resolve(entry);

export const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  changelog: { fetchEntries: fetchChangelogEntries, expandEntry: asIs },
  youtube: { fetchEntries: fetchYoutubeEntries, expandEntry: expandWithTranscript },
  folder: { fetchEntries: fetchFolderEntries, expandEntry: asIs },
  feed: { fetchEntries: fetchFeedEntries, expandEntry: expandShortFeedEntry },
  "hf-papers": { fetchEntries: fetchHfPaperEntries, expandEntry: asIs },
  "hacker-news": {
    fetchEntries: fetchHackerNewsEntries,
    expandEntry: expandWithArticleAndComments,
  },
  // Release notes are short on purpose; the GitHub page around them adds only chrome.
  "github-releases": { fetchEntries: fetchFeedEntries, expandEntry: asIs },
  sitemap: { fetchEntries: fetchSitemapEntries, expandEntry: expandWithPageText },
  snapshot: { fetchEntries: fetchSnapshotEntries, expandEntry: expandWithPageText },
  "page-diff": {
    fetchEntries: fetchPageDiffEntries,
    expandEntry: asIs,
    commitEntry: commitPageDiffEntry,
  },
};
