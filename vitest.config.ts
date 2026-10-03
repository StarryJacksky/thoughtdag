import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit and integration tests for the research workspace. Kept
// apart from vite.config.ts so the app build never loads test-only setup.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/vitest.setup.ts'],
    restoreMocks: true,
  },
});
