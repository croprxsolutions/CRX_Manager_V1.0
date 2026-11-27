import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localSql } from './local-db';
import { API_URL, STATE_FOLDER, assertLocalState } from '../target.mjs';

// Local compatibility proof. The same old screen and invented fixtures run before and after the additive migration.
const id = (name: string) => "md5('invented-completion-notice-" + name + "')::uuid";
const delivery = id('delivery');
const order = id('order');
const product = id('product');
const customer = id('customer');
const invoiceIds = 'SELECT id FROM public.invoices WHERE delivery_id = ' + delivery;
let deliveryId: string;
let adminId: string;
let driverId: string | undefined;
let seeded = false;

async function createDriver() {
  const raw = readFileSync(new URL('../' + STATE_FOLDER + '/local.env', import.meta.url), 'utf8');
  const state = Object.fromEntries(raw.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  assertLocalState(state);
  const email = 'legacy-notice-driver-' + randomUUID() + '@fixture.example.test';
  const password = randomUUID();
  const response = await fetch(API_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.LOCAL_SERVICE_KEY, apikey: state.LOCAL_SERVICE_KEY,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true,
      user_metadata: { role: 'driver', full_name: 'Invented Legacy Notice Driver' } }),
  });
  expect(response.ok).toBe(true);
  const user = await response.json();
  expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  driverId = user.id;
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${driverId}';
    UPDATE auth.users SET banned_until = NULL WHERE id = '${driverId}';
    COMMIT;`);
  localSql(`UPDATE public.profiles SET role = 'driver' WHERE id = '${driverId}';`);
  return { email, password };
}

function seedDelivery(status: 'scheduled' | 'in_progress' = 'in_progress') {
  adminId = localSql("SELECT id FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1");
  expect(adminId).toMatch(/^[0-9a-f-]{36}$/);
  // Walkthrough seeding assigns the invented admin role while the directory trigger is paused.
  // Exercise the original sender with the same synchronized directory that a real role update produces.
  localSql(`UPDATE public.profiles SET role = 'admin' WHERE id = '${adminId}';`);
  expect(localSql('SELECT count(*) FROM public.deliveries WHERE id = ' + delivery)).toBe('0');
  localSql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.customers(id,farm_name,is_active) VALUES (${customer},'Invented Delivery Notice Farm',true);
    INSERT INTO public.products(id,product_name,sku,product_form,inventory_unit,unit_size,rate_unit,container_unit,
      rate_per_acre,current_cost,tier1_price,tier2_price,tier3_price,pricing_version,is_active)
      VALUES (${product},'Invented Completion Notice Product','INVENTED-NOTICE-01','liquid','Gal','Gal','Gal','Gal',1,6,10,10,10,1,true);
    INSERT INTO public.inventory(product_id,location,quantity_available,quantity_prebooked,unit_size)
      VALUES (${product},'Main Warehouse',20,2,'Gal');
    INSERT INTO public.orders(id,order_number,customer_id,status)
      VALUES (${order},'INVENTED-NOTICE-ORDER',${customer},'confirmed');
    INSERT INTO public.order_items(id,order_id,product_id,product_name,unit_size,total_units_needed,quantity_delivered,
      quantity_remaining,price_per_unit,cost_per_unit,total_price,profit,net_margin)
    VALUES (${id('order-line')},${order},${product},'Invented Completion Notice Product','Gal',2,0,2,10,6,20,8,40);
    INSERT INTO public.deliveries(id,delivery_number,order_id,customer_id,created_by,assigned_driver,status,scheduled_date)
      VALUES (${delivery},'INVENTED-NOTICE-DELIVERY',${order},${customer},'${driverId ?? adminId}',
        ${driverId ? "'" + driverId + "'" : 'NULL'},'${status}',(now() AT TIME ZONE 'America/Chicago')::date);
    INSERT INTO public.delivery_items(id,delivery_id,order_item_id,product_id,quantity,quantity_delivered,unit_size)
      VALUES (${id('line')},${delivery},${id('order-line')},${product},2,0,'Gal');
    COMMIT;`);
  deliveryId = localSql('SELECT ' + delivery);
  seeded = true;
}

