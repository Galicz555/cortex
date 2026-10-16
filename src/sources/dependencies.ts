import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DATA, EXTRA_RELEASE_REPOS, PROJECTS } from "../config.ts";
import type { Source } from "../entries.ts";
import { logLine, toSlug } from "../shared.ts";

type Ecosystem = "npm" | "pypi";
type Dependency = { ecosystem: Ecosystem; name: string; projects: Set<string> };

const MANIFESTS = "{,*/,services/*/}{package.json,pyproject.toml}";
const REPO_CACHE = path.join(DATA, "repos.json");
const GITHUB_REPO = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/;

/**
 * One release feed per GitHub repo behind a dependency of our projects. Releases of a repo are
 * news for every project using any of its packages, so the source title names them.
 */
export const fetchDependencySources = async (): Promise<Source[]> => {
  const repoCache = await readRepoCache();
  const byRepo = new Map<string, Set<string>>(
    EXTRA_RELEASE_REPOS.map((repo) => [repo, new Set<string>()]),
  );
  for (const dependency of await collectProjectDependencies()) {
    const repo = await resolveRepoWith(repoCache)(dependency);
    if (repo === null) continue;
    const projects = byRepo.get(repo) ?? new Set<string>();
    for (const project of dependency.projects) projects.add(project);
    byRepo.set(repo, projects);
  }
  await writeFile(REPO_CACHE, JSON.stringify(repoCache, null, 2));
  return [...byRepo].map(([repo, projects]) => toReleaseSource(repo, [...projects].sort()));
};

const toReleaseSource = (repo: string, projects: string[]): Source => ({
  id: `release-${toSlug(repo.replace("/", "-"))}`,
  kind: "github-releases",
  title: `${repo} releases${projects.length > 0 ? ` (used by ${projects.join(", ")})` : ""}`,
  trust: "primary",
  location: `https://github.com/${repo}/releases.atom`,
  // Only releases published after Cortex started watching the repo are news.
  bootstrapKeep: 0,
});

export const collectProjectDependencies = async (): Promise<Dependency[]> => {
  const all = new Map<string, Dependency>();
  for (const project of PROJECTS) {
    const exclude = (name: string) => name === "node_modules" || name.startsWith(".");
    for await (const file of glob(MANIFESTS, { cwd: project.path, exclude })) {
      const text = await readFile(path.join(project.path, file), "utf8");
      const found = file.endsWith(".json") ? extractNpmNames(text) : extractPythonNames(text);
      const ecosystem: Ecosystem = file.endsWith(".json") ? "npm" : "pypi";
      for (const name of found) {
        const key = `${ecosystem}:${name}`;
        const dependency = all.get(key) ?? { ecosystem, name, projects: new Set<string>() };
        dependency.projects.add(project.name);
        all.set(key, dependency);
      }
    }
  }
  return [...all.values()];
};

const PackageJson = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** Workspace links and type-only packages have no releases worth reading. */
export const extractNpmNames = (text: string): string[] => {
  const manifest = PackageJson.parse(JSON.parse(text));
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([name, version]) => !name.startsWith("@types/") && !version.startsWith("workspace:"))
    .map(([name]) => name);
};

/** Which array keys hold requirements, per TOML table; `*` means every array in the table. */
const REQUIREMENT_KEYS: Record<string, string> = {
  project: "dependencies",
  "dependency-groups": "*",
  "project.optional-dependencies": "*",
  "tool.uv": "dev-dependencies",
};

/**
 * Package names from the requirement strings of a pyproject.toml.
 * Simplification: regex over TOML, not a TOML parser; a requirement written as an inline table is missed.
 */
export const extractPythonNames = (text: string): string[] =>
  text
    .split(/^\[/m)
    .flatMap((section) => {
      const table = /^([^\]]+)\]/.exec(section)?.[1]?.trim() ?? "";
      const wanted = REQUIREMENT_KEYS[table];
      if (wanted === undefined) return [];
      return [...section.matchAll(/^\s*([\w-]+)\s*=\s*\[([^\]]*)\]/gm)]
        .filter((match) => wanted === "*" || match[1] === wanted)
        .flatMap((match) => [
          ...(match[2] ?? "").replace(/#.*$/gm, "").matchAll(/["']([A-Za-z][\w.-]*)/g),
        ]);
    })
    .map((match) => (match[1] ?? "").toLowerCase());

type RepoCache = Record<string, string | null>;

const readRepoCache = async (): Promise<RepoCache> => {
  try {
    return z
      .record(z.string(), z.string().nullable())
      .parse(JSON.parse(await readFile(REPO_CACHE, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
};

/** Registry lookups are cached forever, misses included: a package rarely moves its repo. */
const resolveRepoWith =
  (cache: RepoCache) =>
  async (dependency: Dependency): Promise<string | null> => {
    const key = `${dependency.ecosystem}:${dependency.name}`;
    if (key in cache) return cache[key] ?? null;
    try {
      cache[key] = extractGithubRepo(await fetchRegistryUrls(dependency));
    } catch (error) {
      logLine(`dependency ${key}: registry lookup failed, retried next run: ${String(error)}`);
      return null;
    }
    return cache[key] ?? null;
  };

const fetchRegistryUrls = async ({ ecosystem, name }: Dependency): Promise<string[]> => {
  const url =
    ecosystem === "npm"
      ? `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`
      : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  const parsed = z
    .object({
      repository: z.union([z.string(), z.object({ url: z.string() })]).optional(),
      homepage: z.string().optional(),
      info: z
        .object({
          project_urls: z.record(z.string(), z.string()).nullish(),
          home_page: z.string().nullish(),
        })
        .optional(),
    })
    .parse(body);
  return [
    typeof parsed.repository === "string" ? parsed.repository : parsed.repository?.url,
    parsed.homepage,
    ...Object.values(parsed.info?.project_urls ?? {}),
    parsed.info?.home_page,
  ].filter((candidate): candidate is string => typeof candidate === "string");
};

export const extractGithubRepo = (urls: string[]): string | null => {
  for (const url of urls) {
    const match = GITHUB_REPO.exec(url);
    // github.com/sponsors/<user> is a funding page, often listed before the source
    if (match?.[1] && match[2] && match[1].toLowerCase() !== "sponsors")
      return `${match[1]}/${match[2]}`.toLowerCase();
  }
  return null;
};
