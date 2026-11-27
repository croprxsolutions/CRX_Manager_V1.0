import { expect, test, type Page } from '@playwright/test';
import { localSql } from './local-db';

// Whole-item follow-ups (20270314100000): on an Ea product, 0.5 typed on the stock adjustment, cycle count,
// return and PO receiving screens is refused with the server's sentence, and a whole figure is accepted.
const ID = (k: string) => `md5('wif-${k}')::uuid`;
const NAME = '[WIF] Seed Bag';
const SENTENCE = /\[WIF\] Seed Bag is sold by the whole item \(Ea\), so 0\.5 can't be used\. Enter a whole number\./;
const CLEAN = `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.activity_feed WHERE customer_id = ${ID('customer')};
DELETE FROM public.return_items WHERE product_id = ${ID('product')};
DELETE FROM public.returns WHERE order_id = ${ID('order')};
DELETE FROM public.receiving_records WHERE product_id = ${ID('product')};
DELETE FROM public.purchase_order_items WHERE product_id = ${ID('product')};
DELETE FROM public.purchase_orders WHERE id = ${ID('po')};
DELETE FROM public.cycle_count_items WHERE product_id = ${ID('product')};
DELETE FROM public.inventory_transactions WHERE product_id = ${ID('product')};
DELETE FROM public.delivery_items WHERE id = ${ID('line')};
DELETE FROM public.deliveries WHERE id = ${ID('delivery')};
DELETE FROM public.order_items WHERE id = ${ID('order-line')};
DELETE FROM public.orders WHERE id = ${ID('order')};
DELETE FROM public.inventory WHERE product_id = ${ID('product')};
DELETE FROM public.product_change_history WHERE product_id = ${ID('product')};
DELETE FROM public.products WHERE id = ${ID('product')};
DELETE FROM public.customers WHERE id = ${ID('customer')};
COMMIT;`;

const RUN = Date.now().toString(36);
let seeded = false;
let admin = '';
let cycleCountNumber = '';
const asAdmin = (sql: string) => localSql(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${admin}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
${sql};
COMMIT;`);

test.beforeAll(() => {
  if (localSql(`SELECT count(*) FROM pg_proc WHERE proname = '_assert_whole_item_quantity'`) === '0') {
    throw new Error('The local copy lacks 20270314100000. Rebuild it: node scripts/local-app/walkthrough.mjs rebuild.');
  }
  if (localSql(`SELECT count(*) FROM public.products WHERE id = ${ID('product')}`) !== '0') {
    throw new Error('Invented WIF rows are already in the local copy; if no run is going, run CLEAN from this file.');
  }
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  admin = localSql(`SELECT id FROM auth.users WHERE email = '${email}'`);
  // Triggers off for the invented starting rows only; every later step goes through the real RPCs.
  localSql(`BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.customers (id, farm_name, is_active) VALUES (${ID('customer')}, '[WIF] Whole Item Farm', true);
INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
    rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
  VALUES (${ID('product')}, '${NAME}', '${NAME}', 'each', 'Ea', 'Ea', 'Ea', 'Ea', 1, 8, 10, 10, 10, 1, true);
INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (${ID('inventory')}, ${ID('product')}, 'Main Warehouse', 'Ea', 10, 0, 0);
INSERT INTO public.orders (id, order_number, customer_id, status) VALUES (${ID('order')}, 'WIF-O1', ${ID('customer')}, 'confirmed');
INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit)
  VALUES (${ID('order-line')}, ${ID('order')}, ${ID('product')}, '${NAME}', 'Ea', 2, 0, 2, 10, 8);
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery, scheduled_date)
  VALUES (${ID('delivery')}, 'WIF-D1', ${ID('order')}, ${ID('customer')}, '${admin}', '${admin}', 'in_progress', false, (now() AT TIME ZONE 'America/Chicago')::date);
INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
  VALUES (${ID('line')}, ${ID('delivery')}, ${ID('order-line')}, ${ID('product')}, 2, 'Ea');
INSERT INTO public.purchase_orders (id, po_number, vendor, status, created_by) VALUES (${ID('po')}, 'WIF-PO1', '[WIF] Vendor', 'submitted', '${admin}');
INSERT INTO public.purchase_order_items (purchase_order_id, product_id, product_name, quantity_ordered, quantity_received, unit_size, unit_cost)
  VALUES (${ID('po')}, ${ID('product')}, '${NAME}', 3, 0, 'Ea', 5);
