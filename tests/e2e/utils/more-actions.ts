import type { Locator, Page } from '@playwright/test';

/**
 * Billing UI (Nov 13): the sale (order) and invoice pages keep their secondary actions under a "More actions"
 * menu (Write off…, Void invoice…, Unpost…, Apply credit…, Create task, Record payment on the sale, Cancel/Void
 * order…). This opens that menu and returns the named item. When the item is not offered the menu is closed
 * again, so the returned locator is simply not visible and callers can keep their existing "if visible" checks.
 */
export async function moreAction(page: Page, name: string | RegExp): Promise<Locator> {
  const item = page.getByRole('menuitem', { name }).first();
  const more = page.getByRole('button', { name: 'More actions' }).first();
  if (!(await more.isVisible({ timeout: 5000 }).catch(() => false))) return item;
  await more.click();
  if (!(await item.isVisible({ timeout: 2000 }).catch(() => false))) await page.keyboard.press('Escape');
  return item;
}

