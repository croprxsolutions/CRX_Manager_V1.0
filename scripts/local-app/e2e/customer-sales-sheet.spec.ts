import { expect, test, type Download, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Proof: the downloaded files carry the assigned customer's price, one column, and no tier. Invented data only.
const run = Date.now();
const productName = `Sheet Proof ${run}`;
const assignedFarm = `Assigned Farm ${run}`;
const otherFarm = `Other Farm ${run}`;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addProductAndCustomers(page: Page): Promise<string> {
  return page.evaluate(async ({ name, farms }) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { error: customerError } = await supabase.from('customers').insert(farms);
    if (customerError) throw new Error(customerError.message);
    const { data, error } = await supabase
      .from('products')
      .insert({ product_name: name, product_form: 'liquid', is_active: true })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }, {
    name: productName,
    farms: [{ farm_name: assignedFarm, assigned_tier: 2 }, { farm_name: otherFarm, assigned_tier: 3 }],
  });
}

async function priceProduct(page: Page, id: string) {
  await page.goto(`/products/${id}`);
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('margin_driven');
  await page.locator('#product-current-cost').fill('80');
  for (const [box, percent] of [['#tier1-net-margin', '20'], ['#tier2-net-margin', '22.5'], ['#tier3-net-margin', '25']]) {
    await page.locator(box).pressSequentially(percent, { delay: 40 });
  }
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.getByLabel('Source (supplier, document, date)').fill('Invented price list');
  await page.getByLabel('Reason for the change').fill('Proof of the customer sales sheet');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await page.getByRole('region', { name: 'Warnings to acknowledge' }).locator('textarea').fill('Invented first price');
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByRole('button', { name: 'Apply approved changes' })).toHaveCount(0);
}

// The dialog moves focus just after it opens, which clears text typed in that same moment.
async function pickCustomer(page: Page, name: string) {
  const option = page.getByRole('option', { name: new RegExp(name) });
  await expect(async () => {
    await page.getByRole('combobox', { name: 'Customer' }).fill(name);
    await expect(option).toBeVisible({ timeout: 1000 });
  }).toPass();
  await option.click();
}

async function downloadSheet(page: Page, format: 'PDF' | 'CSV', farm: string): Promise<Download> {
  await page.getByRole('button', { name: /^Download/ }).first().click();
  await page.getByRole('button', { name: 'Customer Sales Sheet' }).nth(format === 'PDF' ? 0 : 1).click();
  await pickCustomer(page, farm);
  const started = page.waitForEvent('download');
  await page.getByRole('button', { name: `Download ${format}` }).click();
  return started;
}

async function fileText(file: Download) {
  return readFileSync(await file.path());
}

async function pdfText(file: Download) {
  const pdf = await getDocument({ data: new Uint8Array(await fileText(file)) }).promise;
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
  }));
  return pages.join(' ');
}

test('the sales sheet shows the assigned customer one price and no tier, on desktop and at phone size', async ({ page }) => {
  await signIn(page);
  const id = await addProductAndCustomers(page);
  await priceProduct(page, id);
  await page.goto('/products');
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(productName);
  await expect(page.getByText(productName).filter({ visible: true }).first()).toBeVisible();

  const tierTwoFile = await downloadSheet(page, 'CSV', assignedFarm);
  expect(tierTwoFile.suggestedFilename()).toContain(`sales-sheet-assigned-farm-${run}`);
  const csv = (await fileText(tierTwoFile)).toString('utf8');
  expect(csv).toContain('103.23');
  expect(csv).not.toMatch(/100\.00|106\.67|tier/i);

  const pdfFile = await downloadSheet(page, 'PDF', assignedFarm);
  expect(pdfFile.suggestedFilename()).toContain(`sales_sheet_assigned_farm_${run}`);
  const pdf = await pdfText(pdfFile);
  expect(pdf).toContain(`Prepared for ${assignedFarm}`);
  expect(pdf).toContain('103.23');
  expect(pdf).not.toMatch(/100\.00|106\.67|tier/i);

  // Another customer's level changes the price on the same product.
  const tierThree = (await fileText(await downloadSheet(page, 'CSV', otherFarm))).toString('utf8');
  expect(tierThree).toContain('106.67');
  expect(tierThree).not.toMatch(/100\.00|103\.23|tier/i);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.getByRole('button', { name: /^Download/ }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: 'Customer Sales Sheet' }).first().click();
  await pickCustomer(page, assignedFarm);
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeInViewport();
  await page.screenshot({ path: 'scripts/local-app/.state/customer-sheet-phone.png' });
});
