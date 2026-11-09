import { test, expect, type Page } from '@playwright/test';
import { login } from './utils/auth';
import { E2E_PREFIX, runId } from './fixtures/e2e-constants';

/**
 * Width guard for the Quotes list: the page never scrolls sideways at the eight
 * widths the UI redesign supports, and a 60-character customer name stays on
 * screen in the 360 px card. Synthetic data only; the customer carries the
 * E2E prefix so globalTeardown removes it with its quote.
 */
export const UI_WIDTHS = [360, 390, 768, 1024, 1280, 1366, 1440, 1920];
const HEIGHT = 900;

export async function expectNoSideScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBeLessThanOrEqual(clientWidth);
}

async function openQuotes(page: Page) {
  await page.goto('/quotes');
  await expect(page.getByRole('heading', { name: /quotes/i }).first()).toBeVisible({ timeout: 15000 });
  await page.locator('.animate-pulse').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

test.describe('Quotes list width guard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const width of UI_WIDTHS) {
    test(`no sideways scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await openQuotes(page);
      await expectNoSideScroll(page);
      await page.screenshot({ path: `test-results/ui-widths/quotes-${width}.png`, fullPage: true });
    });
  }

  test('60-character customer name stays on screen in the 360px card', async ({ page }) => {
    test.setTimeout(120000);
    const name = `${E2E_PREFIX} Width ${runId()} Extraordinarily Long Farm Name Partnership`.slice(0, 60);
    expect(name).toHaveLength(60);

    // Seed through the app: a customer, then a draft quote with one product.
    await page.setViewportSize({ width: 1280, height: HEIGHT });
    await page.goto('/customers/new');
    await page.getByLabel('Farm Name').fill(name);
    await page.getByRole('button', { name: 'Create Customer' }).click();
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}/, { timeout: 15000 });

    await page.goto('/quotes/new');
    await page.getByRole('combobox', { name: 'Customer' }).fill(name.slice(0, 30));
    await page.getByRole('option', { name }).click();
    await page.getByRole('button', { name: /Add Item/i }).first().click();
    await page.getByRole('button', { name: /Select Product/i }).first().click();
    await page.getByPlaceholder('Search by name, SKU, category, or vendor...').fill(E2E_PREFIX);
    // Scoped to the product picker's result list (as quote-builder-v2.spec.ts does), not any button on the page.
    await page.getByRole('dialog').locator('.max-h-80 button').filter({ hasText: E2E_PREFIX }).first().click();
    await page.getByLabel('Units needed').first().fill('1');
    await page.getByRole('button', { name: /Save Draft/i }).first().click();
    await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 30000 });

    // The card at 360 px keeps the whole name inside the viewport.
    await page.setViewportSize({ width: 360, height: HEIGHT });
    await openQuotes(page);
    const label = page.getByText(name).locator('visible=true').first();
    await expect(label).toBeVisible();
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    // The name wraps rather than truncating: all of it is shown, nothing is clipped.
    await expect(label).toHaveText(name);
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
    await expectNoSideScroll(page);
    await page.screenshot({ path: 'test-results/ui-widths/quotes-360-long-name.png', fullPage: true });
  });
});
