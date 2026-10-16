import type { Claim } from "./knowledge.ts";
import type { ModelRef, Practice, Stance, Surface } from "./practices.ts";
import { compareVersions, findStanceAt, parseModelRef, SURFACES } from "./practices.ts";
import { logLine, todayIn } from "./shared.ts";
import type { Store } from "./store.ts";
import { writeVaultFile } from "./vault.ts";

/** Claim id → the claim, for linking evidence to its topic and flagging superseded claims. */
type ClaimLookup = Map<number, Claim>;

export const writePracticeNotesFrom = async (store: Store): Promise<void> => {
  const stances = store.fetchStances();
  await writeVaultFile(
    "practices.md",
    renderPracticesNote(store.listPractices(), stances, toClaimLookup(store, stances)),
  );
};

/**
 * `pnpm compare opus-3 opus-5.5 [surface]`: what to do differently on the second model, as a
 * vault note. A pure render of the practice history; no model is called.
 */
export const compareModelsIn =
  (store: Store) =>
  async ([from = "", to = "", surface = "any"]: string[]): Promise<void> => {
    const checkedSurface = SURFACES.find((known) => known === surface);
    if (checkedSurface === undefined)
      throw new Error(`surface must be one of ${SURFACES.join(", ")}, got ${surface}`);
    const before = parseModelRef(from);
    const after = parseModelRef(to);
    const stances = store.fetchStances();
    const file = `compare/${toModelName(before)}--${toModelName(after)}${checkedSurface === "any" ? "" : `--${checkedSurface}`}.md`;
    await writeVaultFile(
      file,
      renderComparison({
        before,
        after,
        surface: checkedSurface,
        practices: store.listPractices(),
        stances,
        claims: toClaimLookup(store, stances),
      }),
    );
    logLine(`compare: wrote vault/${file}`);
  };

const toClaimLookup = (store: Store, stances: Stance[]): ClaimLookup =>
  new Map(
    store
      .fetchClaimsByIds([...new Set(stances.flatMap((stance) => stance.evidence))])
      .map((claim) => [claim.id, claim]),
  );

const toModelName = (model: ModelRef): string => `${model.line}-${model.version}`;

const isDiscouraged = (stance: Stance | undefined): boolean =>
  stance?.stance === "avoid" || stance?.stance === "unsupported";

type PracticeChange = { practice: Practice; before: Stance | undefined; after: Stance | undefined };

/**
 * Sections by what the reader should do on the newer model: stop, start, adjust. A practice
 * whose stance is the same on both sides is listed by name only; one with no stance on either
 * side is left out, since nothing is known about it for these models.
 */
export const renderComparison = (input: {
  before: ModelRef;
  after: ModelRef;
  surface: Surface;
  practices: Practice[];
  stances: Stance[];
  claims: ClaimLookup;
}): string => {
  const changes: PracticeChange[] = input.practices
    .map((practice) => {
      const own = input.stances.filter((stance) => stance.practice === practice.slug);
      return {
        practice,
        before: findStanceAt(own, input.before, input.surface),
        after: findStanceAt(own, input.after, input.surface),
      };
    })
    .filter((change) => change.before !== undefined || change.after !== undefined);
  const isSame = (change: PracticeChange): boolean =>
    change.before !== undefined && change.before.stance === change.after?.stance;
  const differing = changes.filter((change) => !isSame(change));
  const stop = differing.filter(
    (change) => isDiscouraged(change.after) && !isDiscouraged(change.before),
  );
  const start = differing.filter(
    (change) => change.after?.stance === "recommended" && !stop.includes(change),
  );
  const other = differing.filter((change) => !stop.includes(change) && !start.includes(change));
  const toLine = toChangeLine(input.claims);
  return [
    "---",
    `title: ${JSON.stringify(`${toModelTitle(input.before)} → ${toModelTitle(input.after)}`)}`,
    `surface: ${input.surface}`,
    `generated: ${todayIn()}`,
    "---",
    "",
    `# ${toModelTitle(input.before)} → ${toModelTitle(input.after)}`,
    "",
    "Rendered from the practice history ([[practices]]). A stance holds from the version it names",
    "until a later one replaces it; trust is the best source behind it, and a single training or",
    "practitioner source is tentative.",
    "",
    ...toSection("Stop doing", stop.map(toLine)),
    ...toSection("Start doing", start.map(toLine)),
    ...toSection("Changed", other.map(toLine)),
    ...toSection(
      "Same on both",
      changes
        .filter(isSame)
        .map((change) => `- ${change.practice.title}: ${change.after?.stance ?? ""}`),
    ),
  ].join("\n");
};

const toModelTitle = (model: ModelRef): string =>
  `${model.line[0]?.toUpperCase() ?? ""}${model.line.slice(1)} ${model.version}`;

const toSection = (heading: string, lines: string[]): string[] =>
  lines.length === 0 ? [] : [`## ${heading}`, "", ...lines, ""];

const toChangeLine =
  (claims: ClaimLookup) =>
  (change: PracticeChange): string =>
    `- **${change.practice.title}** (${change.practice.kind}): ${toStanceSummary(change.before)} → ${toStanceSummary(change.after)}${change.after === undefined ? "" : `. ${change.after.note} ${toEvidence(claims, change.after)}`}`;

const toStanceSummary = (stance: Stance | undefined): string =>
  stance === undefined ? "no guidance" : `${stance.stance} (since ${stance.since})`;

/** Evidence links to the topic holding each claim; a stance whose claims were all superseded says so. */
const toEvidence = (claims: ClaimLookup, stance: Stance): string => {
  const own = stance.evidence.flatMap((id) => claims.get(id) ?? []);
  const links = own.map((claim) => `[[topics/${claim.topic}|C${claim.id}]]`).join(", ");
  const stale = own.length > 0 && own.every((claim) => claim.status === "superseded");
  return `(${stance.trust}; ${links}${stale ? "; evidence since superseded" : ""})`;
};

export const renderPracticesNote = (
  practices: Practice[],
  stances: Stance[],
  claims: ClaimLookup,
): string =>
  [
    "---",
    'title: "Practices by model"',
    `updated: ${todayIn()}`,
    "---",
    "",
    "# Practices by model",
    "",
    "How Anthropic's guidance on each prompting, API, agent and skill practice changed across",
    "Claude versions. Each line is a stance that holds from its version on, for the lines and",
    "surface named. Compare two models with `pnpm compare opus-3 opus-5.5`.",
    "",
    ...practices.flatMap((practice) => {
      const timeline = stances
        .filter((stance) => stance.practice === practice.slug && stance.replacedBy === null)
        .sort((a, b) => compareVersions(a.since, b.since));
      return timeline.length === 0
        ? []
        : [
            `## ${practice.title}`,
            "",
            `\`${practice.slug}\` (${practice.kind}): ${practice.summary}`,
            "",
            ...timeline.map(
              (stance) =>
                `- **${stance.since}+** ${stance.lines.length === 0 ? "all lines" : stance.lines.join(", ")}, ${stance.surface}: ${stance.stance}. ${stance.note} ${toEvidence(claims, stance)}`,
            ),
            "",
          ];
    }),
  ].join("\n");
