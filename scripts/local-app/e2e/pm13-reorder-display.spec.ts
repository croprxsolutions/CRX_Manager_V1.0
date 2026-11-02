import { expect, test, type Page } from '@playwright/test';

// WP-PM-13 proof: the product page's stock matches the Inventory page. Invented data only.
// The test copy has no unit list, so these products have no unit; the unit is covered in ProductStockCard.test.tsx.
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addProduct(page: Page, name: string) {
  return page.evaluate(async (productName) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase
      .from('products')
      .insert({ product_name: productName, product_form: 'liquid', is_active: true })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }, name);
}

// Stock has no direct browser write, so this product comes from seed.sql.
const STOCKED_ID = 'c0ca1000-0000-4000-8000-000000000003';
const STOCKED_NAME = 'Test Stocked Product (invented)';

test('the product page shows the same stock as Inventory, and its link opens that product', async ({ page }) => {
  await signIn(page);

  await page.goto(`/products/${STOCKED_ID}`);
  await expect(page.getByText('North Barn')).toBeVisible();
  await expect(page.getByText('12.5 —')).toBeVisible();
  await expect(page.getByText('South Barn')).toBeVisible();
  await expect(page.getByText('0.25 —')).toBeVisible();
  await expect(page.getByText('Total on hand: 12.75 —')).toBeVisible();
  await expect(page.getByText('Not set')).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm13-product-card.png' });

  await page.getByRole('link', { name: 'Open in Inventory' }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory\\?product=${STOCKED_ID}$`));
  await expect(page.getByText(`Showing one product: ${STOCKED_NAME}`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'North Barn' })).toContainText('12.5');
  await expect(page.getByRole('row').filter({ hasText: 'South Barn' })).toContainText('0.25');
  await page.screenshot({ path: 'scripts/local-app/.state/pm13-inventory-one-product.png' });

  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
});

test('a product with no stock says so and still links to Inventory', async ({ page }) => {
  await signIn(page);
  const id = await addProduct(page, `No Stock Proof ${Date.now()} (invented)`);
  await page.goto(`/products/${id}`);
  await expect(page.getByText('No stock recorded for this product.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Inventory' })).toHaveAttribute('href', `/inventory?product=${id}`);
});
