import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:54329';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: ACTOR, aud: 'authenticated', role: 'authenticated', email: 'order-proof@example.invalid',
  email_confirmed_at: '2026-10-28T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-10-28T00:00:00Z' };
function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: ACTOR, role: 'authenticated', aud: 'authenticated', exp })}.isolated`,
    refresh_token: 'isolated', token_type: 'bearer', expires_in: 3600, expires_at: exp, user };
}
type Request = { p_order_id: string; p_expected_row_version: number; p_idempotency_key: string; p_items: { total_units_needed: number }[] };
function backend() {
  return { version: 7, quantity: 10, failRead: false, missingVersion: false, missingOrder: false, orderReadDelayMs: 0, role: 'admin', planned: false, loseReply: false, saves: [] as Request[], receipts: new Map<string, { order_id: string; row_version: number; success: boolean }>() };
}
async function isolate(page: Page, state: ReturnType<typeof backend>) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket(`${API.replace('http', 'ws')}/realtime/v1/websocket**`, (socket) => socket.onMessage(() => undefined));
  await page.route(`${API}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (body: unknown, status = 200, count = 0) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (url.pathname === '/auth/v1/token') return json(session());
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname === '/rest/v1/profiles') return json({ id: ACTOR, email: user.email, full_name: 'Order Proof Admin', role: state.role, is_active: true, denied_pages: [] });
    if (url.pathname === '/rest/v1/orders') {
      // The planned toggle is a direct update; the order's triggers advance its version.
      if (req.method() === 'PATCH') { state.planned = req.postDataJSON().is_planned; state.version += 1; return json([{ id: ORDER }]); }
      if (state.failRead) return json({ message: 'controlled failed order read' }, 500);
      if (state.orderReadDelayMs) await new Promise((resolve) => setTimeout(resolve, state.orderReadDelayMs));
      if (state.missingOrder) return json(null);
      return json({ id: ORDER, order_number: 'ORD-LOCAL-1', customer_id: CUSTOMER, status: 'confirmed', order_date: '2026-10-28',
        created_at: '2026-10-28T00:00:00Z', row_version: state.missingVersion ? null : state.version, total_price: state.quantity * 20,
        pricing_status: 'priced', commission_split: null, is_planned: state.planned, booking_draw: false, deleted_at: null });
    }
    if (url.pathname === '/rest/v1/customers') return json(url.searchParams.get('id') === `eq.${CUSTOMER}`
      ? { id: CUSTOMER, farm_name: 'Local Proof Farm', assigned_tier: 1 } : [{ id: CUSTOMER, farm_name: 'Local Proof Farm' }], 200, 1);
    if (url.pathname === '/rest/v1/order_items') return json([{ id: LINE, order_id: ORDER, product_id: PRODUCT, product_name: 'Proof Product',
      unit_size: 'gal', price_per_unit: 20, cost_per_unit: 10, total_units_needed: state.quantity, quantity_delivered: 0, total_price: state.quantity * 20 }], 200, 1);
    if (url.pathname.endsWith('/rpc/get_admin_cost_fields')) {
      const data = req.postDataJSON();
      return json(Object.fromEntries((data.p_ids ?? [ORDER, LINE]).map((id: string) => [id, { total_cost: 100, cost_per_unit: 10 }])));
    }
    if (url.pathname.endsWith('/rpc/update_order_items')) {
      const data = req.postDataJSON() as Request; state.saves.push(data);
      const old = state.receipts.get(data.p_idempotency_key);
      if (old) return json(old);
      if (data.p_expected_row_version !== state.version) return json({ code: 'P0001', message: 'ORDER_STALE_WRITE' }, 400);
      state.quantity = data.p_items[0].total_units_needed; state.version += 2;
      const receipt = { order_id: ORDER, row_version: state.version, success: true };
      state.receipts.set(data.p_idempotency_key, receipt);
      if (state.loseReply) { state.loseReply = false; return route.abort('failed'); }
      return json(receipt);
    }
    return json([]);
  });
  return errors;
}
async function openEditor(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('isolated-proof-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: false })).toBeVisible();
  await page.goto(`/orders/${ORDER}`);
  await page.getByRole('button', { name: 'Edit Order' }).click();
}
const qtyInput = (page: Page) => page.getByRole('row').filter({ hasText: 'Proof Product' }).getByRole('spinbutton').nth(1);

test('two editors: first save wins, second draft survives conflict and failed reload, then reload reconciles', async ({ page, context }) => {
  const state = backend(); const errors = await isolate(page, state);
  const other = await context.newPage(); const otherErrors = await isolate(other, state);
  await openEditor(page);
  // The second tab shares the authenticated browser context.
  await other.goto(`/orders/${ORDER}`);
  await other.getByRole('button', { name: 'Edit Order' }).click();
  await qtyInput(page).fill('14'); await qtyInput(other).fill('17');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Order' })).toBeVisible();
  await other.getByRole('button', { name: 'Save Changes' }).click();
  await expect(other.getByRole('button', { name: 'Reload Order' })).toBeVisible();
  await expect(qtyInput(other)).toHaveValue('17');
  await other.getByRole('button', { name: 'Keep editing' }).click();
  await expect(qtyInput(other)).toHaveValue('17');
  await other.getByRole('button', { name: 'Save Changes' }).click();
  state.failRead = true;
  await other.getByRole('button', { name: 'Reload Order' }).click();
  await expect(other.getByText(/Reload could not finish/)).toBeVisible();
  await expect(qtyInput(other)).toHaveValue('17');
  state.failRead = false;
  await other.getByRole('button', { name: 'Reload Order' }).click();
  await other.getByRole('button', { name: 'Edit Order' }).click();
  await expect(qtyInput(other)).toHaveValue('14');
  await qtyInput(other).fill('18');
  await other.getByRole('button', { name: 'Save Changes' }).click();
  await expect(other.getByRole('button', { name: 'Edit Order' })).toBeVisible();
  expect(state.quantity).toBe(18);
  expect(state.saves.map((r) => r.p_expected_row_version)).toEqual([7, 7, 9]);
  expect(errors).toEqual([]); expect(otherErrors).toEqual([]);
});

for (const laterEdit of [false, true]) {
test(`a lost save response retries the same request${laterEdit ? ' after another editor saves' : ''}`, async ({ page }) => {
  const state = backend(); state.loseReply = true;
  const errors = await isolate(page, state); await openEditor(page);
  await qtyInput(page).fill('16');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText(/Failed to fetch|NetworkError|network|try again/i).first()).toBeVisible();
  await expect(qtyInput(page)).toHaveValue('16');
  if (laterEdit) { state.quantity = 19; state.version = 11; }
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Order' })).toBeVisible();
  expect(state.saves).toHaveLength(2); expect(state.saves[1]).toEqual(state.saves[0]);
  expect(state.version).toBe(laterEdit ? 11 : 9);
  expect(state.quantity).toBe(laterEdit ? 19 : 16); expect(errors).toEqual([]);
});
}

