import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

test('Job Detail loads fleet picker and vessel capacity without full register records', async ({ page }) => {
  const email = process.env.LOCAL_TEST_EMAIL!;
  const actor = localSql(`SELECT id FROM public.profiles WHERE email = '${email.replaceAll("'", "''")}' AND role = 'admin';`);
  expect(actor).toMatch(/^[0-9a-f-]{36}$/i);
  const activeId = randomUUID();
  const inactiveId = randomUUID();
  const name = `Invented Job Vehicle ${activeId.slice(0, 8)}`;
  const registration = `INVENTED-${activeId.slice(0, 8)}`;

  try {
    localSql(`BEGIN;
      INSERT INTO public.vehicles (id, vehicle_name, vehicle_type, category, capacity_gallons, capacity_unit, status, registration, notes)
        VALUES ('${activeId}', '${name}', 'ground', 'Sprayer', 317, 'gal', 'active', '${registration}', 'Invented register note'),
               ('${inactiveId}', '${name} Inactive', 'ground', 'Sprayer', 127, 'gal', 'inactive', NULL, NULL);
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${actor}';
      COMMIT;`);
    await page.addLocatorHandler(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /what's new/i }) }),
      async dialog => { await dialog.getByRole('button', { name: /close|got it/i }).first().click(); });
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(process.env.LOCAL_TEST_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/login/);

    const vehicleResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rest/v1/vehicles'));
    await page.goto('/jobs/new');
    const response = await vehicleResponse;
    expect(response.ok()).toBe(true);
    const vehicleRows: Array<Record<string, unknown>> = await response.json();
    expect(vehicleRows.find(row => row.id === activeId)).toEqual({
      id: activeId, vehicle_name: name, vehicle_type: 'ground', category: 'Sprayer',
      capacity_gallons: 317, capacity_unit: 'gal', status: 'active',
    });
    expect(vehicleRows.some(row => row.id === inactiveId)).toBe(false);

    const vehicle = page.locator('select').filter({ has: page.getByRole('option', { name: 'Select vehicle...' }) });
    await expect(vehicle.locator(`option[value="${activeId}"]`)).toHaveText(`${name} (ground)`);
    await vehicle.selectOption(activeId);
    const vessel = page.locator('#job-loader select').filter({
      has: page.getByRole('option', { name: 'Assigned vehicle (default)' }),
    });
    await expect(vessel.locator(`option[value="${activeId}"]`)).toHaveText(`${name} — 317 gal · Sprayer`);
    await vessel.selectOption(activeId);
    await expect(page.locator('#job-loader input[placeholder="Vehicle: 317"]')).toHaveValue('317');
  } finally {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'admin' WHERE id = '${actor}';
      DELETE FROM public.vehicles WHERE id IN ('${activeId}', '${inactiveId}');
      COMMIT;`);
  }
});
