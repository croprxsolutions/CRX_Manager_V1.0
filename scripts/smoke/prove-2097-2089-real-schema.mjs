#!/usr/bin/env node
/**
 * Real-schema proof for 20270307210000_booking_expiry_draw_recheck_and_posting_customer_lock (#2097, #2089).
 * Builds the production baseline plus every replayable migration before the candidate (Docker; the image may be
 * pulled once; no network), then runs three races on separate connections, each before the candidate, after it,
 * and after the rollback text (scripts/smoke/booking-expiry-draw-and-posting-lock-reverse.sql):
 *   #2097  the nightly expiry has opened its loop (its snapshot) and is held up on an earlier booking's hold;
 *          a draw on a later booking commits; the loop reaches that booking. Before: it tries to expire it; the
 *          draw guard refuses (BOOKING_PARTIALLY_DRAWN) and the whole night's run fails. After: the run completes,
 *          the booking stays open with its hold, the other quotes expire.
 *   #2089a an invoice is created and posted, uncommitted; the customer is deactivated. Before: the deactivation
 *          does not wait and the customer ends inactive with a posted invoice. After: it waits, then is refused.
 *   #2089b the customer is being deactivated, uncommitted; an invoice is created and posted. Before: the posting
 *          does not wait and lands on the now-inactive customer. After: it waits, then is refused.
 * The draw is written the way every draw path writes it (booking row locked FOR UPDATE, a quote_product_draws
 * row, the booking row updated); posting is the status change every posting function makes. The triggers under
 * test fire on those writes whatever the caller.
 *
 * Run: node scripts/smoke/prove-2097-2089-real-schema.mjs   (needs Docker)
 * Prints V021_RACES_PROOF_PASS on success. CRX_PROVER_REUSE=1 with UNDO_PATHS_CONTAINER=<a kept container built
 * without the candidate> skips the build (and keeps the container).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const REUSE = process.env.CRX_PROVER_REUSE === '1';
process.env.UNDO_PATHS_CONTAINER ||= `crx-v021-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, NAME, docker, ROOT } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270307210000_booking_expiry_draw_recheck_and_posting_customer_lock.sql';
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'booking-expiry-draw-and-posting-lock-reverse.sql');
const OLD_EXPIRY_MD5 = 'f677101398caef2eb0b195a42af5e38f';
const OLD_DEACTIVATION_MD5 = '77141ca2b586a22418d08c15108b3c7e';
const ADMIN = USERS.admin;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function applyFile(file) {
  docker(['cp', file, `${NAME}:/tmp/v021-apply.sql`]);
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-1', '-f', '/tmp/v021-apply.sql'], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

/** One connection kept open: statements run as they are sent; ON_ERROR_STOP ends it on the first error. */
function session(app) {
  const child = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.stdin.on('error', () => {});
  const s = { app, closed: false, marks: 0, output: () => out };
  const done = new Promise((resolve) => child.on('close', (status) => { s.closed = true; resolve({ status, out }); }));
  child.stdin.write(`SET application_name = '${app}';\n`);
  return Object.assign(s, {
    // Each batch ends with a marker row, so "its statements ran" is read from the output, not from timing.
    send(sql) { s.marks += 1; child.stdin.write(`${sql}\nSELECT 'V021MARK${s.marks}';\n`); },
    end(sql = '') { child.stdin.end(`${sql}\n`); return done; },
    done,
  });
}
/** 'idle' (its statements ran; the transaction stays open), 'lock' (waiting on a lock), or 'gone' (ended). */
async function settle(s) {
  const { app } = s;
  for (let i = 0; i < 150; i += 1) {
    if (s.output().includes(`V021MARK${s.marks}`)) return 'idle';
    if (s.closed) return 'gone';
    const wait = scalar(`SELECT COALESCE(wait_event_type, '') FROM pg_stat_activity
      WHERE application_name = '${app}' UNION ALL SELECT '' LIMIT 1;`);
    if (wait === 'Lock') return 'lock';
    await pause(100);
  }
  throw new Error(`${app} neither finished nor waited`);
}
const signedIn = `BEGIN; ${claims(ADMIN)}`;

