#!/usr/bin/env node
/**
 * Real-schema proof for 20270213110000_followup_remainders_reopen.sql (KI-188 #2179; contract
 * docs/plans/2026-11-22-followup-remainders-CONTRACT.md).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented rows through the real RPCs, shows the
 * bug on the old bodies, applies the candidate (autocommit refused, POSTFLIGHT_OK, re-apply refused), then checks
 * every contract proof case in rolled-back probes through the public RPCs signed in as the admin, the driver and
 * rep refusals, and the reverse script.
 *
 * Run: node scripts/smoke/prove-followup-remainders-real-schema.mjs   (needs Docker; never touches live)
 * Prints FOLLOWUP_REMAINDERS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, attempt, asUser, refuse, signIn, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270213110000_followup_remainders_reopen.sql';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const reverse = lf(path.join(ROOT, 'scripts', 'smoke', 'followup-remainders-reopen-reverse.sql'));
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => docker([...PSQL, ...flags], { input: sql, allowFailure: true });
const { admin: ADMIN, rep: REP, driver: DRIVER } = USERS;

// Invented ids (tag 'c1..'; the harness's users use 'a1'..'a4').
const uid = (n) => `7c7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid('c1c1'); const PROD = uid('c1d1');
const ORDER = uid('c1e1'); const ORDER3 = uid('c1e3');
const LINE = uid('c1f1'); const LINE3 = uid('c1f4');
const DO = uid('c1b1'); const D3 = uid('c1b3'); const YOUNG = uid('c1b9');
const BODIES = {
  cancel: 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)',
  void: 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)',
};
const md5s = () => Object.fromEntries(Object.entries(BODIES).map(([k, f]) => [k, scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${f}'::regprocedure;`)]));

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };
const item = (del) => `(SELECT id FROM public.delivery_items WHERE delivery_id = ${del} AND order_item_id = '${LINE}')`;
const follow = (orig, key) => `public.create_followup_delivery(${orig}, CURRENT_DATE, '${ADMIN}', '${key}')`;
const cancel = (del, key) => `public.cancel_delivery(${del}, '[C1] customer called', '${ADMIN}', '${key}')`;
const voidDel = (del, key) => `public.void_delivery(${del}, '[C1] delivered in error', '${ADMIN}', '${key}')`;
const complete = (del, key, qty) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = ${del};
  r := public.complete_delivery(p_delivery_id => ${del}, p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${qty ?? 'NULL'}, p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[C1] fixture');`;
const four = (del) => `jsonb_build_object(${item(del)}::text, 4)`;
// The order's remainder rows (O = original is the first delivery, S = any other), the order line, and every open
// delivery of the order, read as postgres.
const FP = `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT 'rem=' || coalesce(string_agg(dr.status || ':' || dr.quantity_remaining::numeric(12,2) || ':' || CASE WHEN dr.original_delivery_id = '${DO}' THEN 'O' ELSE 'S' END
    || ':' || CASE WHEN dr.followup_delivery_id IS NULL THEN '-' ELSE 'F' END, ',' ORDER BY dr.created_at, dr.status DESC, dr.id), '') x
    FROM public.delivery_remainders dr WHERE dr.order_id = '${ORDER}'
  UNION ALL SELECT 'line=' || quantity_delivered::numeric(12,2) || '/' || quantity_remaining::numeric(12,2) FROM public.order_items WHERE id = '${LINE}'
  UNION ALL SELECT 'open=' || coalesce(string_agg(d.status || ':' || di.quantity::numeric(12,2), ',' ORDER BY d.created_at, d.id), '')
    FROM public.deliveries d JOIN public.delivery_items di ON di.delivery_id = d.id
   WHERE d.order_id = '${ORDER}' AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL) s)`;
const ALL_ROWS = `(SELECT md5(coalesce(string_agg(dr::text, '|' ORDER BY id), '')) FROM public.delivery_remainders dr)`;

function seedAll() {
  const line = (lid, ord, units) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${lid}', '${ord}', '${PROD}', '[C1] line', 10, 6, ${units}, ${units * 10}, ${units * 4}, 40, 0, ${units}, 'Gal');`;
  const delivery = (did, ord, lid, q) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${did}', '[C1] ${did.slice(-2)}', '${ord}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${did}', '${lid}', '${PROD}', ${q}, 0, 'Gal');`;
  seed('lane-c1', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[C1] Farm', '[C1]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit) VALUES
      ('${PROD}', '[C1] Product', 'Gal', '999999-99988', 'liquid', 'Gal');
    DO $price$ DECLARE v jsonb; BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')), '${ADMIN}', 'c1-p-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'c1-p-apply');
    END $price$;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${PROD}', 'Main Warehouse', 100, 0, 'Gal');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES
      ('${ORDER}', '[C1] O1', '${CUST}', 'confirmed', false), ('${ORDER3}', '[C1] O3', '${CUST}', 'confirmed', false);
    ${line(LINE, ORDER, 10)} ${line(LINE3, ORDER3, 5)}
    ${delivery(DO, ORDER, LINE, 10)} ${delivery(D3, ORDER3, LINE3, 5)}
    DO $c$ DECLARE r jsonb; BEGIN ${complete(`'${DO}'`, 'c1-seed-do', four(`'${DO}'`))} END $c$;`);
}

const F = `r := ${follow(`'${DO}'`, 'c1-f1')}; u := (r->>'delivery_id')::uuid;`; // F = follow-up of O, delivery id in u
const G = `r3 := ${follow('u', 'c1-g1')};`; // G = follow-up of F's successor row, its result kept in r3
const gId = `(r3->>'delivery_id')::uuid`;
const cases = {
  // 0. (bug check) cancel a scheduled follow-up and read the rows.
  cancelState: `${asUser(F)} ${asUser(`r := ${cancel('u', 'c1-c1')};`)} v := ${FP};`,
  // 0b. (bug check) void a fully delivered follow-up and read the rows.
  voidState: `${asUser(F)} ${asUser(complete('u', 'c1-k1'))} ${asUser(`r := ${voidDel('u', 'c1-v1')};`)} v := ${FP};`,
  // 0c. G holds F's short items: try voiding F and read whether anything changed.
  voidWhileGOpen: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} ${asUser(G)} f0 := ${FP};
    ${refuse(`r := ${voidDel('u', 'c1-v1')};`)} v := left(t, 60) || ' unchanged=' || (${FP} = f0);`,
  // 1. cancel a scheduled follow-up: O's 6 back on the queue; one replacement of 6; same key = same delivery; fresh key refused.
  cancel: `${asUser(F)} f1 := ${FP};
    ${asUser(`r3 := ${cancel('u', 'c1-c1')};`)} f2 := ${FP};
    ${asUser(`r := ${follow(`'${DO}'`, 'c1-f2')};`)} t2 := (r->>'item_count') || ' item(s) of ' || (SELECT quantity::numeric(12,2) FROM public.delivery_items WHERE delivery_id = (r->>'delivery_id')::uuid);
    ${asUser(`r2 := ${follow(`'${DO}'`, 'c1-f2')};`)} t2 := t2 || ' same_key_same=' || ((r->>'delivery_id') = (r2->>'delivery_id'));
    ${refuse(`r := ${follow(`'${DO}'`, 'c1-f3')};`)} f0 := ${FP};
    ${asUser(`r2 := ${cancel('u', 'c1-c1')};`)}
    v := 'scheduled: ' || f1 || ' | cancelled: ' || f2 || ' | again: ' || t2 || ' | fresh_key: ' || left(t, 22)
      || ' | cancel_replay_same=' || (r2 = r3) || ' replacement_kept=' || (${FP} = f0);`,
  // 2. a follow-up in progress with 2 recorded delivered, then cancelled: the 2 go back and O owes 6.
  cancelInProgress: `${asUser(F)}
    UPDATE public.delivery_items SET quantity_delivered = 2 WHERE delivery_id = u;
    UPDATE public.order_items SET quantity_delivered = quantity_delivered + 2, quantity_remaining = quantity_remaining - 2 WHERE id = '${LINE}';
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = u; f1 := ${FP};
    ${asUser(`r := ${cancel('u', 'c1-c1')};`)} f2 := ${FP};
    v := 'in progress: ' || f1 || ' | cancelled: ' || f2;`,
  // 3. delivered in full, then voided: owed 6 again; the same void key replays; re-scheduling gives 6.
  voidFull: `${asUser(F)} ${asUser(complete('u', 'c1-k1'))} f1 := ${FP};
    ${asUser(`r := ${voidDel('u', 'c1-v1')};`)} f2 := ${FP};
    ${asUser(`r2 := ${voidDel('u', 'c1-v1')};`)} t2 := ' replay_same=' || (r = r2) || ' ' || (${FP} = f2);
    ${asUser(`r := ${follow(`'${DO}'`, 'c1-f2')};`)} t2 := (SELECT quantity::numeric(12,2) FROM public.delivery_items WHERE delivery_id = (r->>'delivery_id')::uuid)::text || t2;
    v := 'completed: ' || f1 || ' | voided: ' || f2 || ' | rescheduled ' || t2;`,
  // 4. delivered 4 of 6 (successor 2 pending, not scheduled), then voided: the successor goes, O owes 6 (not 8).
  voidPartial: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} f1 := ${FP};
    ${asUser(`r := ${voidDel('u', 'c1-v1')};`)} f2 := ${FP};
    v := 'partial: ' || f1 || ' | voided: ' || f2;`,
  // 5. successor 2 scheduled as G: voiding F is refused (nothing changes); cancel G, then void F: O owes 6.
  voidBlockedThenCancelG: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} ${asUser(G)} f0 := ${FP};
    ${refuse(`r := ${voidDel('u', 'c1-v1')};`)} t2 := left(t, 60) || ' unchanged=' || (${FP} = f0);
    ${asUser(`r := ${cancel(gId, 'c1-cg')};`)} f1 := ${FP};
    ${asUser(`r := ${voidDel('u', 'c1-v2')};`)} f2 := ${FP};
    v := 'G scheduled: ' || f0 || ' | F void: ' || t2 || ' | G cancelled: ' || f1 || ' | F voided: ' || f2;`,
  // 6. successor 2 delivered by G: voiding F is refused; void G, then void F: O owes 6.
  voidBlockedThenVoidG: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} ${asUser(G)}
    ${asUser(complete(gId, 'c1-kg'))} f0 := ${FP};
    ${refuse(`r := ${voidDel('u', 'c1-v1')};`)} t2 := left(t, 60) || ' unchanged=' || (${FP} = f0);
    ${asUser(`r := ${voidDel(gId, 'c1-vg')};`)} f1 := ${FP};
    ${asUser(`r := ${voidDel('u', 'c1-v2')};`)} f2 := ${FP};
    v := 'G delivered: ' || f0 || ' | F void: ' || t2 || ' | G voided: ' || f1 || ' | F voided: ' || f2;`,
  // 7. legacy: G was cancelled under the old code with its row left 'scheduled'; voiding F is allowed and O owes 6.
  legacyCancelledG: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} ${asUser(G)}
    UPDATE public.deliveries SET status = 'cancelled' WHERE id = ${gId}; f0 := ${FP};
    ${asUser(`r := ${voidDel('u', 'c1-v1')};`)} f2 := ${FP};
    v := 'G cancelled (old): ' || f0 || ' | F voided: ' || f2;`,
  // 7b. chain O -> F -> G -> H with G closed under the old code but H live: voiding F is refused and names H.
  deepChain: `${asUser(F)} ${asUser(complete('u', 'c1-k1', four('u')))} ${asUser(G)}
    ${asUser(complete(gId, 'c1-kg', `jsonb_build_object(${item(gId)}::text, 1)`))} ${asUser(`r2 := ${follow(gId, 'c1-h1')};`)}
    UPDATE public.deliveries SET status = 'cancelled' WHERE id = ${gId}; f0 := ${FP};
    ${refuse(`r := ${voidDel('u', 'c1-v1')};`)}
    v := left(t, 60) || ' names_H=' || (t LIKE '%' || (SELECT delivery_number FROM public.deliveries WHERE id = (r2->>'delivery_id')::uuid) || '%')
      || ' unchanged=' || (${FP} = f0);`,
  // 7c. (hand-made: completed deliveries cannot go back to scheduled, so cancel never meets this for real) a scheduled
  // F whose own remainder row is linked to a live delivery: cancelling F is refused, nothing changes.
  cancelBlocked: `${asUser(F)}
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${YOUNG}', '[C1] YOUNG', '${ORDER}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_remainders (original_delivery_id, order_id, order_item_id, customer_id, product_id, quantity_remaining, status, followup_delivery_id)
      VALUES (u, '${ORDER}', '${LINE}', '${CUST}', '${PROD}', 1, 'scheduled', '${YOUNG}'); f0 := ${FP};
    ${refuse(`r := ${cancel('u', 'c1-c1')};`)} v := left(t, 60) || ' names_young=' || (t LIKE '%[C1] YOUNG%') || ' unchanged=' || (${FP} = f0);`,
  // 8. the order was cancelled before F is voided: nothing queued (the void does not raise a cancelled order's line).
  voidOrderCancelled: `${asUser(F)} ${asUser(complete('u', 'c1-k1'))}
    UPDATE public.invoices SET status = 'cancelled' WHERE order_id = '${ORDER}' AND status = 'draft';
    UPDATE public.orders SET status = 'cancelled' WHERE id = '${ORDER}';
    ${asUser(`r := ${voidDel('u', 'c1-v1')};`)} f2 := ${FP};
    ${refuse(`r := ${follow(`'${DO}'`, 'c1-f2')};`)}
    v := 'voided: ' || f2 || ' | reschedule: ' || left(t, 22);`,
  // 9. the order was cancelled before F is cancelled: nothing queued.
  cancelOrderCancelled: `${asUser(F)}
    UPDATE public.orders SET status = 'cancelled' WHERE id = '${ORDER}';
    ${asUser(`r := ${cancel('u', 'c1-c1')};`)} f2 := ${FP};
    v := 'cancelled: ' || f2;`,
  // 10. cancelling a delivery nobody's remainder points at changes no remainder row.
  unrelated: `f0 := ${ALL_ROWS};
    ${asUser(`r := ${cancel(`'${D3}'`, 'c1-c3')};`)} f1 := ${ALL_ROWS};
    v := 'remainders_unchanged=' || (f0 = f1) || ' d3=' || (SELECT status FROM public.deliveries WHERE id = '${D3}');`,
  // 11. who may act is unchanged, refusals leave every row as it was, and the two bodies stay private.
  denied: `${asUser(F)} ${asUser(complete('u', 'c1-k1'))} f0 := ${ALL_ROWS};
    ${signIn(DRIVER)} ${refuse(`r := public.cancel_delivery(u, '[C1] x', '${DRIVER}', 'c1-dc');`)} t2 := 'driver_cancel=' || left(t, 40);
    ${signIn(REP)} ${refuse(`r := public.void_delivery(u, '[C1] x', '${REP}', 'c1-rv');`)} t2 := t2 || ' | rep_void=' || left(t, 40);
    v := t2 || ' | unchanged=' || (f0 = ${ALL_ROWS}) || ' | grants=' || has_function_privilege('anon', '${BODIES.cancel}', 'EXECUTE')
      || has_function_privilege('authenticated', '${BODIES.cancel}', 'EXECUTE') || has_function_privilege('anon', '${BODIES.void}', 'EXECUTE')
      || has_function_privilege('authenticated', '${BODIES.void}', 'EXECUTE');`,
};
const probe = (name) => show(name, attempt(ADMIN, cases[name]));

// Expected results come from the contract's business rule (exact undo of scheduling), not from the new code.
const START = 'line=4.00/6.00 open= rem=pending:6.00:O:-';
const EXPECT = {
  cancel: `ok|scheduled: line=4.00/6.00 open=scheduled:6.00 rem=scheduled:6.00:O:F | cancelled: ${START} | again: 1 item(s) of 6.00 same_key_same=true | fresh_key: NO_PENDING_REMAINDERS | cancel_replay_same=true replacement_kept=true`,
  cancelInProgress: `ok|in progress: line=6.00/4.00 open=in_progress:6.00 rem=scheduled:6.00:O:F | cancelled: ${START}`,
  voidFull: `ok|completed: line=10.00/0.00 open= rem=fulfilled:6.00:O:F | voided: ${START} | rescheduled 6.00 replay_same=true true`,
  voidPartial: `ok|partial: line=8.00/2.00 open= rem=fulfilled:6.00:O:F,pending:2.00:S:- | voided: ${START}`,
  voidBlockedThenCancelG: 'ok|G scheduled: line=8.00/2.00 open=scheduled:2.00 rem=fulfilled:6.00:O:F,scheduled:2.00:S:F | F void: FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up deli unchanged=true'
    + ' | G cancelled: line=8.00/2.00 open= rem=fulfilled:6.00:O:F,pending:2.00:S:-'
    + ` | F voided: ${START}`,
  voidBlockedThenVoidG: 'ok|G delivered: line=10.00/0.00 open= rem=fulfilled:6.00:O:F,fulfilled:2.00:S:F | F void: FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up deli unchanged=true'
    + ' | G voided: line=8.00/2.00 open= rem=fulfilled:6.00:O:F,pending:2.00:S:-'
    + ` | F voided: ${START}`,
  legacyCancelledG: `ok|G cancelled (old): line=8.00/2.00 open= rem=fulfilled:6.00:O:F,scheduled:2.00:S:F | F voided: ${START}`,
  deepChain: 'ok|FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up deli names_H=true unchanged=true',
  cancelBlocked: 'ok|FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up deli names_young=true unchanged=true',
  voidOrderCancelled: 'ok|voided: line=4.00/0.00 open= rem=cancelled:6.00:O:F | reschedule: NO_PENDING_REMAINDERS',
  cancelOrderCancelled: 'ok|cancelled: line=4.00/6.00 open= rem=cancelled:6.00:O:F',
  unrelated: 'ok|remainders_unchanged=true d3=cancelled',
};

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seedAll();
  assert.equal(show('fixture', attempt(ADMIN, `v := ${FP};`)), `ok|${START}`);
  const before = md5s();
  console.log('  baseline bodies:', JSON.stringify(before));

  console.log('Before the candidate (the bug):');
  assert.match(probe('cancelState'), /rem=scheduled:6\.00:O:F$/, 'KI-188 cancel must reproduce on the old body');
  assert.match(probe('voidState'), /^ok\|line=4\.00\/6\.00 open= rem=fulfilled:6\.00:O:F$/, 'KI-188 void must reproduce on the old body');
  assert.equal(probe('voidWhileGOpen'), 'ok|NOT REFUSED unchanged=false', 'old void must delete the row G holds');

  console.log('Apply:');
  const auto = run(candidate);
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = run(candidate, ['-1']);
  assert.equal(once.status, 0, `${once.stdout}${once.stderr}`);
  assert.match(`${once.stdout}${once.stderr}`, /LEGACY_STUCK_REMAINDERS: 0/);
  assert.match(`${once.stdout}${once.stderr}`, /POSTFLIGHT_OK/);
  assert.match(`${run(candidate, ['-1']).stderr}`, /BASELINE_DRIFT/, 're-apply must refuse');
  const after = md5s();
  for (const k of Object.keys(BODIES)) assert.notEqual(after[k], before[k], `${k} body did not change`);

  console.log('After the candidate:');
  assert.equal(probe('cancelState'), `ok|${START}`);
  assert.equal(probe('voidState'), `ok|${START}`);
  assert.equal(probe('voidWhileGOpen'), 'ok|FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up deli unchanged=true');
  for (const [name, expected] of Object.entries(EXPECT)) assert.equal(probe(name), expected, name);
  const denied = probe('denied');
  assert.match(denied, /driver_cancel=Not authorized to cancel deliveries /, 'driver cancel must be refused by the role check');
  assert.match(denied, /rep_void=Admin access required/, 'rep void must be refused by the role check');
  assert.match(denied, /unchanged=true \| grants=falsefalsefalsefalse$/, 'refusals change nothing; bodies stay private');

  console.log('Reverse:');
  assert.match(`${run(reverse).stderr}`, /FOLLOWUP_REMAINDERS_REVERSE_DRIFT: run this file as one transaction/, 'autocommit reverse must refuse');
  assert.deepEqual(md5s(), after, 'a refused reverse changes nothing');
  const back = run(reverse, ['-1']);
  assert.equal(back.status, 0, `${back.stdout}${back.stderr}`);
  assert.match(`${back.stdout}${back.stderr}`, /REVERSE_OK/);
  assert.deepEqual(md5s(), before, 'reverse must restore the previous bodies byte for byte');
  assert.match(`${run(reverse, ['-1']).stderr}`, /FOLLOWUP_REMAINDERS_REVERSE_DRIFT/, 'reverse must refuse bodies that are not the candidate');
  assert.deepEqual(md5s(), before, 'a refused reverse changes nothing');
  const again = run(candidate, ['-1']);
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.match(`${again.stdout}${again.stderr}`, /POSTFLIGHT_OK/, 'candidate must re-apply after the reverse');

  console.log('FOLLOWUP_REMAINDERS_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
