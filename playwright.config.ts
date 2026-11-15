import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // spec 074: e2e tests are designed to run in 15 s or less on CI, and one over 15 s in CI timing data is refactored, never
  // skipped or retried; the 20 s timeout keeps slow-runner noise from turning CI red
  timeout: process.env.CI ? 20_000 : 60_000,
  // 1 per CI shard, since 2 sharing 4 vCPUs on SwiftShader ran 4-8x slower (spec 074, ADR 0036); 2 locally, where more overloaded Gage's laptop (spec 060)
  workers: process.env.CI ? 1 : 2,
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