COMMIT;`);
  seeded = true;
  asAdmin(`SELECT public.complete_delivery(p_delivery_id => ${ID('delivery')}, p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${admin}', p_quantities => jsonb_build_object(${ID('line')}::text, 2), p_idempotency_key => 'wif-done-${RUN}',
    p_evidence => 'no_proof', p_evidence_ref => '[WIF] whole item')`);
  asAdmin(`SELECT public.create_cycle_count(p_warehouse => 'Main Warehouse', p_performed_by => '${admin}'::uuid, p_idempotency_key => 'wif-cc-${RUN}')`);
  cycleCountNumber = localSql(`SELECT cc.count_number FROM public.cycle_count_items i JOIN public.cycle_counts cc ON cc.id = i.cycle_count_id
    WHERE i.product_id = ${ID('product')}`);
});

test.afterAll(() => {
  if (!seeded) return;
  localSql(`UPDATE public.cycle_counts SET status = 'cancelled' WHERE count_number = '${cycleCountNumber}' AND status = 'in_progress'`);
  localSql(CLEAN);
});

const stock = () => Number(localSql(`SELECT quantity_available FROM public.inventory WHERE id = ${ID('inventory')}`));
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

test('Whole-item follow-ups: adjust, count, return and receive refuse 0.5 Ea with the sentence and take a whole figure', async ({ page }) => {
  test.setTimeout(240000);
  await signIn(page);

  // 1. Inventory: manual adjustment.
  const before = stock();
  await page.goto('/inventory');
  const row = page.getByRole('row').filter({ hasText: NAME }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.getByRole('button', { name: 'Manual Adjustment' }).click();
  const adjust = page.getByLabel('Adjustment Quantity (+ or -)');
  await adjust.fill('0.5');
  await page.getByPlaceholder('Reason for adjustment').fill('[WIF] check');
  await page.getByRole('button', { name: 'Apply Adjustment' }).click();
  await expect(page.getByText(SENTENCE).first()).toBeVisible({ timeout: 10000 });
  await expect(adjust).toHaveValue('0.5');
  expect(stock()).toBe(before);
  await page.screenshot({ path: test.info().outputPath('1-adjust-refused.png'), fullPage: true });
  await adjust.fill('-1');
  await page.getByRole('button', { name: /Apply Adjustment|Retry Exact Adjustment/ }).click();
  await expect.poll(stock, { timeout: 10000 }).toBe(before - 1);

  // 2. Cycle count.
  await page.goto('/cycle-counts');
  await page.getByText(cycleCountNumber).first().click();
  const countRow = page.getByRole('row').filter({ hasText: NAME }).first();
  await expect(countRow).toBeVisible({ timeout: 30000 });
  const counted = countRow.getByPlaceholder('Count...');
  await counted.fill('0.5');
  await expect(page.getByText(SENTENCE).first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: test.info().outputPath('2-count-refused.png'), fullPage: true });
  await counted.fill(String(before - 1));
  await expect.poll(() => localSql(`SELECT trim_scale(counted_qty)::text FROM public.cycle_count_items WHERE product_id = ${ID('product')}`), { timeout: 10000 }).toBe(String(before - 1));

  // 3. Return from the delivered 2 Ea line.
  const customer = localSql(`SELECT ${ID('customer')}`);
  const order = localSql(`SELECT ${ID('order')}`);
  await page.goto(`/returns?customer=${customer}&order=${order}`);
  await page.getByRole('button', { name: 'Add Item' }).click();
  const product = page.getByLabel('Return product 1');
  await expect(product.locator('option', { hasText: NAME })).toHaveCount(1, { timeout: 30000 });
  await product.selectOption({ label: (await product.locator('option', { hasText: NAME }).textContent())!.trim() });
  const returned = page.getByLabel('Return quantity 1');
  await returned.fill('0.5');
  await page.getByRole('button', { name: 'Create Return' }).click();
  await expect(page.getByText(SENTENCE).first()).toBeVisible({ timeout: 10000 });
  await expect(returned).toHaveValue('0.5');
  expect(localSql(`SELECT count(*) FROM public.returns WHERE order_id = ${ID('order')}`)).toBe('0');
  await page.screenshot({ path: test.info().outputPath('3-return-refused.png'), fullPage: true });
  await returned.fill('1');
  await page.getByRole('button', { name: 'Create Return' }).click();
  await expect.poll(() => localSql(`SELECT count(*) FROM public.returns WHERE order_id = ${ID('order')}`), { timeout: 10000 }).toBe('1');

  // 4. Receiving on the PO's 3 Ea line.
  await page.goto(`/purchase-orders/${localSql(`SELECT ${ID('po')}`)}`);
  await page.getByRole('button', { name: 'Receive Items' }).click();
  const dialog = page.getByRole('dialog');
  const line = dialog.locator('div.border.rounded-xl').filter({ hasText: NAME }).first();
  const received = line.locator('input[type="number"]').first();
  await received.fill('0.5');
  await dialog.getByRole('button', { name: /^Review/ }).click();
  await dialog.getByRole('button', { name: 'Confirm & Receive' }).click();
  await expect(page.getByText(SENTENCE).first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: test.info().outputPath('4-receive-refused.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(received).toHaveValue('0.5');
  expect(localSql(`SELECT count(*) FROM public.receiving_records WHERE product_id = ${ID('product')}`)).toBe('0');
  await received.fill('1');
  await dialog.getByRole('button', { name: /^Review/ }).click();
  await dialog.getByRole('button', { name: /Confirm & Receive|Retry Exact Receiving/ }).click();
  await expect.poll(() => localSql(`SELECT COALESCE(sum(quantity_received), 0) FROM public.receiving_records WHERE product_id = ${ID('product')}`), { timeout: 10000 }).toMatch(/^1(\.0+)?$/);
});
