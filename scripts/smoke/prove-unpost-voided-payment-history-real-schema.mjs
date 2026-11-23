#!/usr/bin/env node
/**
 * Real-schema proof for 20270225130000_unpost_ignores_voided_payment_history.sql (#2265).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Every invoice is made, posted, paid and voided through
 * the app's own functions (save_invoice, post_invoice / post_invoice_group, allocate_payment, void_payment).
 *   BEFORE: a posted invoice whose only payment was voided cannot be unposted (alone or in its group).
 *   APPLY:  against a drifted body, plain `psql -f` (no ON_ERROR_STOP, no -1) reports PREFLIGHT_FAIL and leaves the
 *           function unchanged; against the pinned body it applies with POSTFLIGHT_OK; re-apply is refused by the md5 pin.
 *   AFTER:  (a) it unposts; the draft saves with its lines and re-posts; the voided payment's rows keep invoice_id and
 *               amount, lose only their line link, and the audit row keeps each one's allocation, line and amount;
 *          (a3) the same for a legacy row naming the line with no invoice_id (filled with this invoice); one that records
 *               another invoice refuses with UNPOST_HISTORY_NEEDS_HAND_CHECK and changes nothing;
 *          (a4) two voided payments on two different lines: both unlinked and audited, the draft saves and re-posts;
 *          (a2) without that unlink, the draft save is refused by invoice_line_allocations_invoice_item_id_fkey;
 *          (b) an active payment still blocks; (c) one voided and one active payment still block;
 *          (e) a non-payment allocation still blocks, even on an inactive set, and so does an active payment
 *              allocation on an invoice whose paid amount is 0 (the allocation guard on its own);
 *          (d) group unpost of a group whose payment was voided works, saves and re-posts; an active one still blocks;
 *          (r) race: void_payment holds the payment set (its first lock) and is held at an advisory-lock gate before it
 *              reaches the invoice; unpost on the same invoice then runs and finishes without waiting on that set, and
 *              both commit or refuse with no deadlock. The same race against a body that also locks active sets (the
 *              round-3 order) deadlocks, so the probe can see one. Ordered by locks only, no sleeps.
 * Every probe is rolled back. Fixtures use fresh ids each run.
 * Reuse: UNDO_PATHS_CONTAINER=<name> runs against a container already built to just before the candidate (the run still
 * applies the file through its preflight and postflight) and never removes it.
 *
 * Run: node scripts/smoke/prove-unpost-voided-payment-history-real-schema.mjs   (needs Docker; never touches live)
 * Prints UNPOST_VOIDED_PAYMENT_HISTORY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, ref, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225130000_unpost_ignores_voided_payment_history.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
// The file as an operator might run it by hand: `psql -f`, no ON_ERROR_STOP, no single transaction.
function plainApply() {
  const staged = path.join(tmpdir(), `${NAME}-candidate.sql`);
  writeFileSync(staged, candidate, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/candidate.sql`]); } finally { unlinkSync(staged); }
  return docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-f', '/tmp/candidate.sql'], { allowFailure: true });
}
const IMPL = "'public._unpost_invoice_replay_impl_20261015(uuid,uuid,text)'::regprocedure";
const implMd5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = ${IMPL};`);
// Re-issue the impl with a body computed from its current one (expr over prosrc): owner and grants are kept.
const setImplSrc = (expr) => docker([...PSQL], { input: `DO $d$ BEGIN EXECUTE format('CREATE OR REPLACE FUNCTION public._unpost_invoice_replay_impl_20261015(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS %L', (SELECT ${expr} FROM pg_proc WHERE oid = ${IMPL})); END $d$;` });
const ADMIN = USERS.admin;
const RUN = randomUUID().slice(0, 8); // fixture names, keys and ids are fresh each run, so a reused container never collides
const CUST = randomUUID();
const GRP = randomUUID();

// Statement builders (PL/pgSQL inside harness attempt(); u = the invoice, r / r3 = payment replies, r2 = unpost reply).
const line = (desc, cents, type) => `jsonb_build_object('description', '${desc}', 'quantity', 1, 'unit_price_cents', ${cents}, 'charge_type', '${type}')`;
const TWO_LINES = `jsonb_build_array(${line('Service', 60000, 'service')}, ${line('Freight', 40000, 'freight')})`;
const draft = (k) => asUser(`u := public.save_invoice(jsonb_build_object('customer_id', '${CUST}', 'invoice_type', 'misc_charge',
  'invoice_date', current_date::text, 'status', 'draft'), ${TWO_LINES}, '${k}');`);
const post = (k, inv = 'u') => `t := public._invoice_post_version(${inv}); ${asUser(`PERFORM public.post_invoice(${inv}, t, '${k}');`)}`;
const pay = (k, cents, into = 'r', inv = 'u') => asUser(`${into} := public.allocate_payment('${CUST}', ${cents}, 'check', 'P2265', NULL, CURRENT_DATE, 'prover',
  jsonb_build_array(jsonb_build_object('invoice_id', ${inv}, 'amount_cents', ${cents})), '${ADMIN}', '${k}');`);
const voidPay = (k, from = 'r') => asUser(`PERFORM public.void_payment((${from}->>'allocation_set_id')::uuid, 'prover void', '${ADMIN}', '${k}');`);
// allocate_payment before 2026-03-15 (20260213100000) also named the invoice line; 20260315200001 backfilled invoice_id.
// Make the voided payment's rows look like one of those, so the line link is there to break the draft save.
const legacyLink = (from = 'r', inv = 'u') => `UPDATE public.invoice_line_allocations
  SET invoice_item_id = (SELECT id FROM public.invoice_items WHERE invoice_id = ${inv} ORDER BY sort_order, id LIMIT 1)
  WHERE allocation_set_id = (${from}->>'allocation_set_id')::uuid;`;
const unpost = (k) => asUser(`r2 := public.unpost_invoice(u, '${ADMIN}', '${k}');`);
// The editor saves the whole draft back: header plus every line (save deletes and re-adds the lines).
const saveBack = (k, inv = 'u') => `r3 := (SELECT jsonb_agg(jsonb_build_object('id', id, 'description', description, 'quantity', quantity,
    'unit_price_cents', unit_price_cents, 'charge_type', charge_type) ORDER BY sort_order, id) FROM public.invoice_items WHERE invoice_id = ${inv});
  ${asUser(`PERFORM public.save_invoice(jsonb_build_object('id', ${inv}, 'customer_id', '${CUST}', 'invoice_type', 'misc_charge',
    'invoice_date', current_date::text, 'status', 'unposted'), r3, '${k}');`)}`;
const history = (inv = 'u') => `(SELECT count(*) || '/' || count(*) FILTER (WHERE a.invoice_item_id IS NULL) || '/' || coalesce(sum(a.amount_cents), 0)
  FROM public.invoice_line_allocations a JOIN public.allocation_sets s ON s.id = a.allocation_set_id
  WHERE a.invoice_id = ${inv} AND s.entity_type = 'payment' AND NOT s.is_active)`;
const audit = `(SELECT new_values->'voided_payment_history_unlinked' FROM public.financial_audit_log
  WHERE operation_type = 'invoice_unposted' AND entity_id = u ORDER BY created_at DESC LIMIT 1)`;
// The audit row must keep the line each unlinked row named (f0), its allocation (f1), amount and prior invoice_id (f2),
// all read before the unpost.
const linkedLine = `f0 := (SELECT invoice_item_id::text FROM public.invoice_line_allocations WHERE allocation_set_id = (r->>'allocation_set_id')::uuid);
  f1 := (SELECT id::text FROM public.invoice_line_allocations WHERE allocation_set_id = (r->>'allocation_set_id')::uuid);
  f2 := (SELECT invoice_id::text FROM public.invoice_line_allocations WHERE allocation_set_id = (r->>'allocation_set_id')::uuid);`;
const auditKeepsLine = (cents) => `(${audit} = jsonb_build_array(jsonb_build_object('allocation_id', f1, 'invoice_item_id', f0, 'amount_cents', ${cents},
  'invoice_id_before', f2)))::text`;
const status = (inv = 'u') => `(SELECT status FROM public.invoices WHERE id = ${inv})`;
const REFUSED = /^ok\|Cannot unpost invoice \S+ — it has payments, prepay, write-offs, or applied credit/;

const caseA = `${draft('a-s1')} ${post('a-p1')} ${pay('a-pay', 100000)} ${voidPay('a-void')} ${legacyLink()} ${linkedLine}
  ${unpost('a-un')} v := ${status()} || '|' || ${history()} || '|audit ' || coalesce(${auditKeepsLine(100000)}, '-');
  ${saveBack('a-s2')} v := v || '|saved ' || (SELECT count(*) FROM public.invoice_items WHERE invoice_id = u);
  ${post('a-p2')} v := v || '|' || ${status()} || '|' || ${history()};`;
// (a3) a legacy row that names the line but has no invoice_id, or a stale one: unpost still unlinks it (filling a
// missing invoice_id with this invoice, a stale one kept), and the draft saves and re-posts.
const caseA3 = (before, after) => `${draft('a3-s1')} ${post('a3-p1')} ${pay('a3-pay', 100000)} ${voidPay('a3-void')} ${legacyLink()}
  UPDATE public.invoice_line_allocations SET invoice_id = ${before} WHERE allocation_set_id = (r->>'allocation_set_id')::uuid;
  ${linkedLine} ${unpost('a3-un')} v := ${status()} || '|audit ' || coalesce(${auditKeepsLine(100000)}, '-') || '|row '
    || (SELECT (invoice_item_id IS NULL AND invoice_id IS NOT DISTINCT FROM ${after})::text FROM public.invoice_line_allocations WHERE id = f1::uuid);
  ${saveBack('a3-s2')} v := v || '|saved ' || (SELECT count(*) FROM public.invoice_items WHERE invoice_id = u);
  ${post('a3-p2')} v := v || '|' || ${status()};`;
// (a3) stale: a voided row naming a line of this invoice but recording another invoice is left for a person.
const caseA3Stale = (other) => `${draft('a3s-s1')} ${post('a3s-p1')} ${pay('a3s-pay', 100000)} ${voidPay('a3s-void')} ${legacyLink()}
  UPDATE public.invoice_line_allocations SET invoice_id = ${other} WHERE allocation_set_id = (r->>'allocation_set_id')::uuid; ${linkedLine}
  ${refuse(`r2 := public.unpost_invoice(u, '${ADMIN}', 'a3s-un');`)} v := t || '|' || ${status()} || '|row '
    || (SELECT (invoice_item_id::text = f0 AND invoice_id = ${other})::text FROM public.invoice_line_allocations WHERE id = f1::uuid);`;
// (a4) two voided payments, each naming a different line: both are unlinked and audited, and the save goes through.
const caseA4 = `${draft('a4-s1')} ${post('a4-p1')} ${pay('a4-pay1', 60000)} ${pay('a4-pay2', 40000, 'r3')} ${voidPay('a4-void1')} ${voidPay('a4-void2', 'r3')}
  ${legacyLink()} UPDATE public.invoice_line_allocations
    SET invoice_item_id = (SELECT id FROM public.invoice_items WHERE invoice_id = u ORDER BY sort_order, id OFFSET 1 LIMIT 1)
    WHERE allocation_set_id = (r3->>'allocation_set_id')::uuid;
  r2 := (SELECT jsonb_agg(jsonb_build_object('allocation_id', a.id::text, 'invoice_item_id', a.invoice_item_id::text, 'amount_cents', a.amount_cents,
      'invoice_id_before', a.invoice_id::text) ORDER BY a.id) FROM public.invoice_line_allocations a
    WHERE a.allocation_set_id IN ((r->>'allocation_set_id')::uuid, (r3->>'allocation_set_id')::uuid));
  v := (SELECT count(DISTINCT e->>'invoice_item_id')::text FROM jsonb_array_elements(r2) e);
  r3 := r2; ${unpost('a4-un')}
  v := v || '|' || ${status()} || '|audit ' || (${audit} = r3)::text || '|' || ${history()};
  ${saveBack('a4-s2')} v := v || '|saved ' || (SELECT count(*) FROM public.invoice_items WHERE invoice_id = u);
  ${post('a4-p2')} v := v || '|' || ${status()};`;
const caseA2 = `${draft('a2-s1')} ${post('a2-p1')} ${pay('a2-pay', 100000)} ${voidPay('a2-void')} ${legacyLink()}
  ${unpost('a2-un')} ${legacyLink()} BEGIN ${saveBack('a2-s2')} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`;
// Part-paid, so the invoice is still 'posted' and the money check (not the paid-status check) is what refuses.
const caseB = `${draft('b-s1')} ${post('b-p1')} ${pay('b-pay', 60000)} ${refuse(`r2 := public.unpost_invoice(u, '${ADMIN}', 'b-un');`)} v := t;`;
const caseC = `${draft('c-s1')} ${post('c-p1')} ${pay('c-pay1', 60000)} ${pay('c-pay2', 40000, 'r3')} ${voidPay('c-void')}
  ${refuse(`r2 := public.unpost_invoice(u, '${ADMIN}', 'c-un');`)} v := t;`;
// Allocation rows written directly, so paid stays 0 and only the allocation count can block: a non-payment set
// (active or not) and an active payment set still count, also when the row names only one of the lines (lineOnly).
const caseE = (entity, active, lineOnly = false) => { const set = randomUUID(); return `${draft('e-s1')} ${post('e-p1')}
  INSERT INTO public.allocation_sets (id, entity_type, entity_id, customer_id, is_active, created_by, payment_date)
    VALUES ('${set}', '${entity}', u, '${CUST}', ${active}, '${ADMIN}', ${entity === 'payment' ? 'CURRENT_DATE' : 'NULL'});
  INSERT INTO public.invoice_line_allocations (allocation_set_id, invoice_id, invoice_item_id, bill_to_customer_id, split_percentage, amount_cents)
    VALUES ('${set}', ${lineOnly ? 'NULL' : 'u'}, ${lineOnly ? '(SELECT id FROM public.invoice_items WHERE invoice_id = u ORDER BY sort_order, id LIMIT 1)' : 'NULL'},
      '${CUST}', 100, 1000);
  ${refuse(`r2 := public.unpost_invoice(u, '${ADMIN}', 'e-un');`)} v := t || ' paid=' || (SELECT paid_amount_cents FROM public.invoices WHERE id = u);`; };
// The group members' ids, resolved after the seed (a signed-in call cannot read undo_paths).
let G1;
let G2;
const postGroup = (k) => `r3 := (SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id = '${GRP}');
  ${asUser(`PERFORM public.post_invoice_group('${GRP}', '${ADMIN}', r3, '${k}');`)}`;
const unpostGroup = (k) => asUser(`r2 := public.unpost_invoice_group('${GRP}', '${ADMIN}', '${k}');`);
const caseD = () => `u := ${G1}; ${postGroup('d-pg1')} ${pay('d-pay', 60000)} ${voidPay('d-void')} ${legacyLink()} ${linkedLine}
  ${unpostGroup('d-ug')} v := ${status(G1)} || ',' || ${status(G2)} || '|' || ${history()} || '|audit ' || coalesce(${auditKeepsLine(60000)}, '-');
  ${saveBack('d-s2', G1)} ${postGroup('d-pg2')} v := v || '|' || ${status(G1)} || ',' || ${status(G2)} || '|' || ${history()};`;
const caseD2 = () => `u := ${G1}; ${postGroup('d2-pg1')} ${pay('d2-pay1', 60000)} ${voidPay('d2-void')} ${pay('d2-pay2', 20000, 'r', G2)}
  BEGIN ${unpostGroup('d2-ug')} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`;

// (r) Two real sessions. A session's SQL is piped to psql, which runs each statement as it arrives.
function session(sql) {
  const child = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
  if (sql !== undefined) child.stdin.end(sql);
  return { child, done };
}
// Polls a catalog condition until it holds (a lock state, not a time): fails after 60 s.
async function until(sql, label) {
  for (const end = Date.now() + 60000; Date.now() < end;) {
    if (scalar(sql) === 't') return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`timed out waiting for ${label}`);
}
const GATE = 2265001;
const gateLock = (granted) => `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${GATE} AND granted = ${granted});`;
async function race(tag) {
  // A posted invoice part-paid by one active payment (committed).
  const ids = attempt(ADMIN, `${draft(`r-s-${tag}-${RUN}`)} ${post(`r-p-${tag}-${RUN}`)} ${pay(`r-pay-${tag}-${RUN}`, 60000)}
    v := u::text || ',' || (r->>'allocation_set_id');`, { commit: true });
  const [inv, set] = ids.replace(/^ok\|/, '').split(',');
  const gate = session();
  gate.child.stdin.write(`SELECT pg_advisory_lock(${GATE});\n`);
  await until(gateLock(true), 'the gate');
  // void_payment's own order: the payment set first (FOR UPDATE), then the invoice. Held at the gate in between.
  const voider = session(`BEGIN;\n${claims(ADMIN)}\nSELECT 1 FROM public.allocation_sets WHERE id = '${set}' FOR UPDATE;
SELECT pg_advisory_xact_lock(${GATE});
SET LOCAL ROLE authenticated;
SELECT public.void_payment('${set}', 'race', '${ADMIN}', 'r-void-${tag}-${RUN}');
COMMIT;\n`);
  await until(gateLock(false), 'void_payment at the gate');
  const unposter = session(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
SELECT public.unpost_invoice('${inv}', '${ADMIN}', 'r-un-${tag}-${RUN}');
COMMIT;\n`);
  // Unpost either finishes, or waits on a lock (held by void_payment): then open the gate either way.
  let unpostDone = false;
  unposter.done.then(() => { unpostDone = true; });
  for (const end = Date.now() + 60000; !unpostDone && Date.now() < end;) {
    if (scalar(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%unpost_invoice(%');`) === 't') break;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  const waited = !unpostDone;
  gate.child.stdin.end(`SELECT pg_advisory_unlock(${GATE});\n`);
  const [v, un] = await Promise.all([voider.done, unposter.done]);
  await gate.done;
  const after = scalar(`SELECT i.status || '|' || i.paid_amount_cents || '|' || s.is_active FROM public.invoices i, public.allocation_sets s
    WHERE i.id = '${inv}' AND s.id = '${set}';`);
  return { waited, deadlock: /deadlock detected/.test(v.out + un.out), voidOut: v.out, voidCode: v.code, unpostOut: un.out, after };
}

const REUSE = Boolean(process.env.UNDO_PATHS_CONTAINER); // a container already built to just before the candidate
try {
  if (!REUSE) { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  seed(`p2265-drafts-${RUN}`, `INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[P2265] Unpost Farm', true);
    DO $s$ DECLARE a uuid; b uuid; BEGIN
      SET LOCAL ROLE authenticated;
      a := public.save_invoice(jsonb_build_object('customer_id', '${CUST}', 'invoice_type', 'misc_charge', 'invoice_date', current_date::text,
        'status', 'draft'), jsonb_build_array(${line('Group A', 60000, 'service')}), 'p2265-g1-${RUN}');
      b := public.save_invoice(jsonb_build_object('customer_id', '${CUST}', 'invoice_type', 'misc_charge', 'invoice_date', current_date::text,
        'status', 'draft'), jsonb_build_array(${line('Group B', 40000, 'service')}), 'p2265-g2-${RUN}');
      RESET ROLE;
      INSERT INTO undo_paths.ids VALUES ('p2265-g1-${RUN}', a), ('p2265-g2-${RUN}', b);
    END $s$;`);
  // A group is normally drafted by a split; the fixture joins two drafts directly (the split guard refuses that path).
  seed(`p2265-group-${RUN}`, `ALTER TABLE public.invoices DISABLE TRIGGER trg_guard_invoice_terminal_order;
    UPDATE public.invoices SET invoice_group_id = '${GRP}' WHERE id IN (${ref(`p2265-g1-${RUN}`)}, ${ref(`p2265-g2-${RUN}`)});
    ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order;`);
  [G1, G2] = [`p2265-g1-${RUN}`, `p2265-g2-${RUN}`].map((n) => `'${scalar(`SELECT ${ref(n)};`)}'::uuid`);

  {
    // BEFORE: the voided payment's history rows block unpost, alone and in a group.
    assert.match(attempt(ADMIN, caseA), /^P0001\|Cannot unpost invoice \S+ — it has payments/, 'old refusal not reproduced');
    assert.match(attempt(ADMIN, caseD()), /^P0001\|Cannot unpost invoice \S+ — it has payments/, 'old group refusal not reproduced');
    console.log('[before] a posted invoice whose only payment was voided is refused by unpost and by group unpost');

    // A drifted body: plain psql -f keeps going after an error, yet the file changes nothing (one statement writes).
    const pinned = implMd5();
    assert.equal(pinned, '161f18c3ccd6126a6fb683c5160f82dc');
    setImplSrc("prosrc || E'-- drift\\n'");
    const drifted = implMd5();
    assert.notEqual(drifted, pinned);
    const plain = plainApply();
    assert.equal(plain.status, 0, 'plain psql -f keeps going and exits 0');
    assert.match(plain.stderr, /PREFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 changed/);
    assert.doesNotMatch(plain.stderr, /POSTFLIGHT_OK/);
    assert.equal(implMd5(), drifted, 'the drifted body must be untouched');
    setImplSrc("left(prosrc, -length(E'-- drift\\n'))");
    assert.equal(implMd5(), pinned, 'pinned body restored');
    console.log('[apply] drifted body: plain psql -f (no ON_ERROR_STOP) printed PREFLIGHT_FAIL and left the function unchanged');
    const once = apply(['-1']);
    assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
    assert.match(once.stderr, /POSTFLIGHT_OK/);
    const again = apply(['-1']);
    assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 changed/, 're-apply must refuse');
    assert.equal(implMd5(), 'd799306fc9dee0c1489da4a28a3af26e');
    console.log('[apply] applied once with POSTFLIGHT_OK (new body md5 pinned), re-apply refused');
  }

  // (a) unpost, save the draft with its lines, re-post; history rows stay with invoice_id and amount.
  assert.equal(attempt(ADMIN, caseA), 'ok|unposted|1/1/100000|audit true|saved 2|posted|1/1/100000');
  console.log('[a] voided-only invoice: unposts (1 history row unlinked; audit keeps its allocation, line and amount), draft saves with 2 lines, re-posts; history row kept (invoice_id, 100000)');
  // (a2) the unlink is what lets the save through.
  assert.match(attempt(ADMIN, caseA2), /^ok\|.*invoice_line_allocations_invoice_item_id_fkey/);
  console.log('[a2] with the line link put back, the draft save is refused by invoice_line_allocations_invoice_item_id_fkey');
  assert.equal(attempt(ADMIN, caseA3('NULL', 'u')), 'ok|unposted|audit true|row true|saved 2|posted');
  assert.match(attempt(ADMIN, caseA3Stale(G2)),
    /^ok\|UNPOST_HISTORY_NEEDS_HAND_CHECK: invoice \S+ has a voided payment allocation \([0-9a-f-]{36}\) .*\|posted\|row true$/);
  console.log('[a3] a legacy history row naming the line with no invoice_id is unlinked (invoice_id filled) and audited, and the draft saves and re-posts; one recording another invoice refuses with UNPOST_HISTORY_NEEDS_HAND_CHECK and changes nothing');
  assert.equal(attempt(ADMIN, caseA4), 'ok|2|unposted|audit true|2/2/100000|saved 2|posted');
  console.log('[a4] two voided payments on two lines: both unlinked and audited; the draft saves and re-posts');
  // (b), (c), (e) still refused.
  assert.match(attempt(ADMIN, caseB), REFUSED);
  assert.match(attempt(ADMIN, caseC), REFUSED);
  for (const [entity, active, lineOnly] of [['invoice', true], ['invoice', false], ['payment', true], ['payment', true, true]]) {
    assert.match(attempt(ADMIN, caseE(entity, active, lineOnly)), /^ok\|Cannot unpost invoice \S+ — it has payments.* paid=0$/,
      `${entity} ${active} ${lineOnly ? 'line only' : ''}`);
  }
  console.log('[b/c/e] an active payment, one voided plus one active payment, an invoice-type allocation (active or not), and an active payment allocation with paid 0 (naming the invoice, or only a line) still block');
  // (d) group unpost.
  assert.equal(attempt(ADMIN, caseD()), 'ok|unposted,unposted|1/1/60000|audit true|posted,posted|1/1/60000');
  assert.match(attempt(ADMIN, caseD2()), /^ok\|Cannot unpost invoice \S+ — it has payments/);
  console.log('[d] group: voided-only member unposts with its group, saves and re-posts; an active payment on a member still blocks the group');

  // (r) unpost vs void_payment on the same invoice.
  const fixed = await race('fixed');
  assert.equal(fixed.deadlock, false, `deadlock:\n${fixed.voidOut}\n${fixed.unpostOut}`);
  assert.equal(fixed.waited, false, 'unpost must not wait on the payment set void_payment holds');
  assert.match(fixed.unpostOut, /Cannot unpost invoice \S+ — it has payments/);
  assert.equal(fixed.voidCode, 0, fixed.voidOut);
  assert.equal(fixed.after, 'posted|0|false');
  console.log('[r] void_payment holding the payment set at a gate: unpost refused at once without waiting on it; void_payment then committed; no deadlock');
  // The probe sees a deadlock when unpost also locks active sets after the invoice (the round-3 order).
  const lockAll = "replace(prosrc, E'WHERE s.entity_type = ''payment'' AND s.is_active = false\\n             AND s.id IN', 'WHERE s.id IN')";
  setImplSrc(lockAll);
  assert.notEqual(implMd5(), 'd799306fc9dee0c1489da4a28a3af26e', 'mutation applied');
  const inverted = await race('inverted');
  assert.equal(inverted.waited, true, 'with active sets locked, unpost waits on the set void_payment holds');
  assert.equal(inverted.deadlock, true, `expected a deadlock:\n${inverted.voidOut}\n${inverted.unpostOut}`);
  const candidateBody = candidate.split('AS $function$')[1].split('$function$')[0];
  setImplSrc(`$body$${candidateBody}$body$::text`);
  assert.equal(implMd5(), 'd799306fc9dee0c1489da4a28a3af26e', 'candidate body restored');
  console.log('[r] control: with active sets also locked after the invoice, the same race deadlocks (detected), so the probe can see one');

  console.log('\nUNPOST_VOIDED_PAYMENT_HISTORY_PROOF_PASS');
} finally {
  if (!REUSE && process.env.KEEP_CONTAINER !== '1') removeContainer();
}
