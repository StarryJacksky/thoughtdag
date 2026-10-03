import { defineConfig } from '@playwright/test';

// End-to-end tests drive the locally installed Chrome, as scripts/smoke.mjs
// does: no browser download. CHROME_PATH names another executable.
const chromePath = process.env.CHROME_PATH;
const appUrl = process.env.APP_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: appUrl,
    // the app picks its language from navigator.language; tests assert English copy
    locale: 'en-US',
    ...(chromePath ? { launchOptions: { executablePath: chromePath } } : { channel: 'chrome' }),
  },
  webServer: {
    command: 'npm run dev',
    url: appUrl,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
