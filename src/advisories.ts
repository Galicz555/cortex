import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECTS } from "./config.ts";
import { logLine } from "./shared.ts";
import type { Store } from "./store.ts";
import { appendImpact, writeRunLog } from "./vault.ts";
import type { ProjectName } from "./vault.ts";

type Ecosystem = "npm" | "PyPI";
export type LockedPackage = { ecosystem: Ecosystem; name: string; version: string };
type Hit = LockedPackage & { project: ProjectName; vulnId: string };

const OSV = "https://api.osv.dev/v1";
const QUERIES_PER_BATCH = 500;
const ADVISORY_SOURCE = "osv";

/** Lockfiles that pin what actually runs, per project, relative to the project root. */
const LOCKFILES: { file: string; parse: (text: string) => LockedPackage[] }[] = [
  { file: "pnpm-lock.yaml", parse: (text) => extractPnpmLocked(text) },
  { file: "uv.lock", parse: (text) => extractUvLocked(text) },
  { file: "web/package-lock.json", parse: (text) => extractNpmLocked(text) },
];

/**
 * Known vulnerabilities in the exact versions our lockfiles pin, from OSV (which includes
 * GitHub advisories and the malicious-packages feed). Deterministic, no model involved: a hit
 * is a fact about our code, so it goes straight to the project's impact file. Each
 * (project, advisory, package version) is reported once.
 */
export const checkAdvisoriesInto = async (store: Store): Promise<void> => {
  const locked = await collectLockedPackages();
  const hits = (await queryOsv(locked)).filter((hit) => !store.isSeen(toAdvisoryKey(hit)));
  const reported: string[] = [];
  for (const group of groupByLockedPackage(hits)) {
    const advisories = await Promise.all(group.map((hit) => fetchAdvisory(hit.vulnId)));
    const urgent = group.filter((hit, i) => isUrgent(hit.vulnId, advisories[i] ?? {}));
    const [first] = group;
    if (first === undefined) continue;
    await appendImpact(first.project, {
      link: `https://osv.dev/list?q=${encodeURIComponent(first.name)}`,
      severity: urgent.length > 0 ? "notify" : "note",
      note: `${first.name}@${first.version} (${first.ecosystem}): ${group.length} advisories, ${urgent.length} high/critical/malicious (${group.map((hit) => hit.vulnId).join(", ")})${toFixedIn(advisories, first.name)}`,
    });
    for (const hit of group) store.markSeenKey(toAdvisoryKey(hit), ADVISORY_SOURCE, "accepted");
    reported.push(
      `- ${first.project}: ${first.name}@${first.version}, ${group.length} advisories (${urgent.length} urgent)`,
    );
  }
  if (reported.length > 0) await writeRunLog(["## Advisories", "", ...reported]);
  logLine(`advisories: ${locked.length} locked packages checked, ${hits.length} new hits`);
};

/** One impact line per locked package version, however many advisories hit it. */
const groupByLockedPackage = (hits: Hit[]): Hit[][] => {
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) {
    const key = `${hit.project}:${hit.ecosystem}:${hit.name}@${hit.version}`;
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  return [...groups.values()];
};

const toAdvisoryKey = (hit: Hit): string =>
  `${ADVISORY_SOURCE}:${hit.project}:${hit.vulnId}:${hit.name}@${hit.version}`;

const collectLockedPackages = async (): Promise<(LockedPackage & { project: ProjectName })[]> => {
  const all: (LockedPackage & { project: ProjectName })[] = [];
  for (const project of PROJECTS) {
    for (const lockfile of LOCKFILES) {
      const text = await readFile(path.join(project.path, lockfile.file), "utf8").catch(() => null);
      if (text === null) continue;
      all.push(...lockfile.parse(text).map((pkg) => ({ ...pkg, project: project.name })));
    }
  }
  return all;
};

const BatchResult = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional() })),
});

