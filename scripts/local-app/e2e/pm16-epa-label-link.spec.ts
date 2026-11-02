import { expect, test } from '@playwright/test';

// WP-PM-16 proof: the link follows the number on the product and on a brand row. Invented data only.
// This browser cannot leave the computer, so EPA's own page is checked separately.
const SEARCH = 'https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:';

test('the product page and brand rows link to EPA for their own number', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const id: string = await page.evaluate(async (name) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase.from('products').insert({ product_name: name, product_form: 'liquid' }).select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
  }, `EPA Link ${Date.now()} (invented)`);

  await page.goto(`/products/${id}`);
  await expect(page.getByText('Add an EPA number to see the label')).toBeVisible();

  const epa = page.getByLabel('EPA Registration');
  await epa.fill('524-475-1381');
  const link = page.getByRole('link', { name: 'Search EPA labels for 524-475-1381' });
  await expect(link).toHaveAttribute('href', `${SEARCH}524-475`);
  await expect(link).toHaveAttribute('target', '_blank');

  await epa.fill('not a number');
  await expect(page.getByText("Check the EPA number's format to see the label")).toBeVisible();

  await epa.fill('100-1070');
  await expect(page.getByRole('link', { name: 'Search EPA labels for 100-1070' })).toHaveAttribute('href', `${SEARCH}100-1070`);
  await page.screenshot({ path: 'scripts/local-app/.state/pm16-product-link.png' });
});
