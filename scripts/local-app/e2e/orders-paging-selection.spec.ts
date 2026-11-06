import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

// Orders list paging and selection (Goal 4) on 5,250 invented [G4O] orders; Mason's 2026-11-06 rule:
// every list read or page turn clears the selection, "Select All" included.
const root = fileURLToPath(new URL('../../..', import.meta.url));
// Deletes exactly the rows the seed made (its md5 ids), as the database owner with triggers off (the
// invoice and order guards refuse deletes), then rolls back if any other row still points at one of them.
const CLEAN = `BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE g4o (tbl text, id uuid) ON COMMIT DROP;
INSERT INTO g4o SELECT 'invoices', md5('g4o-inv-' || g || '-' || k)::uuid FROM generate_series(1, 5200) g, generate_series(1, 4) k;
INSERT INTO g4o SELECT 'deliveries', md5('g4o-del-' || g || '-' || k)::uuid FROM generate_series(1, 5200) g, generate_series(1, 3) k;
INSERT INTO g4o SELECT 'order_items', md5('g4o-item-' || g || '-' || k)::uuid FROM generate_series(1, 5250) g, generate_series(1, 2) k;
INSERT INTO g4o SELECT 'orders', md5('g4o-order-' || g)::uuid FROM generate_series(1, 5250) g;
INSERT INTO g4o SELECT 'products', md5('g4o-prod-' || g)::uuid FROM generate_series(1, 40) g;
INSERT INTO g4o VALUES ('products', md5('g4o-prod-zebra')::uuid), ('customers', md5('g4o-group')::uuid);
INSERT INTO g4o SELECT 'customers', md5('g4o-cust-' || g)::uuid FROM generate_series(1, 60) g;
DELETE FROM public.invoices WHERE id IN (SELECT id FROM g4o WHERE tbl = 'invoices');
DELETE FROM public.deliveries WHERE id IN (SELECT id FROM g4o WHERE tbl = 'deliveries');
DELETE FROM public.order_items WHERE id IN (SELECT id FROM g4o WHERE tbl = 'order_items');
DELETE FROM public.orders WHERE id IN (SELECT id FROM g4o WHERE tbl = 'orders');
DELETE FROM public.products WHERE id IN (SELECT id FROM g4o WHERE tbl = 'products');
DELETE FROM public.customers WHERE id IN (SELECT id FROM g4o WHERE tbl = 'customers');
DO $$
DECLARE fk record; dangling boolean;
BEGIN
  FOR fk IN
    SELECT c.conrelid::regclass AS child, a.attname AS col, p.relname AS parent
      FROM pg_constraint c
      JOIN pg_class p ON p.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND p.relnamespace = 'public'::regnamespace
       AND p.relname IN ('invoices', 'deliveries', 'order_items', 'orders', 'products', 'customers')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text IN (SELECT id::text FROM g4o WHERE tbl = %L))', fk.child, fk.col, fk.parent)
      INTO dangling;
    IF dangling THEN
      RAISE EXCEPTION 'Not deleted: % still points at a test % row. Remove that row first.', fk.child, fk.parent;
    END IF;
  END LOOP;
END $$;
COMMIT;`;
// The season the screen shows (October 1 to September 30, Chicago time), so the seed lands inside it.
const SEASON_START = `make_date(extract(year from (now() AT TIME ZONE 'America/Chicago') - interval '9 months')::int, 10, 1)`;
// 5,200 seeded in the season, 53 of them deleted.
const G4O_IN_SEASON = 5147;

let matching = 0;
// Only the run that loaded the rows deletes them, so two runs never delete each other's.
let seeded = false;

test.beforeAll(() => {
  if (localSql(`SELECT count(*) FROM pg_proc WHERE proname = 'get_orders_keyset_page'`) === '0') {
    throw new Error('The local copy has no get_orders_keyset_page. Rebuild the local copy: node scripts/local-app/app.mjs rebuild (see scripts/local-app/README.md).');
  }
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const admin = localSql(`SELECT id FROM auth.users WHERE email = '${email}'`);
  const from = localSql(`SELECT ${SEASON_START}`);
  const seed = execFileSync(process.execPath, ['scripts/smoke/prove-orders-list-page-real-schema.mjs', '--print-seed', from, admin, admin], { cwd: root, encoding: 'utf8' });
  if (localSql(`SELECT count(*) FROM public.orders WHERE id = md5('g4o-order-1')::uuid`) !== '0') {
    throw new Error('Invented G4O orders are already in the local copy: another run is using them, or one stopped early. '
      + 'If no run is going, delete them by running the CLEAN statement in this file against the local copy.');
  }
  // The seed's fixed ids make a second run started at the same moment fail here instead of sharing rows.
  localSql(`BEGIN;\n${seed}\nCOMMIT;`);
  seeded = true;
  const others = Number(localSql(`SELECT count(*) FROM public.orders WHERE deleted_at IS NULL AND order_number NOT LIKE 'G4O-%'
    AND order_date >= ${SEASON_START} AND order_date < ${SEASON_START} + interval '1 year'`));
  matching = G4O_IN_SEASON + others;
});

