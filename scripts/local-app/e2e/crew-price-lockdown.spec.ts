import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { localSql } from './local-db';

// Applicator price-hide step 3 (20270314160000): an applicator's screens load from the crew views, and no response
// the browser receives carries a job price, cost, memo, commission split, chemical price or billing split.
const PROTECTED = ['total_price_cents', 'total_cost_cents', 'internal_memo', 'commission_split', 'price_per_unit_cents',
  'cost_per_unit_cents', 'split_pct', 'price_override_cents', 'pricing_note', 'PR3 SECRET MEMO'];

async function signIn(page: Page) {
  await page.addLocatorHandler(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /what's new/i }) }),
    async dialog => { await dialog.getByRole('button', { name: /close|got it/i }).first().click(); });
  await page.goto('/login');
  await page.locator('#email').fill(process.env.LOCAL_TEST_EMAIL!);
  await page.locator('#password').fill(process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

test('applicator screens read no prices; admin still does', async ({ page }) => {
  test.setTimeout(120_000); // every API reply is read before the page gets it (see the route below), which slows four screens
  const email = process.env.LOCAL_TEST_EMAIL!;
  const login = email.replaceAll("'", "''");
  // A run killed before its cleanup leaves this local-only admin login as an applicator; put it back first (the
  // stack's start/rebuild seed also does). Specs run one at a time (playwright.config workers: 1), so none sees the switch.
  localSql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin' WHERE email = '${login}' AND role = 'applicator'; COMMIT;`);
  const actor = localSql(`SELECT id FROM public.profiles WHERE email = '${login}' AND role = 'admin';`);
  expect(actor).toMatch(/^[0-9a-f-]{36}$/i);
  const product = localSql('SELECT id FROM public.products ORDER BY created_at LIMIT 1;');
  expect(product).toMatch(/^[0-9a-f-]{36}$/i);
  const [customer, payer, field, job] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const jobNumber = `PR3-${job.slice(0, 6)}`;

  // Each reply is tagged with the role signed in when its request started, so a late applicator reply is still scanned.
  let phase: 'applicator' | 'admin' = 'applicator';
  const bodies: Array<{ phase: typeof phase; path: string; select: string; status: number; text: string }> = [];
  const unreadable: string[] = [];
  const pending: Array<Promise<void>> = [];
  let crewAuth: { origin: string; headers: Record<string, string> } | undefined;
  // Every API reply is read here before the page receives it, so a navigation can never discard a body unscanned.
  await page.route(/\/(rest|storage)\/v1\//, async (route) => {
    const url = new URL(route.request().url());
    const requestPhase = phase;
    if (!crewAuth && url.pathname.endsWith('/rest/v1/jobs_crew')) {
      const { apikey, authorization } = route.request().headers();
      crewAuth = { origin: url.origin, headers: { apikey, authorization } };
    }
    const work = (async () => {
      let response;
      let body;
      try {
        response = await route.fetch();
        body = await response.body();
      } catch (error) {
        unreadable.push(`${url.pathname}: ${String(error).slice(0, 120)}`);
        await route.abort().catch(() => undefined);
        return;
      }
      bodies.push({ phase: requestPhase, path: url.pathname, select: url.searchParams.get('select') ?? '', status: response.status(), text: body.toString('utf8') });
      // The body is already scanned; a page that navigated away may no longer want it.
      await route.fulfill({ response, body }).catch(() => undefined);
    })();
    pending.push(work);
    await work;
  });
  const settle = async () => {
    await page.waitForLoadState('networkidle');
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const BASE = 'jobs|job_chemicals|job_field_shares|field_billing_defaults';
  const crewScan = () => {
    const crew = bodies.filter(b => b.phase === 'applicator');
    // No crew screen reads a base table, top level or embedded (e.g. job_fields?select=*,jobs(...)): such a read
    // now comes back empty and would silently hide the job.
    expect(crew.filter(b => new RegExp(`/rest/v1/(${BASE})$`).test(b.path)
      || new RegExp(`(^|[,(:])\\s*(${BASE})(!\\w+)?\\s*\\(`).test(b.select)).map(b => `${b.path}?select=${b.select}`)).toEqual([]);
    expect(crew.filter(b => b.status >= 400).map(b => `${b.status} ${b.path} ${b.text.slice(0, 120)}`)).toEqual([]);
    expect(unreadable).toEqual([]);
    // shortcut: customers.default_commission_split is the later step-2 lockdown, not this PR; only that one key is
    // allowed on /customers, and every other protected key and the invented memo are still checked there.
    for (const key of PROTECTED) {
      expect(crew.filter(b => b.text.includes(key) && !(key === 'commission_split' && b.path.endsWith('/rest/v1/customers')
        && !b.text.replaceAll('default_commission_split', '').includes('commission_split'))).map(b => `${b.path}: ${key}`)).toEqual([]);
    }
  };
  let cleanupError: unknown;

  try {
    localSql(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO public.customers (id, farm_name, account_number) VALUES
        ('${customer}', 'Invented PR3 Grower', 'PR3-G'), ('${payer}', 'Invented PR3 Payer', 'PR3-P');
      INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${field}', '${customer}', 'Invented PR3 Field', 40);
      INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
        VALUES ('${field}', '${customer}', 60, true), ('${field}', '${payer}', 40, false);
      INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, applicator_id, total_acres, total_price_cents,
                               total_cost_cents, internal_memo, commission_split)
        VALUES ('${job}', '${jobNumber}', '${customer}', 'scheduled', current_date, '${actor}', 40, 123400, 56700,
                'PR3 SECRET MEMO', '{"splits":[]}'::jsonb);
      INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES ('${job}', '${field}', 40, 0);
      INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, sort_order)
        VALUES ('${job}', '${product}', 40, 'gal', 1, 'gal', 2500, 1500, 0);
      INSERT INTO public.job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
        VALUES ('${job}', '${field}', '${customer}', 60, true), ('${job}', '${field}', '${payer}', 40, false);
      UPDATE public.profiles SET role = 'applicator' WHERE id = '${actor}';
      COMMIT;`);

    await signIn(page);
    for (const route of ['/jobs', `/jobs/${job}`, '/field', '/dispatch']) {
      await page.goto(route);
      await expect(page.getByText(jobNumber).first()).toBeVisible({ timeout: 20_000 });
      await settle();
    }
    expect(bodies.some(b => b.path.endsWith('/rest/v1/jobs_crew') && b.text.includes(jobNumber))).toBe(true);
    expect(bodies.some(b => b.path.endsWith('/rest/v1/job_chemicals_crew') && b.text.includes(job))).toBe(true);
    crewScan();
    // The lockdown itself: the applicator's own signed-in token asking the base tables directly gets no rows.
    // (Before migration 20270314160000 these return the job's prices, so this step fails without it.)
    expect(crewAuth?.headers.authorization).toMatch(/^Bearer /);
    // Only key columns are asked for: step 1 column-revoked the cost columns (a select=* is refused), so this counts rows.
    // Before this migration the same request also returned the selling price; the row policies are what now hide it.
    for (const [table, key, value] of [['jobs', 'id', job], ['job_chemicals', 'job_id', job],
      ['job_field_shares', 'job_id', job], ['field_billing_defaults', 'field_id', field]]) {
      const direct = await page.request.get(`${crewAuth!.origin}/rest/v1/${table}?select=${key}&${key}=eq.${value}`, { headers: crewAuth!.headers });
      expect(`${table} ${direct.status()} ${await direct.text()}`).toBe(`${table} 200 []`);
    }

    localSql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.profiles SET role = 'admin' WHERE id = '${actor}'; COMMIT;`);
    await settle();
    phase = 'admin';
    await page.goto(`/jobs/${job}`);
    await expect(page.getByText(jobNumber).first()).toBeVisible({ timeout: 20_000 });
    await settle();
    crewScan(); // again, now that any late applicator reply has landed
    const adminJob = bodies.find(b => b.phase === 'admin' && b.path.endsWith('/rest/v1/jobs') && b.text.includes(jobNumber));
    expect(adminJob?.text).toContain('"total_price_cents":123400');
    expect(adminJob?.text).toContain('PR3 SECRET MEMO');
    expect(adminJob?.text).toMatch(/"price_per_unit_cents": ?2500/);
    // And the admin screen shows them: the memo, the chemical's price and cost (in cents) and the 60/40 split fill their fields.
    const shownValues = () => page.evaluate(() => [...document.querySelectorAll('input, textarea')].map(e => (e as HTMLInputElement).value));
    await expect.poll(shownValues).toContain('PR3 SECRET MEMO');
    await expect.poll(shownValues).toEqual(expect.arrayContaining(['2500', '1500', '60', '40'])); // cents price and cost, billing split
  } finally {
    // A failed cleanup is logged here (never hiding an earlier failure) and fails an otherwise passing run below.
    try { localSql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'admin' WHERE id = '${actor}';
      DELETE FROM public.job_field_shares WHERE job_id = '${job}';
      DELETE FROM public.job_chemicals WHERE job_id = '${job}';
      DELETE FROM public.job_fields WHERE job_id = '${job}';
      DELETE FROM public.jobs WHERE id = '${job}';
      DELETE FROM public.field_billing_defaults WHERE field_id = '${field}';
      DELETE FROM public.fields WHERE id = '${field}';
      DELETE FROM public.customers WHERE id IN ('${customer}', '${payer}');
      COMMIT;`); } catch (error) { cleanupError = error; console.warn('crew-price-lockdown cleanup failed', error); }
  }
  if (cleanupError) throw cleanupError;
});
