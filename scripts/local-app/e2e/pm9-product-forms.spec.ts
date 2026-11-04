import { expect, test } from '@playwright/test';

test('Seed and Each products keep their exact units and lock the saved form', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const form = page.getByLabel('Product Form');
  const inventory = page.locator('.border-t').filter({ hasText: 'Inventory Unit' }).locator('select');
  const container = page.locator('.border-t').filter({ hasText: 'Container' }).getByLabel('Unit');
  const create = async (name: string, productForm: string, unit: string, containerUnit: string) => {
    await page.goto('/products/new');
    await page.getByLabel(/product name/i).fill(name);
    await form.selectOption(productForm);
    if (productForm === 'seed') {
      await expect(inventory.locator('option')).toHaveText(['-- Select --', 'Lb', 'Unit']);
    }
    await inventory.selectOption(unit);
    await page.getByLabel('Size').fill('50');
    await container.selectOption(containerUnit);
    await page.getByRole('button', { name: 'Create Product' }).click();
    await expect(page.getByText('Product created')).toBeVisible();
    await page.getByPlaceholder(/search/i).filter({ visible: true }).first().fill(name);
    await page.getByText(name).filter({ visible: true }).first().click();
    await page.reload();
    await expect(form).toHaveValue(productForm);
    await expect(form).toBeDisabled();
    await expect(inventory).toHaveValue(unit);
    await expect(container).toHaveValue(containerUnit);
  };

  await create(`PM9 Seed ${Date.now()} (invented)`, 'seed', 'Lb', 'Lb');
  await create(`PM9 Each ${Date.now()} (invented)`, 'each', 'Ea', 'Ea');
});
