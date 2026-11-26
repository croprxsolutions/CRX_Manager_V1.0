#!/usr/bin/env node
/**
 * Real-schema proof for 20270308160000_parent_epa_correction_refuses_open_work (#2579): a parent EPA correction is
 * refused while any size has work in progress, and allowed once that work is finished. Builds the baseline plus every
 * migration before the candidate (shared undo-paths harness; the correction is switched on by 20270307180000), then:
 *   APPLY:  refused outside one transaction; commits; a second apply stops at its preflight;
 *   AS THE REAL CALLERS (admin; preview and save): each kind of open work alone refuses PRODUCT_PARENT_EPA_OPEN_WORK
 *     and names it (scheduled, in-progress, completed-not-invoiced job; unreviewed or approved unbilled blend ticket;
 *     draft or unposted invoice), on either size; the same work finished, cancelled, rejected, billed, posted or
 *     deleted does not; another parent's work does not; a formulation-only correction is not refused; more than 10
 *     items list 10 and "and N more"; a refused save changes nothing; with no open work the correction commits.
 *
 * Run: node scripts/smoke/prove-parent-epa-open-work-real-schema.mjs   (needs Docker)
 * Prints PARENT_EPA_OPEN_WORK_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-par1work-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, docker, USERS, id, NAME, ROOT } = await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270308160000_parent_epa_correction_refuses_open_work.sql';
const OLD = '524-475', NEW = '100-497-37686';
const CUST = id('e1'), PARENT = id('e2'), S1 = id('e3'), S2 = id('e4'), OTHER = id('e5');
const JOB = id('e6'), TICKET = id('e7'), INV = id('e8'), POSTED = id('e9'), BTINV = id('ea');

const as = (uid, sql) => `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated; ${sql} COMMIT;`;
const run = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
const ok = (uid, sql) => { const r = run(as(uid, sql)); assert.equal(r.status, 0, out(r)); return r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1); };
const refused = (uid, sql, re) => { const r = run(as(uid, sql)); assert.notEqual(r.status, 0, `expected a refusal: ${sql}`); assert.match(out(r), re); return out(r); };
const version = () => scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${PARENT}';`);
const preview = (changes = `{"generic_epa_registration": "${NEW}"}`) =>
  `SELECT public.preview_product_parent_identity_correction('${PARENT}', '${changes}'::jsonb);`;
const correct = (key, changes = `{"generic_epa_registration": "${NEW}"}`) => `SELECT public.correct_product_parent_identity('${PARENT}', ${version()},
  '${changes}'::jsonb, 'number does not exist at EPA', 'supplier invoice shows ${NEW}', '${key}');`;
const parentEpa = () => scalar(`SELECT generic_epa_registration FROM public.product_parents WHERE id = '${PARENT}';`);
const seed = (sql) => psql(`SET session_replication_role = replica; ${sql}`);
let n = 0;
// Both callers refuse, name the work, and change nothing.
const state = () => scalar(`SELECT concat_ws('|', pp.generic_epa_registration, pp.parent_version, pp.formulation_type, pp.safener,
  (SELECT string_agg(epa_registration, ',' ORDER BY id) FROM public.products WHERE id IN ('${S1}', '${S2}')),
  (SELECT count(*) FROM public.product_parent_events)) FROM public.product_parents pp WHERE pp.id = '${PARENT}';`);
const blocked = (what, re) => {
  const before = state();
  refused(USERS.admin, preview(), re);
  refused(USERS.admin, correct(`k-${++n}`), re);
  refused(USERS.admin, correct(`k-${++n}`, `{"generic_epa_registration": "${NEW}", "safener": "x"}`), re);
  assert.equal(state(), before, `the refused correction changed nothing: parent, sizes, version, events (${what})`);
  console.log(`[OPEN-WORK] refused (preview and save): ${what}`);
};
const allowed = (what) => { ok(USERS.admin, preview()); console.log(`[OPEN-WORK] not blocking: ${what}`); };
const OPEN = /PRODUCT_PARENT_EPA_OPEN_WORK/;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  assert.equal(scalar('SELECT public._product_parent_epa_correction_enabled();'), 't', 'the correction is switched on (20270307180000)');

  seed(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Work Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active) VALUES
      ('${S1}', '[PROVER] Atz 2.5 Gal', 'WRK-1', 'liquid', 'Gal', 'Herbicide', '${OLD}', 10, 15, true),
      ('${S2}', '[PROVER] Atz Bulk', 'WRK-2', 'liquid', 'Gal', 'Herbicide', '${OLD}', 10, 15, true),
      ('${OTHER}', '[PROVER] Other', 'WRK-3', 'liquid', 'Gal', 'Herbicide', '100-1070', 10, 15, true);
    INSERT INTO public.product_parents (id, name, product_form, category, generic_epa_registration, created_by, updated_by) VALUES
      ('${PARENT}', '[PROVER] Atz', 'liquid', 'Herbicide', '${OLD}', '${USERS.admin}', '${USERS.admin}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ('${S1}', '${PARENT}', 'package', '${USERS.admin}'), ('${S2}', '${PARENT}', 'bulk', '${USERS.admin}');
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, posted_by, posted_at, total_amount_cents, season) VALUES
      ('${POSTED}', 'WRK-POSTED', '${CUST}', 'field_application', 'posted', '${USERS.admin}', '${USERS.admin}', now(), 0, 2026);`);

  // APPLY
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/candidate.sql'], {
    input: fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n') });
  const applyFile = (single) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(single ? ['-1'] : []), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  // Before the candidate a scheduled job does not block (the 20270307180000 rule).
  seed(`INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by) VALUES
      ('${JOB}', 'WRK-JOB', '${CUST}', 'scheduled', current_date, '${USERS.admin}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit) VALUES ('${JOB}', '${S1}', 10, 'Gal');`);
  allowed('scheduled job, BEFORE the candidate');
  let r = applyFile(false);
  assert.notEqual(r.status, 0); assert.match(out(r), /PARENT_EPA_OPEN_WORK_NOT_IN_TRANSACTION/);
  r = applyFile(true);
  assert.equal(r.status, 0, `the candidate applies: ${out(r)}`);
  r = applyFile(true);
  assert.notEqual(r.status, 0); assert.match(out(r), /PARENT_EPA_OPEN_WORK_PREFLIGHT/);
  assert.equal(scalar(`SELECT proacl::text FROM pg_proc WHERE oid = 'public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure;`),
    scalar(`SELECT '{postgres=X/postgres}'`), 'still owner-only');
  console.log('[OPEN-WORK] APPLY: refused outside one transaction; commits; a second apply stops at the preflight');

  // Jobs (W1, W2)
  refused(USERS.rep, correct('k-rep'), /ADMIN_REQUIRED/);
  const msg = refused(USERS.admin, preview(), OPEN);
  assert.match(msg, /job WRK-JOB \(scheduled\)/, 'the refusal names the job and its status');
  blocked('scheduled job', /job WRK-JOB \(scheduled\)/);
  seed(`UPDATE public.jobs SET status = 'in_progress' WHERE id = '${JOB}';`);
  blocked('in-progress job', /job WRK-JOB \(in progress\)/);
  seed(`UPDATE public.jobs SET status = 'completed', completed_at = now() WHERE id = '${JOB}';`);
  blocked('completed job with no invoice', /job WRK-JOB \(completed, not invoiced\)/);
  seed(`UPDATE public.job_chemicals SET product_id = '${S2}' WHERE job_id = '${JOB}';`);
  blocked('the same job on the other size', /job WRK-JOB/);
  seed(`UPDATE public.jobs SET status = 'invoiced', invoice_id = '${POSTED}' WHERE id = '${JOB}';`);
  allowed('invoiced job (posted invoice)');
  seed(`UPDATE public.jobs SET status = 'completed' WHERE id = '${JOB}';`);
  allowed('completed job linked to a live invoice');
  seed(`UPDATE public.invoices SET deleted_at = now() WHERE id = '${POSTED}';`);
  blocked('completed job whose invoice was deleted', /job WRK-JOB \(completed, not invoiced\)/);
  seed(`UPDATE public.invoices SET deleted_at = NULL WHERE id = '${POSTED}';`);
  seed(`UPDATE public.invoices SET status = 'voided' WHERE id = '${POSTED}';`);
  blocked('completed job whose invoice was voided', /job WRK-JOB \(completed, not invoiced\)/);
  seed(`UPDATE public.invoices SET status = 'posted' WHERE id = '${POSTED}';`);
  seed(`UPDATE public.jobs SET status = 'cancelled', invoice_id = NULL WHERE id = '${JOB}';`);
  allowed('cancelled job');
  seed(`UPDATE public.jobs SET status = 'scheduled', deleted_at = now() WHERE id = '${JOB}';`);
  allowed('deleted scheduled job');
  seed(`UPDATE public.jobs SET deleted_at = NULL WHERE id = '${JOB}'; UPDATE public.job_chemicals SET product_id = '${OTHER}' WHERE job_id = '${JOB}';`);
  allowed('scheduled job for another parent\'s product');

  // Blend tickets (W3)
  seed(`INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, customer_id, review_status, payment_status) VALUES
      ('${TICKET}', 'WRK-BT', '${USERS.admin}', '${CUST}', 'unreviewed', 'unbilled');
    INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity) VALUES ('${TICKET}', '${S1}', '[PROVER] Atz', 5);`);
  blocked('unreviewed unbilled blend ticket', /blend ticket WRK-BT \(unbilled\)/);
  seed(`UPDATE public.blend_tickets SET review_status = 'approved' WHERE id = '${TICKET}';`);
  blocked('approved unbilled blend ticket', /blend ticket WRK-BT \(unbilled\)/);
  seed(`UPDATE public.blend_tickets SET payment_status = 'billed' WHERE id = '${TICKET}';`);
  blocked('billed blend ticket with no application record yet', /blend ticket WRK-BT \(no application record\)/);
  seed(`INSERT INTO public.application_records (record_number, source_type, source_id, customer_id, application_date, product_data)
    VALUES ('WRK-AR', 'blend_ticket', '${TICKET}', '${CUST}', current_date, '[]'::jsonb);`);
  allowed('billed blend ticket with its application record');
  seed(`UPDATE public.blend_tickets SET payment_status = 'no_charge' WHERE id = '${TICKET}';`);
  allowed('no-charge blend ticket with its application record');
  seed(`UPDATE public.blend_tickets SET payment_status = 'unbilled' WHERE id = '${TICKET}';`);
  blocked('unbilled blend ticket with its application record', /blend ticket WRK-BT \(unbilled\)/);
  seed(`DELETE FROM public.application_records WHERE record_number = 'WRK-AR';`);
  for (const [set, what] of [[`review_status = 'rejected', deleted_at = NULL`, 'rejected'], [`review_status = 'approved', deleted_at = now()`, 'deleted']]) {
    seed(`UPDATE public.blend_tickets SET payment_status = 'unbilled', ${set} WHERE id = '${TICKET}';`);
    allowed(`blend ticket ${what}`);
  }

  // A ticket tied to a live job is counted through the job (Sol r1: its own application record would deduct twice).
  seed(`UPDATE public.blend_tickets SET deleted_at = NULL, job_id = '${JOB}' WHERE id = '${TICKET}';
    UPDATE public.jobs SET status = 'invoiced', invoice_id = '${POSTED}' WHERE id = '${JOB}';`);
  blocked('the ticket tied to an invoiced job that does not list its product', /blend ticket WRK-BT \(unbilled\)/);
  seed(`UPDATE public.job_chemicals SET product_id = '${S1}' WHERE job_id = '${JOB}';`);
  allowed('unbilled ticket with no application record, tied to an invoiced job listing its product');
  seed(`UPDATE public.jobs SET status = 'cancelled', invoice_id = NULL WHERE id = '${JOB}';`);
  blocked('the same ticket once its job is cancelled', /blend ticket WRK-BT \(unbilled\)/);
  // A job billed through its blend ticket counts as billed (job invoicing then refuses BLEND_TICKET_ALREADY_BILLED).
  seed(`UPDATE public.jobs SET status = 'completed', completed_at = now() WHERE id = '${JOB}';
    UPDATE public.job_chemicals SET product_id = '${S1}' WHERE job_id = '${JOB}';
    UPDATE public.blend_tickets SET payment_status = 'billed' WHERE id = '${TICKET}';
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, posted_by, posted_at, total_amount_cents, season, blend_ticket_id) VALUES
      ('${BTINV}', 'WRK-BTINV', '${CUST}', 'field_application', 'posted', '${USERS.admin}', '${USERS.admin}', now(), 0, 2026, '${TICKET}');`);
  allowed('completed job billed through its blend ticket');
  seed(`UPDATE public.invoices SET status = 'voided' WHERE id = '${BTINV}';`);
  blocked('the same job once that ticket invoice is voided', /job WRK-JOB \(completed, not invoiced\)/);
  seed(`UPDATE public.blend_tickets SET deleted_at = now() WHERE id = '${TICKET}';
    UPDATE public.jobs SET status = 'scheduled' WHERE id = '${JOB}';
    UPDATE public.job_chemicals SET product_id = '${OTHER}' WHERE job_id = '${JOB}';`);
  allowed('linked work cleared');

  // Invoices (W4)
  seed(`INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, total_amount_cents, season) VALUES
      ('${INV}', 'WRK-DRAFT', '${CUST}', 'chemical_sale', 'draft', '${USERS.admin}', 1500, 2026);
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${INV}', '${S2}', '[PROVER] Atz line', 1, 1500, 1500, 1000, '${OLD}');`);
  blocked('draft invoice', /invoice WRK-DRAFT \(draft\)/);
  seed(`UPDATE public.invoices SET status = 'unposted', invoice_type = 'field_application' WHERE id = '${INV}';`);
  blocked('unposted field invoice', /invoice WRK-DRAFT \(unposted\)/);
  for (const st of ['posted', 'paid', 'voided', 'cancelled']) {
    seed(`UPDATE public.invoices SET status = '${st}', posted_by = '${USERS.admin}', posted_at = now() WHERE id = '${INV}';`);
    allowed(`invoice ${st}`);
  }
  seed(`UPDATE public.invoices SET status = 'draft', posted_by = NULL, posted_at = NULL, deleted_at = now() WHERE id = '${INV}';`);
  allowed('deleted draft invoice');

  // A formulation-only correction is not an EPA change.
  seed(`UPDATE public.invoices SET deleted_at = NULL WHERE id = '${INV}';`);
  refused(USERS.admin, preview(), OPEN);
  ok(USERS.admin, correct('k-form', '{"formulation_type": "SC"}'));
  assert.equal(scalar(`SELECT formulation_type FROM public.product_parents WHERE id = '${PARENT}';`), 'SC');
  console.log('[OPEN-WORK] a formulation-only correction is not refused by open work');

  // More than 10 items: 10 named, then "and N more".
  seed(`INSERT INTO public.invoices (customer_id, invoice_number, invoice_type, status, created_by, total_amount_cents, season)
      SELECT '${CUST}', 'WRK-MANY-' || lpad(g::text, 2, '0'), 'chemical_sale', 'draft', '${USERS.admin}', 0, 2026 FROM generate_series(1, 11) g;
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration)
      SELECT i.id, '${S1}', '[PROVER] line', 1, 0, 0, 0, '${OLD}' FROM public.invoices i WHERE i.invoice_number LIKE 'WRK-MANY-%';`);
  const many = refused(USERS.admin, preview(), OPEN);
  assert.match(many, /and 2 more/, '12 items: 10 listed and "and 2 more"');
  assert.equal((many.match(/invoice WRK-/g) || []).length, 10);
  console.log('[OPEN-WORK] 12 open invoices: 10 named and "and 2 more"');

  // The more specific restricted-use refusal still wins over open work (its remedy is "do not post it").
  seed(`UPDATE public.invoices SET status = 'draft' WHERE id = '${INV}';
    INSERT INTO public.epa_registrations (epa_registration, rup_status, created_by, updated_by) VALUES ('${NEW}', 'yes', '${USERS.admin}', '${USERS.admin}');`);
  blocked('a draft saved under a non-restricted number, correcting to a restricted one', /PRODUCT_PARENT_EPA_RUP_DRAFT: invoice WRK-DRAFT/);
  seed(`DELETE FROM public.epa_registrations WHERE epa_registration = '${NEW}';`);

  // All work finished: the correction commits.
  seed(`UPDATE public.invoices SET status = 'posted', posted_by = '${USERS.admin}', posted_at = now() WHERE invoice_number LIKE 'WRK-%';`);
  const receipt = JSON.parse(ok(USERS.admin, correct('k-final')));
  assert.equal(parentEpa(), NEW);
  assert.equal(scalar(`SELECT epa_registration FROM public.products WHERE id = '${S1}';`), NEW);
  assert.equal(scalar(`SELECT epa_registration FROM public.products WHERE id = '${S2}';`), NEW);
  assert.equal(receipt.sizes.length, 2);
  console.log('[OPEN-WORK] all work finished: the correction commits and writes both sizes');
  console.log('PARENT_EPA_OPEN_WORK_PROOF_PASS');
} finally {
  removeContainer();
}
