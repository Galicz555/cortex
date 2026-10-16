import { TIME_ZONE } from "./config.ts";

export const todayIn = (timeZone: string = TIME_ZONE): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());

export const logLine = (message: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 60;

/**
 * Slugs become file names inside the vault, and some come from model output that read
 * untrusted web text: only this shape may ever reach a path.
 */
export const isSlug = (value: string): boolean =>
  value.length <= MAX_SLUG_LENGTH && SLUG.test(value);

export const toSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");

/** Untrusted text for a prompt's tagged data block: it can neither close nor open a tag. */
export const toPromptData = (text: string): string =>
  text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** An untrusted attribute value: quoted, so it cannot add attributes either. */
export const toPromptAttribute = (text: string): string => JSON.stringify(toPromptData(text));

export const truncateWords = (text: string, maxWords: number): string => {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(" ")} [truncated]`;
};

/**
 * The key two reports of the same original share: a URL without scheme, "www.", query,
 * fragment or trailing slash. Anything that is not a URL is kept as given, lowercased.
 */
export const toOriginKey = (origin: string): string => {
  const trimmed = origin.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};
