import { defineConfig } from "@playwright/test";

// Documentation runs use a dedicated server so ordinary tests cannot remove its
// server or artifacts midway through a report. Test output is isolated by the runner.
const reportRun = process.env.OMARKD_E2E_REPORT === "1";
const port = reportRun ? 1431 : 1430;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1100, height: 820 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `bun run dev --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI && !reportRun,
  },
});
