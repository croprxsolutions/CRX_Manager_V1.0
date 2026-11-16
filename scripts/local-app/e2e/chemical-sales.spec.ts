import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, test, type Page, type Download } from '@playwright/test';
import { localSql } from './local-db';

const run = randomUUID().replaceAll('-', '').slice(0, 12);
const productId = randomUUID();
const adminCustomerId = randomUUID();
const repCustomerId = randomUUID();
const otherRepCustomerId = randomUUID();
const productName = `Local Sales Gauntlet ${run}`;
const adminFarm = `Local Gauntlet Admin ${run}`;
const repFarm = `Local Gauntlet Rep ${run}`;
const otherFarm = `Local Gauntlet Other Rep ${run}`;
let unitPriceCents = 0;
const orderQuantity = 2;

type FixtureIds = { adminId: string; repId: string; otherRepId: string };
let ids: FixtureIds;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureSql() {
  const adminEmail = process.env.LOCAL_TEST_EMAIL;
  const repEmail = process.env.LOCAL_REP_EMAIL;
  const otherRepEmail = process.env.LOCAL_OTHER_REP_EMAIL;
  if (!adminEmail || !repEmail || !otherRepEmail) {
    throw new Error('Chemical sales gauntlet requires the isolated local admin and two sales-rep accounts.');
  }
  const idQuery = `SELECT
    (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlText(adminEmail)})) AS admin_id,
    (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlText(repEmail)})) AS rep_id,
    (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlText(otherRepEmail)})) AS other_rep_id`;
  const product = `INSERT INTO public.products
    (id, product_name, category, product_form, inventory_unit, container_unit, container_type,
     container_size, unit_size, is_active)
    VALUES (${sqlText(productId)}::uuid, ${sqlText(productName)}, 'Herbicide', 'liquid', 'Gal', 'Gal', 'Jug',
     1, 'Gal', true);
    INSERT INTO public.inventory (product_id, location, quantity_available, unit_size)
      VALUES (${sqlText(productId)}::uuid, 'Main Warehouse', 50, 'Gal');`;
  const customers = `INSERT INTO public.customers (id, farm_name, contact_name, email, assigned_tier, assigned_sales_rep, default_commission_split)
    VALUES
      (${sqlText(adminCustomerId)}::uuid, ${sqlText(adminFarm)}, 'Local Admin Contact', NULL, 1, NULL, '{"splits":[]}'),
      (${sqlText(repCustomerId)}::uuid, ${sqlText(repFarm)}, 'Local Rep Contact', NULL, 1, (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlText(repEmail)})), '{"splits":[]}'),
      (${sqlText(otherRepCustomerId)}::uuid, ${sqlText(otherFarm)}, 'Local Other Rep Contact', NULL, 1, (SELECT id FROM auth.users WHERE lower(email) = lower(${sqlText(otherRepEmail)})), '{"splits":[]}');`;
  return { idQuery, product, customers };
}

async function login(page: Page, email: string, password: string) {
  if (!email || !password) throw new Error('Required generated local test login is missing.');
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 20_000 });
}

async function addLine(page: Page, farm: string) {
  await page.getByRole('combobox', { name: 'Customer', exact: true }).fill(farm);
  await page.getByRole('option', { name: new RegExp(farm, 'i') }).click();
  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  await page.getByRole('button', { name: 'Select Product', exact: true }).last().click();
  const productPicker = page.getByPlaceholder(/search by name, SKU, category, or vendor/i);
  await productPicker.fill(productName);
  await page.getByRole('button', { name: new RegExp(productName, 'i') }).last().click();
  await page.getByLabel('Units needed', { exact: true }).fill(String(orderQuantity));
}

async function saveDraft(page: Page) {
  const saved = page.waitForResponse((response) => response.url().endsWith('/rpc/save_quote'));
  await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]+/i, { timeout: 15_000 });
  const quoteId = page.url().split('/').at(-1)!;
  await expect.poll(() => localSql(`SELECT count(*) FROM quotes WHERE id=${sqlText(quoteId)}::uuid AND status='draft'`)).toBe('1');
}

