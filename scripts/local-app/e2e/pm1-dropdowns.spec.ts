import { expect, test, type Locator, type Page } from '@playwright/test';

// WP-PM-1 proof: the shared dropdown, on the two pages that use it. Invented data only.
const run = Date.now();
const categories = ['Adjuvant', 'Fungicide', 'Growth Regulator', 'Herbicide', 'Insecticide', 'Micronutrient', 'Nitrogen', 'Soil Fertility'];
const vendors = [`Vendor A ${run}`, `Vendor B ${run}`];
const makers = [`Maker A ${run}`, `Maker B ${run}`];
let batch = 0;
const timings = ['Post-Emergence', 'Pre-Emerge Corn', 'Pre-Emerge Soybean', 'Volunteer Corn', 'Range/Pasture/Turf'];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

// The app's own signed-in client, so the rows go through the same permissions as a user.
async function addProducts(page: Page) {
  batch += 1;
  const rows = categories.map((category, i) => ({
    product_name: `Dropdown ${category} ${run} ${batch}`,
    product_form: 'liquid',
    category,
    vendor: vendors[i % 2],
    manufacturer: makers[i % 2],
    use_timing: category === 'Herbicide' ? 'Pre-Emerge Corn' : null,
  }));
  const id: string = await page.evaluate(async (products) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase.from('products').insert(products).select('id, category');
    if (error) throw new Error(error.message);
    return data.find((row: { category: string }) => row.category === 'Herbicide').id;
  }, rows);
  return id;
}

const box = (page: Page, label: string) => page.getByRole('combobox', { name: label, exact: true });
const optionTexts = (page: Page) => page.getByRole('listbox').getByRole('option').allInnerTexts();

async function expectFullList(page: Page, input: Locator, saved: string, expected: string[]) {
  await input.click();
  await expect.poll(async () => (await optionTexts(page)).map((text) => text.trim()))
    .toEqual(expect.arrayContaining(expected));
  await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toHaveText(saved);
}

test('product page dropdowns show the full list, mark the saved choice, and save', async ({ page }) => {
  await signIn(page);
  const id = await addProducts(page);
  await page.goto(`/products/${id}`);
  await expect(page.getByLabel(/product name/i)).toHaveValue(`Dropdown Herbicide ${run} ${batch}`);

  const category = box(page, 'Category');
  await expectFullList(page, category, 'Herbicide', categories);
  await page.keyboard.press('Tab');
  // Focus moves to the next box, which opens by itself, so this one is what must have closed.
  await expect(category).toHaveAttribute('aria-expanded', 'false');

  await expectFullList(page, box(page, 'Vendor'), vendors[1], vendors);
  await page.keyboard.press('Tab');
  await expectFullList(page, box(page, 'Manufacturer'), makers[1], makers);
  await page.keyboard.press('Tab');

  // Every Use Timing option can be clicked, and a second click after a pick reopens the whole list.
  const timing = box(page, 'Use Timing');
  await expectFullList(page, timing, 'Pre-Emerge Corn', timings);
  await page.keyboard.press('Tab');
  for (const option of timings) {
    await timing.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(timings.length);
    await page.getByRole('listbox').getByRole('option', { name: option }).click();
    await expect(timing).toHaveValue(option);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await timing.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(timings.length);
    await page.keyboard.press('Escape');
    await expect(timing).toHaveValue(option);
  }

  // Typing narrows, Escape cancels the typing, and typed text stays free text.
  const maker = box(page, 'Manufacturer');
  await maker.click();
  await maker.fill(makers[0]);
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(maker).toHaveValue(makers[1]);
  await maker.fill(`Typed Maker ${run}`);
  await page.keyboard.press('Tab');
  await expect(maker).toHaveValue(`Typed Maker ${run}`);

  // Keyboard: down to the last option, then Enter.
  await category.click();
  await page.keyboard.press('ArrowUp');
  const last = await page.getByRole('listbox').getByRole('option').last().innerText();
  for (let i = 0; i < 40 && (await category.getAttribute('aria-activedescendant')) !== await page.getByRole('listbox').getByRole('option').last().getAttribute('id'); i += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.getByRole('listbox').getByRole('option').last()).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(category).toHaveValue(last.trim());
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await page.screenshot({ path: 'scripts/local-app/.state/pm1-product-page.png' });
});

test('the list scrolls by wheel and hovering does not move it', async ({ page }) => {
  await signIn(page);
  const id = await addProducts(page);
  await page.goto(`/products/${id}`);
  const category = box(page, 'Category');
  await category.click();
  const list = page.getByRole('listbox');
  const scrollTop = () => list.evaluate((el) => el.scrollTop);
  await list.evaluate((el) => { el.scrollTop = 0; });

  await page.getByRole('listbox').getByRole('option').nth(1).hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  const afterWheel = await scrollTop();

  await page.mouse.move(0, 0);
  const point = await list.evaluate((el) => {
    const listRect = el.getBoundingClientRect();
    const option = Array.from(el.querySelectorAll('[role="option"]')).find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.top >= listRect.top && rect.bottom <= listRect.bottom;
    });
    if (!option) throw new Error('No fully visible option to hover');
    const rect = option.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.move(point.x, point.y);
  expect(await scrollTop()).toBe(afterWheel);
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const last = (await page.getByRole('listbox').getByRole('option').last().innerText()).trim();
  await page.getByRole('listbox').getByRole('option').last().click();
  await expect(category).toHaveValue(last);
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('a save after a pick survives a reload', async ({ page }) => {
  await signIn(page);
  const id = await addProducts(page);
  await page.goto(`/products/${id}`);
  const timing = box(page, 'Use Timing');
  await timing.click();
  await page.getByRole('listbox').getByRole('option', { name: 'Volunteer Corn' }).click();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText(/product (saved|updated)/i).first()).toBeVisible();
  await page.reload();
  await expect(box(page, 'Use Timing')).toHaveValue('Volunteer Corn');
});

test('Escape in a dropdown inside a pop-up closes only the list', async ({ page }) => {
  await signIn(page);
  await addProducts(page);
  await page.goto('/brand-vs-generic');
  await page.getByRole('button', { name: /^Add/ }).first().click();
  const branded = page.getByLabel(/branded product/i);
  await branded.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(branded).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(branded).toHaveCount(0);
});
