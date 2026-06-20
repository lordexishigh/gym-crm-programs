import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // RLS tests open real DB connections; keep them serial and give DB setup
    // a little headroom.
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
