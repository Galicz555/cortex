import { describe, expect, it } from "vitest";
import {
  extractNpmLocked,
  extractPnpmLocked,
  extractUvLocked,
  isUrgent,
} from "../src/advisories.ts";
import { toLineDiff } from "../src/sources/page-diff.ts";

describe("locked versions from lockfiles", () => {
  it("reads the packages section of a pnpm lockfile, not the snapshots", () => {
    const lock = `lockfileVersion: '9.0'

packages:

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-x}

  zod@4.6.5:
    resolution: {integrity: sha512-y}

snapshots:

  '@scope/pkg@1.2.3(peer@2.0.0)':
    dependencies: {}
`;
    expect(extractPnpmLocked(lock)).toEqual([
      { ecosystem: "npm", name: "@scope/pkg", version: "1.2.3" },
      { ecosystem: "npm", name: "zod", version: "4.6.5" },
    ]);
  });

  it("reads registry packages of uv.lock and skips workspace members", () => {
    const lock = `version = 1

[[package]]
name = "example-app"
version = "0.0.0"
source = { virtual = "." }

[[package]]
name = "httpx"
version = "0.28.1"
source = { registry = "https://pypi.org/simple" }
`;
    expect(extractUvLocked(lock)).toEqual([
      { ecosystem: "PyPI", name: "httpx", version: "0.28.1" },
    ]);
  });

  it("reads nested node_modules of package-lock.json, skipping the root", () => {
    const lock = JSON.stringify({
      packages: {
        "": { version: "1.0.0" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/@b/c": { version: "2.0.0" },
      },
    });
    expect(extractNpmLocked(lock)).toEqual([
      { ecosystem: "npm", name: "a", version: "1.0.0" },
      { ecosystem: "npm", name: "@b/c", version: "2.0.0" },
    ]);
  });
});

describe("which advisories interrupt the owner", () => {
  it("always flags malicious packages, and high or critical severity", () => {
    expect(isUrgent("MAL-2026-1", {})).toBe(true);
    expect(isUrgent("GHSA-x", { database_specific: { severity: "HIGH" } })).toBe(true);
    expect(isUrgent("GHSA-x", { database_specific: { severity: "MODERATE" } })).toBe(false);
    expect(isUrgent("GHSA-x", {})).toBe(false);
  });
});

describe("page diffs", () => {
  it("reports added and removed lines, ignoring moves and blank lines", () => {
    expect(toLineDiff("a\nb\n\nc", "c\na\nd\n")).toEqual({ added: ["d"], removed: ["b"] });
  });
});
