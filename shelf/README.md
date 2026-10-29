# Shelf

AlphaEarth embeddings (spec 002), model training, classification and model files (specs 001, 003-005), shelved by spec 013 (ADR 0017). Nothing here is built, linted, typechecked or tested.
Each file keeps its repo path under `shelf/` and its imports, so reviving it means moving it back under a new spec. Files that are fragments of a kept module (`src/core/types.ts`, `classes.ts`, `geotags.ts`, `labelStore.ts`, `src/io/pipeline.ts`, `seeding.ts`, `geotiffSource.ts`, and the mixed tests) are merged back by hand.
It last ran wired at commit 1f3a143; check it out to see the working whole (the UI wiring and the shelved e2e steps are only in history).
Dependencies to restore: `terra-draw` 1.38.0 and `terra-draw-maplibre-gl-adapter` 1.5.0.
