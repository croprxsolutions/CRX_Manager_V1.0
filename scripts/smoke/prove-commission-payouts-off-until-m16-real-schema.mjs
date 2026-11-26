#!/usr/bin/env node
/**
 * Real-schema proof for 20270308180000_commission_payouts_off_until_m16.sql (Mason, 2026-11-25: "make sure no
 * payout batch can run until it's live"). Builds the checked-in baseline plus every migration before the candidate
 * in a network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), commits one posted and one
 * unposted payout batch, then as the signed-in admin:
 *   1. before the apply: a new batch is created and the unposted batch posts (rolled back);
 *   2. after the apply: create and post are refused COMMISSION_PAYOUTS_OFF_UNTIL_M16 and nothing changes; voiding
 *      the posted and the unposted batch still works; a sales rep and a bad key get their old refusals; no API role
 *      can call the switch; a second apply is refused by the preflight;
 *   3. the reverse script restores both staging bodies (the candidate's preflight accepts them again) and a batch is
 *      created again.
 *
 * Run: node scripts/smoke/prove-commission-payouts-off-until-m16-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a database built up to the candidate: UNDO_PATHS_CONTAINER=<name> PAYOUTGUARD_REUSE=1 (left running).
 * Prints COMMISSION_PAYOUTS_OFF_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-payoutguard-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, seed, scalar, attempt, asUser, refuse, signIn, ref, id, USERS, ROOT, NAME, docker } =
  await import('./undo-paths/harness.mjs');

const MIGRATION = '20270308180000_commission_payouts_off_until_m16.sql';
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');
const OFF = 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
const CREATE_SIG = 'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)';
const POST_SIG = 'public.post_commission_payment(uuid,uuid,text)';
const STAGING_MD5 = { create: '41ef85f28f8168e2a7330a66828a6b10', post: 'bb01e87a4675fc11ba86deb4636e5640' };
const { admin: ADMIN, rep: REP } = USERS;
const CUST = id('16c1'); const ORDER = id('16e1');
// posted: in the posted batch; unposted: in the unposted batch; free: pending, in no batch.
const COM = { posted: id('16a1'), unposted: id('16a2'), free: id('16a3') };
const reuse = process.env.PAYOUTGUARD_REUSE === '1';

const sh = (sql, { user = 'postgres', single = true } = {}) => docker(['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q',
  '-v', 'ON_ERROR_STOP=1', ...(single ? ['-1'] : [])], { input: sql, allowFailure: true });
const bodyMd5 = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const show = (label, got) => { console.log(`[payout-guard] ${label}: ${got}`); return got; };

/** The three commissions and every batch holding them, read as postgres. */
const fp = `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT right(c.id::text, 1) || '=' || c.status || ':' || c.commission_amount x
    FROM public.commissions c WHERE c.id IN ('${COM.posted}', '${COM.unposted}', '${COM.free}')
  UNION ALL SELECT 'batches=' || coalesce(string_agg(cp.status || ':' || cp.total_amount, ',' ORDER BY cp.status, cp.total_amount), '')
    FROM public.commission_payments cp WHERE EXISTS (SELECT 1 FROM public.commission_payment_items i
      WHERE i.commission_payment_id = cp.id AND i.commission_id IN ('${COM.posted}', '${COM.unposted}', '${COM.free}'))) s)`;
const create = (who, key) => `u := public.create_commission_payment(ARRAY['${COM.free}']::uuid[], 'check', 'PG16-CHK-3',
  CURRENT_DATE, NULL, '${who}', ${key});`;
const post = (paymentId, key) => `r := public.post_commission_payment(${paymentId}, '${ADMIN}', '${key}');`;
const voidBatch = (paymentId, key) => `r := public.void_commission_payment(${paymentId}, '[PG16] wrong batch', '${ADMIN}', '${key}');`;

