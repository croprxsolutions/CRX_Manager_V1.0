#!/usr/bin/env node
/**
 * Real-schema proof for M9 (refunds paid outside CRX, prepay balance check, returned checks):
 * 20270227140000_m9_refunds_and_returned_checks.sql. Design: docs/plans/2026-11-23-m9-refunds-returned-checks-DESIGN.md.
 * Written first (stage 1: every case failed because the functions did not exist, with setup passing).
 *
 * Container setup and replay copied from prove-month-close-payments-recheck-real-schema.mjs, replaying EVERY
 * post-baseline migration (M9 is the last file replayed); a second apply of M9 must stop at its preflight.
 * Setup (real writers, committed): an admin, a rep, one customer per case; $500.00 Prepayment Manager checks
 * (create_prepay_check_splits); a $1,237.00 invoice dated 2026-10-05 paid by a $1,537.00 Record Payment dated
 * 2026-10-15 (allocate_payment, $300.00 kept as prepay); October 2026 closed through close_accounting_period.
 * Cases (each rolled back, so they never see each other):
 *   1) refund $300 of a $500 prepay check: prepay $200, a refund record, stored balance = credits = $200, the check's
 *      original amount (Month-End's figure) unchanged, the balance check agrees.
 *   2) refund $600 of $500: refused, nothing changed.
 *   3) a refund paid 2026-10-20 (October closed) is recorded today with its paid-on date kept.
 *   4) balance check: clean -> ok; +100 cents planted in customers.prepay_balance_cents -> ok=false, difference 100;
 *      the check changes nothing.
 *   5) returned check (dated today) for the October payment: invoice back to $1,237.00 unpaid, prepay -$300.00,
 *      October still closed, the October payment rows and October's Month-End payments unchanged, November's
 *      payments show the -$1,537.00 reversal, a returned-check entry dated today.
 *   6) a rep is refused each function; same-key replay returns the same result once; an edited retry is refused.
 *   7) a Prepayment Manager check entered in closed October and partly applied there is returned in the open month:
 *      its invoice reopens, the credit ends at $0 (original kept, application row kept), October unchanged, this
 *      month's payments show -$500.00; a second return of the same check is refused.
 *   8) guards: void_payment refuses a returned payment and one whose prepay was refunded; a credit with a refund
 *      cannot have its balance edited (an unchanged-balance edit still saves its notes) or be deleted; an invoice whose
 *      prepay application was reversed by a returned check cannot be voided (the application row must stay).
 *   9) the recompute trigger (risk 1): a refund survives apply, batch apply, invoice void and void_payment on the same
 *      customer; every balance agrees with the balance check at the end.
 *  10) Sol round 1: only a check payment can be returned; an edited or deleted check credit is refused; a refund only
 *      draws credit received by its date, refuses a drifted credit (the balance check names it per credit) and trims
 *      every kind of whitespace; a returned payment reopens a past-due invoice as overdue, counts only the invoice
 *      that went from paid to owing, and its invoice cannot be voided (INVOICE_HAS_RETURNED_PAYMENT).
 *  11) two sessions: a return and a void of the same payment, each way round, wait on each other (no deadlock) and
 *      the second is refused (the order is forced with an advisory-lock blocker and lock-wait polling, no sleeps).
 *  12) Sol round 2: a duplicate outside refund needs confirming; a drifted credit blocks a refund even when it is
 *      not drawn (round 4: the whole customer must agree); a return
 *      refuses a drifted credit and a payment whose records do not add up to the check; two checks entered with one
 *      number in one transaction are two payments and come back separately; the recompute trigger function is not
 *      executable by API roles.
 *  13) the integrity gate (round 3): each kind of disagreement is refused RECORD_NEEDS_HAND_CHECK with its reason.
 *  14) Sol round 4: the whole customer must agree (a credit minted by another customer's payment, a stored balance
 *      below the credits' total); a Prepayment Manager entry that lists only some of its buckets, or whose buckets do
 *      not add up to its total, is refused; a return refuses a draft or deleted invoice; a rep cannot read the
 *      reversal tables; void_payment refuses a set that is not a payment; -infinity dates are refused. Round 5: a
 *      credit with no known source, a credit its payment never funded, an entry mixing two receipts, a negative
 *      allocation row and a payment dated -infinity are refused.
 *  15) Sol round 6: a check credit with no creation entry, a negative active allocation on an invoice the return
 *      touches, an entry recorded for another customer and a payment minting another customer's credit are refused.
 *  16) Sol round 8: every Prepayment Manager entry naming a check credit of the customer must be one whole receipt of
 *      this customer, for refunds too (a $500 credit whose entry records $50; one split check recorded as two entries);
 *      refunding one bucket freezes its siblings' amounts (edit / delete refused).
 *  17) Sol round 8 (fixed in round 9): an entry matches its credits only as an array of distinct ids (an object-key
 *      entry, a bucket listed twice and a non-list entry are refused); a refund locks every credit of the customer, so
 *      an edit of a sibling bucket waits for it and is then refused (two sessions, committed).
 *
 * Run: node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs   (needs Docker)
 * Prints M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS when every case passes; otherwise lists each failing case and why and
 * exits 1. Every run replays the chain up to M9, snapshots it (database m9_before), then applies M9 on its own.
 * CRX_PROVER_KEEP_CONTAINER=1 keeps the container; CRX_PROVER_REPLAY_ONLY=1 stops after the snapshot (kept);
 * CRX_PROVER_CONTAINER=<name> reuses a kept container: resets to the snapshot, applies M9, seeds and runs the cases.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REUSE = process.env.CRX_PROVER_CONTAINER || null;
const NAME = REUSE ?? `crx-m9-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = REUSE !== null || process.env.CRX_PROVER_KEEP_CONTAINER === '1' || process.env.CRX_PROVER_REPLAY_ONLY === '1';
const M9 = path.join(ROOT, 'supabase', 'migrations', '20270227140000_m9_refunds_and_returned_checks.sql');
// Marks the containers this script creates; reuse mode refuses any other container.
const LABEL = 'crx.prover.m9-refunds-returned-checks';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // Need live's storage.objects policies, which this database does not have; neither touches money.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
  // Its preflight pins stage_offline_action as 20261217100000 (ledger-only above) leaves it. Delivery driver checks
  // only: its one check_period_open mention is an unchanged call in a re-emitted delivery completion body, which no M9
  // case runs. Reviewed bytes pinned below, so an edit trips the TOUCHED guard again.
  '20270227110000_delivery_driver_checks_need_a_driver.sql',
]);
const LEDGER_ONLY_REVIEWED = new Map([['20270227110000_delivery_driver_checks_need_a_driver.sql', '78a24c2bf56e5901b771575e2c818ef2dccbaf3781cbd2bb159a0d762724714e']]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// Parked/ledger-only files must not touch what M9 relies on.
const TOUCHED = /(prepay_credits|prepay_applications|allocation_sets|invoice_line_allocations|prepay_balance_cents|_month_payments_received|close_accounting_period|check_period_open)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres', db = DB) { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user, options.db), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
// 20261104150000 (WP-PM-9, live) pins three live function bodies that the historical LF replay
// does not reproduce; install them exactly as PM-9's own prover does, right before that file.
const FORMS_SEED_EACH = '20261104150000_product_forms_seed_each.sql';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};
function bodyFrom(file, expression) {
  const match = expression.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  assert.ok(match, `${file} no longer contains its pinned function body`);
  return match[1];
}
function restoreLiveBodies() {
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  const field = bodyFrom('20260630180000_field_app_pricing_unit_fix.sql',
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/);
  const seededConvert = bodyFrom(FORMS_SEED_EACH,
    /CREATE OR REPLACE FUNCTION public.convert_to_gl_lb\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/).replaceAll('\r\n', '\n');
  const seedArm = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;\n";
  assert.equal(seededConvert.split(seedArm).length - 1, 1);
  const convert = seededConvert.replace(seedArm, '');
  psql(`CREATE OR REPLACE FUNCTION public.validate_product_units() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $live_validate$${validate}$live_validate$;`);
  psql(`CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
      p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)
    RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
    AS $live_field$${field}$live_field$;`);
  psql(`CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(
      p_total_applied numeric, p_rate_unit text, p_product_form text)
    RETURNS TABLE(converted_value numeric, converted_unit text) LANGUAGE plpgsql IMMUTABLE
    SET search_path = public AS $live_convert$${convert}$live_convert$;`);
  for (const [signature, expected] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${signature}'::regprocedure;`),
      expected, `${signature} is not the pinned live body`);
  }
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  for (const name of [...PARKED, ...LEDGER_ONLY]) {
    const file = all.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED / LEDGER_ONLY lists)`);
    const reviewed = LEDGER_ONLY_REVIEWED.get(name) === createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.ok(reviewed || !TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  // M9 is applied on its own after the snapshot; later migrations are not replayed (this proof is about M9).
  const at = all.findIndex((f) => path.basename(f) === path.basename(M9));
  assert.ok(at >= 0, 'M9 must be in the replay plan');
  return all.slice(0, at);
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--label', `${LABEL}=1`, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === '20270106110000_invoice_brands_rup.sql') {
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations, last ${path.basename(files.at(-1))}`);
}

// ---------------------------------------------------------------------------------------------------------------
const id = (n) => `e9090000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'); const REP = id('b1');
const C = { c1: id('c1'), c2: id('c2'), c3: id('c3'), c4: id('c4'), c5: id('c5'), c6: id('c6'), c7: id('c7'), c8: id('c8'),
  c9: id('c9'), c10: id('c10') };
const INV5 = id('e5'); const INV7 = id('e7'); const INV2 = id('e2'); const INV9 = id('e9'); const INV9B = id('e9b');
const INV8 = { a: id('e8a'), b: id('e8b'), c: id('e8c') };
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const as = (uid) => `RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);
SET LOCAL ROLE authenticated;`;
const OWNER = 'RESET ROLE;';
/** One psql session: BEGIN; sql; COMMIT|ROLLBACK. Returns status, output, the last stdout row and NOTICE lines. */
function session(sql, end = 'ROLLBACK') {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${sql}\n${end};\n` });
  const output = `${r.stdout}\n${r.stderr}`;
  return {
    status: r.status, output,
    last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '',
    error: /ERROR:\s+([^\n]*)/.exec(r.stderr)?.[1] ?? null,
    refused: [...r.stderr.matchAll(/REFUSED\|([^\n]*)/g)].map((m) => m[1]),
  };
}
function mustCommit(label, sql) {
  const r = session(sql, 'COMMIT');
  if (r.status !== 0) throw new Error(`SETUP FAILED (${label}): ${r.output}`);
  return r.last;
}
/** A call that must be refused. A missing function is NOT a refusal: it is re-raised and fails the case. */
const refusal = (call) => `DO $m9$ BEGIN
  PERFORM ${call};
  RAISE EXCEPTION 'M9_NOT_REFUSED';
EXCEPTION WHEN undefined_function THEN RAISE;
  WHEN OTHERS THEN IF SQLERRM = 'M9_NOT_REFUSED' THEN RAISE; END IF; RAISE NOTICE 'REFUSED|%', SQLERRM;
END $m9$;`;
const refund = (cust, cents, key, { date = TODAY, credit = 'NULL', by = ADMIN, ref = 'QuickBooks check 1042', dup = false } = {}) =>
  `public.record_outside_refund('${cust}', ${cents}, ${date}, '${ref}', 'customer asked for the rest back', ${credit}, '${by}', '${key}'${dup ? ', true' : ''})`;
const returned = (setSql, key, { by = ADMIN, reason = 'NSF: returned by the bank' } = {}) =>
  `public.record_returned_check(${setSql}, ${TODAY}, '${reason}', '${by}', '${key}')`;
const check = (cust) => `public.get_prepay_balance_check('${cust}')`;
const prepayState = (cust) => `json_build_object(
  'stored', (SELECT prepay_balance_cents FROM public.customers WHERE id = '${cust}'),
  'credits', (SELECT COALESCE(sum(balance_cents), 0) FROM public.prepay_credits WHERE customer_id = '${cust}'),
  'originals', (SELECT COALESCE(sum(original_amount_cents), 0) FROM public.prepay_credits WHERE customer_id = '${cust}'),
  'credit_rows', (SELECT md5(COALESCE(string_agg(row_to_json(pc)::text, ',' ORDER BY pc.id), '')) FROM public.prepay_credits pc WHERE customer_id = '${cust}'))`;
const SET5 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c5}' AND entity_type = 'payment')`;
const SET6 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c6}' AND entity_type = 'payment')`;
const bucket7 = (label) => `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c7}' AND source_type = 'check' AND bucket_label = '${label}')`;
const CHECK7A = bucket7('A'); const CHECK7B = bucket7('B');
const pay10 = (num) => `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c10}' AND check_number = '${num}')`;
const CHECK8 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c8}' AND source_type = 'check')`;
const invoiceRow = (inv, num, cust, date, cents) =>
  `('${inv}', '${num}', '${cust}', 'misc_charge', 'posted', ${date}, DATE '2027-01-31', ${cents}, '${ADMIN}', '${ADMIN}', now())`;

