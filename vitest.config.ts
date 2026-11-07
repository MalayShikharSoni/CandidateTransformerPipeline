import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // cli.ts is a thin wrapper over runPipeline (which is tested); it is
      // exercised by running the CLI, not by unit tests.
      exclude: ["src/cli.ts"],
      reporter: ["text", "html", "lcov"],
      // Fail the run if coverage drops below these (current: ~90% lines).
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
