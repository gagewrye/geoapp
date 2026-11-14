# 0036: The full e2e suite runs on GitHub Actions, and a merge waits for it

**Status:** Accepted (2026-11-11), with spec 060. Amended by spec 074 (2026-11-14): 1 worker per job across 8 shards.

**Context:** The full suite (about 316 tests, software GL) took over 30 minutes on Gage's laptop and overloaded it, so Gage chose to move the full run to CI and to run only the touched e2e files locally. Checked 2026-11-11:
- **Playwright 1.64.1 docs:** `--only-changed` runs changed tests and the test files that import changed files; `--shard` splits by file unless `fullyParallel` is set; caching browsers is "not recommended".
- **GitHub docs:** `ubuntu-latest` (Ubuntu 24.04) has 4 vCPU and 16 GB for public repos (2 vCPU and 8 GB for private ones), and standard runners are free for public repos.

**Decision:** Add `.github/workflows/ci.yml`. It runs `check`, then e2e in 8 shards with 1 worker each, on SwiftShader on `ubuntu-latest`, then a `ci` summary job. Two workers sharing 4 vCPUs made tests 4–8× slower (spec 072). Local runs keep 2 workers. It caches npm but not browsers, and it pins the GitHub-maintained actions `checkout@v6`, `setup-node@v6` and `upload-artifact@v5` by major tag. Merges go through a PR, gated by branch protection's required `ci` check.

**Consequences:**
- **CI is Linux-only:** the macOS key paths aren't run there.
- **Merges are slower:** a merge waits for CI, about 7 minutes with 8 shards (estimate, spec 074), and a red CI blocks it.
- **Depends on GitHub's service** and on its free tier. One run uses 10 of GitHub Free's 20 concurrent jobs.
- **The gate is branch protection:** since 2026-11-12, main requires a PR and the `ci` check (not strict, admins can bypass, no force-push or deletion).
