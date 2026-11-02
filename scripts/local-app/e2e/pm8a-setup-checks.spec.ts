import { expect, test } from '@playwright/test';

test('product setup refuses invalid fields and saves Seed with a first form choice', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  // Products are an allowed admin insert. Inventory and order lines are never seeded directly.
  const productId = await page.evaluate(async (name) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const { data, error } = await supabase.from('products')
      .insert({ product_name: name, category: 'Herbicide' }).select('id').single();
    if (error || !data) throw new Error(error?.message ?? 'Local product insert failed');
    return data.id;
  }, `Setup ${Date.now()} (invented)`);

  await page.goto(`/products/${productId}`);
  const name = page.getByLabel('Product Name');
  await expect(name).toHaveValue(/Setup/);
  await name.fill('   ');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Enter a product name.')).toBeVisible();

  await name.fill('Setup test product');
  await page.getByLabel('EPA Registration').fill('bad-epa');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText(/This checks format only/)).toBeVisible();

  await page.getByLabel('EPA Registration').fill('');
  await page.getByLabel('Category').selectOption('Seed');
  await page.getByLabel('Product Form').selectOption('dry');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Product updated')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Category')).toHaveValue('Seed');
  await expect(page.getByLabel('Product Form')).toHaveValue('dry');
});
