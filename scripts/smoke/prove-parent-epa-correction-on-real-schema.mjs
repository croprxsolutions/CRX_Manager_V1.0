#!/usr/bin/env node
/**
 * Real-schema proof for 20270227100000_parent_epa_correction_on (PAR-1 7.7): with the switch on, an admin corrects a
 * parent's EPA number and every OLD record keeps printing the number it was made with. Builds the baseline plus every
 * migration before the candidate (shared undo-paths harness; includes 20270201100000 and KI-195's 20270225193000), then:
 *   FIDELITY: the replayed year-end source has the md5 the candidate pins;
 *   BEFORE:   the correction is refused PRODUCT_PARENT_EPA_CORRECTION_OFF;
 *   APPLY:    refused outside one transaction; commits; a second apply stops at its preflight;
 *   AFTER (as the real callers): a rep is refused; the admin's correction writes the parent and both sizes in one
 *     event; the completed job's spray proof, the applicator-sheet read (job_product_epa), the posted invoice line, the
 *     RUP record, the delivery's brand pick and the application record keep the old number (their rows are unchanged
 *     byte for byte); the year-end summary prints the line's old number; an unsprayed job shows the new number; a
 *     retry returns the same receipt and a stale version is refused.
 *
 * Run: node scripts/smoke/prove-parent-epa-correction-on-real-schema.mjs   (needs Docker)
 * Prints PARENT_EPA_CORRECTION_ON_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-par1on-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, docker, USERS, id, NAME, ROOT } = await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270227100000_parent_epa_correction_on.sql';
const YEAR_END_MD5 = 'd7b64aefdb2699854ab257c2893376e0';
const OLD = '524-475', NEW = '100-497-37686';
const CUST = id('d1'), FIELD = id('d2'), PARENT = id('d3'), S1 = id('d4'), S2 = id('d5');
const J_DONE = id('d6'), J_OPEN = id('d7'), INV = id('d8'), BRAND = id('d9'), PICK = id('dc');

const as = (uid, sql) => `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated; ${sql} COMMIT;`;
const run = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
const ok = (uid, sql) => { const r = run(as(uid, sql)); assert.equal(r.status, 0, out(r)); return r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1); };
const refused = (uid, sql, re) => { const r = run(as(uid, sql)); assert.notEqual(r.status, 0, `expected a refusal: ${sql}`); assert.match(out(r), re); };
const version = () => scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${PARENT}';`);
const correct = (key, ver = version(), epa = NEW) => `SELECT public.correct_product_parent_identity('${PARENT}', ${ver},
  '{"generic_epa_registration": "${epa}"}'::jsonb, 'number does not exist at EPA', 'supplier invoice shows ${epa}', '${key}');`;
const productEpa = (pid) => scalar(`SELECT epa_registration FROM public.products WHERE id = '${pid}';`);
// Every old record that carries a copy, byte for byte (the correction must write none of them).
const OLD_RECORDS = ['invoice_items', 'invoices', 'rup_sales_records', 'delivery_item_brands', 'job_product_epa', 'application_records', 'job_chemicals', 'product_parent_brands'];
const fingerprint = () => OLD_RECORDS.map((t) => `${t}:${scalar(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) FROM public.${t} x;`)}`).join(' ');
const proofEpa = (job) => JSON.parse(ok(USERS.admin, `SELECT public.get_job_proof_data(p_job_id => '${job}')::text;`))
  .products.find((p) => p.product_id === S1 || p.product_name === '[PROVER] Atz 2.5 Gal')?.epa_registration;
const yearEndEpa = () => JSON.parse(ok(USERS.admin, `SELECT public.get_customer_year_end_summary('${CUST}', 2026)::text;`))
  .product_usage.filter((r) => r.product_name === '[PROVER] Atz 2.5 Gal').map((r) => r.epa_registration);
const applyFile = (single) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ...(single ? ['-1'] : []), '-f', '/tmp/candidate.sql'], { allowFailure: true });

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();

  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.get_customer_year_end_summary(uuid,integer)'::regprocedure;`),
    YEAR_END_MD5, 'the replayed year-end summary is the body the candidate pins');
  console.log('[PAR1-ON] FIDELITY: replayed get_customer_year_end_summary matches the pinned body');

  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] PAR1 Farm', true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] PAR1 Field', 80);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active) VALUES
      ('${S1}', '[PROVER] Atz 2.5 Gal', 'PAR1-1', 'liquid', 'Gal', 'Herbicide', '${OLD}', 10, 15, true),
      ('${S2}', '[PROVER] Atz Bulk', 'PAR1-2', 'liquid', 'Gal', 'Herbicide', '${OLD}', 10, 15, true);
    INSERT INTO public.product_parents (id, name, product_form, category, generic_epa_registration, created_by, updated_by) VALUES
      ('${PARENT}', '[PROVER] Atz', 'liquid', 'Herbicide', '${OLD}', '${USERS.admin}', '${USERS.admin}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ('${S1}', '${PARENT}', 'package', '${USERS.admin}'), ('${S2}', '${PARENT}', 'bulk', '${USERS.admin}');
    INSERT INTO public.product_parent_brands (id, parent_id, brand_name, epa_registration, created_by, updated_by) VALUES
      ('${BRAND}', '${PARENT}', '[PROVER] Atz (Winfield)', '1381-158', '${USERS.admin}', '${USERS.admin}');
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by, completed_at) VALUES
      ('${J_DONE}', 'PAR1-DONE', '${CUST}', 'completed', current_date, '${USERS.admin}', now()),
      ('${J_OPEN}', 'PAR1-OPEN', '${CUST}', 'scheduled', current_date, '${USERS.admin}', NULL);
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES ('${J_DONE}', '${FIELD}', 80, 0), ('${J_OPEN}', '${FIELD}', 80, 0);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, customer_supplied, sort_order) VALUES
      ('${J_DONE}', '${S1}', 10, 'Gal', 0.125, 'Gal', 0, true, 0), ('${J_OPEN}', '${S1}', 10, 'Gal', 0.125, 'Gal', 0, true, 0);
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, posted_by, posted_at, total_amount_cents, season) VALUES
      ('${INV}', 'PAR1-INV', '${CUST}', 'chemical_sale', 'posted', '${USERS.admin}', '${USERS.admin}', now(), 3000, 2026);
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${INV}', '${S1}', '[PROVER] Atz line', 2, 1500, 3000, 1000, '${OLD}');
    SET session_replication_role = origin;
    SELECT public._job_epa_freeze('${J_DONE}');`);
  // A posted restricted-use record and a delivery brand pick, written as their own functions would leave them.
  const optional = run(`SET session_replication_role = replica;
    INSERT INTO public.rup_sales_records (invoice_id, invoice_item_id, product_id, customer_id, product_name, epa_registration,
        quantity, unit, buyer_name, sale_date)
      SELECT '${INV}', ii.id, '${S1}', '${CUST}', '[PROVER] Atz S1', '${OLD}', 2, 'gal', '[PROVER] buyer', current_date
        FROM public.invoice_items ii WHERE ii.invoice_id = '${INV}';
    INSERT INTO public.delivery_item_brands (id, delivery_item_id, delivery_id, product_id, source, parent_id, parent_brand_id,
        brand_name, epa_registration, quantity, entered_by)
      VALUES ('${PICK}', '${id('da')}', '${id('db')}', '${S1}', 'parent', '${PARENT}', '${BRAND}',
        '[PROVER] Atz (Winfield)', '1381-158', 1, '${USERS.admin}');
    INSERT INTO public.application_records (record_number, source_type, source_id, customer_id, field_id, application_date, product_data)
      VALUES ('PAR1-AR', 'job', '${J_DONE}', '${CUST}', '${FIELD}', current_date,
        jsonb_build_array(jsonb_build_object('product_id', '${S1}', 'epa_registration', '${OLD}')));`);
  assert.equal(optional.status, 0, `seeding a RUP record: ${out(optional)}`);
  assert.equal(scalar(`SELECT epa_registration FROM public.job_product_epa WHERE job_id = '${J_DONE}' AND product_id = '${S1}';`), OLD);
  console.log('[PAR1-ON] seeded a parent with two sizes at 524-475, a completed (kept) and an open job, a posted invoice and a RUP record');

  refused(USERS.admin, correct('k-off'), /PRODUCT_PARENT_EPA_CORRECTION_OFF/);
  console.log('[PAR1-ON] BEFORE: an admin\'s EPA correction is refused (switched off)');

  docker(['cp', path.join(ROOT, 'supabase', 'migrations', CANDIDATE), `${NAME}:/tmp/candidate.sql`]);
  let r = applyFile(false);
  assert.notEqual(r.status, 0); assert.match(out(r), /PARENT_EPA_CORRECTION_ON_NOT_IN_TRANSACTION/);
  assert.equal(scalar('SELECT public._product_parent_epa_correction_enabled();'), 'f', 'a refused apply leaves the switch off');
  r = applyFile(true);
  assert.equal(r.status, 0, `the candidate applies: ${out(r)}`);
  r = applyFile(true);
  assert.notEqual(r.status, 0); assert.match(out(r), /PARENT_EPA_CORRECTION_ON_PREFLIGHT: the switch is missing or already on/);
  console.log('[PAR1-ON] APPLY: refused outside one transaction; commits; a second apply stops at the preflight');

  assert.deepEqual(yearEndEpa(), [OLD]);
  const before = fingerprint();
  refused(USERS.rep, correct('k-rep'), /ADMIN_REQUIRED/);
  const ver = version();
  const receipt = JSON.parse(ok(USERS.admin, correct('k-fix', ver)));
  assert.equal(scalar(`SELECT generic_epa_registration FROM public.product_parents WHERE id = '${PARENT}';`), NEW);
  assert.equal(productEpa(S1), NEW); assert.equal(productEpa(S2), NEW);
  assert.equal(receipt.sizes.length, 2);
  assert.equal(scalar(`SELECT event_type FROM public.product_parent_events WHERE id = ${receipt.event_id};`), 'identity_corrected');
  console.log('[PAR1-ON] AFTER: a rep is refused; the admin\'s correction wrote the parent and both sizes in one logged event');
  refused(USERS.admin, `SELECT public.correct_product_parent_identity('${PARENT}', ${version()},
    '{"generic_epa_registration": null}'::jsonb, 'clear it', 'none', 'k-clear');`, /an EPA number cannot be cleared/);
  refused(USERS.admin, `SELECT public.preview_product_parent_identity_correction('${PARENT}', '{"generic_epa_registration": ""}'::jsonb);`,
    /an EPA number cannot be cleared/);
  assert.equal(productEpa(S1), NEW);
  console.log('[PAR1-ON] AFTER: clearing the EPA number is refused (save and preview)');

  assert.equal(fingerprint(), before, 'an old record (invoice line, invoice, RUP record, delivery pick, kept job number, application record, job line or brand) changed');
  assert.equal(proofEpa(J_DONE), OLD, 'the completed job\'s spray proof keeps 524-475');
  assert.equal(scalar(as(USERS.rep, `SELECT epa_registration FROM public.job_product_epa WHERE job_id = '${J_DONE}' AND product_id = '${S1}';`)), OLD,
    'the kept row the applicator sheet / report / WPS read as a rep (src/lib/jobEpa.ts, unit-tested by KI-195) keeps 524-475');
  assert.deepEqual(yearEndEpa(), [OLD], 'the year-end summary prints the line\'s 524-475, not the product\'s new number');
  assert.equal(scalar(`SELECT epa_registration FROM public.invoice_items WHERE invoice_id = '${INV}';`), OLD);
  assert.equal(scalar(`SELECT epa_registration FROM public.rup_sales_records WHERE invoice_id = '${INV}';`), OLD);
  assert.equal(scalar(`SELECT epa_registration FROM public.product_parent_brands WHERE id = '${BRAND}';`), '1381-158', 'the brand keeps its own number');
  assert.equal(scalar(`SELECT epa_registration FROM public.delivery_item_brands WHERE id = '${PICK}';`), '1381-158', 'the delivery brand pick keeps its number');
  assert.equal(scalar(`SELECT product_data->0->>'epa_registration' FROM public.application_records WHERE record_number = 'PAR1-AR';`), OLD,
    'the job logbook record keeps 524-475');
  assert.equal(proofEpa(J_OPEN), NEW, 'a job not sprayed yet shows the corrected number');
  console.log('[PAR1-ON] AFTER: old records unchanged byte for byte; spray proof, kept job number, year-end summary, invoice line, RUP record and brand keep 524-475; the unsprayed job shows 100-497-37686');

  // A line saved with no copy for a size that has a number (e.g. a writer that bypassed the fill trigger) falls back to
  // the size's number in the year-end, and blocks the next correction until it is saved (PRODUCT_PARENT_EPA_RECORD_UNSAVED).
  psql(`SET session_replication_role = replica;
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${INV}', '${S1}', '[PROVER] Atz blank line', 1, 1500, 1500, 1000, NULL);`);
  assert.deepEqual(yearEndEpa().sort(), [NEW, OLD].sort(), 'a blank line falls back to the product; the copied line keeps its own');
  refused(USERS.admin, correct('k-blank', version(), '524-477'), /PRODUCT_PARENT_EPA_RECORD_UNSAVED/);
  assert.equal(productEpa(S1), NEW, 'the refused correction changed nothing');

  assert.deepEqual(JSON.parse(ok(USERS.admin, correct('k-fix', ver))), receipt, 'a retry returns the same receipt');
  refused(USERS.admin, correct('k-stale', ver, '524-477'), /STALE|version/i);
  assert.equal(productEpa(S1), NEW);
  console.log('[PAR1-ON] a retried correction returns the same receipt; a stale version is refused');
  // Post-apply cost-exposure keys of the year-end chain (ship.md: carried in the allowlist).
  docker(['cp', path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql'), `${NAME}:/tmp/cost.sql`]);
  const keys = run(`\\i /tmp/cost.sql`).stdout.split(/\r?\n/).filter((l) => /year_end/.test(l)).map((l) => l.split('|')[0]);
  console.log(`[PAR1-ON] post-apply cost-exposure keys: ${keys.join(' ; ')}`);
  const allow = fs.readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'allowlist.json'), 'utf8');
  assert.equal(keys.length, 2, 'the cost-exposure sweep ran and listed both year-end functions');
  for (const key of keys) assert.ok(allow.includes(`"${key.trim()}"`), `allowlist carries ${key}`);
  console.log('PARENT_EPA_CORRECTION_ON_PROOF_PASS');
} finally {
  removeContainer();
}
