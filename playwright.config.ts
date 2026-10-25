import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/browser/server.ts",
    url: "http://127.0.0.1:4174",
    timeout: 120000,
    reuseExistingServer: false,
  },
  outputDir: ".cache/browser-results",
});
