# 0035: Smart select fetches its weights from the pinned Hugging Face revision when first chosen

**Status:** Accepted (Gage, 2026-11-11), with spec 055. It supersedes the hosting part of ADR 0032: same-origin files from `npm run fetch-model`. ADR 0032's choice of model and its Cache Storage use stand.

**Context:** Gage, 2026-11-11: "I don't want to have to run npm to get the tool", and the tool "only downloads the model when selected". Checked 2026-11-11:
- **Browser downloads from the Hub:** transformers.js defaults to them (its `env` docs: `remoteHost` is the Hub, and `allowLocalModels` is false in browsers), so a plain browser GET to `/resolve/` works.
- **Range requests:** these fail on the Xet redirect to `cas-bridge.xethub.hf.co` (forum, 2026-01-02). We send none.
- **Alternatives:** a `predev`/`prebuild` hook would download 78 MB on every fresh checkout whether or not Smart is used.
- **CSP:** the repo has none.

**Decision:** The browser GETs the four files from `https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx/<name>`, with `credentials: "omit"`, `referrerPolicy: "no-referrer"` and no extra headers. It does this only after the download confirm. Sizes are checked as in spec 055, and the files are cached as ADR 0032 describes. `npm run fetch-model`, `scripts/fetch-model.mjs` and the weights' gitignore entry are removed. The weights' `LICENSE` stays under `public/models/`.

**Consequences:**
- **No setup step:** Smart select works from a plain `npm run dev` or deploy.
- **Hugging Face sees each first download:** it learns the user's IP and that Smart select was chosen. No user data is sent, but spec 013 criterion 6 now allows those four URLs.
- **Dependence on the Hub:** Smart is unavailable offline before the first download, or if HF moves or drops the revision.
