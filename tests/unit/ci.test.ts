import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spec 060: the full e2e suite runs on GitHub Actions; these read ci.yml as text, so no YAML dependency is needed.
const yml = readFileSync(".github/workflows/ci.yml", "utf8");

/** The text of one top-level job, from its `  name:` line to the next job's. */
function job(name: string): string {
  const m = yml.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\s*\\n)*)`, "m"));
  if (!m) throw new Error(`no job ${name}`);
  return m[1] ?? "";
}

describe("ci.yml triggers (spec 060 criterion 1)", () => {
  it("runs only on pull_request and push to main, read-only, with no secrets", () => {
    const on = yml.match(/^on:\n((?: {2}.*\n)*)/m)?.[1] ?? "";
    expect(on.match(/^ {2}\S[^:]*/gm)).toEqual(["  pull_request", "  push"]);
    expect(on.match(/branches: \[main\]/g)).toHaveLength(2);
    expect(yml).not.toContain("pull_request_target");
    expect(yml).not.toContain("secrets.");
    expect(yml).not.toContain("LIVE_HF");
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
  });

  it("cancels a superseded run of the same ref", () => {
    expect(yml).toContain("group: ci-${{ github.ref }}");
    expect(yml).toContain("cancel-in-progress: true");
  });
});

describe("ci.yml jobs (spec 060 criterion 2)", () => {
  it("has exactly the check, e2e and ci jobs", () => {
    const jobs = yml.slice(yml.indexOf("\njobs:\n"));
    expect(jobs.match(/^ {2}[\w-]+:/gm)).toEqual(["  check:", "  e2e:", "  ci:"]);
  });

  it("check sets up Node 22 with the npm cache, then runs npm ci and npm run check", () => {
    const check = job("check");
    expect(check).toContain("runs-on: ubuntu-latest");
    expect(check).toContain("uses: actions/checkout@v6");
    expect(check).toContain("uses: actions/setup-node@v6");
    expect(check).toContain("node-version: 22");
    expect(check).toContain("cache: npm");
    expect(check.indexOf("run: npm ci")).toBeGreaterThan(-1);
    expect(check.indexOf("run: npm run check")).toBeGreaterThan(check.indexOf("run: npm ci"));
  });

  it("e2e needs check and runs 4 shards of Playwright on Chromium", () => {
    const e2e = job("e2e");
    expect(e2e).toContain("needs: check");
    expect(e2e).toContain("runs-on: ubuntu-latest");
    expect(e2e).toContain("shard: [1, 2, 3, 4]");
    expect(e2e).toMatch(/strategy:\n(?: {6}#.*\n)? {6}fail-fast: false\n/); // a failing shard doesn't cancel the others
    expect(e2e).toContain("timeout-minutes: 30");
    expect(e2e).toContain("run: npx playwright install --with-deps chromium");
    expect(e2e).toContain("run: npx playwright test --shard=${{ matrix.shard }}/4");
    expect(yml.match(/--shard=[^\n]*/g)).toEqual(["--shard=${{ matrix.shard }}/4"]);
  });

  it("uploads the report only when a shard fails", () => {
    const e2e = job("e2e");
    const upload = e2e.slice(e2e.lastIndexOf("- ", e2e.indexOf("actions/upload-artifact@v5")));
    expect(upload).toContain("if: failure()");
    expect(upload).toContain("name: e2e-report-${{ matrix.shard }}");
    expect(upload).toContain("playwright-report/");
    expect(upload).toContain("test-results/");
    expect(upload).toContain("retention-days: 14");
    expect(yml.match(/upload-artifact/g)).toHaveLength(1);
  });

  it("has no Playwright browser cache step", () => {
    expect(yml).not.toContain("actions/cache");
    expect(yml).not.toMatch(/ms-playwright/);
  });

  it("ci needs both jobs, always runs, and fails unless both succeeded", () => {
    const ci = job("ci");
    expect(ci).toContain("needs: [check, e2e]");
    expect(ci).toContain("if: always()");
    expect(ci).toContain('needs.check.result }}" = success');
    expect(ci).toContain('needs.e2e.result }}" = success');
    expect(ci).toContain("exit 1");
  });
});

describe("playwright config (spec 060 criteria 3-4)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses 2 workers and keeps the default reporter locally", async () => {
    vi.stubEnv("CI", "");
    const config = (await import("../../playwright.config")).default;
    expect(config.workers).toBe(2);
    expect(config.fullyParallel).toBeUndefined();
    expect(config.reporter).toBeUndefined();
    expect(config.retries).toBeUndefined();
    expect(config.forbidOnly).toBeUndefined();
    expect(config.globalTimeout).toBeUndefined();
  });

  it("on CI forbids .only, never retries, stops at 25 min and writes dot and html reports", async () => {
    vi.stubEnv("CI", "true");
    const config = (await import("../../playwright.config")).default;
    expect(config.workers).toBe(2);
    expect(config.forbidOnly).toBe(true);
    expect(config.retries).toBe(0);
    expect(config.globalTimeout).toBe(25 * 60_000);
    expect(config.reporter).toEqual([["dot"], ["html", { open: "never" }]]);
  });

  it("has an e2e:changed script that runs the files changed against main", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["e2e:changed"]).toBe("playwright test --only-changed=main --pass-with-no-tests");
  });
});

describe("e2e tests (spec 060 criterion 7)", () => {
  it("never branch on the host OS", () => {
    for (const f of readdirSync("tests/e2e", { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]s$/.test(f)) continue;
      const text = readFileSync(`tests/e2e/${f}`, "utf8");
      expect(text, f).not.toMatch(/process\.platform|os\.platform\(\)|navigator\.platform/);
    }
  });
});