async function checkPdf(download: Download, name: string) {
  const output = test.info().outputPath(`${name}.pdf`);
  await download.saveAs(output);
  const loading = getDocument({ data: new Uint8Array(readFileSync(output)) });
  const pdf = await loading.promise;
  const text = (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.map((item) => 'str' in item ? item.str : '').join(' ');
  }))).join(' ');
  expect(text.toLowerCase()).toContain(adminFarm.toLowerCase());
  expect(text).toContain(productName);
  expect(text).toContain((unitPriceCents * orderQuantity / 100).toFixed(2));
  await loading.destroy();
}

test.describe.serial('chemical sales quote to invoice gauntlet (local invented records only)', () => {
  test.setTimeout(180_000);
  test.beforeAll(() => {
    const { idQuery, product, customers } = fixtureSql();
    const [adminId, repId, otherRepId] = localSql(idQuery).split('|');
    if (![adminId, repId, otherRepId].every((id) => /^[0-9a-f-]{36}$/i.test(id ?? ''))) {
      throw new Error('The isolated profile is missing one of its generated admin or sales-rep accounts.');
    }
    ids = { adminId, repId, otherRepId };
    localSql(`BEGIN; ${product} ${customers}
      SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${adminId}', true);
      DO $pricing$ DECLARE plan jsonb; BEGIN
        plan := public.preview_product_pricing_changes('product_page', NULL,
          jsonb_build_array(jsonb_build_object('product_id', '${productId}',
            'row_version', (SELECT pricing_version FROM products WHERE id='${productId}'),
            'pricing_mode', 'margin_driven', 'new_cost', '8.00',
            'tier1_margin_percent', '35.18', 'tier2_margin_percent', '35.18', 'tier3_margin_percent', '35.18',
            'change_reason', 'Invented chemical sales fixture')),
          '${adminId}', 'sales-fixture-preview-${run}');
        PERFORM public.apply_product_pricing_change_set((plan->>'change_set_id')::uuid,
          plan->>'request_fingerprint', '${adminId}', 'sales-fixture-apply-${run}');
      END $pricing$;
      COMMIT;`);
    unitPriceCents = Number(localSql(`SELECT round(tier1_price * 100)::bigint::text FROM public.products WHERE id='${productId}'`));
    expect(unitPriceCents).toBe(1234);
  });

  test('admin quote, presentation version, order, signed delivery, draft/post lifecycle and cancellation', async ({ page }) => {
    await login(page, process.env.LOCAL_TEST_EMAIL!, process.env.LOCAL_TEST_PASSWORD!);
    await page.goto('/quotes/new');
    await addLine(page, adminFarm);
    await saveDraft(page);
    const quoteUrl = page.url();
    const quoteId = quoteUrl.split('/').at(-1)!;

    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(productName) })).toBeVisible();
    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF', exact: true }).first().click();
    const downloadedPdf = await pdf;
    expect(downloadedPdf.suggestedFilename()).toMatch(/\.pdf$/i);
    await checkPdf(downloadedPdf, 'quote');

    await page.getByRole('button', { name: 'Preview Quote', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as Presented', exact: true }).click();
    await expect(page.getByText(/marked as presented/i)).toBeVisible({ timeout: 20_000 });
    const sentFacts = localSql(`SELECT q.status || '|' || count(v.id)::text || '|' || coalesce(max(v.version_number),0)::text
      FROM public.quotes q LEFT JOIN public.quote_versions v ON v.quote_id=q.id
      WHERE q.id=${sqlText(quoteId)}::uuid GROUP BY q.id, q.status`);
    expect(sentFacts.split('|')).toEqual(['sent', '1', '1']);

    await page.getByRole('button', { name: /Create Order/i }).click();
    await page.getByRole('menuitem', { name: 'Convert whole booking', exact: true }).click();
    const converted = page.waitForResponse((response) => response.url().endsWith('/rpc/convert_quote_to_order'));
    await page.getByRole('button', { name: 'Create Order', exact: true }).last().click();
    const convertedResponse = await converted;
    expect(convertedResponse.ok(), await convertedResponse.text()).toBe(true);
    const conversionRequest = convertedResponse.request().postDataJSON();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+/i, { timeout: 25_000 });
    const orderId = page.url().split('/').at(-1)!;
    const orderBefore = localSql(`SELECT id::text FROM public.orders WHERE id=${sqlText(orderId)}::uuid`);
    expect(orderBefore).toBe(orderId);
    const replay = await page.evaluate(async (args) => {
      const path = '/src/lib/db.ts';
      const { supabase } = await import(/* @vite-ignore */ path);
      return supabase.rpc('convert_quote_to_order', args);
    }, conversionRequest);
    expect(replay.error).toBeNull();
    expect(replay.data.order_id).toBe(orderId);
    expect(localSql(`SELECT count(*) FROM orders WHERE quote_id=${sqlText(quoteId)}::uuid`)).toBe('1');

    await page.getByRole('button', { name: 'Schedule Delivery', exact: true }).click();
    await expect(page).toHaveURL(/\/deliveries\/new\?/i, { timeout: 15_000 });
    await expect(page.getByRole('spinbutton').first()).toHaveValue(String(orderQuantity));
    const scheduled = page.waitForResponse((response) => response.url().endsWith('/rpc/create_delivery_with_items'));
    await page.getByRole('button', { name: 'Schedule Delivery', exact: true }).last().click();
    const scheduledResponse = await scheduled;
    expect(scheduledResponse.ok(), await scheduledResponse.text()).toBe(true);
    await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]+/i, { timeout: 20_000 });
    const deliveryId = localSql(`SELECT id::text FROM public.deliveries WHERE order_id=${sqlText(orderId)}::uuid ORDER BY created_at DESC LIMIT 1`);
    expect(deliveryId).toMatch(/^[0-9a-f-]{36}$/i);
    await page.goto(`/deliveries/${deliveryId}`);
    await page.getByRole('button', { name: 'Start Delivery', exact: true }).first().click();
    await page.getByRole('button', { name: 'Start Delivery', exact: true }).last().click();
    const stockBefore = Number(localSql(`SELECT sum(quantity_available) FROM inventory WHERE product_id='${productId}'`));
    await expect(page.getByText('Customer Signature', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Signed By').fill('Invented Local Recipient');
    await page.getByLabel('Email delivery receipt to customer').uncheck();
    const canvas = page.locator('canvas').last();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Signature canvas was not visible on the local delivery.');
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.25, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65, { steps: 5 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Complete Delivery', exact: true }).last().click();
    await page.getByRole('button', { name: 'Complete Delivery', exact: true }).last().click();
    await expect(page.getByText(/completed/i).first()).toBeVisible({ timeout: 25_000 });

    const deliveryFacts = localSql(`SELECT d.status || '|' || coalesce(d.signed_by,'') || '|' ||
      (d.signature_url IS NOT NULL)::text || '|' || coalesce(sum(di.quantity),0)::text
      FROM public.deliveries d JOIN public.delivery_items di ON di.delivery_id=d.id
      WHERE d.id=${sqlText(deliveryId)}::uuid GROUP BY d.id`);
    const [deliveryStatus, signedBy, signatureStored, deliveredQty] = deliveryFacts.split('|');
    expect([deliveryStatus, signedBy, signatureStored]).toEqual(['completed', 'Invented Local Recipient', 'true']);
    expect(Number(deliveredQty)).toBe(orderQuantity);
    expect(Number(localSql(`SELECT sum(quantity_available) FROM inventory WHERE product_id='${productId}'`))).toBe(stockBefore - orderQuantity);
    const invoiceId = localSql(`SELECT id::text FROM public.invoices WHERE order_id=${sqlText(orderId)}::uuid AND status='draft' ORDER BY created_at DESC LIMIT 1`);
    expect(invoiceId).toMatch(/^[0-9a-f-]{36}$/i);

    await page.goto(`/invoices/${invoiceId}`);
    await expect(page.getByText(productName).first()).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.reload();
    await expect(page.getByText(productName).first()).toBeVisible();
    const secondTab = await page.context().newPage();
    await secondTab.goto(`/invoices/${invoiceId}`);
    await expect(secondTab.getByText(productName).first()).toBeVisible();
    await secondTab.locator('textarea').first().fill(`Another tab changed this draft ${run}`);
    const changedDraft = secondTab.waitForResponse((response) => response.url().endsWith('/rpc/save_invoice'));
    await secondTab.getByRole('button', { name: 'Save', exact: true }).click();
    const changedResponse = await changedDraft;
    expect(changedResponse.ok(), await changedResponse.text()).toBe(true);
    await secondTab.close();
    const stalePost = page.waitForResponse((response) => response.url().endsWith('/rpc/post_invoice'));
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('button', { name: /^(Post Invoice|Post anyway)$/ }).last().click();
    const staleResponse = await stalePost;
    expect(staleResponse.ok()).toBe(false);
    expect(await staleResponse.text()).toContain('INVOICE_CHANGED_SINCE_LOADED');
    expect(localSql(`SELECT status FROM invoices WHERE id='${invoiceId}'`)).toBe('draft');
    await page.reload();
    await expect(page.getByText(productName).first()).toBeVisible();
    const posting = page.waitForResponse((response) => response.url().endsWith('/rpc/post_invoice'));
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('button', { name: /^(Post Invoice|Post anyway)$/ }).last().click();
    const postedResponse = await posting;
    expect(postedResponse.ok(), await postedResponse.text()).toBe(true);
    await expect(page.getByText(/posted/i).first()).toBeVisible({ timeout: 20_000 });
    const expectedTotal = unitPriceCents * orderQuantity;
    const posted = localSql(`SELECT i.status || '|' || i.total_amount_cents::text || '|' || i.balance_cents::text || '|' ||
      (SELECT sum(ii.quantity)::text FROM public.invoice_items ii WHERE ii.invoice_id=i.id)
      FROM public.invoices i WHERE i.id=${sqlText(invoiceId)}::uuid`);
    const [postedStatus, totalCents, balanceCents, billedQty] = posted.split('|');
    expect([postedStatus, totalCents, balanceCents]).toEqual(['posted', String(expectedTotal), String(expectedTotal)]);
    expect(Number(billedQty)).toBe(orderQuantity);
    const postedSnapshot = () => localSql(`SELECT json_build_object('posted_at', posted_at, 'total', total_amount_cents,
      'balance', balance_cents, 'audit', (SELECT count(*) FROM financial_audit_log WHERE entity_id='${invoiceId}'))::text
      FROM invoices WHERE id='${invoiceId}'`);
    const beforePostRetry = postedSnapshot();
    const postRetry = await page.evaluate(async (args) => {
      const path = '/src/lib/db.ts';
      const { supabase } = await import(/* @vite-ignore */ path);
      return supabase.rpc('post_invoice', args);
    }, postedResponse.request().postDataJSON());
    expect(postRetry.error).toBeNull();
    expect(postedSnapshot()).toBe(beforePostRetry);
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    const invoicePdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
    await checkPdf(await invoicePdf, 'invoice');

    await page.getByRole('button', { name: 'Unpost', exact: true }).click();
    await page.getByRole('button', { name: 'Unpost Invoice', exact: true }).last().click();
    await expect.poll(() => localSql(`SELECT status FROM public.invoices WHERE id=${sqlText(invoiceId)}::uuid`)).toBe('unposted');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('button', { name: /^(Post Invoice|Post anyway)$/ }).last().click();
    await expect.poll(() => localSql(`SELECT status FROM public.invoices WHERE id=${sqlText(invoiceId)}::uuid`)).toBe('posted');
    await page.getByRole('button', { name: 'Void', exact: true }).click();
    await page.getByLabel('Reason for voiding').fill(`Local gauntlet ${run}: void and repost lifecycle`);
    await page.getByRole('button', { name: 'Void Invoice', exact: true }).last().click();
    await expect.poll(() => localSql(`SELECT status FROM public.invoices WHERE id=${sqlText(invoiceId)}::uuid`)).toBe('voided');

    // A second delivery produces an independent draft. Voiding the completed delivery must cancel it.
    await page.goto('/quotes/new');
    await addLine(page, adminFarm);
    await saveDraft(page);
    const draftInvoiceQuoteId = page.url().split('/').at(-1)!;
    await page.getByRole('button', { name: 'Preview Quote', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as Presented', exact: true }).click();
    await expect(page.getByText(/marked as presented/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Create Order/i }).click();
    await page.getByRole('menuitem', { name: 'Convert whole booking', exact: true }).click();
    await page.getByRole('button', { name: 'Create Order', exact: true }).last().click();
    await page.getByRole('button', { name: 'Convert Anyway', exact: true }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+/i, { timeout: 25_000 });
    const draftOrderId = page.url().split('/').at(-1)!;
    await page.getByRole('button', { name: 'Schedule Delivery', exact: true }).click();
    await expect(page.getByRole('spinbutton').first()).toHaveValue(String(orderQuantity));
    await page.getByRole('button', { name: 'Schedule Delivery', exact: true }).last().click();
    await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]+/i, { timeout: 20_000 });
    const draftDeliveryId = localSql(`SELECT id::text FROM public.deliveries WHERE order_id=${sqlText(draftOrderId)}::uuid ORDER BY created_at DESC LIMIT 1`);
    await page.goto(`/deliveries/${draftDeliveryId}`);
    await page.getByRole('button', { name: 'Start Delivery', exact: true }).first().click();
    await page.getByRole('button', { name: 'Start Delivery', exact: true }).last().click();
    await page.getByLabel('Record without proof (admin only)').check();
    await page.getByLabel('Why is there no proof? (required)').fill(`Local sales cancellation fixture ${run}`);
    await page.getByRole('button', { name: 'Complete Delivery', exact: true }).last().click();
    await page.getByRole('button', { name: 'Complete Delivery', exact: true }).last().click();
    await expect.poll(() => localSql(`SELECT count(*)::text FROM public.invoices WHERE order_id=${sqlText(draftOrderId)}::uuid AND status='draft'`)).toBe('1');
    const autoDraftInvoiceId = localSql(`SELECT id::text FROM public.invoices WHERE order_id=${sqlText(draftOrderId)}::uuid AND status='draft' ORDER BY created_at DESC LIMIT 1`);
    await page.getByRole('button', { name: 'Void Delivery', exact: true }).click();
    await page.getByPlaceholder('Enter reason for voiding this delivery...').fill(`Cancel auto-draft from local quote ${draftInvoiceQuoteId}`);
    await page.getByRole('button', { name: 'Void Delivery', exact: true }).last().click();
    await expect.poll(() => localSql(`SELECT status FROM public.invoices WHERE id=${sqlText(autoDraftInvoiceId)}::uuid`)).toBe('cancelled');
  });

  test('sales rep can create own quote and cannot save another rep’s quote edits', async ({ browser }) => {
    const repContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:5209',
      proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
    });
    const repPage = await repContext.newPage();
    await login(repPage, process.env.LOCAL_REP_EMAIL!, process.env.LOCAL_REP_PASSWORD!);
    await repPage.goto('/quotes/new');
    await addLine(repPage, repFarm);
    await saveDraft(repPage);
    const repQuoteId = repPage.url().split('/').at(-1)!;
    expect(localSql(`SELECT created_by::text FROM public.quotes WHERE id=${sqlText(repQuoteId)}::uuid`).toLowerCase()).toBe(ids.repId.toLowerCase());

    const otherContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:5209',
      proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
    });
    const otherPage = await otherContext.newPage();
    await login(otherPage, process.env.LOCAL_OTHER_REP_EMAIL!, process.env.LOCAL_OTHER_REP_PASSWORD!);
    await otherPage.goto('/quotes/new');
    await addLine(otherPage, otherFarm);
    await saveDraft(otherPage);
    const otherQuoteId = otherPage.url().split('/').at(-1)!;

    await repPage.goto(`/quotes/${otherQuoteId}`);
    await expect(repPage.getByRole('button', { name: new RegExp(productName) })).toBeVisible();
    const before = localSql(`SELECT row_version::text || '|' || coalesce(header_notes,'') FROM quotes WHERE id='${otherQuoteId}'`);
    await repPage.getByPlaceholder('Notes visible at the top of the quote...').fill('An unrelated rep must not save this draft');
    const deniedSave = repPage.waitForResponse((response) => response.url().endsWith('/rpc/save_quote'));
    await repPage.getByRole('button', { name: 'Save Draft', exact: true }).click();
    const denied = await deniedSave;
    expect(denied.ok()).toBe(false);
    expect(await denied.text()).toContain('NOT_QUOTE_OWNER');
    expect(localSql(`SELECT row_version::text || '|' || coalesce(header_notes,'') FROM quotes WHERE id='${otherQuoteId}'`)).toBe(before);
    expect(localSql(`SELECT created_by::text FROM public.quotes WHERE id=${sqlText(otherQuoteId)}::uuid`).toLowerCase()).toBe(ids.otherRepId.toLowerCase());
    await Promise.all([repContext.close(), otherContext.close()]);
  });
});
