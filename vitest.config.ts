import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@orrery/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@orrery/source"],
      externalConditions: ["@orrery/source"],
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts", "apps/worker/test/**/*.test.ts", "apps/cli/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    globalSetup: ["./test/global-setup.ts"],
  },
});
