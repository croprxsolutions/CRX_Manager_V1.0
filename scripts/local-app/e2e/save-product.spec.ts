import { expect, test } from '@playwright/test';
import { API_URL, APP_URL } from '../target.mjs';

test('nobody can sign themselves up', async ({ request }) => {
  const response = await request.post(`${API_URL}/auth/v1/signup`, {
    data: { email: 'stranger@crx-local-app.test', password: 'invented-password-1' },
  });
  expect(response.status()).toBe(422);
  expect((await response.json()).error_code).toBe('signup_disabled');
});

test('a website cannot reach the keys or the gateway', async ({ request }) => {
  // .env.example is harmless, but the rule that refuses it is the one that protects a real .env.
  for (const file of ['/scripts/local-app/.state/local.env', '/.env.example', '/.git/config']) {
    expect((await request.get(file)).status(), file).toBe(403);
  }

  const fromAWebsite = await request.fetch(`${API_URL}/rest/v1/`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
  });
  expect(fromAWebsite.headers()['access-control-allow-origin']).not.toBe('https://example.com');
  expect(fromAWebsite.headers()['access-control-allow-origin']).not.toBe('*');

  const reboundName = await request.get(`${API_URL}/rest/v1/`, { headers: { Host: 'example.com:54721' } });
  expect(reboundName.status()).toBe(404);
});

test('the browser cannot leave this computer, even by IP address', async ({ page }) => {
  await expect(page.goto('http://1.1.1.1/', { timeout: 5000 })).rejects.toThrow();
  await expect(page.goto('https://example.com/', { timeout: 5000 })).rejects.toThrow();
});

test('signs in, saves a test product, and the save survives a reload, on localhost only', async ({ page }) => {
  const hosts = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') || url.protocol.startsWith('ws')) hosts.add(url.host);
  });

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const name = `Test Product ${Date.now()} (invented)`;
  await page.goto('/products/new');
  await page.getByLabel(/product name/i).fill(name);
  await page.getByRole('button', { name: 'Create Product' }).click();
  await expect(page.getByText('Product created')).toBeVisible();
  // The app can ask about unsaved changes just after a successful create, on some runs only.
  await expect(async () => {
    const leave = page.getByRole('button', { name: 'Leave' });
    if (await leave.isVisible()) await leave.click();
    await expect(page).toHaveURL(/\/products$/, { timeout: 500 });
  }).toPass();

  await page.reload();
  await page.getByPlaceholder(/search/i).first().fill(name);
  await expect(page.getByText(name).first()).toBeVisible();

  await page.getByText(name).first().click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByLabel(/product name/i)).toHaveValue(name);

  await page.screenshot({ path: 'scripts/local-app/.state/proof.png' });
  console.warn(`hosts seen: ${[...hosts].join(', ')}`);
  expect(hosts.size).toBeGreaterThan(0);
  expect([...hosts].sort()).toEqual([new URL(API_URL).host, new URL(APP_URL).host].sort());
});
