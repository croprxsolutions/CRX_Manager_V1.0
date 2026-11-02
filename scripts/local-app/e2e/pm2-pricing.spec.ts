import { expect, test, type Page } from '@playwright/test';

// WP-PM-2 proof: margins type cleanly, save exactly, and a product opens usable with nothing changed.
// Invented data only.
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function dbRow(page: Page, id: string) {
  return page.evaluate(async (productId) => {
    const dbPath = '/src/lib/db.ts';
    const costPath = '/src/lib/costFields.ts';
    const { supabase } = await import(/* @vite-ignore */ dbPath);
    const { withAdminCost } = await import(/* @vite-ignore */ costPath);
    const { data, error } = await supabase
      .from('products')
      .select('id, tier1_price, tier2_price, tier3_price, pricing_version')
      .eq('id', productId)
      .single();
    if (error) throw new Error(error.message);
    // Cost and margins are admin-only and do not come back from a plain read.
    return withAdminCost('products', data, true);
  }, id);
}

async function applyReview(page: Page) {
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.getByLabel('Source (supplier, document, date)').fill('Invented price list');
  await page.getByLabel('Reason for the change').fill('Proof of the pricing page');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  // A first price is a large change, so the review asks for a reason, as it should.
  await page.getByRole('region', { name: 'Warnings to acknowledge' }).locator('textarea').fill('Invented first price');
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
}

test('margins type cleanly on all tiers, save exactly, and reopen priced', async ({ page }) => {
  await signIn(page);
  const productName = `Pricing Proof ${Date.now()} (invented)`;
  const id: string = await page.evaluate(async (name) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase.from('products').insert({ product_name: name, product_form: 'liquid' }).select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
  }, productName);

  await page.goto(`/products/${id}`);
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('margin_driven');
  await page.locator('#product-current-cost').fill('80');

  const margins: [string, string, string][] = [
    ['#tier1-net-margin', '20', '100'],
    ['#tier2-net-margin', '22.5', '103.23'],
    ['#tier3-net-margin', '25', '106.67'],
  ];
  for (const [box, percent] of margins) {
    await page.locator(box).pressSequentially(percent, { delay: 40 });
    await expect(page.locator(box)).toHaveValue(percent);
  }

  await applyReview(page);
  await expect(page.getByRole('button', { name: 'Apply approved changes' })).toHaveCount(0);
  await page.reload();

  const saved = await dbRow(page, id);
  expect(saved.tier1_margin).toBeCloseTo(0.2, 6);
  expect(saved.tier2_margin).toBeCloseTo(0.225, 6);
  expect(saved.tier3_margin).toBeCloseTo(0.25, 6);
  expect([saved.tier1_price, saved.tier2_price, saved.tier3_price].map(Number)).toEqual(margins.map(([, , price]) => Number(price)));

  // A product with prices and margins saved opens price-driven with its boxes usable.
  await expect(page.locator('#product-pricing-mode')).toHaveValue('price_driven');
  await expect(page.locator('#tier1-price')).toBeEnabled();
  await expect(page.locator('#tier1-net-margin')).toBeDisabled();
  await expect(page.locator('#tier1-net-margin')).toHaveValue('20.0');
  await expect(page.getByText('Markup %:').first()).toBeVisible();
  await expect(page.getByText('Gross Margin')).toHaveCount(0);
  await expect(page.getByText(/release gate/i)).toHaveCount(0);
  await page.screenshot({ path: 'scripts/local-app/.state/pm2-priced-product.png', fullPage: true });

  // Opening and saving a product whose margins set its prices changes no price.
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText(/product (saved|updated)/i).first()).toBeVisible();
  await page.reload();
  expect(await dbRow(page, id)).toEqual(saved);

  // The list opens the same row in the same mode, ready to edit.
  await page.goto('/products');
  await page.getByPlaceholder(/search/i).first().fill(productName);
  await page.getByRole('button', { name: /edit/i }).first().click();
  await expect(page.getByRole('combobox', { name: `Pricing mode for ${productName}` })).toHaveValue('price_driven');
  await expect(page.getByRole('spinbutton', { name: `Tier 1 price for ${productName}` })).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm2-list.png' });
});

test('moving between products keeps Stay and Leave honest', async ({ page }) => {
  await signIn(page);
  const run = Date.now();
  const [first, second] = [`Route One ${run} (invented)`, `Route Two ${run} (invented)`];
  const ids: string[] = await page.evaluate(async (names) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const rows = names.map((product_name) => ({ product_name, product_form: 'liquid' }));
    const { data, error } = await supabase.from('products').insert(rows).select('id, product_name');
    if (error) throw new Error(error.message);
    return names.map((name) => data.find((row: { product_name: string }) => row.product_name === name).id);
  }, [first, second]);

  await page.goto(`/products/${ids[0]}`);
  await expect(page.getByLabel(/product name/i)).toHaveValue(first);
  // The search box moves to another product without leaving the page, which is the route change under test.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/search pages/i).fill(second);
  await page.getByRole('option', { name: new RegExp(second.slice(0, 20)) }).first().click();
  await expect(page.getByLabel(/product name/i)).toHaveValue(second);

  await page.getByLabel('SKU').fill('UNSAVED-SKU');
  await page.goBack();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel(/product name/i)).toHaveValue(second);
  await expect(page.getByLabel('SKU')).toHaveValue('UNSAVED-SKU');

  await page.goBack();
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.getByLabel(/product name/i)).toHaveValue(first);
  await expect(page.getByLabel('SKU')).toHaveValue('');
  await page.goto('/products');
  await expect(page.getByRole('button', { name: 'Stay' })).toHaveCount(0);
});
