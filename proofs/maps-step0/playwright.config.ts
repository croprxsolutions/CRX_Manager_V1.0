import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

const portScript = "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
const environmentPort = process.env.CRX_MAPS_STEP0_PORT;
const portOutput = environmentPort
  ? environmentPort
  : execFileSync(process.execPath, ['-e', portScript], { encoding: 'utf8' })
      .replace(/\u001b\[[0-9;]*m/g, '')
      .trim();
const port = Number(portOutput);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Unable to choose a free proof port');
process.env.CRX_MAPS_STEP0_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'step0.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 800 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: `npx vite --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
