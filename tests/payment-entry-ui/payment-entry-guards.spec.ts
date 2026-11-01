import { expect, test, type Page } from '@playwright/test';

// The real app in a real browser; the fake below keeps the payments a saved call would write, so the
// duplicate lookup and the retry refusal run against what an earlier attempt actually left behind.
const API = 'http://127.0.0.1:54331';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = '66666666-6666-4666-8666-666666666666';
const SHOTS = 'output/playwright/payment-entry-results';

function encoded(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function session() {
  const now = Math.floor(Date.now() / 1000);
  const access_token = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: ACTOR_ID, role: 'authenticated', aud: 'authenticated', exp: now + 3600 })}.isolated`;
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'isolated-refresh', user: { id: ACTOR_ID, aud: 'authenticated', role: 'authenticated', email: 'payment-entry@example.invalid', email_confirmed_at: '2026-11-01T00:00:00Z', confirmed_at: '2026-11-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' } };
}
const profile = { id: ACTOR_ID, email: 'payment-entry@example.invalid', full_name: 'Payment Proof Admin', role: 'admin', is_active: true, denied_pages: [] };
const customer = { id: CUSTOMER_ID, farm_name: 'Proof Farm', account_number: 'A-1', prepay_balance_cents: 0, is_active: true, payment_terms: 'Net 30' };
const invoice = { id: INVOICE_ID, invoice_number: 'INV-PROOF', invoice_type: 'chemical_sale', status: 'posted', customer_id: CUSTOMER_ID, invoice_date: '2026-10-01', due_date: '2026-10-31', payment_terms: 'Net 30', total_amount_cents: 100000, paid_amount_cents: 0, balance_cents: 100000, created_at: '2026-10-01T00:00:00Z', customer };

interface Saved { id: string; customer_id: string; total_payment_cents: number; reference_number: string | null; check_number: string | null; payment_date: string; is_active: boolean }

async function isolate(page: Page) {
  let releaseLookup = () => {};
  const lookupReleased = new Promise<void>((release) => { releaseLookup = release; });
  let releaseSave = () => {};
  const saveReleased = new Promise<void>((release) => { releaseSave = release; });
  const state = {
    payments: [] as Saved[],
    receipts: new Map<string, string>(),
    rpcCalls: 0,
    loseNextResponse: false,
    holdNextLookup: false,
    holdNextSave: false,
    releaseLookup,
    releaseSave,
    pageErrors: [] as string[],
  };
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.routeWebSocket(`${API.replace('http', 'ws')}/realtime/v1/websocket**`, (socket) => socket.onMessage(() => undefined));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const wantsOne = request.headers().accept?.includes('vnd.pgrst.object');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/1' }, body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/auth/v1/token') return json(session());
    if (url.pathname === '/rest/v1/profiles') return json(profile);
    if (url.pathname === '/rest/v1/customers') return json(wantsOne ? customer : [customer]);
    if (['invoices', 'invoices_postable'].includes(url.pathname.slice('/rest/v1/'.length))) return json(wantsOne ? invoice : [invoice]);
    if (url.pathname === '/rest/v1/allocation_sets') {
      if (state.holdNextLookup) {
        state.holdNextLookup = false;
        await lookupReleased;
      }
      const eq = (name: string) => url.searchParams.get(name)?.replace(/^eq\./, '');
      const rows = state.payments.filter((p) => p.customer_id === eq('customer_id')
        && String(p.total_payment_cents) === eq('total_payment_cents')
        && String(p.is_active) === eq('is_active'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' },
        body: JSON.stringify(rows),
      });
    }
    if (url.pathname.endsWith('/rpc/allocate_payment')) {
      state.rpcCalls += 1;
      if (state.holdNextSave) {
        state.holdNextSave = false;
        await saveReleased;
      }
      const body = request.postDataJSON();
      const asked = JSON.stringify([body.p_total_cents, body.p_reference_number]);
      const key = body.p_idempotency_key;
      const earlier = state.receipts.get(key);
      if (earlier && earlier !== asked) return json({ code: 'P0001', message: `IDEMPOTENCY_ARGUMENT_MISMATCH: key ${key} was already used for different allocate_payment arguments` }, 400);
      if (!earlier) {
        state.receipts.set(key, asked);
        state.payments.push({ id: `set-${state.payments.length + 1}`, customer_id: body.p_customer_id, total_payment_cents: body.p_total_cents, reference_number: body.p_reference_number, check_number: body.p_check_number, payment_date: '2026-11-01', is_active: true });
      }
      if (state.loseNextResponse) { state.loseNextResponse = false; return route.abort('connectionreset'); }
      return json({ success: true, allocation_set_id: `set-${state.payments.length}`, total_allocated_cents: body.p_total_cents, prepay_created_cents: 0, invoices_paid: 1 });
    }
    return json(wantsOne ? null : []);
  });
  return state;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('payment-entry@example.invalid');
  await page.getByLabel('Password').fill('isolated-proof-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function enterOnPayments(page: Page, amount: string, reference: string) {
  await page.goto('/payments');
  await page.getByPlaceholder('Search by name or account #...').fill('Proof');
  await page.getByRole('button', { name: /Proof Farm/ }).click();
  await page.getByPlaceholder('0.00').first().fill(amount);
  await page.getByPlaceholder('Check # or ref...').fill(reference);
  await page.getByRole('button', { name: /Auto-Allocate/ }).click();
  await page.getByRole('button', { name: /Apply Payment/ }).click();
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 375, height: 812 }]) {
  test(`Payments page warns on a check already recorded (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await isolate(page);
    await signIn(page);

    await enterOnPayments(page, '500.00', '1234');
    await expect.poll(() => state.rpcCalls).toBe(1);

    await enterOnPayments(page, '500.00', '#1234');
    await expect(page.getByText('Possible Duplicate Payment')).toBeVisible();
    await expect(page.getByText(/already has a \$500\.00 payment with reference 1234/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/duplicate-warning-${viewport.name}.png` });
    expect(state.rpcCalls).toBe(1);

    await page.getByRole('button', { name: /^Cancel/ }).click();
    await expect(page.getByText('Possible Duplicate Payment')).toBeHidden();
    expect(state.rpcCalls).toBe(1);

    await page.getByRole('button', { name: /Apply Payment/ }).click();
    await page.getByRole('button', { name: /Record Anyway/ }).click();
    await expect.poll(() => state.rpcCalls).toBe(2);
    expect(state.payments).toHaveLength(2);
    expect(state.pageErrors).toEqual([]);
  });
}

test('Payments page: a lost reply then an edited retry says to check Payment History', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  state.loseNextResponse = true;
  await enterOnPayments(page, '500.00', '1234');
  await expect.poll(() => state.payments.length).toBe(1);

  await page.getByPlaceholder('0.00').first().fill('400.00');
  await page.getByRole('button', { name: /Auto-Allocate/ }).click();
  await page.getByRole('button', { name: /Apply Payment/ }).click();
  await expect(page.getByText(/an earlier attempt at this payment may have saved\. Check Payment History/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/retry-refused-payments.png` });
  expect(state.payments).toHaveLength(1);
});

