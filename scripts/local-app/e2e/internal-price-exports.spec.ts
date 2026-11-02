import { expect, test, type Download, type Page } from '@playwright/test';
import { copyFileSync, readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Proof: the staff exports that carry every tier say "internal", and a product with no price shows blank, not $0.00.
const run = Date.now();
const productName = `Unpriced Proof ${run}`;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addUnpricedProduct(page: Page) {
  await page.evaluate(async (name) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { error } = await supabase.from('products').insert({ product_name: name, product_form: 'liquid', is_active: true });
    if (error) throw new Error(error.message);
  }, productName);
}

// Keeps a copy of each file for the PR's proof, then returns the product's CSV row.
function keepAndReadRow(file: string, saveAs: string) {
  copyFileSync(file, `scripts/local-app/.state/${saveAs}`);
  const row = readFileSync(file, 'utf8').split(/\r?\n/).find((line) => line.includes(productName));
  expect(row).toBeTruthy();
  return row!;
}

async function pdfText(file: Download) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(await file.path())) }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
}

test('tier exports are labeled internal and leave a missing price blank', async ({ page }) => {
  await signIn(page);
  await addUnpricedProduct(page);

  await page.goto('/products');
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(productName);
  await expect(page.getByText(productName).filter({ visible: true }).first()).toBeVisible();
  // The search leaves only this product, so its box is the one checkbox shown.
  await page.getByRole('checkbox').filter({ visible: true }).first().check();

  let started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).filter({ visible: true }).click();
  const productsCsv = await started;
  expect(productsCsv.suggestedFilename()).toMatch(/^products-internal_/);
  const productsRow = keepAndReadRow(await productsCsv.path(), productsCsv.suggestedFilename());
  expect(productsRow).not.toContain('$0.00');
  expect(productsRow).toContain('"","","","Active"'); // T1, T2, T3 blank

  started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).filter({ visible: true }).click();
  const productsPdf = await started;
  copyFileSync(await productsPdf.path(), `scripts/local-app/.state/${productsPdf.suggestedFilename()}`);
  expect(await pdfText(productsPdf)).toContain('Products — Internal');

  await page.goto('/reports');
  await page.getByRole('button', { name: 'Operational', exact: true }).click();
  await page.getByRole('button', { name: 'Price List', exact: true }).click();
  await expect(page.getByText(/Active products:/)).toBeVisible();
  started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).filter({ visible: true }).click();
  const priceList = await started;
  expect(priceList.suggestedFilename()).toMatch(/^price_list_internal_/);
  const priceRow = keepAndReadRow(await priceList.path(), priceList.suggestedFilename());
  expect(priceRow).not.toContain('$0.00');
  expect(priceRow).toMatch(/"","",""$/); // Tier 1, 2, 3 blank
});
