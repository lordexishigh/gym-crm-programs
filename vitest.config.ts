import { defineConfig } from "vitest/config";

export default defineConfig({
  // The view tests render JSX components; use React's automatic runtime (as
  // Next does) so no explicit `React` import is needed in component files.
  // vite 8 transforms with oxc (the `esbuild` option is inert), and the
  // project tsconfig sets `jsx: "preserve"` (required by Next), which would
  // skip the JSX transform — override it for the test pipeline.
  oxc: {
    jsx: { runtime: "automatic" },
  },
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
    // Vitest 4 removed `poolOptions.forks.singleFork`; a single worker with
    // file parallelism off gives the same serial execution.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
