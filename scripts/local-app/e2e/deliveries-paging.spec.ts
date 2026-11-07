import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

// Deliveries list paging by bookmark (Goal 4 follow-up) on 120 invented [G4D] deliveries: a delivery removed
// from page one while it is on screen must not make Next skip the first delivery of page two.
const COUNT = 120;
const IDS = `SELECT md5('g4d-del-' || g)::uuid FROM generate_series(1, ${COUNT}) g`;
// Deletes exactly the rows the seed made (their md5 ids), as the database owner with triggers off.
const CLEAN = `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.deliveries WHERE id IN (${IDS});
DELETE FROM public.customers WHERE id = md5('g4d-cust')::uuid;
COMMIT;`;

let seeded = false;

test.beforeAll(() => {
  if (localSql(`SELECT count(*) FROM pg_proc WHERE proname = 'get_deliveries_keyset_page'`) === '0') {
    throw new Error('The local copy has no get_deliveries_keyset_page. Rebuild the local copy: node scripts/local-app/app.mjs rebuild (see scripts/local-app/README.md).');
  }
  if (localSql(`SELECT count(*) FROM public.deliveries WHERE id = md5('g4d-del-1')::uuid`) !== '0') {
    throw new Error('Invented G4D deliveries are already in the local copy: another run is using them, or one stopped early. '
      + 'If no run is going, delete them by running the CLEAN statement in this file against the local copy.');
  }
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const admin = localSql(`SELECT id FROM auth.users WHERE email = '${email}'`);
  // Triggers off: the deliveries point at invented orders that do not exist.
  localSql(`BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES (md5('g4d-cust')::uuid, '[G4D] Paging Farm');
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, scheduled_date, status)
SELECT md5('g4d-del-' || g)::uuid, 'G4D-' || lpad(g::text, 4, '0'), md5('g4d-order-' || g)::uuid, md5('g4d-cust')::uuid,
       '${admin}', (now() AT TIME ZONE 'America/Chicago')::date + 3, 'scheduled'
FROM generate_series(1, ${COUNT}) g;
COMMIT;`);
  seeded = true;
});

test.afterAll(() => {
  if (seeded) localSql(CLEAN);
});

test('Deliveries list: a delivery removed from page one does not make Next skip one', async ({ page }) => {
  test.setTimeout(120000);
  const numbers = page.locator('table').getByText(/^G4D-\d{4}$/);
  // The page label shows before the rows land, so wait for all 50 rows before reading them.
  const deliveryNumbers = async () => {
    await expect(numbers).toHaveCount(50, { timeout: 15000 });
    return numbers.allInnerTexts();
  };

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  // Only the invented deliveries, so every row on these pages is one this test may remove.
  await page.goto('/deliveries');
  // Wait for the search to reach the database (it runs a moment after typing stops).
  const searched = page.waitForResponse((r) => r.url().includes('/rpc/get_deliveries_keyset_page') && (r.request().postData() ?? '').includes('"p_search":"G4D-"'));
  await page.getByLabel('Search deliveries').fill('G4D-');
  await searched;
  await expect(page.getByText(`Showing 1–50 of ${COUNT}`, { exact: false })).toBeVisible({ timeout: 30000 });
  const pageOne = await deliveryNumbers();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Page 2 · 50 shown of ${COUNT}`, { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('table').getByText(pageOne[0], { exact: true })).toHaveCount(0, { timeout: 15000 });
  const pageTwo = await deliveryNumbers();

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText(`Showing 1–50 of ${COUNT}`, { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('table').getByText(pageTwo[0], { exact: true })).toHaveCount(0, { timeout: 15000 });
  const removed = (await deliveryNumbers())[2];
  expect(removed).toMatch(/^G4D-\d{4}$/);
  // Removed while page one is on screen (an invented row, deleted as the database owner).
  localSql(`BEGIN; SET LOCAL session_replication_role = replica;
    DELETE FROM public.deliveries WHERE delivery_number = '${removed}' AND id IN (${IDS});
    COMMIT;`);

  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(`Page 2 · 50 shown of ${COUNT - 1}`, { exact: false })).toBeVisible({ timeout: 15000 });
  // A row count would have moved page two's first delivery onto page one; the bookmark keeps page two whole.
  expect(await deliveryNumbers()).toEqual(pageTwo);
  await page.screenshot({ path: 'scripts/local-app/.state/test-results/deliveries-page-two-after-removal.png', fullPage: true });
});
