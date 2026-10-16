import { z } from "zod";
import type { Entry, Source } from "../entries.ts";
import { logLine } from "../shared.ts";
import { fetchPageText, toPlainText } from "./page.ts";

const MIN_POINTS = 150;
const LOOKBACK_DAYS = 3;
const FIRST_COMMENTS = 8;
const ALGOLIA = "https://hn.algolia.com/api/v1";

/**
 * Only AI stories reach triage. A title regex is the cheap pre-filter; Sonnet judges the rest.
 * Simplification: keyword list, misses AI stories with oblique titles; widen it if triage logs show gaps.
 */
const AI_TITLE =
  /\b(AI|LLMs?|GPT|Claude|Anthropic|OpenAI|Gemini|Llama|Mistral|Qwen|DeepSeek|agents?|agentic|models?|inference|transformer|diffusion|embeddings?|RAG|MCP|fine-?tun\w*|prompt\w*|neural|machine learning|copilot|cursor|vibe cod\w*)\b/i;

const Hit = z.object({
  objectID: z.string().regex(/^\d+$/),
  title: z.string(),
  url: z.string().nullish(),
  points: z.number(),
  num_comments: z.number().nullish(),
  created_at: z.string(),
});
type Comment = { text?: string | null | undefined; children?: Comment[] | undefined };
const Item: z.ZodType<Comment> = z.lazy(() =>
  z.object({ text: z.string().nullish(), children: z.array(Item).optional() }),
);

export const fetchHackerNewsEntries = async (source: Source): Promise<Entry[]> => {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86_400;
  const query = `tags=story&hitsPerPage=200&numericFilters=${encodeURIComponent(`points>${MIN_POINTS},created_at_i>${since}`)}`;
  const response = await fetch(`${ALGOLIA}/search_by_date?${query}`);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  return z
    .object({ hits: z.array(Hit) })
    .parse(await response.json())
    .hits.filter((hit) => AI_TITLE.test(hit.title))
    .map((hit) => ({
      id: `${source.id}:${hit.objectID}`,
      source,
      title: hit.title,
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      publishedOn: hit.created_at.slice(0, 10),
      text: `Hacker News: ${hit.points} points, ${hit.num_comments ?? 0} comments, https://news.ycombinator.com/item?id=${hit.objectID}`,
    }));
};

/** The linked article and the first top-level comments: the discussion is where the skepticism is. */
export const expandWithArticleAndComments = async (entry: Entry): Promise<Entry> => {
  const storyId = entry.id.slice(entry.id.indexOf(":") + 1);
  const article = await fetchPageText(entry.url).catch((error: unknown) => {
    logLine(`${entry.id}: article not fetched (${String(error).slice(0, 200)}), comments only`);
    return "(article not available)";
  });
  const response = await fetch(`${ALGOLIA}/items/${storyId}`);
  if (!response.ok) throw new Error(`${entry.id}: comments HTTP ${response.status}`);
  const comments = (Item.parse(await response.json()).children ?? [])
    .filter((comment) => comment.text)
    .slice(0, FIRST_COMMENTS)
    .map((comment) => `- ${toPlainText(comment.text ?? "")}`);
  return {
    ...entry,
    text: `${entry.text}\n\nArticle:\n${article}\n\nFirst top-level comments:\n${comments.join("\n")}`,
  };
};
