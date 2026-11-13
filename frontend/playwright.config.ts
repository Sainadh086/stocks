import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:8002",
    browserName: "chromium",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "PORT=8002 ../.tools/node/bin/node ../server/dist/test/browser-server.js",
    url: "http://127.0.0.1:8002/api/health",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
