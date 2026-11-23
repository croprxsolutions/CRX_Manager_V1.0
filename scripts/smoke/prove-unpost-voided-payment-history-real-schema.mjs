#!/usr/bin/env node
/**
 * Real-schema proof for 20270225130000_unpost_ignores_voided_payment_history.sql (#2265).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Every invoice is made, posted, paid and voided through
 * the app's own functions (save_invoice, post_invoice / post_invoice_group, allocate_payment, void_payment).
 *   BEFORE: a posted invoice whose only payment was voided cannot be unposted (alone or in its group).
 *   APPLY:  autocommit refused, POSTFLIGHT_OK, re-apply refused by the md5 pin.
 *   AFTER:  (a) it unposts; the draft saves with its lines and re-posts; the voided payment's rows keep invoice_id and
 *               amount, lose only their line link, and the audit row keeps each one's allocation, line and amount;
 *          (a3) the same for a legacy row naming the line with no invoice_id (filled with this invoice) or a stale one;
 *          (a2) without that unlink, the draft save is refused by invoice_line_allocations_invoice_item_id_fkey;
 *          (b) an active payment still blocks; (c) one voided and one active payment still block;
 *          (e) a non-payment allocation still blocks, even on an inactive set, and so does an active payment
 *              allocation on an invoice whose paid amount is 0 (the allocation guard on its own);
 *          (d) group unpost of a group whose payment was voided works, saves and re-posts; an active one still blocks.
 * Every probe is rolled back. Fixtures use fresh ids each run.
 * Reuse: UNDO_PATHS_CONTAINER=<name> runs against a container already built to just before the candidate (the run still
 * applies the file through its preflight and postflight) and never removes it.
 *
 * Run: node scripts/smoke/prove-unpost-voided-payment-history-real-schema.mjs   (needs Docker; never touches live)
 * Prints UNPOST_VOIDED_PAYMENT_HISTORY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, ref, attempt, asUser, refuse, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225130000_unpost_ignores_voided_payment_history.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
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

    const auto = apply();
    assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
    const once = apply(['-1']);
    assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
    assert.match(once.stderr, /POSTFLIGHT_OK/);
    const again = apply(['-1']);
    assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 changed/, 're-apply must refuse');
    console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');
  }

  // (a) unpost, save the draft with its lines, re-post; history rows stay with invoice_id and amount.
  assert.equal(attempt(ADMIN, caseA), 'ok|unposted|1/1/100000|audit true|saved 2|posted|1/1/100000');
  console.log('[a] voided-only invoice: unposts (1 history row unlinked; audit keeps its allocation, line and amount), draft saves with 2 lines, re-posts; history row kept (invoice_id, 100000)');
  // (a2) the unlink is what lets the save through.
  assert.match(attempt(ADMIN, caseA2), /^ok\|.*invoice_line_allocations_invoice_item_id_fkey/);
  console.log('[a2] with the line link put back, the draft save is refused by invoice_line_allocations_invoice_item_id_fkey');
  for (const [before, after, label] of [['NULL', 'u', 'no invoice_id'], [G2, G2, 'a stale invoice_id']]) {
    assert.equal(attempt(ADMIN, caseA3(before, after)), 'ok|unposted|audit true|row true|saved 2|posted', label);
  }
  console.log('[a3] a legacy history row naming the line with no invoice_id (filled) or a stale one (kept) is unlinked and audited; the draft saves and re-posts');
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

  console.log('\nUNPOST_VOIDED_PAYMENT_HISTORY_PROOF_PASS');
} finally {
  if (!REUSE && process.env.KEEP_CONTAINER !== '1') removeContainer();
}
