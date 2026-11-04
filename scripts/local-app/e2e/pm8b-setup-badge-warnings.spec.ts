import { expect, test } from '@playwright/test';
import { deleteLocalProducts } from './local-db';

const created: string[] = [];
test.afterEach(() => deleteLocalProducts(created.splice(0)));

test('incomplete setup badge, setup filter, near-match warning and rate help', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  // Products are an allowed admin insert. An invented maker gives the near-match warning something to match.
  const stamp = Date.now();
  const [makerId, productId, productError] = await page.evaluate(async ({ name, maker }) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const { data: makerRow, error: makerError } = await supabase.from('products')
      .insert({ product_name: `${name} maker`, manufacturer: maker }).select('id').single();
    if (makerError || !makerRow) throw new Error(makerError?.message ?? 'Local maker insert failed');
    const { data, error } = await supabase.from('products')
      .insert({ product_name: name, category: 'Herbicide' }).select('id').single();
    // The maker row already exists, so hand its id back for cleanup instead of throwing here.
    return [makerRow.id, data?.id ?? null, error?.message ?? null];
  }, { name: `Setup8b ${stamp} (invented)`, maker: `Zentrova${stamp}` });
  created.push(makerId);
  if (!productId) throw new Error(productError ?? 'Local product insert failed');
  created.push(productId);

  await page.goto(`/products/${productId}`);
  await expect(page.getByText('Incomplete setup')).toBeVisible();
  await expect(page.getByTestId('product-setup-missing')).toContainText('EPA number, Signal word, REI, PHI');

  await page.getByLabel('Manufacturer').fill(`Zentrova${stamp}`.replace('ova', 'va'));
  await expect(page.getByText('This creates a new manufacturer. Did you mean')).toBeVisible();
  await page.getByRole('button', { name: `Zentrova${stamp}`, exact: true }).click();
  await expect(page.getByLabel('Manufacturer')).toHaveValue(`Zentrova${stamp}`);
  await expect(page.getByText('This creates a new manufacturer.')).toHaveCount(0);

  await expect(page.getByText(/Not used in any calculation/)).toBeVisible();
  await expect(page.getByTestId('product-max-label-rate')).toHaveText('Not recorded');
  await expect(page.getByRole('button', { name: 'Label Review' })).toBeVisible();

  await page.goto('/products');
  const setupFilter = page.getByTestId('products-table-layout').getByLabel('Filter by setup');
  await expect(setupFilter.locator('option[value="incomplete"]')).toHaveText(/Incomplete setup \(\d+\)/);
  await setupFilter.selectOption('incomplete');
  await page.getByTestId('products-table-layout').getByPlaceholder('Search products...').fill(`Setup8b ${stamp}`);
  await expect(page.getByTestId('products-table-layout').getByText(`Setup8b ${stamp} (invented)`, { exact: true })).toBeVisible();
});
