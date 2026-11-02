import { expect, test, type Page } from '@playwright/test';

// Proof: product editing works at phone size, and a phone's quick price change goes through the
// same review as the product page. Emulated phone size in Chromium, not a real iPhone. Invented data only.
const run = Date.now();
const phone = { width: 375, height: 812 };
const shot = (name: string) => `scripts/local-app/.state/${name}.png`;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function addProduct(page: Page, name: string): Promise<string> {
  return page.evaluate(async (productName) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase
      .from('products')
      .insert({ product_name: productName, product_form: 'liquid', is_active: true })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }, name);
}

async function savedPrices(page: Page, id: string) {
  return page.evaluate(async (productId) => {
    const path = '/src/lib/db.ts';
    const { supabase } = await import(/* @vite-ignore */ path);
    const { data, error } = await supabase
      .from('products')
      .select('tier1_price, tier2_price, tier3_price, pricing_version')
      .eq('id', productId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }, id);
}

async function answerSourceAndReason(page: Page) {
  const source = page.getByLabel('Source (supplier, document, date)');
  await expect(async () => {
    await source.fill('Invented price list');
    await page.getByLabel('Reason for the change').fill('Proof of phone product editing');
    await expect(source).toHaveValue('Invented price list', { timeout: 1000 });
  }).toPass();
  await page.getByRole('button', { name: 'Preview changes' }).click();
}

// Prices only go in through the review, so the product is priced the way a person would price it.
async function priceProduct(page: Page, id: string) {
  await page.goto(`/products/${id}`);
  await page.getByLabel('Pricing mode', { exact: true }).selectOption('margin_driven');
  await page.locator('#product-current-cost').fill('80');
  for (const [box, percent] of [['#tier1-net-margin', '20'], ['#tier2-net-margin', '22.5'], ['#tier3-net-margin', '25']]) {
    await page.locator(box).pressSequentially(percent, { delay: 40 });
  }
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await answerSourceAndReason(page);
  await page.getByRole('region', { name: 'Warnings to acknowledge' }).locator('textarea').fill('Invented first price');
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByRole('button', { name: 'Apply approved changes' })).toHaveCount(0);
}

const sectionToggle = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function openEverySection(page: Page) {
  for (const name of ['Product Information', 'Brands', 'Margin Floor', 'Stock & Reorder', 'Cost Basis', 'Price & Cost History']) {
    const toggle = sectionToggle(page, name);
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  }
}

// Every control the page shows, with the box a finger actually hits. A checkbox's target is its label.
async function visibleControls(page: Page) {
  return page.evaluate(() => {
    const selector = 'input:not([type=hidden]), select, textarea, button, a[href], [role=button]';
    return [...document.querySelectorAll<HTMLElement>(`#main-content :is(${selector})`)]
      .filter((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0)
      .map((element) => {
        const target = element.matches('[type=checkbox], [type=radio]') ? element.closest('label') ?? element : element;
        const box = target.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.id ?? element.tagName,
          tag: element.tagName,
          type: element.getAttribute('type'),
          height: Math.round(box.height * 10) / 10,
          fontSize: parseFloat(getComputedStyle(element).fontSize),
        };
      });
  });
}

async function expectTouchFriendly(page: Page, where: string) {
  const controls = await visibleControls(page);
  const small = controls.filter((control) => control.height < 44);
  const smallText = controls.filter((control) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tag)
    && control.type !== 'checkbox' && control.type !== 'radio' && control.fontSize < 16);
  console.warn(`${where}: ${controls.length} controls, ${small.length} under 44px, ${smallText.length} fields under 16px`);
  expect(small).toEqual([]);
  expect(smallText).toEqual([]);
}