function seed() {
  psql('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;', { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'm9-a@example.invalid', '{"full_name":"[PROVER] M9 admin","role":"admin"}'::jsonb),
    ('${REP}', 'm9-r@example.invalid', '{"full_name":"[PROVER] M9 rep","role":"sales_rep"}'::jsonb);`);
  raw(`BEGIN;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES
      ${Object.entries(C).map(([k, v]) => `('${v}', '[PROVER] M9 ${k} Farm', true)`).join(',\n      ')};
    -- Case 5: a $1,237.00 invoice dated 2026-10-05, already posted.
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, posted_by, posted_at)
      VALUES ('${INV5}', 'M9-RC-INV', '${C.c5}', 'misc_charge', 'posted', DATE '2026-10-05', DATE '2027-01-31', 123700, '${ADMIN}', '${ADMIN}', '2026-10-05 15:00Z');
    -- Case 7: a $200.00 October invoice; case 8: a $100.00 invoice today; case 9: three invoices today.
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, posted_by, posted_at)
      VALUES ${invoiceRow(INV7, 'M9-PM-INV', C.c7, "DATE '2026-10-08'", 20000)}, ${invoiceRow(INV2, 'M9-G-INV', C.c2, TODAY, 10000)},
             ${invoiceRow(INV8.a, 'M9-R-A', C.c8, TODAY, 30000)}, ${invoiceRow(INV8.b, 'M9-R-B', C.c8, TODAY, 10000)}, ${invoiceRow(INV8.c, 'M9-R-C', C.c8, TODAY, 10000)};
    -- Case 10: a $100.00 invoice already past due (due 2026-11-10) and a $200.00 one due in January.
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, posted_by, posted_at)
      VALUES ('${INV9}', 'M9-OD-INV', '${C.c9}', 'misc_charge', 'posted', DATE '2026-11-01', DATE '2026-11-10', 10000, '${ADMIN}', '${ADMIN}', now()),
             ${invoiceRow(INV9B, 'M9-OD-INV2', C.c9, "DATE '2026-11-01'", 20000)};
    COMMIT;`);
  // $500.00 Prepayment Manager checks through the real writer (cases 1, 2, 3, 4, 6).
  for (const k of ['c1', 'c2', 'c3', 'c4', 'c6', 'c7', 'c8']) {
    // c7's check is split into two buckets ($300 + $200), as the Prepayment Manager does.
    const splits = k === 'c7' ? '[{"label":"A","amount_cents":30000},{"label":"B","amount_cents":20000}]' : '[{"label":"A","amount_cents":50000}]';
    mustCommit(`prepay check ${k}`, `${as(ADMIN)}
      SELECT public.create_prepay_check_splits('${C[k]}', 'M9-${k}', '${splits}'::jsonb, '${ADMIN}', 'm9-setup-check-${k}')::text;`);
  }
  // Case 11: two $100.00 check payments today, all prepay.
  for (const num of ['5001', '5002']) {
    mustCommit(`payment c10 ${num}`, `${as(ADMIN)}
      SELECT public.allocate_payment('${C.c10}', 10000, 'check', 'M9-CC-${num}', '${num}', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-setup-pay-c10-${num}')::text;`);
  }
  // Case 6: a $200.00 Record Payment dated today, all kept as prepay (a returned check in the open month).
  mustCommit('payment c6', `${as(ADMIN)}
    SELECT public.allocate_payment('${C.c6}', 20000, 'check', 'M9-C6-PAY', '2002', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-setup-pay-c6')::text;`);
  // Case 5: a $1,537.00 check dated 2026-10-15 pays the invoice; $300.00 becomes prepay.
  const pay5 = JSON.parse(mustCommit('payment c5', `${as(ADMIN)}
    SELECT public.allocate_payment('${C.c5}', 153700, 'check', 'M9-RC-PAY', '1001', DATE '2026-10-15', 'm9',
      jsonb_build_array(jsonb_build_object('invoice_id', '${INV5}', 'amount_cents', 123700)), '${ADMIN}', 'm9-setup-pay-c5')::text;`));
  assert.equal(pay5.prepay_created_cents, 30000);
  // Case 7: $150.00 of c7's $500.00 check (bucket A) applied to its October invoice; the check and the application are
  // dated in October (entered there) before October is closed.
  mustCommit('apply c7', `${as(ADMIN)}
    SELECT public.apply_prepay_to_invoice(${CHECK7A}, '${INV7}', 15000, '${ADMIN}', 'm9-setup-apply-c7')::text;`);
  raw(`UPDATE public.prepay_credits SET created_at = '2026-10-10 15:00Z' WHERE customer_id = '${C.c7}';
    UPDATE public.prepay_applications SET applied_at = '2026-10-12 15:00Z' WHERE invoice_id = '${INV7}';`);
  // Close October through the real close (reviewed token, payments reviewed).
  mustCommit('close October', `${as(ADMIN)}
    SELECT public.close_accounting_period(DATE '2026-10-31', '${ADMIN}', 'm9-setup-close-oct',
      public.get_monthly_summary(DATE '2026-10-01', DATE '2026-10-31') ->> 'review_token', true, true)::text;`);
  const state = JSON.parse(scalar(`SELECT json_build_object(
    'c1', ${prepayState(C.c1)}, 'c5', ${prepayState(C.c5)}, 'c6', ${prepayState(C.c6)},
    'inv5', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV5}'),
    'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'))::text;`));
  assert.deepEqual([state.c1.stored, state.c1.credits], [50000, 50000], 'setup: c1 holds $500 prepay');
  assert.deepEqual([state.c5.stored, state.c5.credits], [30000, 30000], 'setup: c5 holds $300 prepay from the October payment');
  assert.deepEqual([state.c6.stored, state.c6.credits], [70000, 70000], 'setup: c6 holds $500 check + $200 payment');
  assert.equal(state.inv5, 'paid:0', 'setup: the October invoice is paid');
  assert.equal(state.oct, 'closed', 'setup: October 2026 is closed');
  assert.equal(scalar(`SELECT sum(balance_cents) || ':' || (SELECT balance_cents FROM public.invoices WHERE id = '${INV7}') FROM public.prepay_credits WHERE customer_id = '${C.c7}';`), '35000:5000',
    'setup: c7 check has $350 left; its October invoice owes $50');
  console.log('[setup] admin, rep, ten customers; $500 prepay checks; Oct 15 $1,537 payment paid the $1,237 Oct 5 invoice (+$300 prepay); an October $500 prepay check in two buckets, $150 applied in October; October 2026 closed');
}

// ---------------------------------------------------------------------------------------------------------------
const CASES = [];
const kase = (name, fn) => CASES.push([name, fn]);
/** Fails the case with the database's own error when the session did not run to the end. */
function ran(r) { if (r.status !== 0) throw new Error(r.error ?? r.output.trim().split('\n').at(-1)); return r; }

