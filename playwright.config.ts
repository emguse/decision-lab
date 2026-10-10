import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://127.0.0.1:5175', headless: true },
  webServer: {
    command: 'npm exec vite -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
