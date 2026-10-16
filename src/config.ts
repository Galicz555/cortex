import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Source } from "./entries.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const VAULT = path.join(ROOT, "vault");
export const DATA = path.join(ROOT, "data");
export const TIME_ZONE = "Europe/Budapest";

/** An entry scoring below this is noise for our projects, even if technically true. */
export const MIN_USEFUL_SCORE = 6;

// The subscription's Opus budget is shared with interactive work; topics past this wait a day.
export const MAX_TOPICS_PER_RUN = 6;

/**
 * This machine's own settings, kept out of the repository: the projects Cortex judges against,
 * and the environment its Python tools run with. `CORTEX_CONFIG` points elsewhere (the tests
 * use the example file).
 */
export const LOCAL_CONFIG_FILE = path.resolve(
  ROOT,
  process.env["CORTEX_CONFIG"] ?? "cortex.config.json",
);

// Project names become vault file names (`context/<name>.md`, `impact/<name>.md`), so they
// must have the `isSlug` shape. The regex is repeated because shared.ts imports this module.
const PROJECT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LocalConfig = z.strictObject({
  projects: z
    .array(
      z.strictObject({
        name: z.string().max(60).regex(PROJECT_NAME),
        /** The project's checkout; relative to the config file's folder. */
        path: z.string().min(1),
        /** Files outside the checkout that describe the project; relative to its path. */
        extraFiles: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1)
    .refine((projects) => new Set(projects.map((p) => p.name)).size === projects.length, {
      message: "project names must be unique",
    }),
  toolEnv: z.record(z.string(), z.string()).default({}),
  /** Extra GitHub repositories whose branch commits are watched as primary sources. */
  sources: z
    .array(
      z.strictObject({
        // Source ids are keys in the run database and parts of vault paths.
        id: z.string().max(60).regex(PROJECT_NAME),
        title: z.string().min(1),
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        branch: z.string().regex(/^[\w.-]+(?:\/[\w.-]+)*$/),
      }),
    )
    .default([]),
});

export const parseLocalConfig = (text: string, configDir: string) => {
  const parsed = LocalConfig.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return {
    ...parsed.data,
    projects: parsed.data.projects.map((project) => ({
      ...project,
      path: path.resolve(configDir, project.path),
    })),
  };
};

const readLocalConfig = (file: string) => {
  try {
    return parseLocalConfig(readFileSync(file, "utf8"), path.dirname(file));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new Error(
      missing
        ? `${file} is missing: copy cortex.config.example.json there and list your projects`
        : `${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

const LOCAL_CONFIG = readLocalConfig(LOCAL_CONFIG_FILE);

export const PROJECTS = LOCAL_CONFIG.projects;

/** Merged into the Python tools' environment, e.g. to move uv and Hugging Face caches. */
export const TOOL_ENV = LOCAL_CONFIG.toolEnv;

/** Release feeds watched beyond what the projects' manifests list (runtimes and tools). */
export const EXTRA_RELEASE_REPOS = [
  "nodejs/node",
  "astral-sh/uv",
  "pnpm/pnpm",
  "renpy/renpy",
  "vllm-project/vllm",
  "yt-dlp/yt-dlp",
  "systran/faster-whisper",
];

const youtube = (id: string, title: string, trust: Source["trust"], channelId: string): Source => ({
  id,
  kind: "youtube",
  title: `${title} (YouTube)`,
  trust,
  location: channelId,
  bootstrapKeep: 1,
});

const feed = (id: string, title: string, trust: Source["trust"], url: string): Source => ({
  id,
  kind: "feed",
  title,
  trust,
  location: url,
  bootstrapKeep: 1,
});

const githubFeed = (id: string, title: string, repo: string, branch: string): Source => ({
  id,
  kind: "github-releases",
  title,
  trust: "primary",
  location: `https://github.com/${repo}/commits/${branch}.atom`,
  bootstrapKeep: 0,
});

/** A watched page: what changed on it is the news. */
const pageDiff = (id: string, title: string, url: string): Source => ({
  id,
  kind: "page-diff",
  title,
  trust: "primary",
  location: url,
  bootstrapKeep: Number.POSITIVE_INFINITY,
});

/**
 * Anthropic's prompting guidance as it read in each model generation (Claude 3, 3.5, 3.7, 4,
 * 4.5, early 5), from the Wayback Machine: the current docs only describe current models, and
 * the practice history needs what was advised before. Each is one dated entry, read once.
 */
const ARCHIVED_ANTHROPIC_DOCS: [stamp: string, page: string][] = [
  ["20240416114731", "docs.anthropic.com/claude/docs/be-clear-direct"],
  ["20240417154318", "docs.anthropic.com/claude/docs/use-xml-tags"],
  ["20240417155801", "docs.anthropic.com/claude/docs/prefill-claudes-response"],
  ["20240428061252", "docs.anthropic.com/claude/docs/let-claude-think"],
  ["20240417163826", "docs.anthropic.com/claude/docs/give-claude-a-role"],
  ["20240417150852", "docs.anthropic.com/claude/docs/use-examples"],
  ["20240417161805", "docs.anthropic.com/claude/docs/long-context-window-tips"],
  ["20240417153422", "docs.anthropic.com/claude/docs/minimizing-hallucinations"],
  ["20240417142801", "docs.anthropic.com/claude/docs/keep-claude-in-character"],
  [
    "20241106011251",
    "docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-of-thought",
  ],
  [
    "20241121031810",
    "docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prefill-claudes-response",
  ],
  [
    "20250224203903",
    "docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/extended-thinking-tips",
  ],
  [
    "20250522191526",
    "docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices",
  ],
  ["20250522192410", "docs.anthropic.com/en/docs/about-claude/models/migrating-to-claude-4"],
  ["20251015180236", "docs.claude.com/en/docs/about-claude/models/whats-new-claude-4-5"],
  [
    "20251202035625",
    "platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices",
  ],
  [
    "20260301174342",
    "platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices",
  ],
];

const archivedDoc = ([stamp, page]: [string, string]): Source => {
  const name = page.split("/").at(-1) ?? page;
  const month = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}`;
  return {
    id: `archive-${name}-${stamp.slice(0, 6)}`,
    kind: "snapshot",
    title: `Archived Anthropic docs (${month}): ${name.replace(/-/g, " ")}`,
    trust: "primary",
    location: `https://web.archive.org/web/${stamp}id_/https://${page}`,
    bootstrapKeep: Number.POSITIVE_INFINITY,
  };
};

/** Static sources; dependency release feeds are added at run time from the projects' manifests. */
export const SOURCES: Source[] = [
  {
    id: "field-reports",
    kind: "folder",
    title: "Field report",
    trust: "field-report",
    location: path.join(VAULT, "field-reports"),
    bootstrapKeep: Number.POSITIVE_INFINITY,
  },
  {
    id: "research",
    kind: "folder",
    title: "Research report",
    trust: "analysis",
    location: path.join(VAULT, "research"),
    bootstrapKeep: Number.POSITIVE_INFINITY,
  },
  {
    id: "claude-code-changelog",
    kind: "changelog",
    title: "Claude Code changelog",
    trust: "primary",
    location: "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
    bootstrapKeep: 3,
  },
  {
    id: "anthropic-site",
    kind: "sitemap",
    title: "Anthropic news and engineering",
    trust: "primary",
    location: "https://www.anthropic.com/sitemap.xml",
    match: "^https://www\\.anthropic\\.com/(news|engineering)/[^/]+$",
    bootstrapKeep: 0,
  },
  // claude.com/blog redirects here. The feed holds the whole blog (15 posts), and triage filters them.
  {
    ...feed("claude-dev-blog", "Claude developer blog", "primary", "https://claude.dev/rss.xml"),
    bootstrapKeep: Number.POSITIVE_INFINITY,
  },
  feed("openai-news", "OpenAI news", "primary", "https://openai.com/news/rss.xml"),
  feed(
    "anthropic-status",
    "Anthropic status",
    "primary",
    "https://status.anthropic.com/history.rss",
  ),
  feed("openai-status", "OpenAI status", "primary", "https://status.openai.com/history.rss"),
  ...LOCAL_CONFIG.sources.map(({ id, title, repo, branch }) => githubFeed(id, title, repo, branch)),
  pageDiff(
    "claude-api-notes",
    "Claude API release notes",
    "https://docs.claude.com/en/release-notes/api.md",
  ),
  pageDiff(
    "claude-deprecations",
    "Claude model deprecations",
    "https://docs.claude.com/en/docs/about-claude/model-deprecations.md",
  ),
  pageDiff(
    "claude-pricing",
    "Claude pricing",
    "https://docs.claude.com/en/docs/about-claude/pricing.md",
  ),
  // One page per model: how to prompt it, what changed from the previous one, how to migrate.
  {
    id: "claude-model-docs",
    kind: "sitemap",
    title: "Claude model docs",
    trust: "primary",
    location: "https://platform.claude.com/sitemap.xml",
    match:
      "^https://platform\\.claude\\.com/docs/en/(build-with-claude/prompt-engineering/prompting-claude-[a-z0-9-]+|models/[a-z0-9-]+/(migration-guide|whats-new-[a-z0-9-]+))$",
    bootstrapKeep: Number.POSITIVE_INFINITY,
  },
  pageDiff(
    "claude-prompting-best-practices",
    "Claude prompting best practices",
    "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md",
  ),
  ...ARCHIVED_ANTHROPIC_DOCS.map(archivedDoc),
  pageDiff(
    "claude-skills-best-practices",
    "Agent Skills authoring best practices",
    "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md",
  ),
  pageDiff("claude-code-skills", "Claude Code skills", "https://code.claude.com/docs/en/skills.md"),
  pageDiff(
    "claude-code-legal",
    "Claude Code legal and compliance",
    "https://docs.claude.com/en/docs/claude-code/legal-and-compliance.md",
  ),
  pageDiff(
    "anthropic-consumer-terms",
    "Anthropic consumer terms",
    "https://www.anthropic.com/legal/consumer-terms",
  ),
  pageDiff(
    "gemini-changelog",
    "Gemini API changelog",
    "https://ai.google.dev/gemini-api/docs/changelog.md.txt",
  ),
  pageDiff(
    "gemini-deprecations",
    "Gemini API deprecations",
    "https://ai.google.dev/gemini-api/docs/deprecations.md.txt",
  ),
  pageDiff(
    "gemini-pricing",
    "Gemini API pricing",
    "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
  ),
  pageDiff(
    "vertex-model-versions",
    "Vertex AI model versions and retirement",
    "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions",
  ),
  pageDiff(
    "openai-changelog",
    "OpenAI API changelog",
    "https://platform.openai.com/docs/changelog.md",
  ),
  feed("latent-space", "Latent Space", "analysis", "https://www.latent.space/feed"),
  feed("ainews", "AINews (smol.ai)", "practitioner", "https://news.smol.ai/rss.xml"),
  // Aggregators of other outlets' stories: their repetition is echo, not corroboration.
  feed("tldr-ai", "TLDR AI", "news", "https://tldr.tech/api/rss/ai"),
  feed("the-rundown", "The Rundown AI", "news", "https://www.therundown.ai/feed"),
  feed(
    "techcrunch-ai",
    "TechCrunch AI",
    "news",
    "https://techcrunch.com/category/artificial-intelligence/feed/",
  ),
  {
    id: "hf-papers",
    kind: "hf-papers",
    title: "Hugging Face Daily Papers",
    trust: "analysis",
    location: "https://huggingface.co/api/daily_papers",
    bootstrapKeep: 2,
  },
  {
    id: "hacker-news",
    kind: "hacker-news",
    title: "Hacker News",
    trust: "practitioner",
    location: "https://hn.algolia.com",
    bootstrapKeep: 2,
  },
  youtube("ai-explained", "AI Explained", "analysis", "UCNJ1Ymd5yFuUPtn21xtRbbw"),
  youtube("two-minute-papers", "Two Minute Papers", "analysis", "UCbfYPyITQ-7l4upoX8nvctg"),
  youtube("karpathy", "Andrej Karpathy", "analysis", "UCXUPKJO5MZQN11PqgIvyuvQ"),
  youtube("ai-jason", "AI Jason", "practitioner", "UCrXSVX9a1mj8l0CMLwKgMVw"),
  youtube("matthew-berman", "Matthew Berman", "news", "UCawZsQWqfGSbCI5yjkdVkTA"),
  // Conference talks: dense practitioner experience, but many speakers present their own product.
  youtube("ai-engineer", "AI Engineer", "practitioner", "UCLKPca3kwwd-B59HNr-_lvA"),
];
