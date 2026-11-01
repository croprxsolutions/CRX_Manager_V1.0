import { expect, test, type Page } from '@playwright/test';

// WP-PM-13 proof: the product page's stock matches the Inventory page. Invented data only.
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addStockedProduct(page: Page, name: string, stocked: boolean) {
  return page.evaluate(async ({ productName, withStock }) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase
      .from('products')
      .insert({ product_name: productName, product_form: 'liquid', inventory_unit: 'Gal', is_active: true })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    if (withStock) {
      const rows = [
        { product_id: data.id, location: 'North Barn', quantity_available: 12.5, reorder_point: 5 },
        { product_id: data.id, location: 'South Barn', quantity_available: 0.25, reorder_point: 0 },
      ];
      const { error: stockError } = await supabase.from('inventory').insert(rows);
      if (stockError) throw new Error(stockError.message);
    }
    return data.id as string;
  }, { productName: name, withStock: stocked });
}

test('the product page shows the same stock as Inventory, and its link opens that product', async ({ page }) => {
  await signIn(page);
  const name = `Stock Proof ${Date.now()} (invented)`;
  const id = await addStockedProduct(page, name, true);

  await page.goto(`/products/${id}`);
  const card = page.getByRole('heading', { name: /Stock/ }).locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
  await expect(page.getByText('North Barn')).toBeVisible();
  await expect(page.getByText('12.5 Gal')).toBeVisible();
  await expect(page.getByText('South Barn')).toBeVisible();
  await expect(page.getByText('0.25 Gal')).toBeVisible();
  await expect(page.getByText('Total on hand: 12.75 Gal')).toBeVisible();
  await expect(page.getByText('Not set')).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm13-product-card.png' });
  expect(await card.count()).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Open in Inventory' }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory\\?product=${id}$`));
  await expect(page.getByText(`Showing one product: ${name}`)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'North Barn' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'South Barn' })).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm13-inventory-one-product.png' });

  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
});

test('a product with no stock says so and still links to Inventory', async ({ page }) => {
  await signIn(page);
  const id = await addStockedProduct(page, `No Stock Proof ${Date.now()} (invented)`, false);
  await page.goto(`/products/${id}`);
  await expect(page.getByText('No stock recorded for this product.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Inventory' })).toHaveAttribute('href', `/inventory?product=${id}`);
});
