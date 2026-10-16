import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAdvisoriesInto } from "./advisories.ts";
import { DATA, VAULT } from "./config.ts";
import { runDaily } from "./daily.ts";
import { compareModelsIn } from "./practice-note.ts";
import { reviewPracticesIn } from "./practice-review.ts";
import { buildProjectContexts } from "./projects.ts";
import { logLine } from "./shared.ts";
import { migrateTopicNotes } from "./migrate.ts";
import { seedTopics } from "./seed.ts";
import { openStore } from "./store.ts";
import type { Store } from "./store.ts";
import { runProjections } from "./projections.ts";

const VAULT_DIRS = [
  "topics",
  "sources",
  "impact",
  "context",
  "field-reports",
  "research",
  "log",
  "compare",
];

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  run: () => withStore(runDaily),
  practices: () => withStore(reviewPracticesIn),
  compare: (args) => withStore((store) => compareModelsIn(store)(args)),
  projections: () => withStore(runProjections),
  advisories: () => withStore(checkAdvisoriesInto),
  context: ([project]) => buildProjectContexts(project),
  seed: () => withStore(seedTopics),
  migrate: () => withStore(migrateTopicNotes),
};

const withStore = async (task: (store: Store) => Promise<void>): Promise<void> => {
  const store = openStore(path.join(DATA, "cortex.db"));
  try {
    await task(store);
  } finally {
    store.close();
  }
};

const main = async (command: string | undefined, args: string[]): Promise<void> => {
  const action = command === undefined ? undefined : COMMANDS[command];
  if (action === undefined)
    throw new Error(`usage: node src/main.ts <${Object.keys(COMMANDS).join("|")}>`);
  await mkdir(DATA, { recursive: true });
  for (const dir of VAULT_DIRS) await mkdir(path.join(VAULT, dir), { recursive: true });
  await action(args);
};

main(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
  logLine(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