kase('1) refund $300 of a $500 prepay check', () => {
  const r = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c1, 30000, 'm9-c1-refund')}::text AS res \\gset
    SELECT ${check(C.c1)}::text AS chk \\gset
    SELECT json_agg(json_build_object('type', transaction_type, 'desc', description, 'amount', amount_cents))::text AS stmt
      FROM public.get_customer_statement('${C.c1}', DATE '2026-01-01', ${TODAY}) WHERE transaction_type = 'refund' \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb, 'chk', :'chk'::jsonb, 'stmt', :'stmt'::jsonb, 'state', ${prepayState(C.c1)},
      'records', (SELECT json_agg(json_build_object('kind', kind, 'amount', amount_cents, 'date', entry_date = ${TODAY},
          'by', performed_by, 'reference', reference, 'reason', reason,
          'lines', (SELECT json_agg(json_build_object('credit', l.prepay_credit_id IS NOT NULL, 'amount', l.amount_cents))
                      FROM public.money_reversal_lines l WHERE l.reversal_id = mr.id)))
        FROM public.money_reversals mr WHERE mr.customer_id = '${C.c1}'))::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.state.credits, 20000, 'credits = $200');
  assert.equal(o.state.stored, 20000, 'stored balance = $200');
  assert.equal(o.state.originals, 50000, "the check's original amount (Month-End's figure) is unchanged");
  assert.equal(o.records?.length, 1, 'one refund record');
  const rec = o.records[0];
  assert.deepEqual([rec.kind, rec.amount, rec.date, rec.by, rec.reference], ['outside_refund', 30000, true, ADMIN, 'QuickBooks check 1042']);
  assert.deepEqual(rec.lines, [{ credit: true, amount: 30000 }], 'one line: $300 from the one credit');
  const row = o.chk.find((x) => x.customer_id === C.c1);
  assert.deepEqual([row.received_cents, row.refunded_cents, row.expected_cents, row.stored_cents, row.credits_cents, row.ok],
    [50000, 30000, 20000, 20000, 20000, true], 'the balance check agrees after the refund');
  assert.deepEqual(o.stmt, [{ type: 'refund', desc: 'Refund paid (outside CRX) QuickBooks check 1042', amount: 0 }],
    'the statement shows the refund with $0 effect on what is owed');
});

kase('2) refund $600 of $500 is refused', () => {
  const r = ran(session(`${OWNER} SELECT ${prepayState(C.c2)}::text AS before \\gset
    ${as(ADMIN)}
    ${refusal(refund(C.c2, 60000, 'm9-c2-over'))}
    ${OWNER}
    SELECT json_build_object('before', :'before'::jsonb, 'after', ${prepayState(C.c2)},
      'records', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c2}'))::text;`));
  assert.equal(r.refused.length, 1, 'refused');
  assert.match(r.refused[0], /exceed|more than|available|insufficient/i, `refusal names the over-refund: ${r.refused[0]}`);
  const o = JSON.parse(r.last);
  assert.deepEqual(o.after, o.before, 'prepay unchanged');
  assert.equal(o.records, 0, 'no refund record');
});

kase('3) refund paid 2026-10-20 (October closed): recorded today, the paid-on date kept', () => {
  const r = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c3, 10000, 'm9-c3-closed', { date: "DATE '2026-10-20'" })}::text AS res \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb,
      'row', (SELECT json_build_object('entry_today', entry_date = ${TODAY}, 'paid_on', occurred_on) FROM public.money_reversals WHERE customer_id = '${C.c3}'),
      'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'),
      'stored', (SELECT prepay_balance_cents FROM public.customers WHERE id = '${C.c3}'))::text;`));
  const o = JSON.parse(r.last);
  assert.deepEqual(o.row, { entry_today: true, paid_on: '2026-10-20' }, 'the entry is dated today; the day it was paid is kept');
  assert.deepEqual([o.oct, o.stored, o.res.prepay_balance_debited_cents], ['closed', 40000, 10000]);
});

kase('4) balance check: clean -> ok; planted +100 drift -> ok=false, difference 100; read-only', () => {
  const r = ran(session(`${as(ADMIN)}
    SELECT ${check(C.c4)}::text AS clean \\gset
    ${OWNER}
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C.c4}';
    SELECT ${prepayState(C.c4)}::text AS planted \\gset
    ${as(ADMIN)}
    SELECT ${check(C.c4)}::text AS drift \\gset
    SELECT public.get_prepay_balance_check(NULL)::text AS everyone \\gset
    ${OWNER}
    SELECT json_build_object('clean', :'clean'::jsonb, 'drift', :'drift'::jsonb, 'everyone', :'everyone'::jsonb,
      'planted', :'planted'::jsonb, 'after', ${prepayState(C.c4)})::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.clean.length, 1, 'one row for one customer');
  assert.deepEqual(o.clean[0], {
    customer_id: C.c4, farm_name: '[PROVER] M9 c4 Farm', received_cents: 50000, applied_cents: 0, refunded_cents: 0,
    voided_cents: 0, expected_cents: 50000, stored_cents: 50000, credits_cents: 50000, difference_cents: 0, credit_mismatches: [], ok: true,
  });
  assert.deepEqual([o.drift[0].ok, o.drift[0].difference_cents, o.drift[0].stored_cents, o.drift[0].expected_cents], [false, 100, 50100, 50000]);
  assert.equal(o.everyone.find((x) => x.customer_id === C.c4)?.ok, false, 'the all-customers check flags it too');
  assert.equal(o.everyone.find((x) => x.customer_id === C.c1)?.ok, true, 'and leaves a clean customer ok');
  assert.deepEqual(o.after, o.planted, 'the check changed nothing (no silent fix)');
});

