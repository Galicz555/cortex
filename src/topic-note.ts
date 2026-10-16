import type { Claim, Topic } from "./knowledge.ts";
import { countOrigins, toClaimTrust } from "./knowledge.ts";

/**
 * A topic note is a pure function of the topic's prose and claims: the vault can be rebuilt
 * from the database at any time, and nothing a model wrote reaches the note unchecked.
 */
export const renderTopicNote = (topic: Topic, claims: Claim[]): string => {
  const active = claims.filter((claim) => claim.status === "active");
  const superseded = claims.filter((claim) => claim.status === "superseded");
  return [
    "---",
    `title: ${JSON.stringify(topic.title)}`,
    `summary: ${JSON.stringify(topic.summary)}`,
    `updated: ${topic.updatedOn}`,
    "---",
    "",
    ...toSection("Current state", topic.currentState),
    ...toSection("Guidance", topic.guidance),
    ...toSection("Evidence", active.map(toEvidenceLine).join("\n")),
    ...toSection("Superseded", superseded.map(toSupersededLine).join("\n")),
    ...toSection("Open questions", topic.openQuestions),
    ...toSection("Related", topic.related.map((slug) => `- [[topics/${slug}]]`).join("\n")),
  ].join("\n");
};

const toSection = (heading: string, body: string): string[] =>
  body.trim() === "" ? [] : [`## ${heading}`, "", body.trim(), ""];

export const toEvidenceLine = (claim: Claim): string => {
  const origins = countOrigins(claim.sources);
  const links = claim.sources
    .map((source) => `[[${source.sourceNote}|${source.title.replace(/[|\]]/g, " ")}]]`)
    .join(", ");
  return `- **C${claim.id}** (${claim.statedOn}, ${toClaimTrust(claim.sources)}, ${origins} independent ${origins === 1 ? "origin" : "origins"}) ${claim.text} — ${links}`;
};

const toSupersededLine = (claim: Claim): string =>
  `- ~~C${claim.id}~~ (stated ${claim.statedOn}, superseded ${claim.supersededOn ?? "?"}${claim.supersededBy === null ? "" : ` by C${claim.supersededBy}`}) ${claim.text} — ${claim.reason ?? ""}`;