try {
  if (!reuse) { buildContainer({ stopBefore: MIGRATION }); seedUsers(); }
  assert.equal(scalar(`SELECT to_regprocedure('public._commission_payouts_enabled()') IS NULL;`), 't', 'start from the before state');
  assert.equal(bodyMd5(CREATE_SIG), STAGING_MD5.create, 'create_commission_payment must be the staging body');
  assert.equal(bodyMd5(POST_SIG), STAGING_MD5.post, 'post_commission_payment must be the staging body');

  const com = (k, dollars) => `INSERT INTO public.commissions (id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
      commission_amount, order_profit, order_date, status)
    VALUES ('${COM[k]}', '${ORDER}', '${CUST}', '[PG16] Rep', '${REP}', 100, ${dollars}, ${dollars}, CURRENT_DATE, 'pending');`;
  seed('payoutguard-m16', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[PG16] Payout Farm', '[PG16]-1');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[PG16] ORDER', '${CUST}', 'confirmed', false);
    ${com('posted', '120.00')} ${com('unposted', '80.00')} ${com('free', '45.50')}
    INSERT INTO undo_paths.ids SELECT 'payoutguard-posted', public.create_commission_payment(ARRAY['${COM.posted}']::uuid[],
      'check', 'PG16-CHK-1', CURRENT_DATE, NULL, '${ADMIN}', 'payoutguard-seed-create-1');
    SELECT public.post_commission_payment(${ref('payoutguard-posted')}, '${ADMIN}', 'payoutguard-seed-post-1');
    INSERT INTO undo_paths.ids SELECT 'payoutguard-unposted', public.create_commission_payment(ARRAY['${COM.unposted}']::uuid[],
      'check', 'PG16-CHK-2', CURRENT_DATE, NULL, '${ADMIN}', 'payoutguard-seed-create-2');`);
  // The app role cannot read undo_paths, so pin the RPC-chosen ids as literals before probing.
  const POSTED = `'${scalar(`SELECT ${ref('payoutguard-posted')};`)}'::uuid`;
  const UNPOSTED = `'${scalar(`SELECT ${ref('payoutguard-unposted')};`)}'::uuid`;
  const FIXTURE = '1=paid:120.00 2=pending:80.00 3=pending:45.50 batches=posted:120.00,unposted:80.00';
  assert.equal(show('fixture', attempt(ADMIN, `v := ${fp};`)), `ok|${FIXTURE}`);

  // 1. Before: a new batch is created and the unposted batch posts (each rolled back).
  const createWorks = (label) => assert.equal(show(label, attempt(ADMIN, `${asUser(create(ADMIN, `'payoutguard-${label.replace(/\W+/g, '-')}'`))} v := ${fp};`)),
    'ok|1=paid:120.00 2=pending:80.00 3=pending:45.50 batches=posted:120.00,unposted:45.50,unposted:80.00');
  createWorks('before: create batch');
  assert.equal(show('before: post batch', attempt(ADMIN, `${asUser(post(UNPOSTED, 'payoutguard-before-post'))} v := ${fp};`)),
    'ok|1=paid:120.00 2=paid:80.00 3=pending:45.50 batches=posted:80.00,posted:120.00');

  // 2. Apply. The postflight prints POSTFLIGHT_OK.
  const applied = sh(read('supabase', 'migrations', MIGRATION));
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  console.log('[payout-guard] applied; postflight OK');

  assert.equal(show('after: create refused', attempt(ADMIN, `f0 := ${fp}; ${refuse(create(ADMIN, "'payoutguard-after-create'"))}
    v := t || '|unchanged=' || (f0 = ${fp}) || '|receipts=' || (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'payoutguard-after-create');`)),
    `ok|${OFF}|unchanged=true|receipts=0`);
  assert.equal(show('after: post refused', attempt(ADMIN, `f0 := ${fp}; ${refuse(post(UNPOSTED, 'payoutguard-after-post'))}
    v := t || '|unchanged=' || (f0 = ${fp});`)), `ok|${OFF}|unchanged=true`);
  assert.equal(show('after: void posted batch', attempt(ADMIN, `${asUser(voidBatch(POSTED, 'payoutguard-after-void-1'))} v := ${fp};`)),
    'ok|1=pending:120.00 2=pending:80.00 3=pending:45.50 batches=unposted:80.00,voided:120.00');
  assert.equal(show('after: void unposted batch', attempt(ADMIN, `${asUser(voidBatch(UNPOSTED, 'payoutguard-after-void-2'))} v := ${fp};`)),
    'ok|1=paid:120.00 2=pending:80.00 3=pending:45.50 batches=posted:120.00,voided:80.00');
  assert.equal(show('after: rep create', attempt(ADMIN, `${signIn(REP)} ${refuse(create(REP, "'payoutguard-rep'"))} v := t;`)),
    'ok|Admin access required to create a commission payment');
  assert.equal(show('after: no key', attempt(ADMIN, `${refuse(create(ADMIN, 'NULL'))} v := t;`)),
    'ok|IDEMPOTENCY_KEY_REQUIRED: create_commission_payment requires p_idempotency_key');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._commission_payouts_enabled()', 'EXECUTE');`), 'f', `${role} must not execute the switch`);
  }
  assert.match(show('after: app role calls switch', attempt(ADMIN, `${refuse('PERFORM public._commission_payouts_enabled();')} v := t;`)),
    /^ok\|permission denied for function _commission_payouts_enabled$/);
  const again = sh(read('supabase', 'migrations', MIGRATION));
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /PAYOUT_GUARD_M16_BASELINE_DRIFT/);
  console.log('[payout-guard] second apply refused by the preflight');

  // 3. Reverse: staging bodies back, switch gone, a batch is created again; the candidate's preflight accepts the
  //    restored bodies (so the reverse is exact), then reverse once more to leave the before state.
  const reverse = () => {
    const r = sh(read('scripts', 'smoke', 'commission-payouts-off-until-m16-reverse.sql'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /REVERSE_OK/);
    assert.equal(bodyMd5(CREATE_SIG), STAGING_MD5.create);
    assert.equal(bodyMd5(POST_SIG), STAGING_MD5.post);
    assert.equal(scalar(`SELECT to_regprocedure('public._commission_payouts_enabled()') IS NULL;`), 't');
  };
  reverse();
  console.log('[payout-guard] reverse restored both staging bodies and dropped the switch');
  createWorks('reversed: create batch');
  const reapplied = sh(read('supabase', 'migrations', MIGRATION));
  assert.equal(reapplied.status, 0, reapplied.stderr);
  reverse();
  console.log('[payout-guard] re-apply after the reverse passed its preflight; reversed again');
  console.log('COMMISSION_PAYOUTS_OFF_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
  else console.log(`[payout-guard] left ${NAME} running (PAYOUTGUARD_REUSE=1)`);
}