kase('5) returned check from closed October, recorded today', () => {
  const OCT_ROWS = `(SELECT md5(row_to_json(a)::text || COALESCE((SELECT string_agg(row_to_json(l)::text, ',' ORDER BY l.id)
      FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id), '')) FROM public.allocation_sets a WHERE a.id = ${SET5})`;
  const months = `json_build_object('oct', public.get_monthly_summary(DATE '2026-10-01', DATE '2026-10-31') -> 'payments',
      'now', public.get_monthly_summary(date_trunc('month', ${TODAY})::date, ${TODAY}) -> 'payments')`;
  const r = ran(session(`${OWNER} SELECT ${OCT_ROWS} AS oct_rows \\gset
    ${as(ADMIN)}
    SELECT ${months}::text AS months_before \\gset
    ${refusal(`public.record_returned_check(${SET5}, DATE '2026-10-14', 'NSF', '${ADMIN}', 'm9-c5-too-early')`)}
    SELECT ${returned(SET5, 'm9-c5-returned')}::text AS res \\gset
    SELECT ${months}::text AS months_after \\gset
    SELECT json_agg(json_build_object('type', transaction_type, 'amount', amount_cents, 'running', running_balance) ORDER BY transaction_date)::text AS stmt
      FROM public.get_customer_statement('${C.c5}', DATE '2026-10-01', ${TODAY}) \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb, 'before', :'months_before'::jsonb, 'after', :'months_after'::jsonb,
      'stmt', :'stmt'::jsonb,
      'oct_rows_same', ${OCT_ROWS} = :'oct_rows',
      'inv', (SELECT json_build_object('status', status, 'balance', balance_cents, 'paid', paid_amount_cents) FROM public.invoices WHERE id = '${INV5}'),
      'state', ${prepayState(C.c5)},
      'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'),
      'entry', (SELECT json_agg(json_build_object('kind', kind, 'amount', amount_cents, 'today', entry_date = ${TODAY}))
                  FROM public.money_reversals WHERE allocation_set_id = ${SET5}))::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.inv.balance, 123700, 'invoice balance back to $1,237.00');
  assert.ok(['posted', 'overdue'].includes(o.inv.status), `invoice unpaid again (status ${o.inv.status})`);
  assert.equal(o.state.stored, 0, 'customer stored prepay -$300.00');
  assert.equal(o.state.credits, 0, 'the $300.00 credit is gone');
  assert.equal(o.oct, 'closed', 'October still closed');
  assert.equal(o.oct_rows_same, true, 'the October payment rows (allocation set + allocation lines) are unchanged');
  assert.deepEqual(o.after.oct, o.before.oct, "October's Month-End payments received unchanged");
  assert.equal(o.after.now.total_cents, o.before.now.total_cents - 153700, "this month's payments show the -$1,537.00 reversal");
  assert.equal(o.after.now.count, o.before.now.count, 'a returned check is not counted as a payment');
  assert.match(r.refused[0] ?? '', /RETURNED_BEFORE_RECEIVED/, 'a bank date before the payment date is refused');
  assert.deepEqual([o.res.invoices_reopened, o.res.bank_returned_date, o.res.invoice_payment_cents, o.res.prepay_removed_cents], [1, o.res.entry_date, 123700, 30000]);
  assert.deepEqual(o.entry, [{ kind: 'returned_check', amount: 153700, today: true }], 'a returned-check entry dated today');
  const back = o.stmt.find((x) => x.type === 'returned_check');
  assert.equal(back?.amount, 123700, 'the statement puts back what the check paid on the invoice');
  assert.equal(o.stmt.at(-1).running, 123700, 'the statement ends owing $1,237.00');
});

kase('6) rep refused; same-key replay returns the same result once; edited retry refused', () => {
  const rep = ran(session(`${as(REP)}
    ${refusal(refund(C.c6, 100, 'm9-c6-rep', { by: REP }))}
    ${refusal(check(C.c6))}
    ${refusal(returned(SET6, 'm9-c6-rep-rc', { by: REP }))}
    ${OWNER} SELECT 'done';`));
  assert.equal(rep.refused.length, 3, 'all three refused');
  for (const m of rep.refused) assert.match(m, /INSUFFICIENT_ROLE|admin/i, `rep refusal: ${m}`);

  const replay = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c6, 10000, 'm9-c6-key')}::text AS r1 \\gset
    SELECT ${refund(C.c6, 10000, 'm9-c6-key')}::text AS r2 \\gset
    SELECT ${returned(SET6, 'm9-c6-rc-key')}::text AS q1 \\gset
    SELECT ${returned(SET6, 'm9-c6-rc-key')}::text AS q2 \\gset
    ${OWNER}
    SELECT json_build_object('refund_same', :'r1'::jsonb = :'r2'::jsonb, 'returned_same', :'q1'::jsonb = :'q2'::jsonb,
      'refunds', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c6}' AND kind = 'outside_refund'),
      'returns', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c6}' AND kind = 'returned_check'),
      'state', ${prepayState(C.c6)})::text;`));
  const o = JSON.parse(replay.last);
  assert.deepEqual([o.refund_same, o.returned_same, o.refunds, o.returns], [true, true, 1, 1], 'replays return the same result and save once');
  assert.deepEqual([o.state.stored, o.state.credits], [40000, 40000], '$700 - $100 refund - $200 returned check = $400');

  const edited = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c6, 10000, 'm9-c6-edit')}::text AS r1 \\gset
    ${refusal(refund(C.c6, 12000, 'm9-c6-edit'))}
    SELECT ${returned(SET6, 'm9-c6-rc-edit')}::text AS q1 \\gset
    ${refusal(returned(SET6, 'm9-c6-rc-edit', { reason: 'a different reason' }))}
    ${OWNER} SELECT 'done';`));
  assert.equal(edited.refused.length, 2, 'both edited retries refused');
  for (const m of edited.refused) assert.match(m, /IDEMPOTENCY_INTENT_MISMATCH/, `edited retry: ${m}`);
});

kase('7) Prepayment Manager check from closed October, partly applied, returned in the open month', () => {
  const months = `json_build_object('oct', public.get_monthly_summary(DATE '2026-10-01', DATE '2026-10-31') -> 'payments',
      'now', public.get_monthly_summary(date_trunc('month', ${TODAY})::date, ${TODAY}) -> 'payments')`;
  // The bank returned it on Oct 9 (closed month, before staff entered the check on Oct 10); staff record it today.
  // Bucket B is named; both buckets come back.
  const ret = (key, credit, date = "DATE '2026-10-09'") => `public.record_returned_check(NULL, ${date}, 'NSF: prepayment check returned', '${ADMIN}', '${key}', ${credit})`;
  const r = ran(session(`${as(ADMIN)}
    SELECT ${months}::text AS before \\gset
    SELECT ${ret('m9-c7-return', CHECK7B)}::text AS res \\gset
    SELECT ${months}::text AS after \\gset
    ${refusal(ret('m9-c7-return-again', CHECK7A))}
    SELECT ${check(C.c7)}::text AS chk \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb, 'before', :'before'::jsonb, 'after', :'after'::jsonb, 'chk', :'chk'::jsonb,
      'inv', (SELECT json_build_object('status', status, 'balance', balance_cents, 'prepay', prepay_applied_cents) FROM public.invoices WHERE id = '${INV7}'),
      'credit', (SELECT json_agg(json_build_object('balance', balance_cents, 'original', original_amount_cents) ORDER BY bucket_label) FROM public.prepay_credits WHERE customer_id = '${C.c7}'),
      'apps', (SELECT count(*) FROM public.prepay_applications WHERE prepay_credit_id = ${CHECK7A}),
      'stored', (SELECT prepay_balance_cents FROM public.customers WHERE id = '${C.c7}'),
      'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'),
      'entry', (SELECT json_agg(json_build_object('kind', kind, 'amount', amount_cents, 'today', entry_date = ${TODAY}, 'bank', occurred_on, 'credit', prepay_credit_id = ${CHECK7B}))
                  FROM public.money_reversals WHERE customer_id = '${C.c7}'))::text;`));
  const o = JSON.parse(r.last);
  assert.deepEqual(o.inv, { status: 'posted', balance: 20000, prepay: 0 }, 'the October invoice owes its $200.00 again');
  assert.deepEqual(o.credit, [{ balance: 0, original: 30000 }, { balance: 0, original: 20000 }], 'both buckets end at $0; their original amounts are kept');
  assert.equal(o.apps, 1, 'the October application row is kept');
  assert.equal(o.stored, 0, 'stored prepay -$350.00 (the unused part)');
  assert.equal(o.oct, 'closed', 'October still closed');
  assert.deepEqual(o.after.oct, o.before.oct, "October's payments received unchanged");
  assert.equal(o.after.now.total_cents, o.before.now.total_cents - 50000, "this month's payments show -$500.00");
  assert.deepEqual(o.entry, [{ kind: 'returned_check', amount: 50000, today: true, bank: '2026-10-09', credit: true }],
    'one entry for the whole check at its face value, dated today, keeping the bank date (even before the entry)');
  assert.equal(r.refused.length, 1, `one refusal: ${JSON.stringify(r.refused)}`);
  assert.match(r.refused[0], /CHECK_ALREADY_RETURNED/, 'returning the other bucket is refused (the check already came back)');
  assert.equal(o.chk[0].ok, true, 'the balance check agrees');
  assert.deepEqual([o.chk[0].received_cents, o.chk[0].applied_cents, o.chk[0].voided_cents], [50000, 0, 50000]);
});

kase('8) guards: void_payment, edit/delete of a refunded credit, invoice void after a reversed application', () => {
  const credit1 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c1}' AND source_type = 'check')`;
  const p2 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c2}' AND entity_type = 'payment')`;
  const over2 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c2}' AND source_type = 'overpayment')`;
  const pm2 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c2}' AND source_type = 'check' AND source_reference = 'M9-G2')`;
  const r = ran(session(`${as(ADMIN)}
    SELECT ${returned(SET6, 'm9-c8-ret6')}::text AS q \\gset
    ${refusal(`public.void_payment(${SET6}, 'void after bounce', '${ADMIN}', 'm9-c8-void6')`)}
    SELECT public.allocate_payment('${C.c2}', 20000, 'check', 'M9-G-PAY', '3003', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-c8-pay2')::text AS p \\gset
    SELECT ${refund(C.c2, 10000, 'm9-c8-refund2', { credit: over2 })}::text AS rf \\gset
    ${refusal(`public.void_payment(${p2}, 'void after refund', '${ADMIN}', 'm9-c8-void2')`)}
    SELECT ${refund(C.c1, 30000, 'm9-c8-refund1')}::text AS rf1 \\gset
    ${refusal(`public.edit_prepay_credit(${credit1}, 25000, NULL, NULL, 'try to raise it', '${ADMIN}', 'm9-c8-edit-bal')`)}
    SELECT public.edit_prepay_credit(${credit1}, 20000, NULL, NULL, 'note only', '${ADMIN}', 'm9-c8-edit-note')::text AS e \\gset
    ${refusal(`public.delete_prepay_credit(${credit1}, 'try to delete', '${ADMIN}', 'm9-c8-del')`)}
    SELECT public.create_prepay_check_splits('${C.c2}', 'M9-G2', '[{"label":"A","amount_cents":10000}]'::jsonb, '${ADMIN}', 'm9-c8-pm2')::text AS pm \\gset
    SELECT public.apply_prepay_to_invoice(${pm2}, '${INV2}', 3000, '${ADMIN}', 'm9-c8-apply2')::text AS ap \\gset
    SELECT public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c8-ret-pm2', ${pm2})::text AS rp \\gset
    ${refusal(`public.void_invoice('${INV2}', 'void after reversal', 'm9-c8-void-inv2')`)}
    SELECT public.get_prepay_balance_check(NULL)::text AS chkall \\gset
    ${OWNER}
    SELECT json_build_object(
      'c1', (SELECT json_build_object('balance', balance_cents, 'original', original_amount_cents, 'notes', notes) FROM public.prepay_credits WHERE id = ${credit1}),
      'inv2', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV2}'),
      'chk', (SELECT json_agg(x ->> 'ok') FROM jsonb_array_elements(:'chkall'::jsonb) x
               WHERE x ->> 'customer_id' IN ('${C.c1}', '${C.c2}', '${C.c6}')))::text;`));
  assert.equal(r.refused.length, 5, `five refusals: ${JSON.stringify(r.refused)}`);
  assert.match(r.refused[0], /PAYMENT_RETURNED/, 'void_payment refuses a returned payment');
  assert.match(r.refused[1], /PAYMENT_PREPAY_REFUNDED/, 'void_payment refuses a payment whose prepay was refunded');
  assert.match(r.refused[2], /PREPAY_CREDIT_HAS_REVERSALS/, 'a refunded credit balance cannot be edited');
  assert.match(r.refused[3], /PREPAY_CREDIT_HAS_REVERSALS/, 'a refunded credit cannot be deleted');
  assert.match(r.refused[4], /INVOICE_HAS_RETURNED_PAYMENT/, 'an invoice with a reversed application cannot be voided (clear refusal)');
  const o = JSON.parse(r.last);
  assert.equal(o.c1.balance, 20000, 'c1 balance unchanged by the note edit');
  assert.equal(o.c1.original, 50000, 'c1 original amount unchanged by the note edit');
  assert.match(o.c1.notes ?? '', /note only/, 'the note edit saved');
  assert.equal(o.inv2, 'posted:10000', 'the invoice whose application was reversed owes its $100.00');
  assert.deepEqual(o.chk, ['true', 'true', 'true'], 'balance check ok for every customer touched');
});

kase('9) recompute trigger: a refund survives apply, batch apply, invoice void and void_payment', () => {
  const over8 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c8}' AND source_type = 'overpayment')`;
  const p8 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c8}' AND entity_type = 'payment')`;
  const credit8 = `(SELECT balance_cents FROM public.prepay_credits WHERE customer_id = '${C.c8}' AND source_type = 'check')`;
  const step = (label) => `SELECT '${label}:' || ${credit8} || ':' || (SELECT prepay_balance_cents FROM public.customers WHERE id = '${C.c8}') AS ${label} \\gset`;
  const r = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c8, 5000, 'm9-c9-refund')}::text AS x1 \\gset
    ${step('refund')}
    SELECT public.apply_prepay_to_invoice(${CHECK8}, '${INV8.a}', 10000, '${ADMIN}', 'm9-c9-apply')::text AS x2 \\gset
    ${step('apply')}
    SELECT public.batch_apply_prepayments(jsonb_build_array(jsonb_build_object('prepay_credit_id', ${CHECK8}, 'invoice_id', '${INV8.b}', 'amount_cents', 2000)), '${ADMIN}', 'm9-c9-batch')::text AS x3 \\gset
    ${step('batch')}
    SELECT count(*) FROM (SELECT public.void_invoice('${INV8.a}', 'void restores the application', 'm9-c9-void-inv')) v;
    ${step('voidinv')}
    SELECT public.allocate_payment('${C.c8}', 20000, 'check', 'M9-R-PAY', '4004', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-c9-pay')::text AS x5 \\gset
    SELECT public.apply_prepay_to_invoice(${over8}, '${INV8.c}', 5000, '${ADMIN}', 'm9-c9-apply-over')::text AS x6 \\gset
    SELECT public.void_payment(${p8}, 'void payment', '${ADMIN}', 'm9-c9-void-pay')::text AS x7 \\gset
    ${step('voidpay')}
    SELECT ${check(C.c8)}::text AS chk \\gset
    ${OWNER}
    SELECT json_build_object('steps', json_build_array(:'refund', :'apply', :'batch', :'voidinv', :'voidpay'), 'chk', :'chk'::jsonb,
      'over', (SELECT balance_cents || ':' || original_amount_cents FROM public.prepay_credits WHERE id = ${over8}),
      'invc', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV8.c}'))::text;`));
  const o = JSON.parse(r.last);
  // credit / stored after each step: $500 check; refund $50; apply $100; batch $20; the invoice void puts the $100 back;
  // a $200 overpayment, $50 of it applied, then voided (its unused $150 comes off the stored balance).
  assert.deepEqual(o.steps, ['refund:45000:45000', 'apply:35000:35000', 'batch:33000:33000', 'voidinv:43000:43000', 'voidpay:43000:43000']);
  assert.equal(o.over, '0:0', 'the voided payment credit is $0');
  assert.equal(o.invc, 'posted:10000', 'its application was reversed by the void');
  assert.deepEqual([o.chk[0].ok, o.chk[0].refunded_cents, o.chk[0].expected_cents], [true, 5000, 43000], 'the balance check agrees');
});

