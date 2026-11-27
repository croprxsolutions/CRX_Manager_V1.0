import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

test('scheduling an assigned delivery saves one driver notice without a browser notification write', async ({ page }) => {
  const email = process.env.LOCAL_TEST_EMAIL!;
  const actor = localSql(`SELECT id FROM public.profiles WHERE email = '${email.replaceAll("'", "''")}' AND role = 'admin';`);
  expect(actor).toMatch(/^[0-9a-f-]{36}$/i);
  const [driver, customer, product, order, item] = Array.from({ length: 5 }, randomUUID);
  const tag = order.slice(0, 8);
  const driverName = `Invented Assignment Driver ${tag}`;
  const farm = `Invented Assignment Farm ${tag}`;
  const productName = `Invented Assignment Product ${tag}`;
  const browserWrites: string[] = [];

  try {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${actor}';
      INSERT INTO auth.users (id, email) VALUES ('${driver}', '${driver}@fixture.example.test');
      INSERT INTO public.profiles (id,email,full_name,role,is_active)
        VALUES ('${driver}', '${driver}@fixture.example.test','${driverName}','driver',true);
      INSERT INTO public.profile_public_directory (id,full_name,role,is_active)
        VALUES ('${driver}','${driverName}','driver',true);
      UPDATE public.profile_public_directory SET role = 'sales_rep' WHERE id = '${actor}';
      INSERT INTO public.customers (id,farm_name,assigned_tier,assigned_sales_rep)
        VALUES ('${customer}','${farm}',1,'${actor}');
      INSERT INTO public.products (id,product_name,product_form,unit_size,inventory_unit)
        VALUES ('${product}','${productName}','liquid','Gal','Gal');
      INSERT INTO public.orders (id,order_number,customer_id,status,booking_draw)
        VALUES ('${order}','INVENTED-ORDER-${tag}','${customer}','confirmed',false);
      INSERT INTO public.order_items (id,order_id,product_id,product_name,unit_size,total_units_needed,quantity_remaining,price_per_unit,cost_per_unit)
        VALUES ('${item}','${order}','${product}','${productName}','Gal',10,10,10,1);
      COMMIT;`);

    await page.addLocatorHandler(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /what's new/i }) }),
      async dialog => { await dialog.getByRole('button', { name: /close|got it/i }).first().click(); });
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(process.env.LOCAL_TEST_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/login/);

    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/rest/v1/notifications')) {
        browserWrites.push(request.method());
      }
    });
    await page.goto(`/deliveries/new?order=${order}`);
    await expect(page.getByText(productName, { exact: true })).toBeVisible();
    const driverPicker = page.locator('select').filter({ has: page.getByRole('option', { name: 'Unassigned', exact: true }) });
    await driverPicker.selectOption(driver);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rpc/create_delivery_with_items'));
    await page.getByRole('button', { name: 'Schedule Delivery', exact: true }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}$/i);
    const delivery = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(delivery).toMatch(/^[0-9a-f-]{36}$/i);
    await page.reload();
    await expect(page.getByText(driverName, { exact: true })).toBeVisible();

    const notices = JSON.parse(localSql(`SELECT coalesce(jsonb_agg(jsonb_build_object(
        'sender', n.created_by, 'recipient', n.user_id, 'title', n.title, 'description', n.message,
        'delivery_number', d.delivery_number)), '[]'::jsonb)
      FROM public.notifications n JOIN public.deliveries d ON d.id = n.related_entity_id
      WHERE d.id = '${delivery}' AND d.order_id = '${order}' AND d.assigned_driver = '${driver}'
        AND n.notification_type = 'delivery_assigned' AND n.related_entity_type = 'delivery';`));
    expect(notices).toEqual([expect.objectContaining({ sender: actor, recipient: driver, title: 'New Delivery Assigned' })]);
    expect(notices[0].description).toContain(farm);
    expect(notices[0].description).toContain(notices[0].delivery_number);
    expect(browserWrites).toEqual([]);
  } finally {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'admin' WHERE id = '${actor}';
      UPDATE public.profile_public_directory SET role = 'admin' WHERE id = '${actor}';
      DELETE FROM public.activity_feed WHERE customer_id = '${customer}';
      DELETE FROM public.idempotency_keys WHERE operation = 'create_delivery_with_items'
        AND result->>'delivery_id' IN (SELECT id::text FROM public.deliveries WHERE order_id = '${order}');
      DELETE FROM public.notifications WHERE related_entity_type = 'delivery'
        AND related_entity_id IN (SELECT id FROM public.deliveries WHERE order_id = '${order}');
      DELETE FROM public.delivery_items WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = '${order}');
      DELETE FROM public.deliveries WHERE order_id = '${order}';
      DELETE FROM public.order_items WHERE order_id = '${order}';
      DELETE FROM public.orders WHERE id = '${order}';
      DELETE FROM public.products WHERE id = '${product}';
      DELETE FROM public.customers WHERE id = '${customer}';
      DELETE FROM public.profile_public_directory WHERE id = '${driver}';
      DELETE FROM public.profiles WHERE id = '${driver}';
      DELETE FROM auth.users WHERE id = '${driver}';
      COMMIT;`);
  }
});