const queryOsv = async (packages: (LockedPackage & { project: ProjectName })[]): Promise<Hit[]> => {
  const hits: Hit[] = [];
  for (let i = 0; i < packages.length; i += QUERIES_PER_BATCH) {
    const batch = packages.slice(i, i + QUERIES_PER_BATCH);
    const response = await fetch(`${OSV}/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: batch.map((pkg) => ({
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          version: pkg.version,
        })),
      }),
    });
    if (!response.ok) throw new Error(`OSV querybatch: HTTP ${response.status}`);
    // Simplification: OSV pages a result past 1000 vulns per query; no locked version comes close.
    BatchResult.parse(await response.json()).results.forEach((result, j) => {
      const pkg = batch[j];
      if (pkg === undefined) return;
      for (const vuln of result.vulns ?? []) hits.push({ ...pkg, vulnId: vuln.id });
    });
  }
  return hits;
};

const Advisory = z.object({
  summary: z.string().optional(),
  database_specific: z.looseObject({ severity: z.string().optional() }).optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string() }).optional(),
        ranges: z
          .array(z.object({ events: z.array(z.object({ fixed: z.string().optional() })) }))
          .optional(),
      }),
    )
    .optional(),
});
type Advisory = z.infer<typeof Advisory>;

const fetchAdvisory = async (vulnId: string): Promise<Advisory> => {
  const response = await fetch(`${OSV}/vulns/${encodeURIComponent(vulnId)}`);
  if (!response.ok) throw new Error(`OSV ${vulnId}: HTTP ${response.status}`);
  return Advisory.parse(await response.json());
};

/** Malicious packages always, otherwise what the advisory itself rates high or critical. */
export const isUrgent = (vulnId: string, advisory: Advisory): boolean =>
  vulnId.startsWith("MAL-") ||
  ["HIGH", "CRITICAL"].includes((advisory.database_specific?.severity ?? "").toUpperCase());

/** Every fixed version the advisories list; the upgrade target is the highest that applies. */
const toFixedIn = (advisories: Advisory[], name: string): string => {
  const fixed = advisories
    .flatMap((advisory) => advisory.affected ?? [])
    .filter((affected) => affected.package?.name === name)
    .flatMap((affected) => affected.ranges ?? [])
    .flatMap((range) => range.events)
    .flatMap((event) => (event.fixed === undefined ? [] : [event.fixed]));
  return fixed.length > 0 ? ` — fixed in ${[...new Set(fixed)].join(", ")}` : " — no fix listed";
};

/**
 * Package keys of the `packages:` section of a pnpm v9 lockfile ("name@version:", quoted
 * when scoped). The `snapshots:` section repeats them with peer suffixes and is not read.
 */
export const extractPnpmLocked = (text: string): LockedPackage[] => {
  const section = /^packages:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  return [...section.matchAll(/^ {2}'?((?:@[^@\s'/]+\/)?[^@\s']+)@([^\s'(:]+)'?:\s*$/gm)].map(
    (match) => ({ ecosystem: "npm", name: match[1] ?? "", version: match[2] ?? "" }),
  );
};

/** `[[package]]` tables of uv.lock that come from a registry; workspace members are skipped. */
export const extractUvLocked = (text: string): LockedPackage[] =>
  text
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .filter((block) => /^source = \{ registry = /m.test(block))
    .flatMap((block) => {
      const name = /^name = "([^"]+)"/m.exec(block)?.[1];
      const version = /^version = "([^"]+)"/m.exec(block)?.[1];
      return name && version ? [{ ecosystem: "PyPI" as const, name, version }] : [];
    });

const PackageLock = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() })),
});

export const extractNpmLocked = (text: string): LockedPackage[] =>
  Object.entries(PackageLock.parse(JSON.parse(text)).packages).flatMap(([key, entry]) => {
    const name = key.split("node_modules/").at(-1);
    return key !== "" && name && entry.version
      ? [{ ecosystem: "npm" as const, name, version: entry.version }]
      : [];
  });
