import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pipeline and server tests in tests/; browser-app tests next to the code
    // in web/src (they opt into jsdom with a `@vitest-environment jsdom` comment).
    include: ["tests/**/*.test.ts", "web/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // cli.ts and server/main.ts are thin entry points over runPipeline and
      // createApp (both tested); they are exercised by running them.
      exclude: ["src/cli.ts", "src/server/main.ts"],
      reporter: ["text", "html", "lcov"],
      // Fail the run if coverage drops below these (current: ~95% lines, ~88% branches).
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
