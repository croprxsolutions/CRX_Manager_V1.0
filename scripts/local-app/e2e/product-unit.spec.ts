import { expect, test } from '@playwright/test';
import { STATE_FOLDER } from '../target.mjs';

test('a new product keeps the unit picked for it after a reload', async ({ page }) => {
  await page.addLocatorHandler(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /What's new/i }) }),
    async (dialog) => { await dialog.getByRole('button', { name: 'Close' }).click(); },
  );
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
  const name = `Test Unit Product ${Date.now()} (invented)`;
  const unitSelect = page.locator('.border-t').filter({ hasText: 'Inventory Unit' }).locator('select');
  await page.goto('/products/new');
  await page.getByLabel(/product name/i).fill(name);
  await page.locator('.border-t').filter({ hasText: 'Product Form' }).locator('select').selectOption('liquid');
  await unitSelect.selectOption('Gal', { timeout: 5000 });
  await page.getByRole('button', { name: 'Create Product' }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByLabel(/product name/i)).toHaveValue(name);
  await expect(unitSelect).toHaveValue('Gal');
  await page.screenshot({ path: `scripts/local-app/${STATE_FOLDER}/product-unit.png`, fullPage: true });
});