// #2097 ------------------------------------------------------------------------------------------------------
async function expiryRace(tag) {
  const product = randomUUID();
  const customer = randomUUID();
  const blocker = randomUUID();
  const booking = randomUUID();
  const blockerHold = randomUUID();
  const hold = randomUUID();
  // Compact the table so the rows below are stored, and so scanned, in insert order: blocker, fillers, booking.
  psql('VACUUM FULL public.quotes;');
  psql(`${signedIn}
    INSERT INTO public.customers (id, farm_name) VALUES ('${customer}', '[2097 ${tag}] Farm');
    INSERT INTO public.products (id, product_name, product_form, inventory_unit) VALUES ('${product}', '[2097 ${tag}] Product', 'liquid', 'Gal');
    -- The blocker first, then 60 plain past-date quotes (more than the loop fetches at once), all before the booking.
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, commission_split, expires_at)
      SELECT CASE WHEN g = 0 THEN '${blocker}'::uuid ELSE gen_random_uuid() END, 'Q2097-${tag}-' || g, '${customer}',
             '${ADMIN}', 'sent', '{"splits": []}'::jsonb, CURRENT_DATE - 10
        FROM generate_series(0, 60) g;
    INSERT INTO public.quote_versions (quote_id, sent_by, snapshot_data)
      SELECT id, '${ADMIN}', '{}'::jsonb FROM public.quotes WHERE quote_number LIKE 'Q2097-${tag}-%';
    INSERT INTO public.inventory_holds (id, product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
      VALUES ('${blockerHold}', '${product}', '${customer}', 5, 'crop_program', '${blocker}', '${ADMIN}', true);
    COMMIT;`);
  psql(`${signedIn}
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, commission_split, expires_at)
      VALUES ('${booking}', 'Q2097-${tag}-booking', '${customer}', '${ADMIN}', 'sent', '{"splits": []}'::jsonb, CURRENT_DATE - 1);
    INSERT INTO public.quote_versions (quote_id, sent_by, snapshot_data) VALUES ('${booking}', '${ADMIN}', '{}'::jsonb);
    INSERT INTO public.inventory_holds (id, product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
      VALUES ('${hold}', '${product}', '${customer}', 40, 'crop_program', '${booking}', '${ADMIN}', true);
    COMMIT;`);

  const c = session(`v021-hold-${tag}`);
  c.send(`BEGIN; SELECT 1 FROM public.inventory_holds WHERE id = '${blockerHold}' FOR UPDATE;`);
  assert.equal(await settle(c), 'idle');
  // The nightly job's real context: owner, no signed-in user, READ COMMITTED.
  const a = session(`v021-expiry-${tag}`);
  // The loop's row order depends on the plan; on this tiny table the planner hashes the quotes (random order).
  // Nested loops scan them in stored order (compacted above), so the blocker comes first and the booking is fetched
  // in a later batch than the one the loop is held in. The race itself does not depend on the plan.
  a.send('SET enable_hashjoin = off; SET enable_mergejoin = off; SELECT public.auto_expire_quotes();');
  assert.equal(await settle(a), 'lock', 'the expiry loop should be held on the blocker hold');
  // The draw: NOWAIT proves the loop has not reached (locked) the booking yet.
  const draw = psql(`${signedIn}
    SELECT 1 FROM public.quotes WHERE id = '${booking}' FOR UPDATE NOWAIT;
    INSERT INTO public.quote_product_draws (quote_id, product_id, quantity_drawn) VALUES ('${booking}', '${product}', 10);
    UPDATE public.quotes SET updated_at = now() WHERE id = '${booking}';
    COMMIT;`, { allowFailure: true });
  assert.equal(draw.status, 0, `the draw could not commit while the loop was held:\n${draw.stderr}`);
  await c.end('COMMIT;');
  const run = await a.end();
  return {
    run: run.status === 0 ? 'ok' : (/BOOKING_PARTIALLY_DRAWN/.test(run.out) ? 'BOOKING_PARTIALLY_DRAWN' : run.out),
    booking: scalar(`SELECT status FROM public.quotes WHERE id = '${booking}';`),
    hold: scalar(`SELECT is_active FROM public.inventory_holds WHERE id = '${hold}';`),
    control: scalar(`SELECT status FROM public.quotes WHERE id = '${blocker}';`),
    alert: scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${booking}' AND notification_type = 'booking_past_expiry';`),
  };
}

// #2089 ------------------------------------------------------------------------------------------------------
function newCustomer(tag) {
  const customer = randomUUID();
  psql(`${signedIn} INSERT INTO public.customers (id, farm_name) VALUES ('${customer}', '[2089 ${tag}] Farm'); COMMIT;`);
  return customer;
}
// kind 'post': a sales invoice created and posted; 'draft': only its draft (KI-148 counts a draft as open work
// too); 'credit': a credit memo created and posted (allowed for an inactive customer, but it still takes the lock).
const postSql = (customer, invoice, tag, kind = 'post') => `${signedIn}
  INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number, total_amount_cents)
    VALUES ('${invoice}', '${customer}', '${kind === 'credit' ? 'credit_memo' : 'misc_charge'}', 'INV2089-${tag}',
            ${kind === 'credit' ? -500 : 12500});
  ${kind === 'draft' ? '' : `UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${invoice}';`}`;
