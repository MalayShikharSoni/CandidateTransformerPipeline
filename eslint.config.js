import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "web/dist/", "coverage/", "node_modules/", ".cache/"] },
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
  {
    // The browser app: hooks rules on top of the type-aware ones.
    files: ["web/src/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
