import { defineConfig } from '@playwright/test';

// End-to-end tests of the desktop shell itself. Each file starts the real
// Electron app on a throwaway profile, so a window appears while it runs.
// There is no dev server: the shell serves the built app, so run
// `npm run build` first, and `npm ci` in desktop/ once for Electron.
export default defineConfig({
  testDir: 'tests/e2e-desktop',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
});