kase('10) Sol round 1: check-only returns, edited/deleted credits, blank reference, drift, overdue reopen, invoice void', () => {
  const credit = (k) => `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C[k]}' AND source_type = 'check')`;
  const over9 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c9}' AND payment_method = 'ach')`;
  const chk9 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c9}' AND payment_method = 'check')`;
  const r = ran(session(`${as(ADMIN)}
    SELECT public.allocate_payment('${C.c9}', 5000, 'ach', 'M9-ACH', NULL, DATE '2026-11-20', 'm9', '[]'::jsonb, '${ADMIN}', 'm9-c10-ach')::text AS a \\gset
    ${refusal(returned(over9, 'm9-c10-ret-ach'))}
    SELECT public.edit_prepay_credit(${credit('c3')}, 40000, NULL, NULL, 'refunded by hand', '${ADMIN}', 'm9-c10-edit3')::text AS e \\gset
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c10-ret3', ${credit('c3')})`)}
    SELECT public.delete_prepay_credit(${credit('c4')}, 'entered twice', '${ADMIN}', 'm9-c10-del4')::text AS d \\gset
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c10-ret4', ${credit('c4')})`)}
    ${refusal(refund(C.c9, 1000, 'm9-c10-blank', { ref: '\t' }))}
    ${OWNER}
    UPDATE public.prepay_credits SET balance_cents = balance_cents + 100 WHERE id = ${credit('c2')};
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C.c2}';
    ${as(ADMIN)}
    ${refusal(refund(C.c2, 1000, 'm9-c10-drift'))}
    SELECT ${check(C.c2)}::text AS drift \\gset
    SELECT public.allocate_payment('${C.c9}', 25000, 'check', 'M9-OD-PAY', '6006', ${TODAY}, 'm9',
      jsonb_build_array(jsonb_build_object('invoice_id', '${INV9}', 'amount_cents', 10000), jsonb_build_object('invoice_id', '${INV9B}', 'amount_cents', 15000)),
      '${ADMIN}', 'm9-c10-pay9')::text AS p \\gset
    SELECT ${returned(chk9, 'm9-c10-ret9')}::text AS res \\gset
    ${refusal(`public.void_invoice('${INV9}', 'wrong customer', 'm9-c10-void9')`)}
    ${OWNER}
    SELECT json_build_object('drift', :'drift'::jsonb, 'res', :'res'::jsonb,
      'inv9', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV9}'),
      'inv9b', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV9B}'),
      'stored9', (SELECT prepay_balance_cents FROM public.customers WHERE id = '${C.c9}'))::text;`));
  assert.equal(r.refused.length, 6, `six refusals: ${JSON.stringify(r.refused)}`);
  assert.match(r.refused[0], /NOT_A_CHECK_PAYMENT/, 'an ACH payment cannot be returned as a bounced check');
  assert.match(r.refused[1], /RECORD_NEEDS_HAND_CHECK: CREDIT_AMOUNT_EDITED/, 'a check whose prepay amount was edited is refused');
  assert.match(r.refused[2], /RECORD_NEEDS_HAND_CHECK: CREDIT_DELETED/, 'a check whose prepay was deleted is refused');
  assert.match(r.refused[3], /REFERENCE_REQUIRED/, 'a tab-only reference is blank');
  assert.match(r.refused[4], /RECORD_NEEDS_HAND_CHECK: CREDIT_DRIFT/, 'a refund from a credit that does not match its history is refused');
  assert.match(r.refused[5], /INVOICE_HAS_RETURNED_PAYMENT/, 'an invoice a returned check paid cannot be voided');
  const o = JSON.parse(r.last);
  const row = o.drift[0];
  assert.equal(row.ok, false, 'the balance check flags the drifted credit');
  assert.equal(row.credit_mismatches.length, 1);
  assert.equal(row.credit_mismatches[0].balance_cents - row.credit_mismatches[0].computed_cents, 100, 'named per credit, to the cent');
  assert.equal(o.inv9, 'overdue:10000', 'the past-due invoice reopens as overdue');
  assert.equal(o.inv9b, 'posted:20000', 'the partly paid invoice owes its $200 again and stays posted');
  assert.equal(o.res.invoices_reopened, 1, 'only the invoice that went from paid to owing is counted');
  assert.equal(o.stored9, 5000, "the ACH payment's $50 prepay is untouched");
});

// Two psql sessions in a forced order (see case 11): returns each session's output.
const until = (sql, label) => {
  for (let i = 0; i < 300; i += 1) { if (scalar(sql) === '1') return; wait(100); }
  throw new Error(`timed out waiting for ${label}`);
};
const waiting = (app, event) => `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${app}' AND wait_event_type = 'Lock'${event ? ` AND wait_event = '${event}'` : " AND wait_event <> 'advisory'"};`;
const both = (first, second) => {
  stageText('blk.sql', 'SELECT pg_advisory_lock(4242);\nSELECT pg_sleep(120);\n');
  stageText('s1.sql', `BEGIN;\n${as(ADMIN)}\n${first}\nSELECT pg_advisory_lock(4242);\nCOMMIT;\n`);
  stageText('s2.sql', `BEGIN;\n${as(ADMIN)}\n${second}\nCOMMIT;\n`);
  docker(['exec', NAME, 'rm', '-f', '/tmp/blk.done', '/tmp/s1.done', '/tmp/s2.done']);
  const start = (f) => docker(['exec', '-d', '-e', `PGAPPNAME=m9${f}`, NAME, 'sh', '-c',
    `psql -U postgres -d ${DB} -X -q -A -t -v ON_ERROR_STOP=1 -f /tmp/${f}.sql > /tmp/${f}.out 2>&1; touch /tmp/${f}.done`]);
  start('blk');
  until("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'm9blk' AND l.locktype = 'advisory' AND l.granted;", 'the blocker');
  start('s1');
  until(waiting('m9s1', 'advisory'), 'session 1 to hold its locks');
  start('s2');
  until(waiting('m9s2'), 'session 2 to wait on a row lock');
  psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'm9blk';");
  until("SELECT CASE WHEN count(*) = 0 THEN 1 ELSE 0 END FROM pg_stat_activity WHERE application_name IN ('m9s1', 'm9s2');", 'both sessions to finish');
  for (let i = 0; i < 100 && docker(['exec', NAME, 'sh', '-c', 'test -f /tmp/s1.done && test -f /tmp/s2.done'], { allowFailure: true }).status !== 0; i += 1) wait(100);
  const read = (f) => docker(['exec', NAME, 'cat', `/tmp/${f}.out`]).stdout;
  return { a: read('s1'), b: read('s2') };
};

kase('11) two sessions: return and void of the same payment wait for each other; the second is refused', () => {
  // Deterministic order: a blocker session holds an advisory lock; session 1 makes its call (taking the payment's locks)
  // and then waits on that advisory lock; session 2 starts only once session 1 is seen waiting, and the blocker is
  // released only once session 2 is seen waiting on a row lock. No sleeps decide the order.
  const ret = (num) => `SELECT ${returned(pay10(num), `m9-c11-ret-${num}`)}::text;`;
  const voidp = (num) => `SELECT public.void_payment(${pay10(num)}, 'entered twice', '${ADMIN}', 'm9-c11-void-${num}')::text;`;
  const one = both(ret('5001'), voidp('5001'));
  assert.doesNotMatch(one.a + one.b, /deadlock/i);
  assert.doesNotMatch(one.a, /ERROR/, `the return commits: ${one.a}`);
  assert.match(one.b, /PAYMENT_RETURNED/, `the void waits, then is refused: ${one.b}`);
  const two = both(voidp('5002'), ret('5002'));
  assert.doesNotMatch(two.a + two.b, /deadlock/i);
  assert.doesNotMatch(two.a, /ERROR/, `the void commits: ${two.a}`);
  assert.match(two.b, /PAYMENT_VOIDED/, `the return waits, then is refused: ${two.b}`);
  const state = scalar(`SELECT string_agg(check_number || ':' || is_active, ',' ORDER BY check_number) FROM public.allocation_sets WHERE customer_id = '${C.c10}';`);
  assert.equal(state, '5001:true,5002:false', 'the returned payment stays active; the voided one is inactive');
});

