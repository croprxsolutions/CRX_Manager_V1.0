import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

const fixture = 'Invented register vehicle ' + randomUUID().slice(0, 8);

test.afterEach(() => {
  localSql(`DELETE FROM public.vehicles WHERE vehicle_name = '${fixture}';`);
});

test('the admin register reads and saves a vehicle through the supported screens', async ({ page }) => {
  const registration = 'INVENTED-REGISTER';
  const notes = 'Invented registration proof';
  const changedNotes = 'Invented note after save';
  const registerReads: string[] = [];
  const writeProjections: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    const method = response.request().method();
    if (response.ok() && method === 'GET' && url.pathname.endsWith('/rest/v1/admin_vehicle_register')) {
      registerReads.push(url.searchParams.get('id') || 'list');
    }
    if (response.ok() && method !== 'GET' && url.pathname.endsWith('/rest/v1/vehicles')) {
      writeProjections.push(method + ':' + url.searchParams.get('select'));
    }
  });

  await page.addLocatorHandler(page.getByRole('dialog', { name: /what's new/i }), async dialog => {
    await dialog.getByRole('button', { name: 'Got it' }).click();
  });

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.goto('/vehicles');
  await page.getByRole('button', { name: 'Add Vehicle' }).click();
  await page.getByLabel('Vehicle Name').fill(fixture);
  await page.getByLabel('Registration / ID').fill(registration);
  await page.getByPlaceholder('Maintenance schedule, special considerations...').fill(notes);
  await page.getByRole('button', { name: 'Create Vehicle' }).click();
  await expect(page).toHaveURL(/\/vehicles\/[0-9a-f-]{36}$/);
  await expect(page.getByPlaceholder('Maintenance schedule, special considerations...')).toHaveValue(notes);

  const status = page.getByRole('combobox').filter({ has: page.locator('option[value="inactive"]') });
  await status.selectOption('inactive');
  await page.getByPlaceholder('Maintenance schedule, special considerations...').fill(changedNotes);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Vehicle saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Registration / ID')).toHaveValue(registration);
  await expect(page.getByPlaceholder('Maintenance schedule, special considerations...')).toHaveValue(changedNotes);
  await expect(status).toHaveValue('inactive');

  await page.getByRole('button', { name: 'Back to vehicles' }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: fixture }) });
  await expect(row.getByText(registration, { exact: true })).toBeVisible();
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete 1 vehicle', exact: true }).click();
  await expect(row).toHaveCount(0);
  const refreshedRegister = page.waitForResponse(response =>
    response.ok()
    && response.request().method() === 'GET'
    && new URL(response.url()).pathname.endsWith('/rest/v1/admin_vehicle_register'));
  await page.reload();
  const vehicles = await (await refreshedRegister).json();
  expect(vehicles).not.toContainEqual(expect.objectContaining({ vehicle_name: fixture }));
  await expect(row).toHaveCount(0);

  expect(registerReads).toContain('list');
  expect(registerReads.some(read => read.startsWith('eq.'))).toBe(true);
  expect(writeProjections).toEqual(['POST:id', 'PATCH:id', 'DELETE:id']);
});
