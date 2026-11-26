import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

test('Purchase Order Detail and Quick Receive send damage notices for saved items', async ({ page }) => {
  test.setTimeout(120_000);
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const admin = localSql(`SELECT id FROM public.profiles WHERE email = '${email}' AND role = 'admin' AND is_active;`);
  expect(admin).toMatch(/^[0-9a-f-]{36}$/);
  const activeAdmins = Number(localSql("SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active;"));
  const fixture = (label: string) => {
    const [po, line, product] = Array.from({ length: 3 }, randomUUID);
    const tag = po.slice(0, 8);
    const productName = `Invented ${label} Receiving ${tag}`;
    const poNumber = `LOCAL-DAMAGE-${tag}`;
    localSql(`BEGIN;
      INSERT INTO public.products (id, product_name, category, product_form, inventory_unit)
        VALUES ('${product}', '${productName}', 'Herbicide', 'liquid', 'Gal');
      INSERT INTO public.purchase_orders (id, po_number, vendor, status, created_by)
        VALUES ('${po}', '${poNumber}', 'Invented Vendor', 'submitted', '${admin}');
      INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
        VALUES ('${line}', '${po}', '${product}', 10, 0, 1.00, 'gal');
      COMMIT;`);
    return { po, line, productName, poNumber };
  };
  const detail = fixture('PO Detail');
  const quick = fixture('Quick');
  const detailExtraName = `${detail.productName} Extra`;
  const unmatchedName = `Invented Unmatched Receiving ${randomUUID().slice(0, 8)}`;
  const extraProduct = randomUUID();
  localSql(`BEGIN;
    INSERT INTO public.products (id, product_name, category, product_form, inventory_unit)
      VALUES ('${extraProduct}', '${detailExtraName}', 'Herbicide', 'liquid', 'Gal');
    INSERT INTO public.products (product_name, category, product_form, inventory_unit)
      VALUES ('${unmatchedName}', 'Herbicide', 'liquid', 'Gal');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
      VALUES ('${detail.po}', '${extraProduct}', 10, 0, 1.00, 'gal');
    COMMIT;`);
  const conditionPicker = page.locator('select').filter({ has: page.locator('option[value="damaged"]') });
  let successfulNoticePairs = 0;
  await page.route('**/rest/v1/rpc/notify_damaged_receiving', async route => {
    const [notice, retry] = await Promise.all([route.fetch(), route.fetch()]);
    expect(notice.ok()).toBe(true);
    expect(retry.ok()).toBe(true);
    successfulNoticePairs += 1;
    await route.fulfill({ response: notice });
  });
  const checkNotice = async ({ po, line, productName, poNumber }: ReturnType<typeof fixture>) => {
    await expect.poll(() => localSql(`SELECT count(*) FROM public.notifications
      WHERE related_entity_id = '${po}' AND notification_type = 'po_damaged_received'
        AND created_by IS NULL AND message LIKE '%${productName}%' AND message LIKE '%${poNumber}%';`))
      .toBe(String(activeAdmins));
    expect(localSql(`SELECT count(*) FROM public.receiving_records
      WHERE po_item_id = '${line}' AND condition = 'damaged' AND quantity_received = 2;`)).toBe('1');
  };

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.addLocatorHandler(page.getByRole('dialog', { name: /what's new/i }), async dialog => {
    await dialog.getByRole('button', { name: 'Got it' }).click();
  });
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto(`/purchase-orders/${detail.po}`);
  await page.getByRole('button', { name: 'Receive Items', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive Items' });
  for (const input of await dialog.getByRole('spinbutton').all()) await input.fill('2');
  for (const picker of await conditionPicker.all()) await picker.selectOption('damaged');
  await dialog.getByRole('button', { name: 'Review (2 items)' }).click();
  await dialog.getByRole('button', { name: 'Confirm & Receive' }).click();
  await expect(dialog).toHaveCount(0);
  await checkNotice(detail);
  expect(localSql(`SELECT count(*) FROM public.notifications WHERE notification_type = 'po_damaged_received'
    AND related_entity_id = '${detail.po}' AND message LIKE '%${detailExtraName}%';`)).toBe(String(activeAdmins));

  await page.goto('/receiving?tab=quick');
  await page.getByRole('button', { name: 'Add First Product' }).click();
  const chooseProduct = async (name: string, quantity: string) => {
    await page.getByRole('button', { name: /select product/i }).last().click();
    await page.getByPlaceholder('Search by name, SKU, or vendor...').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('spinbutton', { name: /quantity received/i }).last().fill(quantity);
  };
  await chooseProduct(unmatchedName, '1');
  await page.getByRole('button', { name: 'Add Product', exact: true }).click();
  await chooseProduct(quick.productName, '2');
  await page.getByRole('button', { name: 'Expand details' }).last().click();
  await conditionPicker.selectOption('damaged');
  await page.getByRole('button', { name: /review & match \(2 items\)/i }).click();
  await page.getByRole('radio', { name: 'Skip this product entirely' }).check();
  await page.getByRole('button', { name: /confirm & receive/i }).click();
  await expect(page.getByRole('button', { name: 'Receive Another Shipment' })).toBeVisible();
  await checkNotice(quick);
  expect(successfulNoticePairs).toBe(2);
});