kase('12) Sol round 2: duplicate refund, drift anywhere on the customer (round 4), return drift and totals, one entry per check (Month-End; round 8: such a return is refused), trigger grants', () => {
  const credit = (k) => `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C[k]}' AND source_type = 'check' AND source_reference = 'M9-${k}')`;
  const over6 = `(SELECT id FROM public.prepay_credits WHERE allocation_set_id = ${SET6})`;
  const legacy = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c2}' AND check_number = 'LEGACY-1')`;
  const dupFirst = `(SELECT (fal.new_values -> 'credit_ids' ->> 0)::uuid FROM public.financial_audit_log fal
     WHERE fal.operation_type = 'prepay_credit_created' AND fal.new_values ->> 'reference_number' = 'DUP-1' AND (fal.new_values ->> 'total_cents')::bigint = 10000)`;
  const r = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c1, 10000, 'm9-c12-r1', { ref: 'QB 2001' })}::text AS r1 \\gset
    ${refusal(refund(C.c1, 9900, 'm9-c12-r2', { ref: 'qb 2001' }))}
    SELECT ${refund(C.c1, 10000, 'm9-c12-r3', { ref: 'QB 2001', dup: true })}::text AS r3 \\gset
    SELECT public.create_prepay_check_splits('${C.c8}', 'M9-c8-new', '[{"label":"A","amount_cents":7000}]'::jsonb, '${ADMIN}', 'm9-c12-new8')::text AS n8 \\gset
    ${OWNER}
    UPDATE public.prepay_credits SET balance_cents = balance_cents + 100 WHERE customer_id = '${C.c8}' AND source_reference = 'M9-c8-new';
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C.c8}';
    UPDATE public.prepay_credits SET balance_cents = balance_cents + 100 WHERE id = ${over6};
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C.c6}';
    -- A legacy payment whose records do not add up: $100 check, $60 on an invoice, $30 prepay.
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_method, check_number, payment_date)
      VALUES ('payment', '${C.c2}', '${C.c2}', true, 10000, 7000, 'check', 'LEGACY-1', ${TODAY});
    INSERT INTO public.invoice_line_allocations (allocation_set_id, invoice_id, amount_cents, bill_to_customer_id, split_percentage)
      VALUES (${legacy}, '${INV2}', 6000, '${C.c2}', 100);
    UPDATE public.invoices SET paid_amount_cents = paid_amount_cents + 6000 WHERE id = '${INV2}';
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, allocation_set_id)
      VALUES ('${C.c2}', 3000, 3000, 'overpayment', 'LEGACY-1', ${legacy});
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 3000 WHERE id = '${C.c2}';
    ${as(ADMIN)}
    ${refusal(refund(C.c8, 1000, 'm9-c12-r8', { ref: 'QB 2008' }))}
    ${refusal(returned(SET6, 'm9-c12-ret6'))}
    ${refusal(returned(legacy, 'm9-c12-legacy'))}
    -- Two Prepayment Manager checks with one number in one transaction (same entry time): Month-End counts two
    -- payments, and returning one returns only it.
    SELECT (public.get_monthly_summary(date_trunc('month', ${TODAY})::date, ${TODAY}) #>> '{payments,count}') AS count_before \\gset
    SELECT public.create_prepay_check_splits('${C.c4}', 'DUP-1', '[{"label":"A","amount_cents":10000}]'::jsonb, '${ADMIN}', 'm9-c12-dup-a')::text AS da \\gset
    SELECT public.create_prepay_check_splits('${C.c4}', 'DUP-1', '[{"label":"A","amount_cents":20000}]'::jsonb, '${ADMIN}', 'm9-c12-dup-b')::text AS db \\gset
    SELECT (public.get_monthly_summary(date_trunc('month', ${TODAY})::date, ${TODAY}) #>> '{payments,count}') AS count_after \\gset
    -- Round 8: two entries for one receipt (same reference and entry time) cannot be told apart; refused.
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c12-ret-dup', ${dupFirst})`)}
    ${OWNER}
    SELECT json_build_object('r1', :'r1'::jsonb, 'r3', :'r3'::jsonb,
      'counted', :'count_after'::int - :'count_before'::int,
      'dup', (SELECT json_agg(balance_cents ORDER BY original_amount_cents) FROM public.prepay_credits WHERE customer_id = '${C.c4}' AND source_reference = 'DUP-1'),
      'same_entry', (SELECT count(DISTINCT created_at) FROM public.prepay_credits WHERE customer_id = '${C.c4}' AND source_reference = 'DUP-1'),
      'grant', has_function_privilege('authenticated', 'public._recompute_prepay_credit_balance()', 'EXECUTE'))::text;`));
  assert.equal(r.refused.length, 5, `five refusals: ${JSON.stringify(r.refused)}`);
  assert.match(r.refused[0], /REFUND_DUPLICATE_REFERENCE/, 'the same outside check again (any amount, any case) needs confirming');
  assert.match(r.refused[1], /RECORD_NEEDS_HAND_CHECK: CREDIT_DRIFT/, 'round 4: a drifted credit of the customer blocks a refund even when it is not drawn');
  assert.match(r.refused[2], /RECORD_NEEDS_HAND_CHECK: CREDIT_DRIFT/, 'a return from a drifted credit is refused');
  assert.match(r.refused[3], /RECORD_NEEDS_HAND_CHECK: PAYMENT_TOTALS/, 'a legacy payment whose records do not add up to the check is refused');
  assert.match(r.refused[4], /RECORD_NEEDS_HAND_CHECK: CHECK_ENTRY_MISMATCH/, 'round 8: two entries for one receipt are refused');
  const o = JSON.parse(r.last);
  assert.equal(o.r3.amount_cents, 10000, 'the admin can confirm a second refund with the same reference');
  assert.equal(o.counted, 2, 'two checks entered together are two payments');
  assert.equal(o.same_entry, 1, 'the two checks share one entry time and number');
  assert.deepEqual(o.dup, [10000, 20000], 'the refused return changed neither check');
  assert.equal(o.grant, false, 'authenticated cannot execute the recompute trigger function');
});

kase('13) the integrity gate: each disagreement is refused RECORD_NEEDS_HAND_CHECK with its reason', () => {
  const over6 = `(SELECT id FROM public.prepay_credits WHERE allocation_set_id = ${SET6})`;
  const pm2 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c2}' AND source_reference = 'M9-G13')`;
  const r = ran(session(`${OWNER}
    UPDATE public.prepay_credits SET customer_id = '${C.c2}' WHERE id = ${over6};
    UPDATE public.prepay_credits SET source_type = 'overpayment' WHERE id = ${CHECK7B};
    UPDATE public.invoices SET paid_amount_cents = paid_amount_cents - 100 WHERE id = '${INV5}';
    UPDATE public.customers SET prepay_balance_cents = 100 WHERE id = '${C.c1}';
    ${as(ADMIN)}
    ${refusal(returned(SET6, 'm9-c13-customer'))}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c13-buckets', ${CHECK7A})`)}
    ${refusal(returned(SET5, 'm9-c13-paid'))}
    SELECT public.create_prepay_check_splits('${C.c2}', 'M9-G13', '[{"label":"A","amount_cents":10000}]'::jsonb, '${ADMIN}', 'm9-c13-pm2')::text AS pm \\gset
    SELECT public.apply_prepay_to_invoice(${pm2}, '${INV2}', 3000, '${ADMIN}', 'm9-c13-apply2')::text AS ap \\gset
    ${OWNER}
    UPDATE public.invoices SET prepay_applied_cents = prepay_applied_cents + 1 WHERE id = '${INV2}';
    ${as(ADMIN)}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c13-prepay', ${pm2})`)}
    ${refusal(refund(C.c1, 1000, 'm9-c13-stored', { ref: 'QB 1301' }))}
    ${OWNER} SELECT 'done';`));
  assert.deepEqual(r.refused.map((m) => /RECORD_NEEDS_HAND_CHECK: ([A-Z_]+)/.exec(m)?.[1] ?? m),
    ['CUSTOMER_MISMATCH', 'CHECK_BUCKETS', 'INVOICE_PAID_MISMATCH', 'INVOICE_PREPAY_MISMATCH', 'STORED_BALANCE_MISMATCH'],
    'a credit of another customer; a bucket that is no longer a check; an invoice paid amount that disagrees with its payments; an invoice prepay amount that disagrees with its applications; a stored balance that is not the credits\' total');
});

kase('14) Sol round 4: whole-customer gate, partial bucket list, face value, closed invoices, rep reads, non-payment void', () => {
  const pm1 = `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c1}' AND source_type = 'check')`;
  const leg = (label) => `(SELECT id FROM public.prepay_credits WHERE customer_id = '${C.c3}' AND source_reference = 'LEG-14' AND bucket_label = '${label}')`;
  const order3 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c3}' AND entity_type = 'order')`;
  const pay2 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c2}' AND check_number = '7007')`;
  const r = ran(session(`${OWNER}
    -- c1: a $100 overpayment credit minted by c5's payment (another customer's money); the books otherwise agree.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, allocation_set_id)
      VALUES ('${C.c1}', 10000, 10000, 'overpayment', 'FOREIGN-14', ${SET5});
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 10000 WHERE id = '${C.c1}';
    ${as(ADMIN)}
    ${refusal(refund(C.c1, 1000, 'm9-c14-foreign', { credit: pm1 }))}
    -- c6: two clean credits ($500 check, $200 payment) but a stored balance $100 short.
    ${OWNER}
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents - 10000 WHERE id = '${C.c6}';
    ${as(ADMIN)}
    ${refusal(refund(C.c6, 1000, 'm9-c14-low'))}
    -- c3: a legacy $500 Prepayment Manager check in two buckets ($300 + $200, one entry time) whose entry lists only
    -- the $300 bucket.
    ${OWNER}
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label, created_at)
      VALUES ('${C.c3}', 30000, 30000, 'check', 'LEG-14', 'A', '2026-11-02 15:00Z'), ('${C.c3}', 20000, 20000, 'check', 'LEG-14', 'B', '2026-11-02 15:00Z');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 50000 WHERE id = '${C.c3}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c3}', '${ADMIN}',
              jsonb_build_object('reference_number', 'LEG-14', 'credit_ids', jsonb_build_array(${leg('A')}), 'total_cents', 50000), 50000, 'legacy');
    ${as(ADMIN)}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c14-partial', ${leg('A')})`)}
    -- The $200 bucket gets its own entry: now the $300 entry's buckets do not add up to its $500 total.
    ${OWNER}
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c3}', '${ADMIN}',
              jsonb_build_object('reference_number', 'LEG-14', 'credit_ids', jsonb_build_array(${leg('B')}), 'total_cents', 20000), 20000, 'legacy');
    ${as(ADMIN)}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c14-face', ${leg('A')})`)}
    -- c2: a check pays its $100 invoice, which is then put back to draft (legacy) and, separately, soft-deleted.
    SELECT public.allocate_payment('${C.c2}', 10000, 'check', 'M9-C14-PAY', '7007', ${TODAY}, 'm9',
      jsonb_build_array(jsonb_build_object('invoice_id', '${INV2}', 'amount_cents', 10000)), '${ADMIN}', 'm9-c14-pay2')::text AS p2 \\gset
    ${OWNER}
    SET CONSTRAINTS ALL IMMEDIATE;
    ALTER TABLE public.invoices DISABLE TRIGGER enforce_invoice_status_transition;  -- legacy row; rolled back
    UPDATE public.invoices SET status = 'draft' WHERE id = '${INV2}';
    ${as(ADMIN)}
    ${refusal(returned(pay2, 'm9-c14-draft'))}
    ${OWNER}
    UPDATE public.invoices SET status = 'paid', deleted_at = now() WHERE id = '${INV2}';
    ${as(ADMIN)}
    ${refusal(returned(pay2, 'm9-c14-deleted'))}
    -- An order allocation set cannot be voided as a payment.
    ${OWNER}
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents)
      VALUES ('order', gen_random_uuid(), '${C.c3}', true, 0, 0);
    ${as(ADMIN)}
    ${refusal(`public.void_payment(${order3}, 'not a payment', '${ADMIN}', 'm9-c14-void-order')`)}
    -- A date of -infinity is not a date (L18).
    ${refusal(refund(C.c4, 1000, 'm9-c14-inf', { date: "'-infinity'::date", ref: 'QB 1402' }))}
    ${refusal(`public.record_returned_check(${pay2}, '-infinity'::date, 'NSF', '${ADMIN}', 'm9-c14-inf-ret')`)}
    -- Round 5. c8: an overpayment credit with no payment behind it.
    ${OWNER}
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference)
      VALUES ('${C.c8}', 5000, 5000, 'overpayment', 'ORPHAN-15');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 5000 WHERE id = '${C.c8}';
    ${as(ADMIN)}
    ${refusal(refund(C.c8, 1000, 'm9-c14-unknown', { ref: 'QB 1403' }))}
    -- c9: a $100 all-prepay check payment, plus a $50 credit linked to it that it never funded.
    SELECT public.allocate_payment('${C.c9}', 10000, 'check', 'M9-C14-P9', '7009', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-c14-pay9')::text AS p9 \\gset
    ${OWNER}
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, allocation_set_id)
      VALUES ('${C.c9}', 5000, 5000, 'overpayment', 'EXTRA-15', (SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c9}' AND check_number = '7009'));
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 5000 WHERE id = '${C.c9}';
    ${as(ADMIN)}
    ${refusal(refund(C.c9, 1000, 'm9-c14-extra', { ref: 'QB 1404' }))}
    -- c3: one entry listing buckets of two different receipts.
    ${OWNER}
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label, created_at)
      VALUES ('${C.c3}', 30000, 30000, 'check', 'MIX-A', 'A', '2026-11-03 15:00Z'), ('${C.c3}', 20000, 20000, 'check', 'MIX-B', 'A', '2026-11-04 15:00Z');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 50000 WHERE id = '${C.c3}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c3}', '${ADMIN}', jsonb_build_object('reference_number', 'MIX',
              'credit_ids', (SELECT jsonb_agg(id) FROM public.prepay_credits WHERE customer_id = '${C.c3}' AND source_reference IN ('MIX-A', 'MIX-B')),
              'total_cents', 50000), 50000, 'legacy');
    ${as(ADMIN)}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c14-mix', (SELECT id FROM public.prepay_credits WHERE source_reference = 'MIX-A'))`)}
    -- c7: a legacy $100 check payment recorded as $150 and -$50 on one invoice; and one dated -infinity.
    ${OWNER}
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_method, check_number, payment_date)
      VALUES ('payment', gen_random_uuid(), '${C.c7}', true, 10000, 10000, 'check', 'NEG-15', ${TODAY}),
             ('payment', gen_random_uuid(), '${C.c7}', true, 1000, 0, 'check', 'INF-15', '-infinity');
    INSERT INTO public.invoice_line_allocations (allocation_set_id, invoice_id, amount_cents, bill_to_customer_id, split_percentage)
      SELECT a.id, '${INV7}', v.cents, '${C.c7}', 100 FROM public.allocation_sets a, (VALUES (15000), (-5000)) v(cents) WHERE a.check_number = 'NEG-15';
    ${as(ADMIN)}
    ${refusal(returned(`(SELECT id FROM public.allocation_sets WHERE check_number = 'NEG-15')`, 'm9-c14-neg'))}
    ${refusal(returned(`(SELECT id FROM public.allocation_sets WHERE check_number = 'INF-15')`, 'm9-c14-infpay'))}
    -- Reads: an admin sees a refund's record and line; a rep sees no row of either table (case 11's committed return
    -- included).
    SELECT ${refund(C.c4, 1000, 'm9-c14-ok', { ref: 'QB 1401' })}::text AS ok \\gset
    SELECT (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c4}') || ':' || (SELECT count(*) FROM public.money_reversal_lines l
      JOIN public.money_reversals mr ON mr.id = l.reversal_id WHERE mr.customer_id = '${C.c4}') AS admin_reads \\gset
    ${as(REP)}
    SELECT (SELECT count(*) FROM public.money_reversals) || ':' || (SELECT count(*) FROM public.money_reversal_lines) AS rep_reads \\gset
    ${OWNER}
    SELECT json_build_object('admin', :'admin_reads', 'rep', :'rep_reads',
      'inv2', (SELECT status || ':' || paid_amount_cents FROM public.invoices WHERE id = '${INV2}'))::text;`));
  assert.deepEqual(r.refused.map((m) => /^([A-Z_]+)(?::\s*([A-Z_]+))?/.exec(m)?.slice(1).filter(Boolean).join(': ') ?? m),
    ['RECORD_NEEDS_HAND_CHECK: CREDIT_SOURCE_MISMATCH', 'RECORD_NEEDS_HAND_CHECK: STORED_BALANCE_MISMATCH',
     'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS', 'RECORD_NEEDS_HAND_CHECK: CHECK_FACE_VALUE',
     'RETURN_INVOICE_NOT_OPEN', 'RETURN_INVOICE_NOT_OPEN', 'NOT_A_PAYMENT', 'BAD_VALUE', 'BAD_VALUE',
     'RECORD_NEEDS_HAND_CHECK: CREDIT_SOURCE_UNKNOWN', 'RECORD_NEEDS_HAND_CHECK: SOURCE_PAYMENT_TOTALS',
     'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS', 'RECORD_NEEDS_HAND_CHECK: PAYMENT_TOTALS', 'PAYMENT_UNDATED'],
    `another customer's payment behind a credit; a stored balance below the credits; a partial bucket list; a face value that is not the entry's total; a draft and a deleted invoice; a non-payment void; -infinity dates; round 5: an unlinked overpayment credit, a credit its payment never funded, an entry mixing two receipts, a negative allocation row, a payment dated -infinity: ${JSON.stringify(r.refused)}`);
  const o = JSON.parse(r.last);
  assert.equal(o.admin, '1:1', `an admin reads the refund and its line: ${r.last}`);
  assert.equal(o.rep, '0:0', 'a rep reads no reversal rows');
  assert.equal(o.inv2, 'paid:10000', 'the refused returns changed nothing on the invoice');
});

kase('15) Sol round 6: an unproven check credit, a negative allocation on a touched invoice, another customer\'s entry, a payment minting another customer\'s credit', () => {
  const over6 = `(SELECT id FROM public.prepay_credits WHERE allocation_set_id = ${SET6})`;
  const r = ran(session(`${OWNER}
    -- c10: a Prepayment Manager-style check credit with no creation entry.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference)
      VALUES ('${C.c10}', 5000, 5000, 'check', 'NOENTRY-15');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 5000 WHERE id = '${C.c10}';
    -- c5: a legacy active payment that puts -$25 on the invoice the October check paid (the invoice agrees).
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_method, check_number, payment_date)
      VALUES ('payment', gen_random_uuid(), '${C.c5}', true, 0, -2500, 'check', 'MINUS-15', DATE '2026-11-01');
    INSERT INTO public.invoice_line_allocations (allocation_set_id, invoice_id, amount_cents, bill_to_customer_id, split_percentage)
      SELECT id, '${INV5}', -2500, '${C.c5}', 100 FROM public.allocation_sets WHERE check_number = 'MINUS-15';
    UPDATE public.invoices SET paid_amount_cents = paid_amount_cents - 2500 WHERE id = '${INV5}';
    -- c4: a check credit whose only entry was recorded for c1.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label)
      VALUES ('${C.c4}', 10000, 10000, 'check', 'OTHER-15', 'A');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 10000 WHERE id = '${C.c4}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c1}', '${ADMIN}', jsonb_build_object('reference_number', 'OTHER-15',
              'credit_ids', jsonb_build_array((SELECT id FROM public.prepay_credits WHERE source_reference = 'OTHER-15')), 'total_cents', 10000), 10000, 'legacy');
    -- c6: its $200 payment's prepay is $150 for c6 and $50 for c1 (each customer's own books agree).
    UPDATE public.prepay_credits SET original_amount_cents = 15000, balance_cents = 15000 WHERE id = ${over6};
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents - 5000 WHERE id = '${C.c6}';
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, allocation_set_id)
      VALUES ('${C.c1}', 5000, 5000, 'overpayment', 'SPLIT-15', ${SET6});
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 5000 WHERE id = '${C.c1}';
    ${as(ADMIN)}
    ${refusal(refund(C.c10, 1000, 'm9-c15-noentry', { ref: 'QB 1501' }))}
    ${refusal(returned(`(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c5}' AND check_number = '1001')`, 'm9-c15-minus'))}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c15-other', (SELECT id FROM public.prepay_credits WHERE source_reference = 'OTHER-15'))`)}
    ${refusal(refund(C.c6, 1000, 'm9-c15-split', { ref: 'QB 1502' }))}
    ${OWNER} SELECT (SELECT paid_amount_cents FROM public.invoices WHERE id = '${INV5}');`));
  assert.deepEqual(r.refused.map((m) => /RECORD_NEEDS_HAND_CHECK: ([A-Z_]+)/.exec(m)?.[1] ?? m),
    ['CREDIT_SOURCE_UNKNOWN', 'INVOICE_NEGATIVE_ALLOCATION', 'CHECK_BUCKETS', 'SOURCE_PAYMENT_TOTALS'],
    `a check credit with no entry; a -$25 allocation on the invoice; an entry recorded for another customer; a payment minting another customer's credit: ${JSON.stringify(r.refused)}`);
  assert.equal(r.last, '121200', 'the refused return left the invoice paid amount as it was');
});

