const { defineConfig, devices } = require('@playwright/test');

// End-to-end browser tests (Phase 2, D114): the ten flows that must never break, in Chromium,
// against e2e/server.js (an in-memory database; nothing real is reached). Run: npm run e2e.
// GitHub runs them on every push (.github/workflows/tests.yml); a failure keeps its trace,
// screenshot and video in e2e-results/ (an artifact on GitHub).
const PORT = Number(process.env.E2E_PORT || 3200);

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 90 * 1000,
  expect: { timeout: 15 * 1000 },
  // The flows build on one another (a lead, its quotation, the order …): one after the other.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/server.js',
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180 * 1000,
    env: { E2E_PORT: String(PORT) },
  },
});
