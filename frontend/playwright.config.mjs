import {defineConfig} from '@playwright/test';

const port = Number(process.env.CARDGW_BROWSER_TEST_PORT || 4197);
const baseURL = `http://127.0.0.1:${port}`;
// Config is also evaluated inside workers. Inherit one ID for the whole run.
const runID = (process.env.CARDGW_BROWSER_RUN_ID ||= `${Date.now()}-${process.pid}`);
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  expect: {timeout: 8000},
  workers: 1,
  fullyParallel: false,
  // Preserve each run's screenshots and diagnostics instead of overwriting
  // evidence from a previous run.
  outputDir: `./test-results/${runID}`,
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: {width: 1440, height: 1000},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}
      : {},
  },
  webServer: {
    command: 'node dev.mjs --fixture',
    url: `${baseURL}/__fixture/state`,
    env: {CARDGW_FRONTEND_PORT: String(port)},
    reuseExistingServer: false,
    timeout: 15000,
  },
});
