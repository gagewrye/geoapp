import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // core/ is pure: no DOM, no I/O layers.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", "document", "window", "navigator", "fetch"],
      "no-restricted-imports": ["error", { patterns: ["**/io/**", "**/map/**", "**/ui/**", "maplibre-gl", "terra-draw*", "geotiff"] }],
    },
  },
);
