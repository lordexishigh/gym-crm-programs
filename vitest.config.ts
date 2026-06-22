import { defineConfig } from "vitest/config";

export default defineConfig({
  // The view test renders JSX components; use React's automatic runtime (as
  // Next does) so no explicit `React` import is needed in component files.
  esbuild: { jsx: "automatic" },
  test: {
    // RLS tests open real DB connections; keep them serial and give DB setup
    // a little headroom.
    include: ["test/**/*.test.ts"],
    // Runs before any test module is imported. Neutralises a non-local
    // DATABASE_URL so the seeding RLS suites can never silently target a
    // remote/production database (see test/setup/db-safety.ts).
    setupFiles: ["test/setup/db-safety.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