kase('16) Sol round 8: every check entry of the customer is one whole receipt (refunds too); siblings of a refunded bucket are frozen', () => {
  const r = ran(session(`${OWNER}
    -- c10: a $500 check credit whose one entry records a $50 check.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label)
      VALUES ('${C.c10}', 50000, 50000, 'check', 'SMALL-16', 'A');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 50000 WHERE id = '${C.c10}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c10}', '${ADMIN}', jsonb_build_object('reference_number', 'SMALL-16',
              'credit_ids', jsonb_build_array((SELECT id FROM public.prepay_credits WHERE source_reference = 'SMALL-16')), 'total_cents', 5000), 5000, 'legacy');
    -- c9: one $500 check in two buckets ($300 + $200, one entry time) recorded as two entries, each with its own total.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label, created_at)
      VALUES ('${C.c9}', 30000, 30000, 'check', 'SPLIT-16', 'A', '2026-11-05 15:00Z'), ('${C.c9}', 20000, 20000, 'check', 'SPLIT-16', 'B', '2026-11-05 15:00Z');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 50000 WHERE id = '${C.c9}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      SELECT 'prepay_credit_created', 'prepay_credit', '${C.c9}', '${ADMIN}', jsonb_build_object('reference_number', 'SPLIT-16',
             'credit_ids', jsonb_build_array(id), 'total_cents', original_amount_cents), original_amount_cents, 'legacy'
        FROM public.prepay_credits WHERE source_reference = 'SPLIT-16';
    ${as(ADMIN)}
    ${refusal(refund(C.c10, 30000, 'm9-c16-small', { ref: 'QB 1601' }))}
    ${refusal(`public.record_returned_check(NULL, ${TODAY}, 'NSF', '${ADMIN}', 'm9-c16-split', (SELECT id FROM public.prepay_credits WHERE source_reference = 'SPLIT-16' AND bucket_label = 'A'))`)}
    ${refusal(refund(C.c9, 1000, 'm9-c16-split-refund', { ref: 'QB 1602' }))}
    -- c7: refund $10 from bucket A of its split check; bucket B (untouched) can no longer be edited or deleted.
    SELECT ${refund(C.c7, 1000, 'm9-c16-c7', { credit: CHECK7A, ref: 'QB 1603' })}::text AS r7 \\gset
    ${refusal(`public.edit_prepay_credit(${CHECK7B}, 10000, NULL, NULL, 'shrink the sibling', '${ADMIN}', 'm9-c16-edit7b')`)}
    ${refusal(`public.delete_prepay_credit(${CHECK7B}, 'entered twice', '${ADMIN}', 'm9-c16-del7b')`)}
    ${OWNER}
    SELECT json_build_object('r7', :'r7'::jsonb,
      'c7b', (SELECT original_amount_cents || ':' || balance_cents FROM public.prepay_credits WHERE id = ${CHECK7B}),
      'c10', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c10}' AND kind = 'outside_refund'))::text;`));
  assert.deepEqual(r.refused.map((m) => /RECORD_NEEDS_HAND_CHECK: ([A-Z_]+)/.exec(m)?.[1] ?? /^([A-Z_]+)/.exec(m)?.[1] ?? m),
    ['CHECK_ENTRY_MISMATCH', 'CHECK_ENTRY_MISMATCH', 'CHECK_ENTRY_MISMATCH', 'PREPAY_CREDIT_HAS_REVERSALS', 'PREPAY_CREDIT_HAS_REVERSALS'],
    `a refund from a check whose entry records less; a split check scattered over two entries (return and refund); a sibling of a refunded bucket edited or deleted: ${JSON.stringify(r.refused)}`);
  const o = JSON.parse(r.last);
  assert.equal(o.r7.amount_cents, 1000, 'the refund from a clean split check is recorded');
  assert.equal(o.c7b, '20000:20000', 'the untouched sibling keeps its amount');
  assert.equal(o.c10, 0, 'no refund was recorded from the unproven check');
});

