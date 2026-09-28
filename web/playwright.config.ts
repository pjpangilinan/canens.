import { defineConfig, devices } from "@playwright/test";

// Port 3000 on purpose: it is the origin the API allows by default, and
// anything else will be blocked by CORS. Override with PORT only if you also
// widen ALLOWED_ORIGINS on the backend.
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "localhost";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "on-first-retry",
  },
  // The previous config started nothing, so the suite only ran if a dev
  // server happened to be open already.
  webServer: {
    command: "npm run start",
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PORT: String(PORT) },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
