import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Random order, files and tests alike: a test that leans on another's leftovers fails.
    sequence: { shuffle: true },
    // Tests see the example projects, never this machine's real list.
    env: { CORTEX_CONFIG: "cortex.config.example.json" },
  },
});
