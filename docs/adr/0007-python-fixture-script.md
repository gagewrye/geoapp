# 0007: Python dev script for AlphaEarth test fixtures

**Status:** Accepted (Gage, 2026-10-26)

**Context:** Spec 002 needs offline AlphaEarth fixtures and a reference accuracy. Gage's real embeddings live in mangrove-embed `data/chips/*/chip_NNNN.npz`: compressed numpy, float16 [64,128,128], uint8 labels, about 0.7 MB each, 2.1 GB in total. Reading npz and float16 in Node would mean hand-parsing zip and `.npy`. The reference should be the same model mangrove-embed benchmarks (sklearn `LogisticRegression(max_iter=3000)`, `pixel.py`), not a reimplementation. mangrove-embed's environment already has numpy and scikit-learn (`pyproject.toml`).

**Decision:** Add `scripts/fixtures/make_aef_fixtures.py`, run by hand in the mangrove-embed environment with the data path as an argument. It uses only numpy, scikit-learn and the Python standard library: `struct` and `zlib` for writing tiled Int8 GeoTIFFs, and `urllib` for capturing one real COG header and its `.vrt`. Its outputs (`tests/fixtures/aef/`, at most 5 MB) are committed together with a NOTICE that gives the attributions. CI and `npm run check` never run Python.

**Consequences:** No dependency enters `package.json`, but Python is now a second dev-only language. Fixtures are parsed by geotiff.js, an independent reader. Orientation is pinned to the real file header and `.vrt`, not only to our own writer. Regenerating the fixtures needs mangrove-embed's data and environment.
