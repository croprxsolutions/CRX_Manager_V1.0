import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

test('Herbicide keeps two timings and category change asks before clearing', async ({ page }) => {
  await signIn(page);
  const name = `PM5 timing ${Date.now()}`;
  const id: string = await page.evaluate(async (productName) => {
    const modulePath = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ modulePath);
    const { data, error } = await supabase.from('products')
      .insert({ product_name: productName, category: 'Herbicide', use_timings: [] })
      .select('id').single();
    if (error || !data) throw new Error(error?.message ?? 'Product insert returned no row');
    return data.id;
  }, name);
  await page.goto(`/products/${id}`);
  const timings = page.getByRole('group', { name: 'Use Timing' });
  await timings.getByRole('checkbox', { name: 'Pre-Emerge Corn' }).check();
  await timings.getByRole('checkbox', { name: 'Post-Emerge Soybeans' }).check();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText(/product updated/i).first()).toBeVisible();
  await page.reload();
  await expect(timings.getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
  await expect(timings.getByRole('checkbox', { name: 'Post-Emerge Soybeans' })).toBeChecked();

  await page.getByRole('combobox', { name: 'Category' }).selectOption('Insecticide');
  await expect(page.getByText('This product has use timings. Changing the category clears them.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('Herbicide');
  await expect(timings.getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
  await page.getByRole('combobox', { name: 'Category' }).selectOption('Insecticide');
  await page.getByRole('button', { name: 'Change Category' }).click();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText(/product updated/i).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('Insecticide');
  await expect(timings).toHaveCount(0);
});