test('Payments page: a lost reply then an unchanged retry keeps one payment', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  state.loseNextResponse = true;
  await enterOnPayments(page, '500.00', '1234');
  await expect.poll(() => state.payments.length).toBe(1);

  // The first attempt did save, so the check now warns; the same key then replays that save.
  await page.getByRole('button', { name: /Apply Payment/ }).click();
  await expect(page.getByText('Possible Duplicate Payment')).toBeVisible();
  await page.getByRole('button', { name: /Record Anyway/ }).click();
  await expect(page.getByText('Payment Applied Successfully')).toBeVisible();
  expect(state.rpcCalls).toBe(2);
  expect(state.payments).toHaveLength(1);
  expect(state.pageErrors).toEqual([]);
});

test('Payments page: the form locks during the duplicate check', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  state.holdNextLookup = true;
  await enterOnPayments(page, '500.00', '1234');
  await expect(page.getByPlaceholder('Check # or ref...')).toBeDisabled();
  await expect(page.getByPlaceholder('0.00').first()).toBeDisabled();
  expect(state.rpcCalls).toBe(0);

  state.releaseLookup();
  await expect(page.getByText('Payment Applied Successfully')).toBeVisible();
  expect(state.payments[0]).toMatchObject({ total_payment_cents: 50000, reference_number: '1234' });
});

