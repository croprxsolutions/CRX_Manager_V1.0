import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { localSql } from './local-db';

const [first, second, farm, job, fieldA, fieldB, locationA, locationB] = Array.from({ length: 8 }, randomUUID);

test.afterEach(() => {
  localSql(`BEGIN;
    DELETE FROM public.notifications WHERE related_entity_type = 'job' AND related_entity_id = '${job}';
    DELETE FROM public.job_location_dispatches WHERE job_id = '${job}';
    DELETE FROM public.job_fields WHERE id IN ('${locationA}', '${locationB}');
    DELETE FROM public.jobs WHERE id = '${job}';
    DELETE FROM public.fields WHERE id IN ('${fieldA}', '${fieldB}');
    DELETE FROM public.customers WHERE id = '${farm}';
    DELETE FROM public.profile_public_directory WHERE id IN ('${first}', '${second}');
    DELETE FROM public.profiles WHERE id IN ('${first}', '${second}');
    DELETE FROM auth.users WHERE id IN ('${first}', '${second}');
    COMMIT;`);
});

test('Location dispatch saves notices once without a browser notification write', async ({ page }) => {
  test.setTimeout(120_000);
  const tag = job.slice(0, 8);
  const jobNumber = `Local-Dispatch-${tag}`;
  const fieldName = `Invented North ${tag}`;
  const firstName = `Invented Applicator A ${tag}`;
  const secondName = `Invented Applicator B ${tag}`;
  const email = process.env.LOCAL_TEST_EMAIL!.replaceAll("'", "''");
  const sender = localSql(`SELECT id FROM public.profiles WHERE email = '${email}' AND role = 'admin' AND is_active;`);
  expect(sender).toMatch(/^[0-9a-f-]{36}$/);
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES ('${first}', '${first}@fixture.example.test'), ('${second}', '${second}@fixture.example.test');
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
      ('${first}', '${first}@fixture.example.test', '${firstName}', 'applicator', true),
      ('${second}', '${second}@fixture.example.test', '${secondName}', 'applicator', true);
    INSERT INTO public.profile_public_directory (id, full_name, role, is_active) VALUES
      ('${first}', '${firstName}', 'applicator', true), ('${second}', '${secondName}', 'applicator', true);
    INSERT INTO public.customers (id, farm_name) VALUES ('${farm}', 'Invented Dispatch Farm');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, total_acres)
      VALUES ('${job}', '${jobNumber}', '${farm}', CURRENT_DATE, 'scheduled', 20);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES
      ('${fieldA}', '${farm}', '${fieldName}', 10), ('${fieldB}', '${farm}', 'Invented South ${tag}', 10);
    INSERT INTO public.job_fields (id, job_id, field_id, acres_to_treat) VALUES
      ('${locationA}', '${job}', '${fieldA}', 10), ('${locationB}', '${job}', '${fieldB}', 10);
    COMMIT;`);

  const notices = () => localSql(`SELECT concat_ws(':', user_id, notification_type, created_by)
    FROM public.notifications WHERE related_entity_id = '${job}' ORDER BY user_id, notification_type;`).split(/\r?\n/);
  const browserSends: string[] = [];
  const modes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/rest\/v1\/(notifications|rpc\/(un)?dispatch_job_locations)$/.test(path)) {
      browserSends.push(path);
    }
    if (request.method() === 'POST' && path.endsWith('/rpc/dispatch_location_with_notices')) {
      modes.push(request.postDataJSON().p_mode);
    }
  });

  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto('/dispatch');
  await page.getByRole('dialog', { name: /what's new/i }).getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('button', { name: 'Dispatch Jobs', exact: true }).click();
  await page.getByRole('button', { name: /start dispatch/i }).click();
  await page.getByRole('checkbox', { name: new RegExp(fieldName) }).check();
  await page.getByRole('checkbox', { name: new RegExp(`Invented South ${tag}`) }).check();
  await page.getByRole('button', { name: 'Next: Assign' }).click();
  await page.getByRole('dialog', { name: 'Dispatch Jobs wizard' }).getByRole('combobox').first()
    .selectOption(`applicator:${first}`);
  await page.getByRole('button', { name: 'Apply to all' }).click();
  await page.getByRole('button', { name: 'Next: Finish' }).click();
  await page.getByRole('button', { name: 'Finish Dispatching' }).click();
  await expect(page.getByText('Dispatched 2 locations', { exact: true })).toBeVisible();
  expect(notices()).toEqual([`${first}:job_dispatched:${sender}`]);

  await page.reload();
  await page.getByRole('button', { name: 'View Dispatched List', exact: true }).click();
  const card = page.locator('div.rounded-xl.bg-slate-900.p-4')
    .filter({ has: page.getByText(fieldName, { exact: true }) });
  await expect(card.getByText(firstName, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Reassign', exact: true }).click();
  await card.getByRole('combobox').selectOption(`applicator:${second}`);
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText(secondName, { exact: true })).toBeVisible();
  expect(notices().sort()).toEqual([
    `${first}:job_dispatched:${sender}`, `${first}:job_undispatched:${sender}`, `${second}:job_dispatched:${sender}`,
  ].sort());

  await card.getByRole('button', { name: 'Undispatch', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Undispatch this location?' }).getByRole('button', { name: 'Undispatch' }).click();
  await expect(card).toHaveCount(0);
  expect(notices().sort()).toEqual([
    `${first}:job_dispatched:${sender}`, `${first}:job_undispatched:${sender}`,
    `${second}:job_dispatched:${sender}`, `${second}:job_undispatched:${sender}`,
  ].sort());
  expect(browserSends).toEqual([]);
  expect(modes).toEqual(['wizard', 'reassign', 'remove']);
});
