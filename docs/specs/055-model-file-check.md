# 055: Smart select's model comes from Hugging Face, is checked, and fails with one popup

**Status:** Accepted (Gage, 2026-11-11), with the recommended answers to the open questions. **ADRs:** 0035 (Accepted), which supersedes ADR 0032's hosting. **Amends spec 046** (decision 6, scope 1 and 2, criteria 4, 7, 8 and 11) and **spec 013** criterion 6.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `smart-model.tester` (criteria 7–9, scope 3–4) and `smart-model-live.tester` (10, live only); unit `io/modelCache.tester` (1–4) and `ui/smartLoad.tester` (6, scope 4). `io/segmenter.tester` is renamed `io/segmenter.load.test.ts` (3 and 5) with both cases kept. `smart-model` and `smart-select` stay.

**Request** (Gage): "I want this fixed in the webapp code for the users." Then: "I want it so that the smart select tool only downloads the model when selected. I don't want to have to run npm to get the tool. … If the tool fails, a popup should read that the tool is not available for your device instead of an error. The error should go to a log." **Bug:** the weights were missing, the server answered with `index.html` (200, 4271 bytes), `fetchCached` cached it, and ORT's protobuf error then stayed.

**Decided (Gage, 2026-11-11):** an exact byte-length check, not sha256, and no build guard.

## Open questions (the spec does the recommended answer)
1. **Failures after load.** An encode or decode error while Smart is in use keeps today's red message, because it may be a raster read error (spec 014). Should it also become the popup?
2. **"A log"** is `console.error` in the user's browser. Nothing is sent anywhere and nothing is kept in the app. Should there be an in-app log instead? There is no reader for one yet.

**Goal:** Choosing Smart select is all a user does to get it. A bad model response is never cached or kept. Any load failure shows one popup and logs the cause.

## Scope
1. **Source (ADR 0035).** The four `FILES` URLs are the pinned Hugging Face `resolve` URLs, fetched only after Smart is chosen and the confirm is accepted. The confirm reads `Smart select downloads an 80 MB model from Hugging Face once. Download it?`. `npm run fetch-model`, its script, its gitignore line and its README line are removed.
2. **Fetch check.** A response that isn't OK, or a complete body whose length differs from the file's size in `FILES`, is not cached and rejects with `ModelFileError`. The message is for the log, for example `<url>: 4271 bytes, expected 314925`. Cancel and network failures are unchanged.
3. **Cache.** The cache name is unchanged. Before fetching, `loadSegmenter` deletes every entry in `MODEL_CACHE` whose URL isn't one of the four. That removes the old same-origin entries, good or bad. A wrong-sized entry for a current URL is deleted and fetched again. `cachedAll` counts a wrong-sized entry as missing, so the confirm is shown first. It must not keep a file's bytes after the check.
4. **Failure.** Any failure of `ensure()` other than Cancel shows `alert(MESSAGES.smartUnavailable)`, which reads `Smart select isn't available on this device.`. It replaces the red text and spec 046's `noWebGpu` message. The failures are: no WebGPU or no `shader-f16` (in the page or the worker), the fetch or check, and an ORT or worker error. The cause goes to `console.error("Smart select:", cause)`. The mode is unchanged. Without WebGPU, the button is disabled with `title` set to `smartUnavailable`, as before. After any other failure it stays enabled, so a later press retries.

**Out of scope:** sha256 in the browser; mirrors or a same-origin fallback; offline use before the first download; encode and decode failures (question 1); a build check.

## Interfaces
- `io/modelCache.ts`: `type ModelFile = { url: string; bytes: number }`; `class ModelFileError extends Error { url: string }`; `cachedAll(files: ModelFile[]): Promise<boolean>`; `fetchCached(file: ModelFile, onProgress, signal): Promise<Uint8Array>`; `pruneCache(files: ModelFile[]): Promise<void>`.
- `io/segmenter.ts`: `MODEL_FILES: ModelFile[]` built from the revision and `FILES`. `MODEL_URLS` is derived from it.
- `ui/smartLoad.ts`: `Deps` gains `alert: (text: string) => void` and `log: (e: unknown) => void`. `ensure()` keeps its return type.
- `ui/messages.ts`: `smartUnavailable` replaces `noWebGpu`, and `smartDownload` gets the new text.

## Acceptance criteria
1. **Unit (io), fake `caches` and `fetch`:** a 200 response with a 4271-byte body for a file of 12 bytes rejects with `ModelFileError`, stores nothing, and leaves `cachedAll` false. A 404 does the same.
2. **Unit (io):** a wrong-sized entry for a current URL makes `cachedAll` false. `fetchCached` then makes one request, returns the bytes and stores them.
3. **Unit (io):** `pruneCache` deletes an entry under a URL that isn't listed and keeps the listed ones.
4. **Unit (io):** spec 046 criterion 4 passes with sizes: a correct entry is read with no request, and a cancel stores nothing.
5. **Unit (io):** each fetch is a GET of a `MODEL_FILES` URL starting `https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx/`, with `credentials: "omit"` and `referrerPolicy: "no-referrer"`.
6. **Unit (ui), `initSmartLoad` with fakes:** in each of no WebGPU, a `fetchCached` rejection and a worker load rejection, `alert` is called once with `smartUnavailable`, `log` once with the cause, and `say` is not called with kind error. A Cancel calls none of them.
7. **E2E:** the HF URLs are routed by `page.route` to a 4271-byte HTML 200, `navigator.gpu` is stubbed with `shader-f16`, and the confirm is accepted. Pressing `M` raises a dialog reading `smartUnavailable`, logs a console error, leaves the mode unchanged and keeps the button enabled. Afterwards `caches` holds no model entry.
8. **E2E:** with `navigator.gpu` removed, `M` raises the same dialog, disables `#mode-smart`, and requests nothing from `huggingface.co` or `models/`.
9. **E2E (privacy, amends spec 013 criterion 6 and 046 criterion 8):** with Smart never chosen, every request from load through open, paint, export and import is same-origin. In criterion 7's run, the only cross-origin requests are GETs to the four URLs, with no `Referer` or `Cookie` header.
10. **Manual (tester, Chrome, real network, no `public/models/` weights):** a fresh profile's first Smart press downloads from HF and gives a mask. The tester records whether there was a redirect to an `xethub.hf.co` host and that it succeeded. A reload loads with no network request for the model.
11. **Docs:**
    - README has no `fetch-model`, and says the model comes from Hugging Face on first use.
    - ADR 0032's Status names ADR 0035.
    - Spec 046's header names this spec.
12. `npm run check` passes, and spec 046's other criteria pass.

**Note for the tester:** `loadSegmenter` fetches the files in order, so criterion 7 needs only the first URL routed. Route all four anyway, so the test doesn't depend on the network.
