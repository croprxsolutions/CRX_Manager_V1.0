import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

test('authorized logbooks keep aircraft registration', async ({ page }) => {
  const smoke = readFileSync(new URL('../../smoke/smoke-vehicle-logbook-registration.sql', import.meta.url), 'utf8');
  expect(localSql(smoke)).toMatch(/SMOKE_PASS_ROLLBACK$/);

  const email = process.env.LOCAL_TEST_EMAIL!;
  const actor = localSql(`SELECT id FROM public.profiles WHERE email = '${email.replaceAll("'", "''")}' AND role = 'admin';`);
  expect(actor).toMatch(/^[0-9a-f-]{36}$/i);
  const [customer, aircraft, record, source] = Array.from({ length: 4 }, randomUUID);
  const tag = record.slice(0, 8);
  const registration = `INVENTED-FAA-${tag}`;
  try {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${actor}';
      INSERT INTO public.customers (id, farm_name) VALUES ('${customer}', 'Invented FAA Farm ${tag}');
      INSERT INTO public.vehicles (id, vehicle_name, vehicle_type, category, registration, status)
        VALUES ('${aircraft}', 'Invented FAA Aircraft ${tag}', 'air', 'Airplane', '${registration}', 'inactive');
      INSERT INTO public.application_records (id, record_number, source_type, source_id,
        customer_id, applicator_id, application_date, vehicle_id)
        VALUES ('${record}', 'INVENTED-REPORT-${tag}', 'job', '${source}', '${customer}', '${actor}', current_date - 1, '${aircraft}');
      COMMIT;`);

    await page.addLocatorHandler(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /what's new/i }) }),
      async dialog => { await dialog.getByRole('button', { name: /close|got it/i }).first().click(); });
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(process.env.LOCAL_TEST_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/login/);
    await page.goto('/reports');
    await page.getByRole('button', { name: 'Application Logbook', exact: true }).click();
    const faaResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rpc/get_logbook_faa'));
    await page.getByRole('button', { name: 'FAA Aerial', exact: true }).click();
    const response = await faaResponse;
    expect(response.ok()).toBe(true);
    await expect(page.getByRole('cell', { name: registration, exact: true })).toBeVisible();
  } finally {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'admin' WHERE id = '${actor}';
      DELETE FROM public.application_records WHERE id = '${record}';
      DELETE FROM public.vehicles WHERE id = '${aircraft}';
      DELETE FROM public.customers WHERE id = '${customer}';
      COMMIT;`);
  }
});
