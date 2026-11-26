import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { localSql } from './local-db';

test('A saved excess receipt survives a lost response without sending a second notice', async ({ page }) => {
  test.setTimeout(120_000);
  const [po, line, product] = Array.from({ length: 3 }, randomUUID);
  const tag = po.slice(0, 8);
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const sender = localSql(`SELECT id FROM public.profiles WHERE email = '${email}' AND role = 'admin' AND is_active;`);
  expect(sender).toMatch(/^[0-9a-f-]{36}$/);
  const activeAdmins = Number(localSql("SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active;"));
  localSql(`BEGIN;
    INSERT INTO public.products (id, product_name, category, product_form, inventory_unit)
      VALUES ('${product}', 'Invented Receipt Product ${tag}', 'Herbicide', 'liquid', 'Gal');
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, created_by)
      VALUES ('${po}', 'LOCAL-EXCESS-${tag}', 'Invented Vendor', 'submitted', '${sender}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
      VALUES ('${line}', '${po}', '${product}', 10, 0, 1.00, 'gal');
    COMMIT;`);

  const browserNotices: string[] = [];
  const attempts: string[] = [];
  const concurrentResponses: APIResponse[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/rest/v1/notifications')) browserNotices.push(path);
  });
  await page.route('**/rest/v1/rpc/receive_po_items_with_excess_notice', async route => {
    attempts.push(route.request().postDataJSON().p_idempotency_key);
    if (attempts.length > 1) return route.continue();
    const [response, duplicate] = await Promise.all([route.fetch(), route.fetch()]);
    if (!response.ok()) return route.fulfill({ response });
    concurrentResponses.push(response, duplicate);
    await route.abort('failed');
  });

  await page.addLocatorHandler(page.getByRole('dialog', { name: /what's new/i }), async dialog => {
    await dialog.getByRole('button', { name: 'Got it' }).click();
  });
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto(`/purchase-orders/${po}`);
  await page.getByRole('button', { name: 'Receive Items', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive Items' });
  await dialog.getByRole('spinbutton').fill('11');
  await dialog.getByRole('button', { name: 'Review (1 item)' }).click();
  await dialog.getByRole('checkbox', { name: 'Confirm over-receive (admin override)' }).check();
  await dialog.getByPlaceholder(/^Reason /).fill('Invented extra delivery verified');
  await dialog.getByRole('button', { name: 'Confirm & Receive' }).click();

  const retry = dialog.getByRole('button', { name: 'Retry Exact Receiving' });
  await expect(retry).toBeEnabled();
  expect(concurrentResponses).toHaveLength(2);
  expect(concurrentResponses[1].ok()).toBe(true);
  expect(await concurrentResponses[1].json()).toEqual(await concurrentResponses[0].json());
  const saved = () => localSql(`SELECT concat_ws('|', trim_scale(l.quantity_received),
    (SELECT count(*) FROM public.receiving_records WHERE po_item_id = l.id),
    (SELECT count(*) FROM public.notifications WHERE related_entity_id = l.purchase_order_id
      AND notification_type = 'over_receive' AND created_by = '${sender}'))
    FROM public.purchase_order_items l WHERE l.id = '${line}';`);
  expect(saved()).toEqual(`11|1|${activeAdmins}`);
  await retry.click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: `LOCAL-EXCESS-${tag}`, exact: true })).toBeVisible();
  expect(saved()).toEqual(`11|1|${activeAdmins}`);
  expect(browserNotices).toEqual([]);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBeTruthy();
  expect(attempts[1]).toBe(attempts[0]);
});