const deactivateSql = (customer) => `${signedIn} UPDATE public.customers SET is_active = false WHERE id = '${customer}';`;
const state = (customer, invoice) => ({
  active: scalar(`SELECT is_active FROM public.customers WHERE id = '${customer}';`),
  invoice: scalar(`SELECT COALESCE((SELECT status FROM public.invoices WHERE id = '${invoice}'), 'none');`),
});

async function postingFirst(tag, kind = 'post') {
  const customer = newCustomer(`${tag}-a-${kind}`);
  const invoice = randomUUID();
  const p = session(`v021-post-${tag}`);
  p.send(postSql(customer, invoice, `${tag}-a`, kind));
  assert.equal(await settle(p), 'idle', p.output());
  const d = session(`v021-deact-${tag}`);
  d.send(deactivateSql(customer));
  const waited = await settle(d);
  const posted = await p.end('COMMIT;');
  assert.equal(posted.status, 0, posted.out);
  const deact = await d.end('COMMIT;');
  return { waited, refused: deact.status !== 0, error: deact.out.trim(), ...state(customer, invoice) };
}

async function deactivationFirst(tag, kind = 'post') {
  const customer = newCustomer(`${tag}-b-${kind}`);
  const invoice = randomUUID();
  const d = session(`v021-deact-${tag}`);
  d.send(deactivateSql(customer));
  assert.equal(await settle(d), 'idle');
  const p = session(`v021-post-${tag}`);
  p.send(postSql(customer, invoice, `${tag}-b`, kind));
  const waited = await settle(p);
  const deact = await d.end('COMMIT;');
  assert.equal(deact.status, 0, deact.out);
  const posted = await p.end('COMMIT;');
  return { waited, refused: posted.status !== 0, error: posted.out.trim(), ...state(customer, invoice) };
}

const RUN = Date.now().toString(36);  // unique names when a kept container is reused
async function runAll(phase) {
  const tag = `${phase}-${RUN}`;
  return {
    expiry: await expiryRace(tag),
    postFirst: await postingFirst(tag),
    deactFirst: await deactivationFirst(tag),
    draftFirst: await postingFirst(`${tag}-d`, 'draft'),
    deactFirstDraft: await deactivationFirst(`${tag}-d`, 'draft'),
  };
}
function assertBroken(r, when) {
  // Today the draw guard (_enforce_quote_terminal_not_drawn) stops the stale expiry, so the hold is not released,
  // but the whole night's run fails with it: no other quote expires and no alert is sent.
  assert.deepEqual(r.expiry, { run: 'BOOKING_PARTIALLY_DRAWN', booking: 'sent', hold: 't', control: 'sent', alert: '0' },
    `${when}: #2097 should reproduce (the run misses the draw and fails whole)`);
  assert.equal(r.postFirst.waited, 'idle', `${when}: the deactivation should not wait`);
  assert.deepEqual([r.postFirst.refused, r.postFirst.active, r.postFirst.invoice], [false, 'f', 'posted'],
    `${when}: #2089a should reproduce (inactive customer with a posted invoice)`);
  assert.equal(r.deactFirst.waited, 'idle', `${when}: the posting should not wait`);
  assert.deepEqual([r.deactFirst.refused, r.deactFirst.active, r.deactFirst.invoice], [false, 'f', 'posted'],
    `${when}: #2089b should reproduce (inactive customer with a posted invoice)`);
  for (const k of ['draftFirst', 'deactFirstDraft']) {
    assert.equal(r[k].waited, 'idle', `${when} ${k}: nothing should wait`);
    assert.deepEqual([r[k].refused, r[k].active, r[k].invoice], [false, 'f', 'draft'],
      `${when} ${k}: should reproduce (inactive customer with an open draft)`);
  }
}

