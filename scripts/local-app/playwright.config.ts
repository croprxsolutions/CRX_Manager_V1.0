import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, assertCleanEnvironment, assertFrontendIsOurs, assertLocalState } from './target.mjs';

// Separate from the staging config on purpose: this one can only ever reach this computer.
const here = fileURLToPath(new URL('.', import.meta.url));
const state = Object.fromEntries(
  readFileSync(resolve(here, '.state/local.env'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
assertCleanEnvironment();
assertLocalState(state);
await assertFrontendIsOurs(state.LOCAL_ANON_KEY);
process.env.LOCAL_TEST_EMAIL = state.LOCAL_TEST_EMAIL;
process.env.LOCAL_TEST_PASSWORD = state.LOCAL_TEST_PASSWORD;

export default defineConfig({
  testDir: './e2e',
  outputDir: './.state/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: APP_URL,
    screenshot: 'only-on-failure',
    // A dead proxy for everything but this computer, so a stray request cannot leave, IP addresses included.
    proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
  },
  webServer: {
    command: 'node scripts/local-app/app.mjs frontend',
    cwd: resolve(here, '..', '..'),
    url: APP_URL,
    // assertFrontendIsOurs above already refused anything that is not this test app.
    reuseExistingServer: true,
    timeout: 120000,
  },
});
