import { expect, test } from '@playwright/test';

test('blocked order, stock warning, and admin reactivation', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const seeded = await page.evaluate(async () => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const suffix = Date.now().toString(36);
    const customer = await supabase.from('customers').insert({ farm_name: `PM3 Customer ${suffix}` }).select('id').single();
    if (customer.error || !customer.data) throw new Error(customer.error?.message ?? 'customer seed failed');
    const held = await supabase.from('products').insert({ product_name: `PM3 Held ${suffix}`, product_form: 'liquid' }).select('id, product_name').single();
    if (held.error || !held.data) throw new Error(held.error?.message ?? 'held product seed failed');
    const stock = await supabase.from('products').insert({ product_name: `PM3 Stock ${suffix}` }).select('id, product_name').single();
    if (stock.error || !stock.data) throw new Error(stock.error?.message ?? 'stock product seed failed');
    return { suffix, customerId: customer.data.id, held: held.data, stock: stock.data };
  });

  // An order line needs a cost basis, which only the governed pricing review sets.
  await page.goto(`/products/${seeded.held.id}`);
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('margin_driven');
  await page.locator('#product-current-cost').fill('50');
  for (const box of ['#tier1-net-margin', '#tier2-net-margin', '#tier3-net-margin']) {
    await page.locator(box).pressSequentially('20', { delay: 40 });
  }
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.getByLabel('Source (supplier, document, date)').fill('Invented price list');
  await page.getByLabel('Reason for the change').fill('Turn-off proof');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await page.getByRole('region', { name: 'Warnings to acknowledge' }).locator('textarea').fill('Invented first price');
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByRole('button', { name: 'Apply approved changes' })).toHaveCount(0);

  const fixture = await page.evaluate(async ({ suffix, customerId, held, stock }) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const customer = { data: { id: customerId } };
    const actor = (await supabase.auth.getUser()).data.user?.id;
    if (!actor) throw new Error('signed-in admin missing');
    const order = await supabase.rpc('create_direct_order', {
      p_customer_id: customer.data.id,
      p_order_date: new Date().toISOString().slice(0, 10),
      p_order_name: `PM3-${suffix}`,
      p_items: [{ product_id: held.id, product_name: held.product_name,
        quantity: 1, price_per_unit: 62.5, unit_cost: 50, unit_size: 'gal' }],
      p_performed_by: actor,
      p_idempotency_key: `pm3-e2e-order-${suffix}`,
    });
    if (order.error || !order.data?.order_id) throw new Error(order.error?.message ?? 'order seed failed');
    const savedOrder = await supabase.from('orders').select('order_number').eq('id', order.data.order_id).single();
    if (savedOrder.error || !savedOrder.data) throw new Error(savedOrder.error?.message ?? 'order read failed');
    const balance = await supabase.rpc('manual_inventory_add', {
      p_product_id: stock.id, p_location: `PM3-${suffix}`, p_quantity: 2,
      p_performed_by: actor, p_notes: 'Turn-off proof stock', p_unit_cost: 1,
      p_idempotency_key: `pm3-e2e-stock-${suffix}`,
    });
    if (balance.error) throw new Error(balance.error.message);
    return { held, stock, orderNumber: savedOrder.data.order_number };
  }, seeded);

  await page.goto('/products');
  const heldRow = page.locator('tr').filter({ hasText: fixture.held.product_name });
  await heldRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('dialog')).toContainText(fixture.orderNumber);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  await heldRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Deactivate' }).first().click();
  await expect(page.getByRole('dialog')).toContainText(fixture.orderNumber);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

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