try {
  if (!REUSE) { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  assert.equal(scalar(`SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE oid = 'public.auto_expire_quotes(text)'::regprocedure;`),
    OLD_EXPIRY_MD5, 'the database must start without the candidate');

  const before = await runAll('before');
  assertBroken(before, 'BEFORE');
  console.log('[v021] BEFORE #2097: a draw committed mid-run is missed; the run tries to expire the booking and fails whole (BOOKING_PARTIALLY_DRAWN), so no quote expires that night');
  console.log('[v021] BEFORE #2089a: deactivation did not wait for the posting; inactive customer with a posted invoice');
  console.log('[v021] BEFORE #2089b: posting did not wait for the deactivation; inactive customer with a posted invoice');

  const applied = applyFile(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
  assert.equal(applied.status, 0, applied.output);
  const again = applyFile(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
  assert.notEqual(again.status, 0);
  assert.match(again.output, /V021_RACES_PREFLIGHT/);
  console.log('[v021] candidate applied; a second apply is refused by its preflight');

  const after = await runAll('after');
  assert.deepEqual(after.expiry, { run: 'ok', booking: 'sent', hold: 't', control: 'expired', alert: '1' },
    'AFTER #2097: the part-drawn booking must stay open with its hold (the undrawn control still expires)');
  assert.equal(after.postFirst.waited, 'lock', 'AFTER #2089a: the deactivation must wait for the posting');
  assert.equal(after.postFirst.refused, true);
  assert.match(after.postFirst.error, /CUSTOMER_HAS_OPEN_WORK/);
  assert.deepEqual([after.postFirst.active, after.postFirst.invoice], ['t', 'posted']);
  assert.equal(after.deactFirst.waited, 'lock', 'AFTER #2089b: the posting must wait for the deactivation');
  assert.equal(after.deactFirst.refused, true);
  assert.match(after.deactFirst.error, /CUSTOMER_INACTIVE_POSTING/);
  assert.deepEqual([after.deactFirst.active, after.deactFirst.invoice], ['f', 'none']);
  console.log('[v021] AFTER #2097: the run completes; booking stays sent with its hold and gets its past-date alert; the undrawn quotes still expire');
  console.log('[v021] AFTER #2089a: deactivation waited, then CUSTOMER_HAS_OPEN_WORK; customer active, invoice posted');
  console.log('[v021] AFTER #2089b: posting waited, then CUSTOMER_INACTIVE_POSTING; customer inactive, no invoice');
  assert.equal(after.draftFirst.waited, 'lock');
  assert.match(after.draftFirst.error, /CUSTOMER_HAS_OPEN_WORK/);
  assert.deepEqual([after.draftFirst.active, after.draftFirst.invoice], ['t', 'draft']);
  assert.equal(after.deactFirstDraft.waited, 'lock');
  assert.match(after.deactFirstDraft.error, /CUSTOMER_INACTIVE_POSTING/);
  assert.deepEqual([after.deactFirstDraft.active, after.deactFirstDraft.invoice], ['f', 'none']);
  console.log('[v021] AFTER #2089 drafts: the same in both orders for a draft saved during a deactivation');
  // Credit memos are allowed for an inactive customer (Taha 2026-11-25) but still take the lock, so the race stays closed.
  const creditFirst = await postingFirst(`after-${RUN}-c`, 'credit');
  assert.equal(creditFirst.waited, 'lock', 'a deactivation must wait for a credit memo being posted');
  assert.match(creditFirst.error, /CUSTOMER_HAS_OPEN_WORK/);
  assert.deepEqual([creditFirst.active, creditFirst.invoice], ['t', 'posted']);
  const deactFirstCredit = await deactivationFirst(`after-${RUN}-c`, 'credit');
  assert.equal(deactFirstCredit.waited, 'lock', 'a credit memo must wait for a deactivation in progress');
  assert.equal(deactFirstCredit.refused, false, deactFirstCredit.error);
  assert.deepEqual([deactFirstCredit.active, deactFirstCredit.invoice], ['f', 'posted']);
  console.log('[v021] AFTER #2089 credit memos: both orders wait on the lock; deactivation then refused, or the credit memo posts for the now-inactive customer');

  // Not races: what else counts as an invoice starting to carry a balance, and the isolation rule.
  const oldCustomer = newCustomer(`after-old-${RUN}`);
  const draft = randomUUID();
  const paid = randomUUID();
  const deletedDraft = randomUUID();
  psql(`${signedIn} INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number) VALUES ('${draft}', '${oldCustomer}', 'misc_charge', 'INV2089-old-${RUN}');
    INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number, total_amount_cents) VALUES ('${paid}', '${oldCustomer}', 'misc_charge', 'INV2089-paid-${RUN}', 100);
    UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${paid}';
    UPDATE public.invoices SET status = 'paid' WHERE id = '${paid}';
    INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number) VALUES ('${deletedDraft}', '${oldCustomer}', 'misc_charge', 'INV2089-del-${RUN}');
    UPDATE public.invoices SET deleted_at = now() WHERE id = '${deletedDraft}'; COMMIT;`);
  // KI-148 refuses deactivating with an open draft, so this customer goes inactive the way legacy rows are: directly.
  psql(`BEGIN; ALTER TABLE public.customers DISABLE TRIGGER customers_open_work_on_deactivate_20270128;
    UPDATE public.customers SET is_active = false WHERE id = '${oldCustomer}';
    ALTER TABLE public.customers ENABLE TRIGGER customers_open_work_on_deactivate_20270128; COMMIT;`);
  const refused = (sql) => {
    const r = psql(`${signedIn} ${sql} COMMIT;`, { allowFailure: true });
    assert.notEqual(r.status, 0, `not refused: ${sql}`);
    assert.match(r.stderr, /CUSTOMER_INACTIVE_POSTING/);
  };
  const allowed = (sql) => {
    const r = psql(`${signedIn} ${sql} COMMIT;`, { allowFailure: true });
    assert.equal(r.status, 0, `refused: ${sql}\n${r.stderr}`);
  };
  refused(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${draft}';`);
  assert.equal(scalar(`SELECT status FROM public.invoices WHERE id = '${draft}';`), 'draft');
  // Allowed (Taha 2026-11-25): a returned check or voided payment moves paid back to posted.
  allowed(`UPDATE public.invoices SET status = 'posted' WHERE id = '${paid}';`);
  assert.equal(scalar(`SELECT status FROM public.invoices WHERE id = '${paid}';`), 'posted');
  // Allowed: a credit memo created, then posted, in separate saves.
  const credit = randomUUID();
  allowed(`INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number, total_amount_cents) VALUES ('${credit}', '${oldCustomer}', 'credit_memo', 'INV2089-cm-${RUN}', -500);`);
  allowed(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${credit}';`);
  assert.equal(scalar(`SELECT status FROM public.invoices WHERE id = '${credit}';`), 'posted');
  // Restoring a deleted draft, and creating a new one.
  refused(`UPDATE public.invoices SET deleted_at = NULL WHERE id = '${deletedDraft}';`);
  refused(`INSERT INTO public.invoices (customer_id, invoice_type, invoice_number) VALUES ('${oldCustomer}', 'misc_charge', 'INV2089-new-${RUN}');`);
  // Moving an open invoice onto the inactive customer.
  const other = newCustomer(`after-other-${RUN}`);
  const moving = randomUUID();
  psql(`${signedIn} INSERT INTO public.invoices (id, customer_id, invoice_type, invoice_number) VALUES ('${moving}', '${other}', 'misc_charge', 'INV2089-mv-${RUN}'); COMMIT;`);
  refused(`UPDATE public.invoices SET customer_id = '${oldCustomer}' WHERE id = '${moving}';`);
  console.log('[v021] AFTER: for an inactive customer, posting an old sales draft, a new sales draft, restoring a deleted draft and moving an invoice onto it are refused CUSTOMER_INACTIVE_POSTING; a credit memo (create, post) and paid back to posted go through');
  // A deactivation outside READ COMMITTED would count from its first snapshot, so it is refused.
  const rrCustomer = newCustomer(`after-rr-${RUN}`);
  const rr = psql(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${claims(ADMIN)}
    UPDATE public.customers SET is_active = false WHERE id = '${rrCustomer}'; COMMIT;`, { allowFailure: true });
  assert.notEqual(rr.status, 0);
  assert.match(rr.stderr, /CUSTOMER_DEACTIVATION_NEEDS_READ_COMMITTED/);
  assert.equal(scalar(`SELECT is_active FROM public.customers WHERE id = '${rrCustomer}';`), 't');
  console.log('[v021] AFTER: a REPEATABLE READ deactivation is refused CUSTOMER_DEACTIVATION_NEEDS_READ_COMMITTED');

  const reversed = applyFile(REVERSE);
  assert.equal(reversed.status, 0, reversed.output);
  assert.equal(scalar(`SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE oid = 'public.auto_expire_quotes(text)'::regprocedure;`), OLD_EXPIRY_MD5);
  assert.equal(scalar(`SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE oid = 'public.guard_customer_deactivation_open_work_20270128()'::regprocedure;`), OLD_DEACTIVATION_MD5);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_inactive_customer_posting_20270306';`), '0');
  assert.equal(scalar(`SELECT array_to_string(proacl, ',') FROM pg_proc WHERE oid = 'public.auto_expire_quotes(text)'::regprocedure;`),
    'postgres=X/postgres,service_role=X/postgres');
  assertBroken(await runAll('rollback'), 'ROLLBACK');
  console.log('[v021] ROLLBACK: both pinned bodies back and no posting guard; all three races reproduce again');
  console.log('V021_RACES_PROOF_PASS');
} finally {
  // A failed run must not leave its sessions holding locks in a kept container.
  try { psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'v021-%';", { allowFailure: true }); } catch { /* container gone */ }
  if (!REUSE) removeContainer();
}
