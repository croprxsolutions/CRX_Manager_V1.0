import { expect, test, type Page } from '@playwright/test';
import { localSql } from './local-db';

// Pricing audit batch 2: the New PO cost refusal, the PO cost stale-screen check and the Cost History
// who/source line, walked on the local test copy with invented data.
const stamp = Date.now();
const productName = `Audit Cost Product ${stamp} (invented)`;

async function signIn(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /What's new/i }) }),
    async (dialog) => { await dialog.getByRole('button', { name: 'Close' }).click(); },
  );
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

function seed() {
  const email = process.env.LOCAL_TEST_EMAIL!.replace(/'/g, "''");
  // Products start pricing-free; the cost is set as the database owner with triggers lifted, like app.mjs seed.
  const [productId, poId, itemId, adminName] = localSql(`BEGIN;
    INSERT INTO public.products (product_name, product_form, inventory_unit) VALUES ('${productName}', 'liquid', 'Gal');
    SET LOCAL session_replication_role = replica;
    UPDATE public.products SET current_cost = 12.50 WHERE product_name = '${productName}';
    SET LOCAL session_replication_role = origin;
    WITH admin AS (SELECT u.id, p.full_name FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.email = '${email}'),
    product AS (SELECT id FROM public.products WHERE product_name = '${productName}'),
    history AS (INSERT INTO public.cost_history (product_id, old_cost, new_cost, change_source, price_source, changed_by, change_note)
      SELECT product.id, 11.00, 12.50, 'product_page', 'Vendor price list', admin.id, 'Invented seed' FROM product, admin RETURNING 1),
    po AS (INSERT INTO public.purchase_orders (po_number, vendor, status, created_by)
      SELECT 'AUDIT-${stamp}', 'Invented Vendor', 'submitted', admin.id FROM admin RETURNING id),
    item AS (INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
      SELECT po.id, product.id, 10, 0, 12.50, 'Gal' FROM po, product RETURNING id)
    SELECT product.id || '|' || po.id || '|' || item.id || '|' || admin.full_name FROM product, po, item, admin, (SELECT count(*) FROM history) h;
    COMMIT;
  `).split('|');
  return { productId, poId, itemId, adminName };
}

test('pricing audit batch 2 screens', async ({ page }) => {
  const { productId, poId, itemId, adminName } = seed();
  await signIn(page);

  // Cost History names who changed the cost and where the price came from.
  await page.goto(`/products/${productId}`);
  await expect(page.getByText(`${adminName} · Product page · Vendor price list`).first()).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: test.info().outputPath('1-cost-history-who-source.png'), fullPage: true });

  // New PO: a blank or mistyped cost is refused, naming the product.
  await page.goto('/purchase-orders/new');
  await page.getByPlaceholder('Enter or select vendor...').fill('Invented Vendor');
  const select = page.getByRole('button', { name: 'Select Product' });
  if (!(await select.count())) await page.getByRole('button', { name: 'Add Item' }).click();
  await page.getByRole('button', { name: 'Select Product' }).first().click();
  await page.getByPlaceholder('Search by name, SKU, or vendor...').fill(productName);
  await page.getByText(productName).last().click();
  const cost = page.getByLabel(`Unit cost for ${productName}`);
  await expect(cost).toHaveValue('12.5');
  await page.getByRole('row').filter({ hasText: productName }).locator('input').first().fill('10');
  await cost.fill('');
  await page.getByRole('button', { name: 'Save as Draft' }).click();
  await expect(page.getByText(`Enter a unit cost for "${productName}" (type 0 if it is free).`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('2-new-po-blank-cost-refused.png'), fullPage: true });
  await cost.fill('12oops');
  await expect(page.locator('td.font-mono.font-semibold')).toHaveText('—');
  await page.getByRole('button', { name: 'Save as Draft' }).click();
  await expect(page.getByText(`Check the unit cost for "${productName}"`).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('3-new-po-bad-cost-refused.png'), fullPage: true });

  // PO cost correction: a normal save works; a cost changed behind the screen is refused and the PO reloads.
  await page.goto(`/purchase-orders/${poId}`);
  await page.getByRole('button', { name: /Correct Unit Cost|Confirm \/ Correct Cost/ }).click();
  await page.getByLabel(`Unit cost for ${productName}`).fill('13.00');
  await page.getByRole('button', { name: 'Save Cost' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(localSql(`SELECT unit_cost_cents FROM public.purchase_order_items WHERE id = '${itemId}';`)).toBe('1300');

  await page.getByRole('button', { name: /Correct Unit Cost|Confirm \/ Correct Cost/ }).click();
  await page.getByLabel(`Unit cost for ${productName}`).fill('14.00');
  localSql(`UPDATE public.purchase_order_items SET unit_cost = 15.00 WHERE id = '${itemId}';`);
  await page.getByRole('button', { name: 'Save Cost' }).click();
  await expect(page.getByText(/changed since you opened this purchase order\. Nothing was saved/)).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('4-po-stale-cost-refused.png'), fullPage: true });
  expect(localSql(`SELECT unit_cost_cents FROM public.purchase_order_items WHERE id = '${itemId}';`)).toBe('1500');
  await page.getByRole('button', { name: /Correct Unit Cost|Confirm \/ Correct Cost/ }).click();
  await expect(page.getByLabel(`Unit cost for ${productName}`)).toHaveValue(/^15(\.00?)?$/);
});
