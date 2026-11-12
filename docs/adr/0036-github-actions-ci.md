# 0036: The full e2e suite runs on GitHub Actions, and a merge waits for it

**Status:** Accepted (2026-11-11), with spec 060.

**Context:** The full suite (about 316 tests, software GL) took over 30 minutes on Gage's laptop and overloaded it, so Gage chose to move the full run to CI and to run only the touched e2e files locally. Checked 2026-11-11:
- **Playwright 1.64.1 docs:** `--only-changed` runs changed tests and the test files that import changed files; `--shard` splits by file unless `fullyParallel` is set; caching browsers is "not recommended".
- **GitHub docs:** `ubuntu-latest` (Ubuntu 24.04) has 4 vCPU and 16 GB for public repos (2 vCPU and 8 GB for private ones), and standard runners are free for public repos.

**Decision:** Add `.github/workflows/ci.yml`. It runs `check`, then e2e in 4 shards with 2 workers each, on SwiftShader on `ubuntu-latest`, then a `ci` summary job. It caches npm but not browsers, and it pins the GitHub-maintained actions `checkout@v6`, `setup-node@v6` and `upload-artifact@v5` by major tag. The orchestrator merges only after `gh pr checks` is green.

**Consequences:**
- **CI is Linux-only:** the macOS key paths aren't run there.
- **Merges are slower:** a merge waits about 10 to 15 minutes for CI, and a red CI blocks it.
- **Depends on GitHub's service** and on its free tier.
- **The gate is the orchestrator's rule:** branch protection stays off (Gage, 2026-11-11), so a direct push to main bypasses it.
