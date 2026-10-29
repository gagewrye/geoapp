import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // shelf/ holds code kept out of the app and out of check (ADR 0017)
  { ignores: ["dist/", "node_modules/", "test-results/", "playwright-report/", "shelf/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  {
    // e2e code reaches into the page's untyped window.__geoapp hook inside page.evaluate
    files: ["tests/e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
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
