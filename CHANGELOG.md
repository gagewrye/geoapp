# Changelog

One entry per merge to main, newest first. Details are in the named spec.

## 2026-10-29
- **Spec 013:** AlphaEarth, training and model seeding are gone from the app; their code is kept unused in `shelf/`. The area tool is gone too.

## 2026-10-28
- **Spec 015:** A starfield shows around the globe.
- **Specs 009–012:**
  - Wheel zoom is centred on the map, and you can pan with a middle-button drag or WASD.
  - The brush cursor shows the label colour, and Undo/Ctrl+Z undo strokes.
  - Label tiles no longer show seams or strips.
  - A low-res world basemap is bundled with the app.
- **Fix:** Unit tests pass on Windows with Node 24. The AEF index script no longer overwrites a stray file on Windows.
- **Spec 004:** Import labels from a classified GeoTIFF, or seed them from a model, then export them as a label GeoTIFF that imports back unchanged. Seeding from a model is now shelved by spec 013.

## 2026-10-27
- **Spec 003:** Label local imagery with a paint brush.
- **Spec 002:** Classify with AlphaEarth embeddings. Now shelved by spec 013.

## 2026-10-26
- **Spec 001:** First classifier: logistic regression on labelled pixels. Now shelved by spec 013.
