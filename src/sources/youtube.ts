import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { ROOT, TOOL_ENV } from "../config.ts";
import type { Entry, Source } from "../entries.ts";

const run = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

const FeedEntry = z.object({
  "yt:videoId": z.string().regex(/^[\w-]{11}$/),
  title: z.coerce.string(),
  published: z.string(),
  link: z.object({ "@_href": z.string() }),
  "media:group": z.object({ "media:description": z.coerce.string().default("") }),
});
const Feed = z.object({
  feed: z.object({ entry: z.union([FeedEntry, z.array(FeedEntry)]).optional() }),
});

/** The channel's public Atom feed: the newest ~15 uploads, Shorts excluded. */
export const fetchYoutubeEntries = async (source: Source): Promise<Entry[]> => {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.location)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  const { feed } = Feed.parse(
    new XMLParser({ ignoreAttributes: false }).parse(await response.text()),
  );
  return [feed.entry ?? []]
    .flat()
    .filter((video) => !video.link["@_href"].includes("/shorts/"))
    .map((video) => ({
      id: `${source.id}:${video["yt:videoId"]}`,
      source,
      title: video.title,
      url: `https://www.youtube.com/watch?v=${video["yt:videoId"]}`,
      publishedOn: video.published.slice(0, 10),
      text: `Description:\n${video["media:group"]["media:description"]}`,
    }));
};

/**
 * Whisper over the audio track, not YouTube's captions: the caption endpoint demands a PO
 * token and rate-limits, while the audio download does not.
 */
export const expandWithTranscript = async (entry: Entry): Promise<Entry> => {
  const workDir = await mkdtemp(path.join(tmpdir(), "cortex-audio-"));
  try {
    await run(
      "yt-dlp",
      [
        "--quiet",
        "--no-playlist",
        "-f",
        "ba",
        "-o",
        path.join(workDir, "audio.%(ext)s"),
        entry.url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS },
    );
    const [audioFile] = await readdir(workDir);
    if (audioFile === undefined) throw new Error(`${entry.id}: yt-dlp produced no audio file`);
    const { stdout } = await run(
      "uv",
      ["run", "--script", path.join(ROOT, "tools/transcribe.py"), path.join(workDir, audioFile)],
      {
        timeout: TRANSCRIBE_TIMEOUT_MS,
        maxBuffer: MAX_TRANSCRIPT_BYTES,
        env: { ...process.env, ...TOOL_ENV },
      },
    );
    return { ...entry, text: `${entry.text}\n\nTranscript:\n${stdout}` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};
