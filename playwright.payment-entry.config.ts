import { defineConfig, devices } from '@playwright/test';

// Every API request is served by the browser fixture; this process cannot reach CRX.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54331';
process.env.VITE_SUPABASE_ANON_KEY = 'isolated-payment-entry-proof';

export default defineConfig({
  testDir: './tests/payment-entry-ui', workers: 1, retries: 0, reporter: 'line', timeout: 90_000,
  expect: { timeout: 15_000 }, outputDir: 'output/playwright/payment-entry-results',
  use: { baseURL: 'http://127.0.0.1:41746', ...devices['Desktop Chrome'], screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 41746', url: 'http://127.0.0.1:41746', reuseExistingServer: false, timeout: 120_000 },
});
