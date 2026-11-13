import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // CI skips @ci-skip tests, which time out on its slow software GL; local runs keep them (spec 060 criterion 15)
  grepInvert: process.env.CI ? /@ci-skip/ : undefined,
  timeout: 60_000,
  // 2 workers per CI shard (4 vCPU, ADR 0036) and locally, where more overloaded Gage's laptop (spec 060)
  workers: 2,
  // on CI a flake fails the run instead of hiding behind a retry (spec 060)
  ...(process.env.CI ? { forbidOnly: true, retries: 0, globalTimeout: 25 * 60_000, reporter: [["dot"], ["html", { open: "never" }]] } : {}),
  use: {
    baseURL: "http://localhost:4173",
    ...devices["Desktop Chrome"],
    viewport: { width: 1024, height: 768 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: { command: "npm run build && npm run preview", url: "http://localhost:4173", reuseExistingServer: true, timeout: 120_000 },
});