async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test('the product page is usable at phone size and unchanged on desktop', async ({ page }) => {
  await signIn(page);
  const name = `Phone Page Proof ${run} (invented)`;
  const id = await addProduct(page, name);
  await priceProduct(page, id);

  await page.setViewportSize(phone);
  await page.goto(`/products/${id}`);
  await expect(page.locator('#product-pricing-mode')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Pricing is open first and starts inside the first screen.
  const pricingTop = (await sectionToggle(page, 'Pricing & Margins').boundingBox())!.y;
  console.warn(`Page height folded: ${await page.evaluate(() => document.documentElement.scrollHeight)}px; Pricing starts at ${pricingTop}px`);
  expect(pricingTop).toBeLessThan(phone.height);
  await expect(page.getByLabel('SKU')).toBeHidden();
  await page.screenshot({ path: shot('phone-product-top') });
  await expectTouchFriendly(page, 'Phone, folded');

  // Folding keeps what was typed.
  await sectionToggle(page, 'Product Information').click();
  await page.getByLabel('SKU').fill('FOLDED-KEEPS-THIS');
  await sectionToggle(page, 'Product Information').click();
  await expect(page.getByLabel('SKU')).toBeHidden();
  await sectionToggle(page, 'Product Information').click();
  await expect(page.getByLabel('SKU')).toHaveValue('FOLDED-KEEPS-THIS');
  await page.getByLabel('SKU').fill('');

  await openEverySection(page);
  await expect(page.getByText('Margin Floor', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expectNoSidewaysScroll(page);
  await expectTouchFriendly(page, 'Phone, every section open');
  await page.screenshot({ path: shot('phone-product-open-full'), fullPage: true });

  // Save stays on screen in the middle of the page.
  const saveChanges = page.getByRole('button', { name: 'Save Changes' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await expect(saveChanges).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: shot('phone-product-middle') });

  // ...and does not cover the last thing on the page.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const saveBarTop = (await page.getByTestId('product-save-bar').boundingBox())!.y;
  const lastCardBottom = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#main-content .shadow-card')].filter((card) => card.checkVisibility());
    return Math.max(...cards.map((card) => card.getBoundingClientRect().bottom));
  });
  expect(lastCardBottom).toBeLessThanOrEqual(saveBarTop);
  await page.screenshot({ path: shot('phone-product-bottom') });

  // A refused save opens the closed section that holds the problem.
  await page.goto(`/products/${id}`);
  await expect(page.getByLabel('SKU')).toBeHidden();
  await sectionToggle(page, 'Product Information').click();
  await page.getByLabel(/product name/i).fill('');
  await sectionToggle(page, 'Product Information').click();
  await expect(page.getByLabel(/product name/i)).toBeHidden();
  await saveChanges.click();
  await expect(page.getByText('Product name is required')).toBeVisible();
  await expect(page.getByLabel(/product name/i)).toBeInViewport();
  await page.screenshot({ path: shot('phone-product-refused') });

  // A tablet gets the desktop form, and it fits.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/products/${id}`);
  await page.getByRole('button', { name: 'Leave' }).click({ timeout: 2000 }).catch(() => undefined);
  await expect(page.getByLabel('SKU')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: shot('tablet-product'), fullPage: true });

  // Desktop: every section shows, no toggles, and Save sits in the page as before.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/products/${id}`);
  await expect(page.getByLabel('SKU')).toBeVisible();
  await expect(page.locator('#tier1-price')).toBeVisible();
  for (const title of ['Stock', 'Margin', 'Supplier Price', 'Sell Price']) {
    await expect(page.getByRole('heading', { name: new RegExp(`^${title}`) }).first()).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Product Information', exact: true })).toBeHidden();
  const saveBar = page.getByTestId('product-save-bar');
  expect(await saveBar.evaluate((bar) => getComputedStyle(bar).position)).toBe('static');
  expect(await page.locator('#tier1-price').evaluate((box) => getComputedStyle(box).fontSize)).toBe('14px');
  await page.screenshot({ path: shot('desktop-product'), fullPage: true });
});

test('a quick price change from the phone list goes through review and saves the tier price', async ({ page }) => {
  await signIn(page);
  const name = `Phone Quick Price ${run} (invented)`;
  const id = await addProduct(page, name);
  await priceProduct(page, id);
  const before = await savedPrices(page, id);

  await page.setViewportSize(phone);
  await page.goto('/products');
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(name);
  await expect(page.getByRole('button', { name: `Change price of ${name}` })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: shot('phone-list') });
  await expectTouchFriendly(page, 'Phone list');

  await page.getByRole('button', { name: `Change price of ${name}` }).click();
  const tierTwo = page.getByLabel('Tier 2 price');
  await expect(tierTwo).toHaveValue('103.23');

  // An inexact amount is refused, and nothing moves on.
  await expect(async () => {
    await tierTwo.fill('1.999');
    await expect(tierTwo).toHaveValue('1.999', { timeout: 1000 });
  }).toPass();
  await page.getByRole('button', { name: 'Review Price Change' }).click();
  await expect(page.getByText('Enter an amount with no more than two decimal places.')).toBeVisible();
  await expect(page.getByLabel('Source (supplier, document, date)')).toHaveCount(0);

  await tierTwo.fill('110.25');
  await expectTouchFriendly(page, 'Quick price modal');
  await page.screenshot({ path: shot('phone-quick-price') });
  await page.getByRole('button', { name: 'Review Price Change' }).click();

  await answerSourceAndReason(page);
  const apply = page.getByRole('button', { name: 'Apply approved changes' });
  await expect(apply).toBeVisible();
  await expect(page.getByText('$103.23').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('$110.25').filter({ visible: true }).first()).toBeVisible();
  // Nothing is saved until the review is applied.
  expect(await savedPrices(page, id)).toEqual(before);
  const warnings = page.getByRole('region', { name: 'Warnings to acknowledge' });
  if (await warnings.count()) await warnings.locator('textarea').first().fill('Invented reason');
  await page.screenshot({ path: shot('phone-quick-review') });
  await apply.click();
  await expect(apply).toHaveCount(0);

  await page.reload();
  await page.getByPlaceholder('Search products...').filter({ visible: true }).fill(name);
  await expect(page.getByRole('button', { name: new RegExp(`^${name.slice(0, 20)}`) })).toContainText('$110.25');
  await page.screenshot({ path: shot('phone-list-after') });
  const after = await savedPrices(page, id);
  expect(Number(after.tier2_price)).toBe(110.25);
  expect(after.pricing_version).toBeGreaterThan(before.pricing_version);
  expect([after.tier1_price, after.tier3_price]).toEqual([before.tier1_price, before.tier3_price]);
});
