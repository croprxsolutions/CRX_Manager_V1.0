import { expect, test, type Download, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// WP-PM-4 proof: read the downloaded files themselves. Invented data only.
const run = Date.now();
const category = `Proof ${run}`;
const activeName = `=Active, "Quoted" ${run}`;
const inactiveName = `Inactive Proof ${run}`;
const epa = `98${String(run).slice(-3)}-7${String(run).slice(-2, -1).replace('0', '1')}1`;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addProducts(page: Page) {
  await page.evaluate(async (rows) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { error } = await supabase.from('products').insert(rows);
    if (error) throw new Error(error.message);
  }, [
    { product_name: activeName, product_form: 'liquid', category, manufacturer: `Maker ${run}`, epa_registration: epa, is_rup: true, signal_word: 'Caution', is_active: true },
    { product_name: inactiveName, product_form: 'liquid', category, manufacturer: null, epa_registration: null, is_rup: false, signal_word: null, is_active: false },
  ]);
}

async function chooseFilters(page: Page, status: string) {
  await page.getByLabel('Filter by category').filter({ visible: true }).selectOption(category);
  await page.getByLabel('Filter by status').filter({ visible: true }).selectOption(status);
}

async function download(page: Page, section: 'PDF' | 'CSV', item: string): Promise<Download> {
  await page.getByRole('button', { name: /^Download/ }).first().click();
  const started = page.waitForEvent('download');
  // The menu lists PDF then CSV, with the same names in each.
  await page.getByRole('button', { name: item }).nth(section === 'PDF' ? 0 : 1).click();
  return started;
}

const fileText = async (file: Download) => readFileSync(await file.path());

async function pdfText(file: Download) {
  const pdf = await getDocument({ data: new Uint8Array(await fileText(file)) }).promise;
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
  }));
  return pages.join(' ');
}

test('the sales sheet leaves out inactive products and internal fields, whatever the filter', async ({ page }) => {
  await signIn(page);
  await addProducts(page);
  await page.goto('/products');

  await page.getByLabel('Filter by category').filter({ visible: true }).selectOption(category);
  await expect(page.getByRole('cell', { name: inactiveName })).toHaveCount(0);
  await page.getByLabel('Filter by status').filter({ visible: true }).selectOption('inactive');
  await expect(page.getByText(inactiveName).filter({ visible: true }).first()).toBeVisible();
  await page.getByLabel('Filter by status').filter({ visible: true }).selectOption('all');
  await expect(page.getByText(inactiveName).filter({ visible: true }).first()).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm4-list.png' });

  await chooseFilters(page, 'all');
  const csv = (await fileText(await download(page, 'CSV', 'Sales Sheet (prices only)'))).toString('utf8');
  const lines = csv.trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(csv).not.toContain(inactiveName);
  // Spreadsheet safety: the leading = is neutralised and the comma and quotes stay inside one cell.
  expect(lines[1]).toContain(`"'=Active, ""Quoted"" ${run}"`);
  expect(lines[0]).not.toMatch(/cost|margin|status|epa|signal|notes/i);

  const pdf = await pdfText(await download(page, 'PDF', 'Sales Sheet (prices only)'));
  expect(pdf).toContain('Product Sales Sheet');
  expect(pdf).toContain('1 active product(s)');
  expect(pdf).toContain(String(run));
  expect(pdf).not.toContain(inactiveName);
  expect(pdf).not.toMatch(/Cost|Margin|Internal|EPA/);

  const internal = (await fileText(await download(page, 'CSV', 'Internal (cost + margin)'))).toString('utf8');
  const internalLines = internal.trim().split('\n');
  expect(internalLines).toHaveLength(3);
  for (const header of ['Manufacturer', 'EPA Reg #', 'RUP', 'Signal Word', 'REI Hours', 'PHI Days', 'Form', 'Inventory Unit', 'Container Unit', 'Cost', 'Status']) {
    expect(internalLines[0]).toContain(`"${header}"`);
  }
  expect(internal).toContain(inactiveName);
  expect(internal).toContain(epa);
});

test('search finds a product by EPA number, and Details adds the compliance columns', async ({ page }) => {
  await signIn(page);
  await addProducts(page);
  await page.goto('/products');
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(epa);
  await expect(page.getByText(`Quoted" ${run}`).filter({ visible: true }).first()).toBeVisible();
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(`Maker ${run}`);
  await expect(page.getByText(`Quoted" ${run}`).filter({ visible: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Signal Word' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'RUP' })).toBeVisible();
  await page.screenshot({ path: 'scripts/local-app/.state/pm4-details.png' });
});
