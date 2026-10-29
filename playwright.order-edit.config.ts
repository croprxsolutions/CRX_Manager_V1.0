import { defineConfig, devices } from '@playwright/test';

// Every API request is served by the browser fixture; this process cannot reach CRX.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54329';
process.env.VITE_SUPABASE_ANON_KEY = 'isolated-order-edit-proof';

export default defineConfig({
  testDir: './tests/order-edit-ui', workers: 1, retries: 0, reporter: 'line', timeout: 60_000,
  expect: { timeout: 15_000 }, outputDir: 'output/playwright/order-edit-results',
  use: { baseURL: 'http://127.0.0.1:41744', ...devices['Desktop Chrome'], channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 41744', url: 'http://127.0.0.1:41744', reuseExistingServer: false, timeout: 120_000 },
});
