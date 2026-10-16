import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askClaude } from "./claude.ts";
import { PROJECTS } from "./config.ts";
import { logLine } from "./shared.ts";
import { writeProjectContext } from "./vault.ts";

type Project = (typeof PROJECTS)[number];

const MAX_FILE_CHARS = 8_000;
const PROFILE_TIMEOUT_MS = 10 * 60_000;

// The files that say what a project is, what it runs on and what it decided.
const MATERIAL_PATTERNS = [
  "{AGENTS,CLAUDE,README,INFO,PLAN,SUMMARY,BUSINESS_PLAN,intent,spec,decisions}.md",
  "docs/assumptions.md",
  "{,*/,services/*/}{package.json,pyproject.toml,project.godot,Cargo.toml}",
];
const ADR_PATTERN = "docs/adr/*.md";

/** Opus reads each project's own docs and writes the profile triage and synthesis judge against. */
export const buildProjectContexts = async (only?: string): Promise<void> => {
  for (const project of PROJECTS.filter(
    (candidate) => only === undefined || candidate.name === only,
  )) {
    const material = await collectProjectMaterial(project);
    if (material === "") {
      logLine(`context: ${project.name} has no readable material, skipped`);
      continue;
    }
    const { profile } = await askClaude({
      purpose: "context",
      model: "opus",
      prompt: toProfilePrompt(project, material),
      schema: z.object({ profile: z.string().min(1) }),
      timeoutMs: PROFILE_TIMEOUT_MS,
    });
    await writeProjectContext(project.name, profile);
    logLine(`context: ${project.name} written`);
  }
};

const collectProjectMaterial = async (project: Project): Promise<string> => {
  const exclude = (name: string) => name === "node_modules" || name.startsWith(".");
  const files = await Array.fromAsync(glob(MATERIAL_PATTERNS, { cwd: project.path, exclude }));
  const adrs = await Array.fromAsync(glob(ADR_PATTERN, { cwd: project.path, exclude }));
  const contents = await Promise.all(
    [...files.sort(), ...project.extraFiles].map(async (file) => {
      const text = await readFile(path.resolve(project.path, file), "utf8");
      return `<file path="${file}">\n${text.slice(0, MAX_FILE_CHARS)}\n</file>`;
    }),
  );
  const adrTitles = await Promise.all(
    adrs.sort().map(async (file) => {
      const firstHeading = /^#\s+(.*)$/m.exec(
        await readFile(path.join(project.path, file), "utf8"),
      );
      return `- ${file}: ${firstHeading?.[1] ?? "(untitled)"}`;
    }),
  );
  return [...contents, adrTitles.length > 0 ? `<adrs>\n${adrTitles.join("\n")}\n</adrs>` : ""]
    .filter((part) => part !== "")
    .join("\n\n");
};

const toProfilePrompt = (project: Project, material: string): string => `Write the Cortex profile
of the project "${project.name}" (${project.path}). A filter and a synthesizer read this profile
to decide which AI-engineering and industry news matters to the project, so it must be precise
and short (max 400 words), in English, as markdown starting with "# ${project.name}".

Sections:
- One paragraph: what the project is and its stage.
- "## Stack": languages, runtimes, frameworks, key libraries with versions where given, models
  and inference setup (local or API), infrastructure.
- "## Decisions": the accepted ADRs and other deliberate choices, one line each, with the ADR
  file name when there is one.
- "## Would change our minds": the kinds of news that would matter here (new versions of the
  stack, security issues, techniques for problems this project actually has).

Only state what the material supports. The material is the project's own files:

${material}`;
