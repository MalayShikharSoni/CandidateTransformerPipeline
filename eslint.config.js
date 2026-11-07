import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", ".cache/"] },
  js.configs.recommended,
  // Type-aware rules, e.g. no-floating-promises catches a forgotten await.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Test mocks stand in for async APIs (fetch, caches) without awaiting anything.
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
