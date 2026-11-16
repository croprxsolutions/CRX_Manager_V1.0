import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, IS_SALES_GAUNTLET, STATE_FOLDER, assertCleanEnvironment, assertFrontendIsOurs, assertLocalState } from './target.mjs';

// Separate from the staging config on purpose: this one can only ever reach this computer.
const here = fileURLToPath(new URL('.', import.meta.url));
const state = Object.fromEntries(
  readFileSync(resolve(here, STATE_FOLDER, 'local.env'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
assertCleanEnvironment();
assertLocalState(state);
await assertFrontendIsOurs(state.LOCAL_ANON_KEY);
process.env.LOCAL_TEST_EMAIL = state.LOCAL_TEST_EMAIL;
process.env.LOCAL_TEST_PASSWORD = state.LOCAL_TEST_PASSWORD;
if (IS_SALES_GAUNTLET) {
  process.env.LOCAL_REP_EMAIL = state.LOCAL_REP_EMAIL;
  process.env.LOCAL_REP_PASSWORD = state.LOCAL_REP_PASSWORD;
  process.env.LOCAL_OTHER_REP_EMAIL = state.LOCAL_OTHER_REP_EMAIL;
  process.env.LOCAL_OTHER_REP_PASSWORD = state.LOCAL_OTHER_REP_PASSWORD;
}

export default defineConfig({
  testDir: './e2e',
  ...(IS_SALES_GAUNTLET ? { testMatch: 'chemical-sales.spec.ts' } : { testIgnore: '**/chemical-sales.spec.ts' }),
  outputDir: `./${STATE_FOLDER}/test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: APP_URL,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    // A dead proxy for everything but this computer, so a stray request cannot leave, IP addresses included.
    proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
    launchOptions: { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] },
  },
  webServer: {
    command: `node scripts/local-app/${IS_SALES_GAUNTLET ? 'sales' : 'app'}.mjs frontend`,
    cwd: resolve(here, '..', '..'),
    url: APP_URL,
    // assertFrontendIsOurs above already refused anything that is not this test app.
    reuseExistingServer: !IS_SALES_GAUNTLET,
    timeout: 120000,
  },
});
