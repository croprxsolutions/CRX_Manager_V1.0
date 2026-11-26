import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

// Whole-item quantities (20270311000000): on a load in progress, an admin who sets 0.5 on a line whose product is
// stocked by the item (Ea) is refused on screen before anything is sent, and the load stays in progress.
const ID = (k: string) => `md5('wiq-${k}')::uuid`;
const CLEAN = `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.delivery_items WHERE id = ${ID('line')};
DELETE FROM public.deliveries WHERE id = ${ID('delivery')};
DELETE FROM public.order_items WHERE id = ${ID('order-line')};
DELETE FROM public.orders WHERE id = ${ID('order')};
DELETE FROM public.product_change_history WHERE product_id = ${ID('product')};
DELETE FROM public.products WHERE id = ${ID('product')};
DELETE FROM public.customers WHERE id = ${ID('customer')};
COMMIT;`;

let seeded = false;
let deliveryId = '';

test.beforeAll(() => {
  if (localSql(`SELECT count(*) FROM pg_proc WHERE proname = '_enforce_whole_item_quantity'`) === '0') {
    throw new Error('The local copy lacks 20270311000000. Rebuild it: node scripts/local-app/walkthrough.mjs rebuild.');
  }
  if (localSql(`SELECT count(*) FROM public.deliveries WHERE id = ${ID('delivery')}`) !== '0') {
    throw new Error('Invented WIQ rows are already in the local copy; if no run is going, run CLEAN from this file.');
  }
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const admin = localSql(`SELECT id FROM auth.users WHERE email = '${email}'`);
  // Triggers off: invented rows only, deleted by CLEAN afterwards.
  localSql(`BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.customers (id, farm_name, is_active) VALUES (${ID('customer')}, '[WIQ] Whole Item Farm', true);
INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
    rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
  VALUES (${ID('product')}, '[WIQ] Seed Bag', '[WIQ] Seed Bag', 'each', 'Ea', 'Ea', 'Ea', 'Ea', 1, 8, 10, 10, 10, 1, true);
INSERT INTO public.orders (id, order_number, customer_id, status) VALUES (${ID('order')}, 'WIQ-O1', ${ID('customer')}, 'confirmed');
INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit)
  VALUES (${ID('order-line')}, ${ID('order')}, ${ID('product')}, '[WIQ] Seed Bag', 'Ea', 2, 0, 2, 10, 8);
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery, scheduled_date)
  VALUES (${ID('delivery')}, 'WIQ-D1', ${ID('order')}, ${ID('customer')}, '${admin}', '${admin}', 'in_progress', false, (now() AT TIME ZONE 'America/Chicago')::date);
INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
  VALUES (${ID('line')}, ${ID('delivery')}, ${ID('order-line')}, ${ID('product')}, 2, 'Ea');
COMMIT;`);
  deliveryId = localSql(`SELECT ${ID('delivery')}`);
  seeded = true;
});

test.afterAll(() => {
  if (seeded) localSql(CLEAN);
});

test('Delivery: 0.5 on a whole-item (Ea) line is refused on screen and the load stays in progress', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.goto(`/deliveries/${deliveryId}`);
  const section = page.locator('#delivery-complete');
  await expect(section).toBeVisible({ timeout: 30000 });
  const qty = section.locator('input[type="number"]').first();
  await expect(qty).toHaveAttribute('step', '1');
  await qty.fill('0.5');
  await expect(qty).toHaveValue('0.5');

  await section.getByText('Record without proof (admin only)').click();
  await section.locator('#no-proof-reason').fill('Customer confirmed by phone that the bags arrived.');
  const rpc = page.waitForRequest((r) => r.url().includes('/rpc/complete_delivery'), { timeout: 3000 }).then(() => true, () => false);
  await section.getByRole('button', { name: /Complete \(Partial\)|Complete Delivery/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Complete/ }).click();

  await expect(page.getByText(/The delivery was not completed\. \[WIQ\] Seed Bag is sold by the whole item \(Ea\), so 0\.5 can't be used\. Enter a whole number\./))
    .toBeVisible({ timeout: 10000 });
  expect(await rpc).toBe(false);
  expect(localSql(`SELECT status FROM public.deliveries WHERE id = ${ID('delivery')}`)).toBe('in_progress');
  await page.screenshot({ path: test.info().outputPath('whole-item-refused.png'), fullPage: true });
});
