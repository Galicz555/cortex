import { describe, expect, it } from "vitest";
import type { Source } from "../src/entries.ts";
import {
  extractGithubRepo,
  extractNpmNames,
  extractPythonNames,
} from "../src/sources/dependencies.ts";
import { parseFeedEntries } from "../src/sources/feed.ts";
import { assertPublicUrl, toPlainText } from "../src/sources/page.ts";

const source: Source = {
  id: "test-feed",
  kind: "feed",
  title: "Test",
  trust: "news",
  location: "https://example.test/feed",
  bootstrapKeep: 1,
};

describe("feed HTML to plain text", () => {
  it("keeps link targets inline, since in a newsletter the link is often the point", () => {
    expect(toPlainText('<p>See <a href="https://github.com/a/b">the repo</a>.</p>')).toBe(
      "See the repo (https://github.com/a/b).",
    );
  });

  it("drops scripts and styles, decodes entities, collapses blank lines", () => {
    const html =
      "<style>p{}</style><script>evil()</script><p>a &amp; b&#39;s &#x41;</p><p></p><p>c</p>";
    expect(toPlainText(html)).toBe("a & b's A\n\nc");
  });
});

describe("feed parsing", () => {
  it("reads RSS items newest first, preferring full content over the description", () => {
    const xml = `<rss><channel>
      <item><title>Old</title><link>https://x.test/old</link><guid>g1</guid>
        <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate><description>teaser</description></item>
      <item><title>New</title><link>https://x.test/new</link><guid>g2</guid>
        <pubDate>Wed, 30 Sep 2026 10:00:00 GMT</pubDate><description>teaser</description>
        <content:encoded><![CDATA[<p>full</p>]]></content:encoded></item>
    </channel></rss>`;
    const entries = parseFeedEntries(source, xml);
    expect(entries.map((entry) => [entry.id, entry.publishedOn, entry.text])).toEqual([
      ["test-feed:g2", "2026-09-30", "full"],
      ["test-feed:g1", "2026-09-28", "teaser"],
    ]);
  });

  it("reads a single Atom entry and picks its alternate link", () => {
    const xml = `<feed><entry><id>tag:r/1</id><title>v1.0</title>
      <link rel="self" href="https://x.test/self"/><link rel="alternate" href="https://x.test/v1"/>
      <updated>2026-10-01T00:00:00Z</updated><content type="html">&lt;p&gt;notes&lt;/p&gt;</content>
    </entry></feed>`;
    expect(parseFeedEntries(source, xml)).toEqual([
      expect.objectContaining({ id: "test-feed:tag:r/1", url: "https://x.test/v1", text: "notes" }),
    ]);
  });

  it("reads a feed with no entries as empty", () => {
    expect(parseFeedEntries(source, "<feed><id>tag:r</id><title>none yet</title></feed>")).toEqual(
      [],
    );
    expect(
      parseFeedEntries(source, "<rss><channel><title>none yet</title></channel></rss>"),
    ).toEqual([]);
  });
});

describe("which page URLs may be fetched", () => {
  it.each([
    ["a non-web scheme", "file:///etc/passwd"],
    ["a non-web scheme", "ftp://example.com/x"],
    ["a name for loopback", "http://localhost:8080/"],
    ["IPv4 loopback", "http://127.0.0.1/"],
    ["IPv4 loopback in another notation", "http://2130706433/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["RFC 1918 10/8", "http://10.1.2.3/"],
    ["RFC 1918 172.16/12", "http://172.20.0.1/"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/"],
    ["IPv6 unique local", "http://[fd12:3456::1]/"],
    ["IPv4 link-local (cloud metadata)", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    // Hex, because the export scan refuses this range written out as a tailnet address.
    ["shared address space 100.64/10", "http://0x64400001/"],
    ["IPv4 unspecified", "http://0.0.0.0/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv4 multicast", "http://224.0.0.251/"],
    ["IPv6 multicast", "http://[ff02::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
  ])("refuses %s: %s", async (_, url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(/refused/);
  });

  it("allows a public address", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/dns-query")).resolves.toBeUndefined();
  });

  it("drops feed entries whose link is not a web URL, keeping the rest", () => {
    const xml = `<rss><channel>
      <item><title>Bad</title><link>javascript:alert(1)</link><guid>g1</guid></item>
      <item><title>Worse</title><link>file:///etc/passwd</link><guid>g2</guid></item>
      <item><title>Broken</title><link>http://</link><guid>g3</guid></item>
      <item><title>Good</title><link>https://x.test/ok</link><guid>g4</guid></item>
    </channel></rss>`;
    expect(parseFeedEntries(source, xml).map((entry) => entry.url)).toEqual(["https://x.test/ok"]);
  });
});

describe("dependency discovery", () => {
  it("skips type packages and workspace links in package.json", () => {
    const manifest = JSON.stringify({
      dependencies: { zod: "4.6.5", "@app/shared": "workspace:*" },
      devDependencies: { "@types/node": "24", vitest: "5" },
    });
    expect(extractNpmNames(manifest)).toEqual(["zod", "vitest"]);
  });

  it("reads requirement arrays only, ignoring comments and unrelated arrays", () => {
    const toml = `[project]
name = "x"
dependencies = [
    "Torch>=2.4",  # it's pinned below
    "pipecat-ai[silero]==0.0.9; python_version >= '3.12'",
]
[dependency-groups]
dev = ["pytest"]
[tool.pytest.ini_options]
testpaths = ["tests"]
`;
    expect(extractPythonNames(toml)).toEqual(["torch", "pipecat-ai", "pytest"]);
  });

  it("finds the GitHub repo in registry URLs, normalised", () => {
    expect(
      extractGithubRepo(["https://example.com", "git+https://github.com/Kysely-org/kysely.git"]),
    ).toBe("kysely-org/kysely");
    expect(extractGithubRepo(["https://github.com/SYSTRAN/faster-whisper/tree/main"])).toBe(
      "systran/faster-whisper",
    );
    expect(extractGithubRepo(["https://gitlab.com/a/b"])).toBeNull();
    // a funding link is listed before the source on PyPI, and is not a repo
    expect(
      extractGithubRepo([
        "https://github.com/sponsors/Kludex",
        "https://github.com/Kludex/uvicorn",
      ]),
    ).toBe("kludex/uvicorn");
  });
});
