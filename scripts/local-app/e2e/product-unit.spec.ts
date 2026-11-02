import { expect, test } from '@playwright/test';

test('a new product keeps the unit picked for it after a reload', async ({ page }) => {
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
  await expect(page.getByText('Product created')).toBeVisible();
  await expect(page).toHaveURL(/\/products$/);

  await page.getByPlaceholder(/search/i).filter({ visible: true }).first().fill(name);
  await page.getByText(name).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByLabel(/product name/i)).toHaveValue(name);
  await expect(unitSelect).toHaveValue('Gal');
  await page.screenshot({ path: 'scripts/local-app/.state/product-unit.png', fullPage: true });
});
