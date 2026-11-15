import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-electron',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
