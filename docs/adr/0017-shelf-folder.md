# 0017: Shelve AlphaEarth and training code in `shelf/`, outside `npm run check`

**Status:** Accepted (Gage, 2026-10-28), with spec 013. Shelves ADRs 0003, 0005-0008 and 0011, and ADR 0012 except its option (iii).

**Context:** Gage (2026-10-28) took AlphaEarth and training out of scope and said to hide the code by moving it, unused, to a separate folder, not to delete it. Checked 2026-10-28 in this repo:
- tsconfig `include` is `src`, `tests` and `*.config.ts`; Vitest includes `tests/unit/**/*.test.ts`; Playwright's `testDir` is `tests/e2e`. So none of them sees a root folder.
- `eslint .` lints every file not ignored.
- Vite bundles only what `index.html` imports, but copies `public/` "to the root of the dist directory as-is" (vite.dev Static Asset Handling; the repo pins 8.3.5).
- terra-draw 1.38.0 and terra-draw-maplibre-gl-adapter 1.5.0 are imported only by `map/draw.ts`, `ui/aef.ts` and `ui/main.ts` (a type import).

The options were: (a) `shelf/` excluded from check; (b) `shelf/` typechecked and tested; (c) feature flags in `src/`.

**Decision:** (a). `shelf/` mirrors the repo's paths, and its files keep their imports, so reviving one means moving it back under a new spec. ESLint ignores `shelf/`. terra-draw and its adapter leave `package.json`. The catalog index leaves `public/`.

**Consequences:** No dependency is added, two are removed, and the site makes no third-party requests. The shelf rots: shared code (the label store, spec 014) may change under it, and nothing checks that, so reviving it needs git (`shelf/README.md` names the last working commit) and a fresh spec. Option (b) would keep it honest, but it needs terra-draw installed and slows every labelling change. Option (c) would leave dead code in the bundle.
