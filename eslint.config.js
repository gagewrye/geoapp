import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  {
    // e2e code reaches into the page's untyped window.__geoapp hook inside page.evaluate
    files: ["tests/e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // dev scripts run under Node
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", Buffer: "readonly" } },
  },
  {
    // core/ is pure: no DOM, no I/O layers.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", "document", "window", "navigator", "fetch"],
      "no-restricted-imports": ["error", { patterns: ["**/io/**", "**/map/**", "**/ui/**", "maplibre-gl", "terra-draw*", "geotiff"] }],
    },
  },
);
