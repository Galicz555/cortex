import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT, TOOL_ENV } from "../config.ts";
import type { Entry } from "../entries.ts";

const run = promisify(execFile);

const PAGE_TIMEOUT_MS = 10 * 60_000;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;

// Entry URLs come from feeds and Hacker News: none of them may reach this machine or its network.
// tools/page_text.py repeats the check for every redirect hop.
const NON_PUBLIC = new BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NON_PUBLIC.addSubnet(prefix, bits, "ipv4");
// ::/96 holds the unspecified, loopback and IPv4-compatible addresses. IPv4-mapped addresses
// need no rule of their own: BlockList checks them against the IPv4 subnets.
for (const [prefix, bits] of [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NON_PUBLIC.addSubnet(prefix, bits, "ipv6");

/** A web URL, or undefined for any other scheme or an unparsable string. */
export const toWebUrl = (raw: string): URL | undefined => {
  const url = URL.parse(raw);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") && url.hostname
    ? url
    : undefined;
};

/** Throws unless the URL is http(s) and every address its host resolves to is public. */
export const assertPublicUrl = async (raw: string): Promise<void> => {
  const url = toWebUrl(raw);
  if (url === undefined) throw new Error(`refused ${raw}: not an http(s) URL`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const addresses = await lookup(host, { all: true });
  const blocked = addresses.find(({ address, family }) =>
    NON_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4"),
  );
  if (blocked !== undefined) throw new Error(`refused ${raw}: ${blocked.address} is not public`);
};

/** The readable text of a web page, via `tools/page_text.py` (robots.txt, backoff on 429/5xx). */
export const fetchPageText = async (url: string): Promise<string> => {
  await assertPublicUrl(url);
  const { stdout } = await run(
    "uv",
    ["run", "--script", path.join(ROOT, "tools/page_text.py"), url],
    {
      timeout: PAGE_TIMEOUT_MS,
      maxBuffer: MAX_PAGE_BYTES,
      env: { ...process.env, ...TOOL_ENV },
    },
  );
  return stdout.trim();
};

export const expandWithPageText = async (entry: Entry): Promise<Entry> => ({
  ...entry,
  text: `${entry.text}\n\nPage text:\n${await fetchPageText(entry.url)}`,
});

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Feed HTML to text the model can read cheaply. Link targets are kept inline, because in a
 * newsletter the link (a repo, a paper) is often the most valuable part.
 * Simplification: regex, not a DOM parser; malformed HTML leaves stray tags, which costs tokens, not facts.
 */
export const toPlainText = (html: string): string =>
  html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X"))
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
