import type { Page } from '@playwright/test';
import { parseDollars } from './math-helpers';

/**
 * Invoice page (Billing UI, Nov 13). "What this invoice bills" lists product rows, then Charges, then the
 * "Worked out for you" discount and tax rows; each row's amount is tagged data-testid="invoice-line-amount"
 * with data-kind product | charge | worked. An editable charge shows its unit price in a box and carries the
 * line total on data-cents. Amount due shows "Products", the charges, the discount, the tax and "Invoice total".
 */
export interface InvoiceLineAmounts {
  products: number[];
  charges: number[];
  worked: number[];
  /** Every line on the invoice, in cents. */
  totalCents: number;
}

export async function invoiceLineAmounts(page: Page): Promise<InvoiceLineAmounts> {
  const cells = page.locator('section[aria-labelledby="invoice-lines-title"] [data-testid="invoice-line-amount"]');
  const out: InvoiceLineAmounts = { products: [], charges: [], worked: [], totalCents: 0 };
  const count = await cells.count();
  for (let i = 0; i < count; i++) {
    const cell = cells.nth(i);
    const kind = await cell.getAttribute('data-kind');
    const dataCents = await cell.getAttribute('data-cents');
    const cents = dataCents != null ? Number(dataCents) : parseDollars(await cell.textContent());
    if (kind === 'product') out.products.push(cents);
    else if (kind === 'charge') out.charges.push(cents);
    else if (kind === 'worked') out.worked.push(cents);
    out.totalCents += cents;
  }
  return out;
}

/** A row of the Amount due card by its exact label ("Products", "Invoice total", "Balance due"...), in cents; null when absent. */
export async function amountDueCents(page: Page, label: string): Promise<number | null> {
  const row = page.locator('section[aria-labelledby="invoice-amount-due"]').getByText(label, { exact: true }).first();
  if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) return null;
  return parseDollars(await row.locator('..').locator('.tabular-nums').first().textContent());
}

/** The closing "Invoice total" of the lines card, in cents; null when absent. */
export async function linesCardTotalCents(page: Page): Promise<number | null> {
  const row = page.locator('section[aria-labelledby="invoice-lines-title"]').getByText('Invoice total', { exact: true }).first();
  if (!(await row.isVisible({ timeout: 2000 }).catch(() => false))) return null;
  return parseDollars(await row.locator('..').locator('.tabular-nums').first().textContent());
}