kase('17) Sol round 8: entries match only as arrays of distinct ids; a refund holds every credit, so a sibling edit waits and is refused', () => {
  const r = ran(session(`${OWNER}
    -- c10: a $500 check credit whose only entry lists it as an object key, recording $50.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label)
      VALUES ('${C.c10}', 50000, 50000, 'check', 'OBJ-17', 'A');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 50000 WHERE id = '${C.c10}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c10}', '${ADMIN}', jsonb_build_object('reference_number', 'OBJ-17',
              'credit_ids', jsonb_build_object((SELECT id FROM public.prepay_credits WHERE source_reference = 'OBJ-17')::text, true), 'total_cents', 5000), 5000, 'legacy');
    -- c9: a $250 check credit whose entry lists it twice and records $500.
    INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, source_type, source_reference, bucket_label)
      VALUES ('${C.c9}', 25000, 25000, 'check', 'TWICE-17', 'A');
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 25000 WHERE id = '${C.c9}';
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      SELECT 'prepay_credit_created', 'prepay_credit', '${C.c9}', '${ADMIN}', jsonb_build_object('reference_number', 'TWICE-17',
             'credit_ids', jsonb_build_array(id, id), 'total_cents', 50000), 50000, 'legacy'
        FROM public.prepay_credits WHERE source_reference = 'TWICE-17';
    -- c3: a clean $500 check, plus an entry recorded for c3 whose bucket list is not an array.
    INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, total_impact_cents, description)
      VALUES ('prepay_credit_created', 'prepay_credit', '${C.c3}', '${ADMIN}', jsonb_build_object('reference_number', 'BAD-17',
              'credit_ids', 'not-a-list', 'total_cents', 0), 0, 'legacy');
    ${as(ADMIN)}
    ${refusal(refund(C.c10, 30000, 'm9-c17-object', { ref: 'QB 1701' }))}
    ${refusal(refund(C.c9, 1000, 'm9-c17-twice', { ref: 'QB 1702' }))}
    ${refusal(refund(C.c3, 1000, 'm9-c17-bad', { ref: 'QB 1703' }))}
    ${OWNER} SELECT 'done';`));
  assert.deepEqual(r.refused.map((m) => /RECORD_NEEDS_HAND_CHECK: ([A-Z_]+)/.exec(m)?.[1] ?? m),
    ['CREDIT_SOURCE_UNKNOWN', 'CHECK_ENTRY_MISMATCH', 'CHECK_ENTRY_MALFORMED'],
    `an entry naming the credit only as an object key; an entry listing one bucket twice; an entry for the customer that is not a list: ${JSON.stringify(r.refused)}`);
  // The race: a refund from c7's bucket A holds its locks; an edit of sibling bucket B waits, then is refused.
  const refundA = `SELECT ${refund(C.c7, 1000, 'm9-c17-race-refund', { credit: CHECK7A, ref: 'QB 1704' })}::text;`;
  const editB = `SELECT public.edit_prepay_credit(${CHECK7B}, 10000, NULL, NULL, 'shrink the sibling', '${ADMIN}', 'm9-c17-race-edit')::text;`;
  const race = both(refundA, editB);
  assert.doesNotMatch(race.a + race.b, /deadlock/i);
  assert.doesNotMatch(race.a, /ERROR/, `the refund commits: ${race.a}`);
  assert.match(race.b, /PREPAY_CREDIT_HAS_REVERSALS/, `the sibling edit waits, then is refused: ${race.b}`);
  assert.equal(scalar(`SELECT original_amount_cents || ':' || balance_cents FROM public.prepay_credits WHERE id = ${CHECK7B};`), '20000:20000',
    'the sibling keeps its amount');
});

const admin = (sql) => psql(sql, { user: 'supabase_admin', db: 'template1' });
const KICK = "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();";
function applyM9() {
  stageText('m9.sql', lf(M9));
  const first = apply('m9.sql');
  assert.equal(first.status, 0, `M9 failed to apply:\n${first.output}`);
  const again = apply('m9.sql');
  assert.notEqual(again.status, 0, 'a second apply of M9 must be refused');
  assert.match(again.output, /M9_PREFLIGHT: already applied/);
  console.log('[prover] M9 applied; a second apply stops at its preflight');
}

async function main() {
  if (REUSE) {
    // Only a container this script built, and only when its pre-M9 snapshot is there: checked before anything is dropped.
    const label = docker(['inspect', '-f', `{{ index .Config.Labels "${LABEL}" }}`, NAME], { allowFailure: true });
    if (label.status !== 0 || label.stdout.trim() !== '1') throw new Error(`REUSE_REFUSED: ${NAME} was not created by this prover (no ${LABEL} label)`);
    const snap = docker([...psqlArgs('supabase_admin', 'template1'), '-A', '-t'], { input: "SELECT count(*) FROM pg_database WHERE datname = 'm9_before';" });
    if (snap.stdout.trim() !== '1') throw new Error(`REUSE_REFUSED: ${NAME} has no m9_before snapshot; run with CRX_PROVER_REPLAY_ONLY=1 first`);
    admin(`${KICK} DROP DATABASE postgres WITH (FORCE);`);
    admin('CREATE DATABASE postgres OWNER postgres TEMPLATE m9_before;');  // live and the image: postgres owns it (and so public)
    console.log(`[prover] reusing container ${NAME}: reset to the pre-M9 snapshot`);
  } else {
    buildContainer();
    admin(`${KICK} CREATE DATABASE m9_before TEMPLATE postgres;`);
    if (process.env.CRX_PROVER_REPLAY_ONLY === '1') { console.log(`[prover] pre-M9 snapshot ready in ${NAME}`); return; }
  }
  applyM9();
  seed();
  const failed = [];
  for (const [name, fn] of CASES) {
    try { fn(); console.log(`[PASS] ${name}`); } catch (e) {
      const why = (e.message ?? String(e)).split('\n')[0];
      failed.push([name, why]);
      console.log(`[FAIL] ${name}\n       ${why}`);
    }
  }
  if (failed.length) {
    console.log(`M9_REFUNDS_RETURNED_CHECKS_PROOF_FAIL: ${failed.length} of ${CASES.length} case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
