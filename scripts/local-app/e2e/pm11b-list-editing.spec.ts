import { expect, test, type Page } from '@playwright/test';

// WP-PM-11b proof: paged edit mode, the unsaved warning, and the phone layout. Invented data only.
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addProducts(page: Page, prefix: string, count: number) {
  await page.evaluate(async ({ namePrefix, total }) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const rows = Array.from({ length: total }, (_, index) => ({
      product_name: `${namePrefix} ${String(index + 1).padStart(3, '0')}`,
      product_form: 'liquid',
      sku: `${namePrefix}-${index + 1}`,
      category: namePrefix,
    }));
    const { error } = await supabase.from('products').insert(rows);
    if (error) throw new Error(error.message);
  }, { namePrefix: prefix, total: count });
}

test('edit mode shows a page of rows, keeps edits across pages, and warns before leaving', async ({ page }) => {
  await signIn(page);
  const prefix = `Paged ${Date.now()}`;
  await addProducts(page, prefix, 60);

  await page.goto('/products');
  await page.getByLabel('Filter by category').filter({ visible: true }).selectOption(prefix);
  await expect(page.getByText(`${prefix} 060`)).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  await expect(page.getByText('Showing 1–50 of 60')).toBeVisible();
  await expect(page.getByRole('combobox', { name: /^Pricing mode for / })).toHaveCount(50);

  const firstName = page.locator('tbody input[type="text"]').first();
  await firstName.fill(`${prefix} edited`);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Showing 51–60 of 60')).toBeVisible();
  await expect(page.getByText('1 unsaved on other pages')).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm11b-edit-page-2.png' });

  await page.getByText('Supplier Pricing').first().click();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/products$/);
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(firstName).toHaveValue(`${prefix} edited`);

  await page.getByText('Supplier Pricing').first().click();
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page).toHaveURL(/\/inventory/);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the list shows tappable cards with no cost, and Download still works', async ({ page }) => {
    await signIn(page);
    const prefix = `Phone ${Date.now()}`;
    await addProducts(page, prefix, 3);

    await page.goto('/products');
    const list = page.getByTestId('products-mobile-list');
    await list.getByPlaceholder('Search products...').fill(prefix);
    await expect(list.getByText(`${prefix} 001`)).toBeVisible();
    await expect(list.getByText(/cost|margin/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Download/ }).first()).toBeVisible();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'scripts/local-app/.state/pm11b-phone.png' });

    await list.getByText(`${prefix} 001`).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  });
});
