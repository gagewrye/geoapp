# 074: CI runs e2e with 1 worker per job across 8 shards, then enforces 15 s per test

**Status:** Accepted on Gage's decision (2026-11-14): "Merge, then 1 browser/job". **ADR:** 0036, amended. **Builds on:** spec 072, whose criteria 3 and 6 move here. **Lands after:** spec 072 (PR #16).

**Goal:** every e2e test runs in 15 s or less on CI, and CI's test timeout enforces it.

**Why one worker:** spec 072 found the remaining slowness is two workers sharing 4 vCPUs on SwiftShader.
- "Create context" takes 2–9 s while the other worker is busy, and 0–1 s alone.
- Test work runs 4–8× slower than on the laptop.
- After 072, 3–9 tests per CI run still take 15–26 s, and which ones changes from run to run.

## Scope
- **`.github/workflows/ci.yml`:** the `e2e` matrix becomes `shard: [1, 2, 3, 4, 5, 6, 7, 8]` with `fail-fast: false` (as now), and runs `npx playwright test --shard=${{ matrix.shard }}/8`. Everything else is unchanged: setup, upload on failure, `timeout-minutes: 30`, and the `ci` summary job.
- **`playwright.config.ts`:** `workers: process.env.CI ? 1 : 2`. Local runs stay at 2.
- **A temporary timing commit,** reverted before merge as in specs 061 and 072:
  - on CI, a JSON reporter (`["json", { outputFile: "e2e-times.json" }]`) is added to the reporters;
  - each shard uploads the file with `if: always()`.
- **Last commit, 072's old criterion 6:**
  - `timeout: process.env.CI ? 15_000 : 60_000`;
  - no `test.setTimeout` above 15,000 in `tests/e2e/`;
  - `tests/unit/ci.test.ts` checks both.

  The draft is `crit6.py` in the scratchpad. Its paths point at the 072 worktree and its comments say "spec 072", so the implementer adapts both to this branch and to spec 074.

**Out of scope:** local worker count, `fullyParallel`, retries (they stay 0), and any app change.

## Expected cost (estimate; criterion 6 records the measured values)
- **Per shard:** about 3 min of setup (`npm ci`, Chromium install with its system packages, build), plus about 13 tests at 5–8 s each with no contention, about 1.5–2 min. So about 5 min per shard.
- **Total wall time:** shards run in parallel, so CI is about 2 min of `check` plus about 5 min of e2e, against 8–10 min per shard today.
- **Runner minutes:** about 40 per run, which is free on the public repo.
- **Concurrency:** one run uses 10 jobs (`check`, 8 shards, `ci`). GitHub Free allows 20 concurrent jobs on standard runners (Actions limits docs, checked 2026-11-14), so 2 runs at once fill it, and a third queues.

## Acceptance criteria
1. **Matrix.** `ci.yml`'s `e2e` matrix lists shards 1–8, has `fail-fast: false`, and passes `--shard=${{ matrix.shard }}/8`. `tests/unit/ci.test.ts` asserts all three. Its old shard-total assertion of 4 is replaced.
2. **Workers.** `playwright.config.ts` gives `workers` 1 with `CI` set and 2 without. `ci.test.ts` asserts both, loading the config under each environment as it already does for `forbidOnly`.
3. **Sharding is complete.** With `CI=1`, `--list --shard=k/8` for k = 1 to 8 lists every test exactly once in total. The tester compares the lists.
4. **Timing data is temporary.** The JSON-reporter commit is reverted before merge: `git diff main...HEAD` adds no `json` reporter and no timing upload step, and `ci.test.ts`'s reporter assertion is unchanged.
5. **Every test takes ≤ 15 s on CI** in each of 3 consecutive runs of this PR (the first, plus `gh run rerun` twice), read from those JSON files.
   - **If a test is still over 15 s,** it is refactored or split under the standing rule (spec 072's levers), keeping every assertion. One or two such tests are fixed in this PR. More than two are escalated to Gage.
6. **Timeout last.** The final commit applies 072's old criterion 6 (see Scope). After it, `ci` is green. The CHANGELOG records each shard's wall time and the longest test from the last timing run.
7. **Docs.**
   - **ADR 0036:** amended for 1 worker × 8 shards on CI.
   - **README Develop:** says CI runs 1 worker per shard and that every e2e test must take 15 s or less there.
   - **CHANGELOG:** a dated entry.
   - **CLAUDE.md:** gets spec 072's standing text when the timeout lands. Gage edits it.