test.afterEach(() => {
  if (seeded) localSql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.notifications WHERE related_entity_id IN (${delivery}, ${order});
    DELETE FROM public.failed_notifications WHERE entity_id = ${delivery};
    DELETE FROM public.activity_feed WHERE customer_id = ${customer} OR related_entity_id IN (${delivery}, ${order});
    DELETE FROM public.financial_audit_log WHERE entity_id IN (${delivery}, ${order}) OR entity_id IN (${invoiceIds});
    DELETE FROM public.invoice_items WHERE invoice_id IN (${invoiceIds});
    DELETE FROM public.invoices WHERE delivery_id = ${delivery};
    DELETE FROM public.delivery_brand_events WHERE delivery_id = ${delivery};
    DELETE FROM public.idempotency_keys WHERE operation IN ('complete_delivery','start_and_complete_delivery')
      AND result ->> 'delivery_id' = '${deliveryId}';
    DELETE FROM public.inventory_transactions WHERE delivery_id = ${delivery};
    DELETE FROM public.delivery_remainders WHERE original_delivery_id = ${delivery};
    DELETE FROM public.delivery_receipt_queue WHERE delivery_id = ${delivery};
    DELETE FROM storage.objects WHERE bucket_id = 'delivery-signatures' AND name LIKE 'signatures/${deliveryId}/%';
    DELETE FROM public.delivery_items WHERE delivery_id = ${delivery};
    DELETE FROM public.deliveries WHERE id = ${delivery};
    DELETE FROM public.order_items WHERE order_id = ${order};
    DELETE FROM public.orders WHERE id = ${order};
    DELETE FROM public.inventory WHERE product_id = ${product};
    DELETE FROM public.products WHERE id = ${product};
    DELETE FROM public.customers WHERE id = ${customer};
    COMMIT;`);
  if (driverId) localSql(`DELETE FROM auth.users WHERE id = '${driverId}';`);
  driverId = undefined;
  seeded = false;
});

function legacySave(page: Page, operation: 'start_and_complete_delivery' | 'complete_delivery') {
  const hasSender = localSql("SELECT to_regprocedure('public.notify_saved_delivery_completion(uuid,text,text)') IS NOT NULL") === 't';
  const eventCount = () => localSql('SELECT count(*) FROM public.delivery_completion_notice_events');
  const before = hasSender ? eventCount() : null;
  const actor = driverId ?? adminId;
  const save = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/rpc/' + operation));
  // The old driver screen can attempt refused staff alerts before its successful self-alert.
  const direct = page.waitForResponse(response => response.ok() && response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/rest/v1/notifications'), { timeout: 30_000 });
  return async () => {
    const [request] = await Promise.all([save, direct]);
    expect(request.postDataJSON().p_record_completion_notice).toBeUndefined();
    if (hasSender) expect(eventCount()).toBe(before);
    await expect.poll(() => localSql(`SELECT count(*) FROM public.notifications WHERE related_entity_id = ${delivery}
      AND user_id = '${actor}' AND created_by = '${actor}' AND notification_type = 'delivery_completed'`)).toBe('1');
  };
}

test('Original Deliveries list completes and sends its legacy direct notice', async ({ page }) => {
  test.setTimeout(120_000);
  seedDelivery('scheduled');
  await signIn(page);
  await page.goto('/deliveries');
  await page.getByRole('button', { name: 'Mark delivery INVENTED-NOTICE-DELIVERY delivered', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Mark Delivered' }) });
  await dialog.getByText('Record without proof (admin only)').click();
  await dialog.locator('#complete-no-proof-reason').fill('Invented customer confirmed the list delivery by phone.');
  await dialog.getByRole('button', { name: 'Mark Delivered' }).click();
  const checkSave = legacySave(page, 'start_and_complete_delivery');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Record Without Proof' }).click();
  await checkSave();
  await page.goto('/deliveries/' + deliveryId);
  await expect(page.getByText(/^completed$/i).first()).toBeVisible();
});

test('Original Field Stop lets the assigned driver save a signed partial and send their existing notice', async ({ page }) => {
  test.setTimeout(120_000);
  const driver = await createDriver();
  seedDelivery();
  await signIn(page, driver.email, driver.password);
  await page.goto('/my-route/' + deliveryId);
  const quantity = page.getByRole('spinbutton', { name: /Delivered quantity for Invented Completion Notice Product/ });
  await expect(quantity).toBeVisible({ timeout: 30_000 });
  await quantity.fill('1');
  await page.getByRole('button', { name: /Continue with Partial/ }).click();
  await page.getByLabel('Signed by (name)').fill('Invented Route Customer');
  const canvas = page.locator('canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Signature canvas is hidden');
  await page.mouse.move(box.x + box.width * 0.10, box.y + box.height * 0.50);
  await page.mouse.down();
  for (let index = 1; index <= 14; index++) {
    const y = index % 2 ? 0.20 : 0.80;
    await page.mouse.move(box.x + box.width * (0.10 + index * 0.05), box.y + box.height * y, { steps: 4 });
  }
  await page.mouse.up();
  await page.getByRole('button', { name: 'Continue to Review' }).click();
  const checkSave = legacySave(page, 'complete_delivery');
  await page.getByRole('button', { name: 'Complete Delivery' }).click();
  await checkSave();
  await expect(page.getByRole('button', { name: /Next Stop/i })).toBeVisible({ timeout: 30_000 });
  expect(localSql('SELECT quantity_delivered FROM public.delivery_items WHERE delivery_id = ' + delivery)).toBe('1');
  expect(localSql(`SELECT count(*) FROM public.notifications WHERE related_entity_id = ${delivery}
    AND user_id <> '${driverId}' AND notification_type IN ('delivery_completed', 'delivery_remainder')`)).toBe('0');
});

async function signIn(page: Page, email = process.env.LOCAL_TEST_EMAIL!, password = process.env.LOCAL_TEST_PASSWORD!) {
  await page.addLocatorHandler(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /What's new/i }) }),
    async dialog => { await dialog.getByRole('button', { name: 'Close' }).click(); },
  );
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

test('Original Delivery Detail completes and sends its legacy direct notice', async ({ page }) => {
  test.setTimeout(120_000);
  seedDelivery();
  await signIn(page);
  const hasCheckedSender = localSql("SELECT to_regprocedure('public.notify_saved_delivery_completion(uuid,text,text)') IS NOT NULL") === 't';
  const sentBefore = hasCheckedSender
    ? localSql('SELECT count(*) FROM public.delivery_completion_notice_events')
    : null;
  let checkedRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/rpc/notify_saved_delivery_completion')) checkedRequests++;
  });
  await page.goto('/deliveries/' + deliveryId);
  const section = page.locator('#delivery-complete');
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.getByText('Record without proof (admin only)').click();
  await section.locator('#no-proof-reason').fill('Invented customer confirmed the delivery on the original screen.');
  await section.getByRole('button', { name: 'Complete Delivery', exact: true }).click();
  const save = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/rpc/complete_delivery'));
  const direct = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname.endsWith('/rest/v1/notifications'));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Complete Delivery', exact: true }).click();
  const [request] = await Promise.all([save, direct]);
  expect(request.postDataJSON().p_record_completion_notice).toBeUndefined();
  await expect.poll(() => localSql(`
    SELECT count(*) FROM public.notifications WHERE related_entity_id = ${delivery}
      AND user_id = '${adminId}' AND created_by = '${adminId}' AND notification_type = 'delivery_completed';`)).toBe('1');
  expect(checkedRequests).toBe(0);
  if (hasCheckedSender) expect(localSql('SELECT count(*) FROM public.delivery_completion_notice_events')).toBe(sentBefore);
  await page.reload();
  await expect(page.getByText(/^completed$/i).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(hasCheckedSender ? 'legacy-on-additive-db.png' : 'legacy-on-original-db.png'), fullPage: true });
});
