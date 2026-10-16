import { z } from "zod";
import type { Entry, Source } from "../entries.ts";

// Community upvotes are the pre-filter: the daily list has ~30 papers, a handful clear this.
const MIN_UPVOTES = 30;
const PAPERS_PER_FETCH = 100;

const DailyPaper = z.object({
  publishedAt: z.string(),
  paper: z.object({
    id: z.string().regex(/^[\w.-]+$/),
    title: z.string(),
    summary: z.string(),
    upvotes: z.number(),
    githubRepo: z.string().nullish(),
  }),
});

/** Hugging Face Daily Papers: the arXiv papers practitioners upvoted, abstract as the text. */
export const fetchHfPaperEntries = async (source: Source): Promise<Entry[]> => {
  const response = await fetch(`${source.location}?limit=${PAPERS_PER_FETCH}`);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  return z
    .array(DailyPaper)
    .parse(await response.json())
    .filter(({ paper }) => paper.upvotes >= MIN_UPVOTES)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(({ publishedAt, paper }) => ({
      id: `${source.id}:${paper.id}`,
      source,
      title: paper.title,
      url: `https://arxiv.org/abs/${paper.id}`,
      publishedOn: publishedAt.slice(0, 10),
      text: [
        `Upvotes on Hugging Face: ${paper.upvotes}`,
        paper.githubRepo ? `Code: ${paper.githubRepo}` : "",
        `Abstract:\n${paper.summary}`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    }));
};