test('cancel discards the draft even when Edit is reopened before the reload lands', async ({ page }) => {
  const state = backend(); const errors = await isolate(page, state); await openEditor(page);
  await qtyInput(page).fill('16');
  state.orderReadDelayMs = 3000;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Order' }).click();
  await expect(qtyInput(page)).toHaveValue('10');
  state.orderReadDelayMs = 0;
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Order' })).toBeVisible();
  expect(state.saves.map((r) => r.p_items[0].total_units_needed)).toEqual([10]);
  expect(state.quantity).toBe(10); expect(errors).toEqual([]);
});

test('a conflict reload that finds no order keeps the unsaved draft on screen', async ({ page }) => {
  const state = backend(); const errors = await isolate(page, state); await openEditor(page);
  await qtyInput(page).fill('17');
  state.version = 8;
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Reload Order' })).toBeVisible();
  state.missingOrder = true;
  await page.getByRole('button', { name: 'Reload Order' }).click();
  await expect(page.getByText(/Reload could not finish/)).toBeVisible();
  await expect(page.getByText('Order not found')).toHaveCount(0);
  await expect(qtyInput(page)).toHaveValue('17');
  expect(state.saves).toHaveLength(1); expect(errors).toEqual([]);
});

test('marking the order planned refreshes the version the next edit saves against', async ({ page }) => {
  const state = backend(); const errors = await isolate(page, state); await openEditor(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTitle('Click to mark as Planned').click();
  await expect(page.getByTitle('Click to mark as Committed')).toBeEnabled();
  await page.getByRole('button', { name: 'Edit Order' }).click();
  await qtyInput(page).fill('15');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Order' })).toBeVisible();
  expect(state.saves.map((r) => r.p_expected_row_version)).toEqual([8]);
  expect(state.quantity).toBe(15); expect(errors).toEqual([]);
});

test('a role refresh while editing keeps the editor and its unsaved draft', async ({ page, context }) => {
  const state = backend(); const errors = await isolate(page, state); await openEditor(page);
  await qtyInput(page).fill('16');
  state.role = 'sales_rep';
  // Signing in again in another tab re-confirms the same user here (SIGNED_IN), which reloads
  // the profile; the new role rebuilds the page's loader and it reads the order again.
  const orderReread = page.waitForResponse((r) => r.url().includes('/rest/v1/orders'));
  const other = await context.newPage(); await isolate(other, state);
  // The new tab starts without the stored session so it shows the sign-in form.
  await other.addInitScript(() => window.localStorage.clear());
  await other.goto('/'); await other.getByLabel('Email').fill(user.email);
  await other.getByLabel('Password').fill('isolated-proof-password');
  await other.getByRole('button', { name: 'Sign In' }).click();
  await orderReread;
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
  await expect(qtyInput(page)).toHaveValue('16');
  expect(errors).toEqual([]);
});

test('a missing version fails the read closed and sends no save', async ({ page }) => {
  const state = backend(); state.missingVersion = true; await isolate(page, state);
  await page.goto('/'); await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('isolated-proof-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: false })).toBeVisible();
  await page.goto(`/orders/${ORDER}`);
  await expect(page.getByText('This order could not be loaded')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Order' })).toHaveCount(0);
  expect(state.saves).toEqual([]);
});
