/**
 * How far a claim from a source can be trusted, highest first. Synthesis weighs conflicting
 * claims by this order: a field report from one of our own projects beats any outside source.
 */
export const TRUST_ORDER = [
  "field-report",
  "primary",
  "analysis",
  "practitioner",
  "news",
  // Seeded topic notes written from a model's own training data, before any real source.
  "training",
] as const;
export type Trust = (typeof TRUST_ORDER)[number];

export type SourceKind =
  | "folder"
  | "changelog"
  | "youtube"
  | "feed"
  | "hf-papers"
  | "hacker-news"
  | "github-releases"
  | "sitemap"
  | "page-diff"
  | "snapshot";

export type Source = {
  id: string;
  kind: SourceKind;
  title: string;
  trust: Trust;
  /** Feed URL, channel id or directory, depending on the kind. */
  location: string;
  /** On a source's first run only this many newest entries are processed; the rest count as seen. */
  bootstrapKeep: number;
  /** Sitemap sources: a regex the page URL must match. */
  match?: string;
};

/** One item a source published, before anyone judged it. */
export type Entry = {
  id: string;
  source: Source;
  title: string;
  url: string;
  publishedOn: string;
  text: string;
};

/** What triage kept from an accepted entry; synthesis sees only this, never the raw text. */
export type Finding = {
  entryId: string;
  sourceTitle: string;
  trust: Trust;
  title: string;
  url: string;
  publishedOn: string;
  summary: string;
  claims: string[];
  topics: string[];
  projects: string[];
  sourceNote: string;
  /** Who originally published what this entry reports; repeats of one origin are one voice. */
  origin: string;
};
