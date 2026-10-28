process.env.NODE_ENV = "test";

import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { threads: { maxThreads: 4 }, forks: { maxForks: 4 } },
    env: { NODE_ENV: "test" },
    include: ["packages/*/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.test-util.ts", "**/index.ts", "**/cli.ts", "packages/devflow/src/task/**"],
      thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 },
    },
  },
});
