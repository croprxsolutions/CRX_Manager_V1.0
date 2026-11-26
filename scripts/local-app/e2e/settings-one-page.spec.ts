import { expect, test, type Page } from '@playwright/test';

// Local proof for the Settings phone controls: every section saves and survives a reload. Invented values only.
const shot = (page: Page, name: string, fullPage = true) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage });

async function signIn(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /What's new/i }) }),
    async (dialog) => { await dialog.getByRole('button', { name: 'Close' }).click(); },
  );
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function save(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true }).first();
  await expect(button).toBeEnabled();
  await button.click();
  // One section is changed at a time; its Unsaved chip goes only once the write has finished.
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0, { timeout: 15000 });
  await expect(button).toBeDisabled();
}

test('desktop: each Settings section saves and keeps its value after a reload', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await shot(page, '01-desktop-before');
  // Fresh values each run so every Save has a change to write.
  // The last run stored n in the reminder box, so this n always differs from it.
  const n = ((Number(await page.locator('#ar-reminder-days').inputValue()) + 1) % 50) + 10;
  const draftWasOn = await page.locator('#auto-draft-enabled').isChecked();
  const wasBlock = await page.getByRole('radio', { name: /Block/ }).isChecked();
  const mode = wasBlock ? /Warn/ : /Block/;

  const salesTax = page.locator('#sales-tax-rate');
  const hasSalesTax = await salesTax.count() > 0;
  if (hasSalesTax) { await salesTax.fill(`7.${n}`); await save(page, 'Save sales tax'); }

  await page.locator('#auto-draft-enabled').setChecked(!draftWasOn);
  await save(page, 'Save invoice drafts');

  await page.locator('#fuel-enabled').check();
  await page.locator('#fuel-basis').selectOption('per_acre');
  await page.getByLabel(/^Rate/).fill(`1.${n}`);
  await save(page, 'Save fuel surcharge');

  await page.locator('#ar-reminder-days').fill(String(n));
  await page.locator('#default-valid-days').fill(String(n + 1));
  await page.locator('#default-tier').selectOption('2');
  await save(page, 'Save defaults');

  await page.getByRole('radio', { name: mode }).check();
  await save(page, 'Save guardrail');

  await page.locator('#sheet-company-name').fill(`Invented Farm Supply ${n}`);
  await save(page, 'Save field sheet');

  await page.locator('#pre-notice-subject').fill(`Invented pre-notice subject ${n}`);
  await save(page, 'Save notices');

  await page.locator('#company-name').fill(`Invented Co ${n}`);
  await page.locator('#company-phone').fill('555-0100');
  await page.getByLabel('Company email').fill('office@invented.test');
  await page.locator('#company-address').fill('1 Test Road, Nowhere');
  await save(page, 'Save company details');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  if (hasSalesTax) await expect(salesTax).toHaveValue(`7.${n}`);
  await expect(page.locator('#auto-draft-enabled')).toBeChecked({ checked: !draftWasOn });
  await expect(page.locator('#fuel-enabled')).toBeChecked();
  await expect(page.locator('#fuel-basis')).toHaveValue('per_acre');
  await expect(page.getByLabel(/^Rate/)).toHaveValue(`1.${n}`);
  await expect(page.locator('#ar-reminder-days')).toHaveValue(String(n));
  await expect(page.locator('#default-valid-days')).toHaveValue(String(n + 1));
  await expect(page.locator('#default-tier')).toHaveValue('2');
  await expect(page.getByRole('radio', { name: mode })).toBeChecked();
  await expect(page.locator('#sheet-company-name')).toHaveValue(`Invented Farm Supply ${n}`);
  await expect(page.locator('#pre-notice-subject')).toHaveValue(`Invented pre-notice subject ${n}`);
  await expect(page.locator('#company-name')).toHaveValue(`Invented Co ${n}`);
  await expect(page.locator('#company-phone')).toHaveValue('555-0100');
  await expect(page.getByLabel('Company email')).toHaveValue('office@invented.test');
  await expect(page.locator('#company-address')).toHaveValue('1 Test Road, Nowhere');
  // Nothing changed since the reload: every Save is off and there is no pinned phone Save.
  for (const name of ['Save invoice drafts', 'Save fuel surcharge', 'Save defaults', 'Save guardrail', 'Save field sheet', 'Save notices', 'Save company details']) {
    await expect(page.getByRole('button', { name, exact: true }).first()).toBeDisabled();
  }
  await expect(page.locator('[data-pinned-action]')).toHaveCount(0);
  await shot(page, '02-desktop-after-reload');
});

test('phone: dark header, 48px steppers and the pinned Save', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
  await shot(page, '03-phone-top', false);
  await shot(page, '04-phone-full');

  const reminder = page.locator('#ar-reminder-days');
  await reminder.scrollIntoViewIfNeeded();
  const before = Number(await reminder.inputValue());
  const plus = page.getByRole('button', { name: 'More reminder days' });
  await expect(plus).toBeVisible();
  const box = await plus.boundingBox();
  expect(Math.round(box!.height)).toBe(48);
  await plus.click();
  await expect(reminder).toHaveValue(String(before + 1));

  const pinned = page.locator('[data-pinned-action] button');
  await expect(pinned).toBeVisible();
  await expect(pinned).toHaveText(/Save defaults/);
  expect(Math.round((await pinned.boundingBox())!.height)).toBe(56);
  await shot(page, '05-phone-pinned-save', false);
  await pinned.click();
  await expect(page.locator('[data-pinned-action]')).toHaveCount(0, { timeout: 15000 });

  await page.reload();
  await expect(page.locator('#ar-reminder-days')).toHaveValue(String(before + 1));
  await page.locator('#ar-reminder-days').scrollIntoViewIfNeeded();
  await shot(page, '06-phone-after-reload', false);

  // Desktop keeps no phone-only controls.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('button', { name: 'More reminder days' })).toBeHidden();
});
