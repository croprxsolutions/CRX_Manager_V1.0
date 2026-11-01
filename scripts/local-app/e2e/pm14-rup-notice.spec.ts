import { expect, test } from '@playwright/test';

// WP-PM-14 proof: both RUP screens carry the notice. Invented data only.
test('the RUP Products and RUP Sales Register tabs say the list is known incomplete', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.goto('/compliance');
  await page.getByRole('button', { name: /RUP Products/ }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Known incomplete.' })).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm14-rup-products.png' });

  await page.getByRole('button', { name: /RUP Sales Register/ }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Known incomplete.' })).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm14-rup-register.png' });
});
