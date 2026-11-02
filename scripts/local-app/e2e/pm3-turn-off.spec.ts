import { expect, test } from '@playwright/test';

test('blocked order, stock warning, and admin reactivation', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const fixture = await page.evaluate(async () => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const suffix = Date.now().toString(36);
    const customer = await supabase.from('customers').insert({ farm_name: `PM3 Customer ${suffix}` }).select('id').single();
    if (customer.error || !customer.data) throw new Error(customer.error?.message ?? 'customer seed failed');
    const held = await supabase.from('products').insert({ product_name: `PM3 Held ${suffix}` }).select('id, product_name').single();
    if (held.error || !held.data) throw new Error(held.error?.message ?? 'held product seed failed');
    const stock = await supabase.from('products').insert({ product_name: `PM3 Stock ${suffix}` }).select('id, product_name').single();
    if (stock.error || !stock.data) throw new Error(stock.error?.message ?? 'stock product seed failed');
    const order = await supabase.from('orders').insert({ order_number: `PM3-${suffix}`, customer_id: customer.data.id,
      status: 'confirmed' }).select('id, order_number').single();
    if (order.error || !order.data) throw new Error(order.error?.message ?? 'order seed failed');
    const line = await supabase.from('order_items').insert({ order_id: order.data.id,
      product_id: held.data.id, product_name: held.data.product_name,
      total_units_needed: 1, quantity_remaining: 1, price_per_unit: 0, total_price: 0,
      pricing_pending: true });
    if (line.error) throw new Error(line.error.message);
    const balance = await supabase.from('inventory').insert({ product_id: stock.data.id,
      location: `PM3-${suffix}`, quantity_available: 2 });
    if (balance.error) throw new Error(balance.error.message);
    return { held: held.data, stock: stock.data, orderNumber: order.data.order_number };
  });

  await page.goto('/products');
  const heldRow = page.locator('tr').filter({ hasText: fixture.held.product_name });
  await heldRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('dialog')).toContainText(fixture.orderNumber);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await heldRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Deactivate' }).first().click();
  await expect(page.getByRole('dialog')).toContainText(fixture.orderNumber);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  const stockRow = page.locator('tr').filter({ hasText: fixture.stock.product_name });
  await stockRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('dialog')).toContainText('stock remains on hand');
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('Deactivated 1 product(s)')).toBeVisible();

  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('inactive');
  const retired = page.locator('tr').filter({ hasText: fixture.stock.product_name });
  await retired.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Reactivate' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByText('Reactivated 1 product(s)')).toBeVisible();
});
