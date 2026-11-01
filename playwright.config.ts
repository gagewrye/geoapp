import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // the flicker probe takes about a minute, so only npm run e2e:probe runs it (spec 045) (a CLI --grep can't undo grepInvert)
  grepInvert: process.env.npm_lifecycle_event === "e2e:probe" ? undefined : /@probe/,
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4173",
    ...devices["Desktop Chrome"],
    viewport: { width: 1024, height: 768 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: { command: "npm run build && npm run preview", url: "http://localhost:4173", reuseExistingServer: true, timeout: 120_000 },
});