test('Invoice page: Cancel is locked during the duplicate check', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  await page.goto(`/invoices/${INVOICE_ID}`);
  await page.getByRole('button', { name: /Record Payment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Record Payment' });
  await dialog.getByLabel('Reference # (optional)').fill('1234');
  state.holdNextLookup = true;
  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await expect(dialog.getByRole('button', { name: /^Cancel/ })).toBeDisabled();
  await expect(dialog.getByLabel('Reference # (optional)')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  state.releaseLookup();
  await expect.poll(() => state.payments.length).toBe(1);
  expect(state.payments[0].reference_number).toBe('1234');
});

test('Invoice page: warns, Cancel keeps the form, Record Anyway saves', async ({ page }) => {
  const state = await isolate(page);
  state.payments.push({ id: 'set-0', customer_id: CUSTOMER_ID, total_payment_cents: 100000, reference_number: '1234', check_number: null, payment_date: '2026-10-05', is_active: true });
  await signIn(page);
  await page.goto(`/invoices/${INVOICE_ID}`);
  await page.getByRole('button', { name: /Record Payment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Record Payment' });
  await dialog.getByLabel('Reference # (optional)').fill('1234');
  await dialog.getByRole('button', { name: /Record Payment/ }).click();

  await expect(page.getByText('Possible Duplicate Payment')).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/duplicate-warning-invoice.png` });
  expect(state.rpcCalls).toBe(0);

  await page.getByRole('button', { name: /^Cancel/ }).click();
  await expect(dialog.getByLabel('Reference # (optional)')).toHaveValue('1234');
  expect(state.rpcCalls).toBe(0);

  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await page.getByRole('button', { name: /Record Anyway/ }).click();
  await expect.poll(() => state.rpcCalls).toBe(1);
  expect(state.pageErrors).toEqual([]);
});

test('Invoice page: a lost reply then an edited retry says to check Payment History', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  await page.goto(`/invoices/${INVOICE_ID}`);
  state.loseNextResponse = true;
  await page.getByRole('button', { name: /Record Payment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Record Payment' });
  await dialog.getByLabel('Reference # (optional)').fill('1234');
  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await expect.poll(() => state.payments.length).toBe(1);

  await dialog.getByLabel('Reference # (optional)').fill('5678');
  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await expect(page.getByText(/an earlier attempt at this payment may have saved\. Check Payment History/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/retry-refused-invoice.png` });
  expect(state.payments).toHaveLength(1);
});

test('Invoice page: closing the form during a lost save, then saving again, keeps one payment', async ({ page }) => {
  const state = await isolate(page);
  await signIn(page);
  await page.goto(`/invoices/${INVOICE_ID}`);
  state.holdNextSave = true;
  state.loseNextResponse = true;
  const open = page.getByRole('button', { name: /Record Payment/ });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Record Payment' });
  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await expect.poll(() => state.rpcCalls).toBe(1);

  await dialog.getByRole('button', { name: /^Cancel/ }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeDisabled();

  state.releaseSave();
  await expect(open).toBeEnabled();
  await open.click();
  await dialog.getByRole('button', { name: /Record Payment/ }).click();
  await expect.poll(() => state.rpcCalls).toBe(2);
  await expect(dialog).toBeHidden();
  expect(state.payments).toHaveLength(1);
  expect(state.pageErrors).toEqual([]);
});
