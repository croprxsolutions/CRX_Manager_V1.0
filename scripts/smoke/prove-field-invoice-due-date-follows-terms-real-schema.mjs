#!/usr/bin/env node
/**
 * Real-schema proof for 20261120100000_field_invoice_due_date_follows_owner_terms.sql (KI-14).
 *
 * Builds the checked-in baseline and every post-baseline migration BEFORE the candidate in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Customers are on Net 15,
 * Net 30, Due on receipt, '2/10 Net 30' and blank terms. Then:
 *   BEFORE  every transfer stamps invoice date + 30, whatever the terms (the defect); three transfers are
 *           committed so the candidate's one-pass touch of editable field invoices has rows to fix.
 *   APPLY   the candidate applies; bodies keep owner/settings/ACL; one billing-save overload; the trigger
 *           function is not callable by app roles; the flag is readable through invoices_postable.
 *   BACKFILL no existing due date moves: blank terms gain the owner's terms, a date equal to that stamp is
 *           derived, any other date (the old +30 on a Net 15 owner, a typed date) is kept and marked typed.
 *   AFTER   each owner (split included) is due on its own terms, with its terms on the invoice; posting
 *           keeps both; every other invoice and line column matches BEFORE.
 *   RULES   customer re-term after transfer moves nothing; unpost + re-term + repost re-derives; an
 *           invoice-date change re-derives; a typed date (even one equal to the stamp) survives both;
 *           save_invoice-style writes infer the flag from the date they write; a posted row is untouched.
 *   BILLING per-invoice terms save each owner's own terms and dates; malformed maps are refused; an old
 *           app tab (no map, or a JSON null map) saves PO, notes and discounts and leaves every invoice's
 *           terms, due date and typed flag as they were (a mixed split stays mixed, a typed date stays);
 *           replay returns the first result and refuses a changed map under the same key.
 *   RE-APPLY refused by the preflight, nothing changes.
 *
 * Run: node scripts/smoke/prove-field-invoice-due-date-follows-terms-real-schema.mjs   (needs Docker; never touches live)
 * Prints FIELD_INVOICE_DUE_DATE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, docker, id, USERS, ROOT, NAME } from './undo-paths/harness.mjs';

const CANDIDATE = '20261120100000_field_invoice_due_date_follows_owner_terms.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const ADMIN = USERS.admin;
const [C15, C30, CRCPT, CBLANK, C210] = ['c1', 'c2', 'c3', 'c4', 'c5'].map(id);
const PROD = id('d1');
const JOBS = { J15: 'e1', J30: 'e2', JRCPT: 'e3', JSPLIT: 'e4', JBLANK: 'e5', J210: 'e6', JPRE30: 'e7', JPRE15: 'e8', JPREBLANK: 'e9', JPOST15: 'e10', JPOST30: 'e11', JPRETYPED: 'e12' };
const J = Object.fromEntries(Object.entries(JOBS).map(([k, v]) => [k, id(v)]));
const JOB_CUSTOMER = { J15: C15, J30: C30, JRCPT: CRCPT, JSPLIT: C15, JBLANK: CBLANK, J210: C210, JPRE30: C30, JPRE15: C15, JPREBLANK: CBLANK, JPOST15: C15, JPOST30: C30, JPRETYPED: C15 };
const AFTER_JOBS = ['J15', 'J30', 'JRCPT', 'JSPLIT', 'JBLANK', 'J210'];

function applyCandidate() {
  const staged = path.join(tmpdir(), `${NAME}-candidate.sql`);
  writeFileSync(staged, candidate, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/candidate.sql`]); } finally { unlinkSync(staged); }
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/candidate.sql'], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

function seed() {
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active, payment_terms) VALUES
      ('${C15}', '[PROVER] Net 15 Farm', true, 'Net 15'),
      ('${C30}', '[PROVER] Net 30 Farm', true, 'Net 30'),
      ('${CRCPT}', '[PROVER] Receipt Farm', true, 'Due on receipt'),
      ('${CBLANK}', '[PROVER] Blank Terms Farm', true, NULL),
      ('${C210}', '[PROVER] Discount Farm', true, '2/10 Net 30');
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, container_unit, current_cost, is_active) VALUES
      ('${PROD}', '[PROVER] Herbicide', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true);
    ${Object.entries(J).map(([k, job], n) => `
    INSERT INTO public.fields (id, customer_id, field_name, crop_type) VALUES ('${id(`f${n}`)}', '${JOB_CUSTOMER[k]}', '[PROVER] ${k}', 'corn');
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date) VALUES ('${job}', 'PROVER-${k}', '${JOB_CUSTOMER[k]}', 'completed', CURRENT_DATE);
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat) VALUES ('${job}', '${id(`f${n}`)}', 10);
    INSERT INTO public.job_chemicals (job_id, product_id, unit, rate_unit, quantity, price_per_unit_cents, cost_per_unit_cents, rate_per_acre)
      VALUES ('${job}', '${PROD}', 'Gal', 'gal/ac', 20, 2500, 1800, 2);`).join('')}
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${id('f3')}', '${C15}', 60, true), ('${id('f3')}', '${C30}', 40, false);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT count(*) FROM public.jobs WHERE id IN ('${Object.values(J).join("','")}');`), String(Object.keys(J).length));
}

// SQL fragments for attempt() bodies (they run as postgres; app calls run as authenticated).
const transfer = (k) => `SET LOCAL ROLE authenticated; PERFORM public.transfer_job_to_invoice('${J[k]}', '${ADMIN}', 'p-' || gen_random_uuid()); RESET ROLE;`;
const post = (k) => `
  FOR u IN SELECT id FROM public.invoices WHERE job_id = '${J[k]}' AND invoice_group_id IS NULL LOOP
    t := public._invoice_post_version(u);
    SET LOCAL ROLE authenticated; PERFORM public.post_invoice(u, t, 'pp-' || gen_random_uuid()); RESET ROLE;
  END LOOP;
  FOR u IN SELECT DISTINCT invoice_group_id FROM public.invoices WHERE job_id = '${J[k]}' AND invoice_group_id IS NOT NULL LOOP
    SELECT jsonb_object_agg(id::text, public._invoice_post_version(id)) INTO r FROM public.invoices WHERE invoice_group_id = u;
    SET LOCAL ROLE authenticated; PERFORM public.post_invoice_group(u, '${ADMIN}', r, 'pg-' || gen_random_uuid()); RESET ROLE;
  END LOOP;`;
// "<terms>=+<days>[*]" per invoice, by customer; * marks a typed (custom) due date.
const summary = (k, withFlag = true) => `SELECT string_agg(COALESCE(i.payment_terms, '<blank>') || '=+' || (i.due_date - i.invoice_date)
    ${withFlag ? "|| CASE WHEN i.due_date_is_custom THEN '*' ELSE '' END" : ''} || CASE WHEN i.status = 'posted' THEN ' posted' ELSE '' END, ', ' ORDER BY i.customer_id)
  INTO v FROM public.invoices i WHERE i.job_id = '${J[k]}';`;
const rowsJson = (k) => `SELECT jsonb_agg(jsonb_build_object(
    'row', to_jsonb(i) - 'id' - 'invoice_number' - 'created_at' - 'updated_at' - 'posted_at' - 'invoice_group_id' - 'due_date' - 'payment_terms' - 'due_date_is_custom',
    'items', (SELECT jsonb_agg(to_jsonb(ii) - 'id' - 'invoice_id' - 'created_at' - 'updated_at' ORDER BY ii.sort_order, ii.description)
                FROM public.invoice_items ii WHERE ii.invoice_id = i.id)) ORDER BY i.customer_id)::text
  INTO v FROM public.invoices i WHERE i.job_id = '${J[k]}';`;
const billing = (k, args) => `SELECT array_agg(id ORDER BY customer_id) INTO STRICT f0 FROM public.invoices WHERE job_id = '${J[k]}';
  SET LOCAL ROLE authenticated;
  PERFORM public.update_field_app_invoice_billing(p_invoice_ids => f0::uuid[], p_performed_by => '${ADMIN}'::uuid,
    p_idempotency_key => 'pb-' || gen_random_uuid() ${args ? `, ${args}` : ''});
  RESET ROLE;`;
// A per-invoice terms map over the job's invoices in customer order: entries [terms, dueExpr|null].
const termsMap = (k, entries) => `p_terms_by_invoice => (SELECT jsonb_object_agg(x.id::text, jsonb_build_object('payment_terms', e.terms, 'due_date', e.due))
    FROM (SELECT id, row_number() OVER (ORDER BY customer_id) n FROM public.invoices WHERE job_id = '${J[k]}') x
    JOIN (VALUES ${entries.map(([terms, due], n) => `(${n + 1}, ${terms === null ? 'NULL::text' : `'${terms}'`}, ${due === null ? 'NULL::date' : due})`).join(', ')}) e(n, terms, due) ON e.n = x.n)`;
const ok = (body, label) => {
  const res = attempt(ADMIN, body);
  assert.match(res, /^ok\|/, `${label}: ${res}`);
  return res.slice(3);
};
const refused = (body, pattern, label) => {
  const res = attempt(ADMIN, body);
  assert.doesNotMatch(res, /^ok\|/, `${label}: was not refused`);
  assert.match(res, pattern, `${label}: refused for the wrong reason: ${res}`);
};

const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seed();

  // BEFORE: +30 for every customer; posting keeps it.
  const before = {};
  for (const k of AFTER_JOBS) {
    const s = ok(`${transfer(k)} ${post(k)} ${summary(k, false)}`, `BEFORE ${k}`);
    assert.ok(s.split(', ').every((x) => /=\+30 posted$/.test(x)), `BEFORE ${k}: expected +30 everywhere, got ${s}`);
    before[k] = ok(`${transfer(k)} ${post(k)} ${rowsJson(k)}`, `BEFORE rows ${k}`);
  }
  assert.equal(JSON.parse(before.JSPLIT).length, 2, 'the split job did not bill two owners');
  console.log('[prover] BEFORE: every transfer stamps +30 whatever the terms, and posting keeps it');
  // Committed editable invoices for the one-pass touch.
  for (const k of ['JPRE30', 'JPRE15']) assert.match(attempt(ADMIN, transfer(k), { commit: true }), /^ok\|/);
  // A draft with no due date at all (a save can leave one): the touch fills it, and the postflight allows that.
  assert.match(attempt(ADMIN, `${transfer('JPREBLANK')} UPDATE public.invoices SET due_date = NULL WHERE job_id = '${J.JPREBLANK}';`, { commit: true }), /^ok\|/);
  assert.equal(ok(`${summary('JPRE15', false)}`, 'pre'), '<blank>=+30');
  assert.match(attempt(ADMIN, `${transfer('JPRETYPED')} UPDATE public.invoices SET due_date = due_date + 5 WHERE job_id = '${J.JPRETYPED}';`, { commit: true }), /^ok\|/);
  // Committed posted invoices from before the change: a +30 on a Net 15 owner, and one that matches Net 30.
  for (const k of ['JPOST15', 'JPOST30']) assert.match(attempt(ADMIN, `${transfer(k)} ${post(k)}`, { commit: true }), /^ok\|/);

  // APPLY.
  const applied = applyCandidate();
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  const state = (sig) => scalar(`SELECT prosecdef || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) || '|' || proacl::text FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
  assert.equal(state('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'), 'true|search_path=public, pg_temp|postgres|{postgres=X/postgres}');
  assert.equal(state('public._update_field_app_invoice_billing_replay_impl_20261015(uuid[],text,text,text,date,text,text,jsonb,uuid,text,jsonb)'), 'true|search_path=public, pg_temp|postgres|{postgres=X/postgres}');
  assert.equal(state('public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text,jsonb)'), 'true|search_path=public, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname IN ('update_field_app_invoice_billing', '_update_field_app_invoice_billing_replay_impl_20261015');"), '2');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._field_invoice_due_date_follows_terms()', 'EXECUTE');`), 'f', `${role} can call the trigger function`);
  }
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text,jsonb)', 'EXECUTE');"), 'f');
  assert.equal(scalar("SELECT has_column_privilege('authenticated', 'public.invoices', 'due_date_is_custom', 'SELECT');"), 't');
  assert.equal(scalar("SELECT has_column_privilege('authenticated', 'public.invoices', 'due_date_is_custom', 'UPDATE');"), 'f');
  assert.equal(ok(`SET LOCAL ROLE authenticated; SELECT count(*)::text INTO v FROM public.invoices_postable WHERE due_date_is_custom IS NOT NULL; RESET ROLE;`, 'view'), '6');
  console.log('[prover] APPLY: owners, settings and ACLs as reviewed; one billing-save overload; flag readable through invoices_postable');

  // Parser table (the screens' TypeScript copy checks the same cases).
  const PARSER = [['Net 15', 15], ['Net 30', 30], ['net_30', 30], ['NET-45', 45], ['2/10 Net 30', 30], ['2% 10 net 30', 30], ['1/15 Net 60', 60],
    ['Due on receipt', 0], ['  due upon receipt ', 0], ['receipt', 0], ['Immediately', 0], [null, 30], ['', 30], ['COD', 30],
    ['15 days', 15], ['Net 0', 30], ['Net 400', 30], ['Net 99999999999999999999', 30], ['Net 365', 365]];
  for (const [terms, days] of PARSER) {
    assert.equal(scalar(`SELECT public.parse_payment_terms_days(${terms === null ? 'NULL' : `'${terms}'`});`), String(days), `parse(${terms})`);
  }
  console.log(`[prover] PARSER: ${PARSER.length} cases ('2/10 Net 30' -> 30)`);

  // BACKFILL.
  assert.equal(ok(summary('JPRE30'), 'backfill 30'), 'Net 30=+30');
  assert.equal(ok(summary('JPREBLANK'), 'backfill blank'), 'Net 30=+30');
  assert.equal(ok(summary('JPRE15'), 'backfill 15'), 'Net 15=+30*');
  assert.equal(ok(summary('JPRETYPED'), 'backfill typed'), 'Net 15=+35*');
  console.log('[prover] BACKFILL: no existing due date moves; blank terms gain the owner terms; a missing date is filled; a date off its stamp (old +30 on Net 15, typed) is kept as typed');

  // AFTER: each owner on its own terms, set at transfer and kept by posting.
  const EXPECT = { J15: 'Net 15=+15', J30: 'Net 30=+30', JRCPT: 'Due on receipt=+0', JSPLIT: 'Net 15=+15, Net 30=+30', JBLANK: 'Net 30=+30', J210: '2/10 Net 30=+30' };
  for (const k of AFTER_JOBS) {
    assert.equal(ok(`${transfer(k)} ${summary(k)}`, `AFTER ${k}`), EXPECT[k], `AFTER ${k} at transfer`);
    const posted = EXPECT[k].split(', ').map((x) => `${x} posted`).join(', ');
    assert.equal(ok(`${transfer(k)} ${post(k)} ${summary(k)}`, `AFTER post ${k}`), posted, `AFTER ${k} posted`);
    assert.equal(ok(`${transfer(k)} ${post(k)} ${rowsJson(k)}`, `AFTER rows ${k}`), before[k], `${k}: a column other than due date or terms changed`);
  }
  console.log(`[prover] AFTER: ${AFTER_JOBS.map((k) => EXPECT[k]).join(' | ')}; posting keeps them; every other column unchanged`);

  // RULES.
  assert.equal(ok(`${transfer('J15')} UPDATE public.customers SET payment_terms = 'Net 30' WHERE id = '${C15}'; ${post('J15')} ${summary('J15')}`, 're-term'),
    'Net 15=+15 posted', 'RE-TERM: a customer terms change moved the invoice');
  assert.equal(ok(`${transfer('J15')} ${post('J15')}
    SELECT id INTO u FROM public.invoices WHERE job_id = '${J.J15}';
    SET LOCAL ROLE authenticated; PERFORM public.unpost_invoice(u, '${ADMIN}', 'up-' || gen_random_uuid()); RESET ROLE;
    ${billing('J15', termsMap('J15', [['Net 30', null]]))} ${post('J15')} ${summary('J15')}`, 'unpost'), 'Net 30=+30 posted', 'UNPOST: re-term did not re-derive');
  assert.equal(ok(`${transfer('J15')} UPDATE public.invoices SET invoice_date = invoice_date - 1 WHERE job_id = '${J.J15}';
    SELECT (due_date - (now() AT TIME ZONE 'America/Chicago')::date)::text INTO v FROM public.invoices WHERE job_id = '${J.J15}';`, 'date'), '14', 'DATE: an invoice-date change did not re-derive');
  // A typed date equal to the stamp survives a terms change and an invoice-date change.
  assert.equal(ok(`${transfer('J15')} SELECT due_date INTO f1 FROM public.invoices WHERE job_id = '${J.J15}';
    ${billing('J15', termsMap('J15', [['Net 15', 'f1::date']]))}
    ${billing('J15', termsMap('J15', [['Net 30', 'f1::date']]))}
    UPDATE public.invoices SET invoice_date = invoice_date - 1 WHERE job_id = '${J.J15}';
    SELECT (due_date = f1::date)::text || '|' || payment_terms || '|' || due_date_is_custom INTO v FROM public.invoices WHERE job_id = '${J.J15}';`, 'custom'),
  'true|Net 30|true', 'CUSTOM: a typed date moved');
  // save_invoice-style writes (no flag): a new date is typed; NULL follows the terms.
  assert.equal(ok(`${transfer('J15')} UPDATE public.invoices SET due_date = due_date + 3 WHERE job_id = '${J.J15}'; ${summary('J15')}`, 'legacy date'), 'Net 15=+18*');
  assert.equal(ok(`${transfer('J15')} UPDATE public.invoices SET due_date = due_date + 3 WHERE job_id = '${J.J15}';
    UPDATE public.invoices SET due_date = NULL WHERE job_id = '${J.J15}'; ${summary('J15')}`, 'legacy null'), 'Net 15=+15');
  refused(`${transfer('J15')} UPDATE public.invoices SET due_date_is_custom = true, due_date = NULL WHERE job_id = '${J.J15}';`, /custom_due_date_present|FIELD_INVOICE_CUSTOM_DUE_DATE_REQUIRED/, 'custom without date');
  // A posted row is never re-derived by the trigger.
  assert.equal(ok(`${transfer('J15')} ${post('J15')} UPDATE public.customers SET payment_terms = 'Net 30' WHERE id = '${C15}';
    UPDATE public.invoices SET internal_notes = 'x' WHERE job_id = '${J.J15}'; ${summary('J15')}`, 'posted'), 'Net 15=+15 posted');
  // Unposting an invoice posted before the change keeps a date that differs from its terms as typed.
  const unpost = (k) => `SELECT id INTO u FROM public.invoices WHERE job_id = '${J[k]}';
    SET LOCAL ROLE authenticated; PERFORM public.unpost_invoice(u, '${ADMIN}', 'up-' || gen_random_uuid()); RESET ROLE;`;
  assert.equal(ok(`${unpost('JPOST15')} ${summary('JPOST15')}`, 'unpost old 15'), 'Net 15=+30*', 'UNPOST-OLD: a pre-change typed date moved');
  assert.equal(ok(`${unpost('JPOST15')} UPDATE public.invoices SET internal_notes = 'x' WHERE job_id = '${J.JPOST15}'; ${summary('JPOST15')}`, 'unpost old 15 edit'), 'Net 15=+30*');
  assert.equal(ok(`${unpost('JPOST30')} ${summary('JPOST30')}`, 'unpost old 30'), 'Net 30=+30', 'UNPOST-OLD: a matching stamp became typed');
  console.log('[prover] RULES: customer re-term moves nothing; unpost+re-term+repost re-derives; date edit re-derives; typed dates survive; legacy writes infer the flag; posted untouched; unposting a pre-change invoice keeps its off-terms date');

  // BILLING: per-owner terms on the split.
  assert.equal(ok(`${transfer('JSPLIT')} ${billing('JSPLIT', termsMap('JSPLIT', [['Net 30', null], ['Due on receipt', null]]))} ${summary('JSPLIT')}`, 'split per-owner'),
    'Net 30=+30, Due on receipt=+0');
  assert.equal(ok(`${transfer('JSPLIT')} ${billing('JSPLIT', termsMap('JSPLIT', [['Net 15', "(now() AT TIME ZONE 'America/Chicago')::date + 9"], [null, null]]))} ${summary('JSPLIT')}`, 'split custom + blank'),
    'Net 15=+9*, Net 30=+30');
  assert.equal(ok(`${transfer('JSPLIT')} ${billing('JSPLIT', termsMap('JSPLIT', [['Net 15', null], ['Net 30', null]]))} ${post('JSPLIT')} ${summary('JSPLIT')}`, 'split post'),
    'Net 15=+15 posted, Net 30=+30 posted');
  const bad = [
    [termsMap('JSPLIT', [['Net 15', null]]), /exactly one entry/],
    [`p_terms_by_invoice => '[]'::jsonb`, /must be an object/],
    [`p_payment_terms => 'Net 30', ${termsMap('JSPLIT', [['Net 15', null], ['Net 30', null]])}`, /not both/],
    [`p_terms_by_invoice => (SELECT jsonb_object_agg(id::text, '{"payment_terms":"Net 15"}'::jsonb) FROM public.invoices WHERE job_id = '${J.JSPLIT}')`, /YYYY-MM-DD/],
    [`p_terms_by_invoice => (SELECT jsonb_object_agg(id::text, '{"payment_terms":"Net 15","due_date":"2026-02-30"}'::jsonb) FROM public.invoices WHERE job_id = '${J.JSPLIT}')`, /date|range/i],
    [`p_terms_by_invoice => (SELECT jsonb_object_agg(id::text, '{"payment_terms":15,"due_date":null}'::jsonb) FROM public.invoices WHERE job_id = '${J.JSPLIT}')`, /YYYY-MM-DD/],
    [`p_terms_by_invoice => (SELECT jsonb_object_agg(id::text, '"Net 15"'::jsonb) FROM public.invoices WHERE job_id = '${J.JSPLIT}')`, /YYYY-MM-DD/],
  ];
  for (const [args, pattern] of bad) refused(`${transfer('JSPLIT')} ${billing('JSPLIT', args)}`, pattern, `bad map ${args.slice(0, 60)}`);
  // An old app tab (no map): PO, notes and discounts save; terms, due date and the typed flag stay as they were.
  const mixed = `${transfer('JSPLIT')} ${billing('JSPLIT', termsMap('JSPLIT', [['Net 15', "(now() AT TIME ZONE 'America/Chicago')::date + 9"], ['Due on receipt', null]]))}`;
  assert.equal(ok(`${mixed} ${summary('JSPLIT')}`, 'old tab before'), 'Net 15=+9*, Due on receipt=+0');
  const billed = (k) => `SELECT string_agg(concat_ws('|', purchase_order_ref, header_notes, footer_notes, internal_notes, discount_earned_cents, discount_date), ', ' ORDER BY customer_id)
    INTO v FROM public.invoices WHERE job_id = '${J[k]}';`;
  const oldTab = (k, extra) => `p_purchase_order_ref => 'PO-OLD', p_header_notes => 'hn', p_footer_notes => 'fn', p_internal_notes => 'in',
    p_discounts => (SELECT jsonb_object_agg(id::text, '{"amount_cents":500,"date":"2026-12-01"}'::jsonb) FROM public.invoices WHERE job_id = '${J[k]}'), ${extra}`;
  for (const [extra, label] of [["p_payment_terms => 'Net 30', p_due_date => DATE '2027-01-01'", 'old tab terms + date'], ['p_payment_terms => NULL', 'old tab blank'],
    ["p_terms_by_invoice => 'null'::jsonb", 'old tab json null']]) {
    assert.equal(ok(`${mixed} ${billing('JSPLIT', oldTab('JSPLIT', extra))} ${summary('JSPLIT')}`, label), 'Net 15=+9*, Due on receipt=+0', `${label}: terms or due date moved`);
    assert.equal(ok(`${mixed} ${billing('JSPLIT', oldTab('JSPLIT', extra))} ${billed('JSPLIT')}`, `${label} saved`),
      'PO-OLD|hn|fn|in|500|2026-12-01, PO-OLD|hn|fn|in|500|2026-12-01', `${label}: PO/notes/discount did not save`);
  }
  assert.equal(ok(`${transfer('J30')} ${billing('J30', oldTab('J30', "p_payment_terms => 'Due on receipt'"))} ${summary('J30')}`, 'old tab single'), 'Net 30=+30');
  assert.equal(ok(`${transfer('J30')} ${billing('J30', oldTab('J30', "p_payment_terms => 'Due on receipt'"))} ${billed('J30')}`, 'old tab single saved'), 'PO-OLD|hn|fn|in|500|2026-12-01');
  // Replay: same key, same map -> first result; same key, changed map -> refused.
  assert.equal(ok(`${transfer('J15')} SELECT array_agg(id) INTO STRICT f0 FROM public.invoices WHERE job_id = '${J.J15}';
    SET LOCAL ROLE authenticated;
    r := public.update_field_app_invoice_billing(p_invoice_ids => f0::uuid[], p_performed_by => '${ADMIN}'::uuid, p_idempotency_key => 'replay-1', ${termsMap('J15', [['Net 30', null]])});
    r2 := public.update_field_app_invoice_billing(p_invoice_ids => f0::uuid[], p_performed_by => '${ADMIN}'::uuid, p_idempotency_key => 'replay-1', ${termsMap('J15', [['Net 30', null]])});
    BEGIN
      r3 := public.update_field_app_invoice_billing(p_invoice_ids => f0::uuid[], p_performed_by => '${ADMIN}'::uuid, p_idempotency_key => 'replay-1', ${termsMap('J15', [['Net 45', null]])});
      t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    RESET ROLE;
    v := (r = r2)::text || '|' || (t ~ 'IDEMPOTENCY');`, 'replay'), 'true|true', 'REPLAY');
  console.log('[prover] BILLING: per-owner terms and typed dates save per invoice; 7 malformed maps refused; old tabs (no map) save PO/notes/discounts and every invoice keeps its terms, due date and typed flag; replay holds');

  // RE-APPLY.
  const again = applyCandidate();
  assert.notEqual(again.status, 0, 'the candidate applied twice');
  assert.match(again.output, /KI14_(SOURCE_DRIFT|ALREADY_APPLIED)/);
  console.log('[prover] RE-APPLY: refused by the preflight');
  console.log('FIELD_INVOICE_DUE_DATE_PROOF_PASS');
} finally {
  if (KEEP) console.log(`[prover] kept container ${NAME}`);
  else removeContainer();
}