test.afterAll(() => {
  if (seeded) localSql(CLEAN);
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
  await expect(page.getByText(`Page 2 · 50 shown of ${total} orders`, { exact: false })).toBeVisible();
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
  await page.route('**/rpc/get_orders_keyset_page**', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(selectAll).toBeDisabled();
  await expect(page.getByText(`Page 2 · 50 shown of ${total} orders`, { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(selectAll).toBeEnabled();
  await expect(selectedCount).toHaveCount(0);
  await page.unroute('**/rpc/get_orders_keyset_page**');
  await page.getByRole('button', { name: `Select All ${total}` }).click();
  await expect(page.getByText(`${matching} selected`)).toBeVisible({ timeout: 60000 });
  // A page turn clears a full Select All too.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Page 3 · 50 shown of ${total} orders`, { exact: false })).toBeVisible();
  await expect(selectedCount).toHaveCount(0);

  // While a typed search waits to run, the old rows are hidden and Select All is greyed out.
  await page.getByLabel('Search orders or products…').fill('zebra');
  await expect(selectAll).toBeDisabled();
  await expect(page.getByText(/^G4O-\d{5}$/)).toHaveCount(0);
  await expect(page.getByText('G4O-04321')).toBeVisible({ timeout: 30000 });

  // An order removed while page one is on screen does not make Next skip one: page two still starts
  // right after page one's last row (a row count would have moved its first order onto page one).
  // The page label shows before the rows land, so wait for all 50 rows before reading them.
  const orderNumbers = async () => {
    await expect(page.getByText(/^G4O-\d{5}$/)).toHaveCount(50, { timeout: 15000 });
    return page.getByText(/^G4O-\d{5}$/).allInnerTexts();
  };
  // Only the invented orders, so every row on these pages is one this test may remove.
  await page.goto('/orders');
  await page.getByLabel('Search orders or products…').fill('G4O-');
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByText(`Showing 1–50 of ${G4O_IN_SEASON.toLocaleString('en-US')} orders`, { exact: false })).toBeVisible({ timeout: 30000 });
  const pageOne = await orderNumbers();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Page 2 · 50 shown of ${G4O_IN_SEASON.toLocaleString('en-US')} orders`, { exact: false })).toBeVisible();
  // The label can change before the rows do: wait until page one's rows have gone.
  await expect(page.getByText(pageOne[0], { exact: true })).toHaveCount(0, { timeout: 15000 });
  const pageTwo = await orderNumbers();
  expect(pageTwo).toHaveLength(50);
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText(`Showing 1–50 of ${G4O_IN_SEASON.toLocaleString('en-US')} orders`, { exact: false })).toBeVisible();
  // The label can change before the rows do: wait until page two's rows have gone.
  await expect(page.getByText(pageTwo[0], { exact: true })).toHaveCount(0, { timeout: 15000 });
  const removed = (await orderNumbers())[2];
  expect(removed).toMatch(/^G4O-\d{5}$/);
  // Soft-deleted as the owner with triggers off (an invented row; CLEAN deletes it with the rest).
  localSql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.orders SET deleted_at = now() WHERE order_number = '${removed}' AND id IN (SELECT md5('g4o-order-' || g)::uuid FROM generate_series(1, 5250) g);
    COMMIT;`);
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Page 2 · 50 shown of ${(G4O_IN_SEASON - 1).toLocaleString('en-US')} orders`, { exact: false })).toBeVisible({ timeout: 15000 });
  // A row count would have moved page two's first order onto page one; the bookmark keeps page two whole.
  expect(await orderNumbers()).toEqual(pageTwo);
  await page.screenshot({ path: 'scripts/local-app/.state/test-results/orders-page-two-after-removal.png', fullPage: true });
});
