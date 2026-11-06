import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

// Orders list paging and selection (Goal 4) on 5,250 invented [G4O] orders; Mason's 2026-11-06 rule:
// every list read or page turn clears the selection, "Select All" included.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const CLEAN = `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.invoices WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE 'G4O-%');
DELETE FROM public.deliveries WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE 'G4O-%');
DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE 'G4O-%');
DELETE FROM public.orders WHERE order_number LIKE 'G4O-%';
DELETE FROM public.products WHERE product_name LIKE '[G4O]%';
DELETE FROM public.customers WHERE farm_name LIKE '[G4O]%';
COMMIT;`;
// The season the screen shows (October 1 to September 30, Chicago time), so the seed lands inside it.
const SEASON_START = `make_date(extract(year from (now() AT TIME ZONE 'America/Chicago') - interval '9 months')::int, 10, 1)`;
// 5,200 seeded in the season, 53 of them deleted.
const G4O_IN_SEASON = 5147;

let matching = 0;

test.beforeAll(() => {
  if (localSql(`SELECT count(*) FROM pg_proc WHERE proname = 'get_orders_page'`) === '0') {
    throw new Error('The local copy has no get_orders_page. Rebuild the local copy: node scripts/local-app/app.mjs rebuild (see scripts/local-app/README.md).');
  }
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const admin = localSql(`SELECT id FROM auth.users WHERE email = '${email}'`);
  const from = localSql(`SELECT ${SEASON_START}`);
  const seed = execFileSync(process.execPath, ['scripts/smoke/prove-orders-list-page-real-schema.mjs', '--print-seed', from, admin, admin], { cwd: root, encoding: 'utf8' });
  localSql(`${CLEAN}\nBEGIN;\n${seed}\nCOMMIT;`);
  const others = Number(localSql(`SELECT count(*) FROM public.orders WHERE deleted_at IS NULL AND order_number NOT LIKE 'G4O-%'
    AND order_date >= ${SEASON_START} AND order_date < ${SEASON_START} + interval '1 year'`));
  matching = G4O_IN_SEASON + others;
});

test.afterAll(() => {
  localSql(CLEAN);
});

test('Orders list: true totals, selection cleared on every read, Select All greyed out while loading', async ({ page }) => {
  test.setTimeout(180000);
  const total = matching.toLocaleString('en-US');
  const selectAll = page.getByRole('button', { name: /^Select All/ });
  const selectedCount = page.getByText(/^\d+ selected$/);

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.goto('/orders');
  await expect(page.getByText(`Showing 1–50 of ${total} orders`, { exact: false })).toBeVisible({ timeout: 30000 });

  // A ticked row does not follow the user to the next page.
  await page.getByRole('checkbox').first().check();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Showing 51–100 of ${total} orders`, { exact: false })).toBeVisible();
  await expect(selectedCount).toHaveCount(0);

  // Select All reads every matching order; unticking one brings the button back.
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(`Showing 1–50 of ${total} orders`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: `Select All ${total}` }).click();
  await expect(page.getByText(`${matching} selected`)).toBeVisible({ timeout: 60000 });
  await page.getByRole('checkbox').first().uncheck();
  await expect(page.getByText(`${matching - 1} selected`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Select All ${total}` })).toBeVisible();

  // Typing a search clears the selection and the database finds a product deep in the list.
  await page.getByLabel('Search orders or products…').fill('zebra');
  await expect(selectedCount).toHaveCount(0);
  await expect(page.getByText('G4O-04321')).toBeVisible({ timeout: 30000 });

  await page.getByLabel('Search orders or products…').fill('');
  await expect(page.getByText(`Showing 1–50 of ${total} orders`, { exact: false })).toBeVisible({ timeout: 30000 });

  // While a page read runs, Select All is greyed out, never a click that is silently dropped.
  await page.route('**/rpc/get_orders_page**', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(selectAll).toBeDisabled();
  await expect(page.getByText(`Showing 51–100 of ${total} orders`, { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(selectAll).toBeEnabled();
  await expect(selectedCount).toHaveCount(0);
  await page.unroute('**/rpc/get_orders_page**');
  await page.getByRole('button', { name: `Select All ${total}` }).click();
  await expect(page.getByText(`${matching} selected`)).toBeVisible({ timeout: 60000 });
  // A page turn clears a full Select All too.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Showing 101–150 of ${total} orders`, { exact: false })).toBeVisible();
  await expect(selectedCount).toHaveCount(0);

  // While a typed search waits to run, the old rows are hidden and Select All is greyed out.
  await page.getByLabel('Search orders or products…').fill('zebra');
  await expect(selectAll).toBeDisabled();
  await expect(page.getByText(/^G4O-\d{5}$/)).toHaveCount(0);
  await expect(page.getByText('G4O-04321')).toBeVisible({ timeout: 30000 });
});
