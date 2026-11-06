#!/usr/bin/env node
/**
 * Real-schema proof for 20261115160000 (KI-06: a hard delete of an invoice, a payment set or a legacy payment
 * row keeps a full copy in financial_audit_log). Builds the checked-in schema baseline in a network-disabled
 * PostgreSQL container and replays every migration before the candidate. BEFORE: a hard delete leaves no audit
 * row. AFTER (a second apply refuses at the preflight): each hard delete, by postgres, by service_role, and of
 * a posted invoice under app.admin_override, writes exactly one audit row whose old_values equals the erased
 * row; a refused delete (posted invoice without override; a signed-in user) writes none; no API role can
 * execute the trigger function; the widened CHECK keeps every older value and still refuses junk.
 *
 * Run: node scripts/smoke/prove-financial-delete-snapshots-real-schema.mjs   (needs local Docker image)
 * Prints FINANCIAL_DELETE_SNAPSHOTS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-delete-snapshots-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261115160000_financial_delete_snapshots.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /financial_audit_log_operation_type_check|_snapshot_financial_hard_delete|_fill_audit_actor\(|guard_audit_log_immutable\(/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
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
  // Historical replay uses LF staging; validate_product_units had CRLF in live prosrc.
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');  // same bytes on an LF or CRLF checkout
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
      expected, `${signature} is not the pinned live body before the candidate`);
  }
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}


const ADMIN = '16000000-0000-4000-8000-000000000006';
const SYSTEM_ACTOR = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';  // trg_fill_audit_actor's fallback
const FN = 'public._snapshot_financial_hard_delete()';

// Insert one row into public.<table> with session_replication_role = replica (no triggers or FK checks),
// filling every NOT NULL column that has no default with a typed placeholder; `fields` override them.
function seedRow(table, fields) {
  const id = randomUUID();
  const overrides = JSON.stringify({ id, ...fields }).replaceAll("'", "''");
  psql(`SET session_replication_role = replica; SET request.jwt.claim.sub = '${ADMIN}';  -- auth.uid() defaults (created_by)
DO $seed$
DECLARE v_o jsonb := '${overrides}'::jsonb; v_cols text := ''; v_vals text := ''; c record;
BEGIN
  FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
             FROM pg_attribute a
            WHERE a.attrelid = 'public.${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attgenerated = ''
              AND (v_o ? a.attname OR (a.attnotnull AND NOT a.atthasdef))
  LOOP
    v_cols := v_cols || CASE WHEN v_cols = '' THEN '' ELSE ', ' END || quote_ident(c.attname);
    v_vals := v_vals || CASE WHEN v_vals = '' THEN '' ELSE ', ' END || CASE
      WHEN v_o ? c.attname THEN quote_nullable(v_o ->> c.attname) || '::' || c.typ
      WHEN c.typ = 'uuid' THEN 'gen_random_uuid()'
      WHEN c.typ IN ('integer','bigint','smallint') OR c.typ LIKE 'numeric%' THEN '0'
      WHEN c.typ = 'boolean' THEN 'false'
      WHEN c.typ = 'date' THEN 'current_date'
      WHEN c.typ LIKE 'timestamp%' THEN 'now()'
      WHEN c.typ = 'jsonb' THEN '''{}''::jsonb'
      ELSE quote_literal('[PROVER]') || '::' || c.typ END;
  END LOOP;
  EXECUTE format('INSERT INTO public.${table} (%s) VALUES (%s)', v_cols, v_vals);
END $seed$;`);
  return id;
}
const rowJson = (table, id) => scalar(`SELECT to_jsonb(t)::text FROM public.${table} t WHERE id = '${id}';`);
const audits = (id) => Number(scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id = '${id}';`));
const audit = (id) => JSON.parse(scalar(`SELECT jsonb_build_object('op', operation_type, 'entity', entity_type, 'actor', actor_user_id,
  'old', old_values, 'new', new_values)::text FROM public.financial_audit_log WHERE entity_id = '${id}';`));
// Run SQL in its own session (committed unless it fails); returns the status and combined output.
const run = (sql) => { const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: sql }); return { status: r.status, output: `${r.stdout}\n${r.stderr}` }; };

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ADMIN}', 'ki06-admin@example.invalid', '{"full_name":"[PROVER] admin"}'::jsonb) ON CONFLICT DO NOTHING;
    SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${ADMIN}', 'ki06-admin@example.invalid', '[PROVER] admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;
    INSERT INTO auth.users (id, email) VALUES ('${SYSTEM_ACTOR}', 'system@example.invalid') ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${SYSTEM_ACTOR}', 'system@example.invalid', '[PROVER] system', 'admin', false)
    ON CONFLICT (id) DO NOTHING;`);
  const customer = seedRow('customers', {});
  const draft = seedRow('invoices', { customer_id: customer, status: 'draft', invoice_number: `PROVER-${randomUUID().slice(0, 8)}` });
  const set = seedRow('allocation_sets', { customer_id: customer, entity_type: 'payment' });
  // The invoice the payment set's allocation lines point at (kept: invoice_line_allocations -> invoices is NO ACTION).
  const allocInvoice = seedRow('invoices', { customer_id: customer, status: 'draft', invoice_number: `PROVER-${randomUUID().slice(0, 8)}` });
  // Child rows that ON DELETE CASCADE removes with their parent; their contents must survive in the audit row.
  const item1 = seedRow('invoice_items', { invoice_id: draft, quantity: 2, unit_price_cents: 3025, extended_cents: 6050 });
  const item2 = seedRow('invoice_items', { invoice_id: draft, quantity: 1, unit_price_cents: 3950, extended_cents: 3950 });
  const children = {
    item1, item2,
    lineShare: seedRow('invoice_line_shares', { invoice_item_id: item1, split_mode: 'custom', base_price_source: 'manual', price_mode: 'default', split_micro_pct: 100000000 }),
    invoiceShare: seedRow('invoice_shares', { invoice_id: draft, split_percentage: 100 }),
    location: seedRow('field_app_locations', { invoice_id: draft }),
    alloc1: seedRow('invoice_line_allocations', { allocation_set_id: set, invoice_id: allocInvoice, split_percentage: 60 }),
    alloc2: seedRow('invoice_line_allocations', { allocation_set_id: set, invoice_id: allocInvoice, split_percentage: 40 }),
    orderAlloc: seedRow('order_line_allocations', { allocation_set_id: set, split_percentage: 100 }),
  };
  children.locationShare = seedRow('field_app_location_shares', { location_id: children.location, split_pct: 100 });
  return {
    customer, children, draft, set,
    draft2: seedRow('invoices', { customer_id: customer, status: 'draft', invoice_number: `PROVER-${randomUUID().slice(0, 8)}` }),
    posted: seedRow('invoices', { customer_id: customer, status: 'posted', posted_at: new Date().toISOString(), invoice_number: `PROVER-${randomUUID().slice(0, 8)}` }),
    splitSet: seedRow('allocation_sets', { customer_id: customer, entity_type: 'order' }),
    payment: seedRow('payments', { customer_id: customer, amount: 12.34 }),
  };
}

function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  const ids = seed();
  const checkBefore = scalar("SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname = 'financial_audit_log_operation_type_check';");
  assert.equal(checkBefore, '2a95748a7e5ecdd696c35f768739207e', 'the replayed CHECK must match live (preflight pin)');
  const valuesBefore = scalar("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'financial_audit_log_operation_type_check';")
    .match(/'[a-z_]+'::text/g).map((v) => v.slice(1, -7));
  const totalBefore = scalar('SELECT count(*) FROM public.financial_audit_log;');

  // BEFORE: a hard delete leaves nothing behind (rolled back).
  const before = run(`BEGIN; DELETE FROM public.invoices WHERE id = '${ids.draft}';
    SELECT 'AUDITS=' || count(*) FROM public.financial_audit_log WHERE entity_id = '${ids.draft}'; ROLLBACK;`);
  assert.equal(before.status, 0, before.output);
  assert.match(before.output, /AUDITS=0/, before.output);
  console.log('[prover] BEFORE: hard delete of a draft invoice wrote no audit row');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_FINANCIAL_AUDIT_OPERATION_CHECK_DRIFT/);
  assert.equal(scalar('SELECT count(*) FROM public.financial_audit_log;'), totalBefore, 'applying wrote no audit rows');
  console.log('[prover] candidate applied once; a second apply refuses at the preflight');

  // 1. postgres hard-deletes a draft invoice: one row, old_values is the whole erased row, system actor,
  //    and every row that cascaded away with it is kept in new_values.cascaded_rows.
  const draftRow = JSON.parse(rowJson('invoices', ids.draft));
  const c = ids.children;
  const kept = Object.fromEntries(Object.entries({
    item1: 'invoice_items', item2: 'invoice_items', lineShare: 'invoice_line_shares', invoiceShare: 'invoice_shares',
    location: 'field_app_locations', locationShare: 'field_app_location_shares',
    alloc1: 'invoice_line_allocations', alloc2: 'invoice_line_allocations', orderAlloc: 'order_line_allocations',
  }).map(([k, t]) => [k, JSON.parse(rowJson(t, c[k]))]));
  const byId = (list, id) => list.find((x) => x.id === id);
  let r = run(`DELETE FROM public.invoices WHERE id = '${ids.draft}';`);
  assert.equal(r.status, 0, r.output);
  assert.equal(audits(ids.draft), 1);
  let a = audit(ids.draft);
  assert.deepEqual([a.op, a.entity, a.actor], ['invoice_deleted', 'invoice', SYSTEM_ACTOR]);
  assert.deepEqual(a.old, draftRow, 'old_values is the erased invoice row');
  assert.equal(a.new.hard_delete, true);
  assert.equal(a.new.admin_override_setting, false);
  assert.equal(a.new.allocation_entity_type, null);
  const cr = a.new.cascaded_rows;
  assert.equal(cr.invoice_items.length, 2, 'both invoice lines are kept');
  const { invoice_line_shares: shares1, ...line1 } = byId(cr.invoice_items, c.item1);
  assert.deepEqual(line1, kept.item1, 'line 1 is kept whole (product, quantity, price)');
  assert.deepEqual(shares1, [kept.lineShare], 'its line share is kept');
  const { invoice_line_shares: shares2, ...line2 } = byId(cr.invoice_items, c.item2);
  assert.deepEqual([line2, shares2], [kept.item2, []]);
  assert.deepEqual(cr.invoice_shares, [kept.invoiceShare]);
  const { field_app_location_shares: locShares, ...loc } = cr.field_app_locations[0];
  assert.deepEqual([cr.field_app_locations.length, loc, locShares], [1, kept.location, [kept.locationShare]]);
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_items WHERE invoice_id = '${ids.draft}';`), '0', 'the lines really cascaded away');
  console.log('[prover] postgres hard delete of a draft invoice -> one invoice_deleted row holding the full row and its 2 lines, shares and field locations');

  // 2. A posted invoice: refused without the override (and no audit row), snapshotted with it.
  r = run(`DELETE FROM public.invoices WHERE id = '${ids.posted}';`);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Cannot delete invoice in posted status/);
  assert.equal(audits(ids.posted), 0, 'a refused delete writes no audit row');
  const postedRow = JSON.parse(rowJson('invoices', ids.posted));
  r = run(`BEGIN; SET LOCAL app.admin_override = 'true'; DELETE FROM public.invoices WHERE id = '${ids.posted}'; COMMIT;`);
  assert.equal(r.status, 0, r.output);
  assert.equal(audits(ids.posted), 1);
  a = audit(ids.posted);
  assert.deepEqual(a.old, postedRow);
  assert.equal(a.new.admin_override_setting, true);
  console.log('[prover] posted invoice: refused without override (no audit row); with override -> snapshot, admin_override true');

  // 3. service_role, carrying an admin's JWT subject, deletes a payment set and a legacy payment.
  const setRow = JSON.parse(rowJson('allocation_sets', ids.set));
  const payRow = JSON.parse(rowJson('payments', ids.payment));
  r = run(`BEGIN; SET LOCAL request.jwt.claim.sub = '${ADMIN}'; SET LOCAL ROLE service_role;
    DELETE FROM public.allocation_sets WHERE id = '${ids.set}'; DELETE FROM public.payments WHERE id = '${ids.payment}'; COMMIT;`);
  assert.equal(r.status, 0, r.output);
  a = audit(ids.set);
  assert.deepEqual([a.op, a.entity, a.actor], ['payment_deleted', 'allocation_set', ADMIN]);
  assert.deepEqual(a.old, setRow);
  assert.deepEqual([a.new.allocation_entity_type, a.new.db_role], ['payment', 'service_role']);
  assert.deepEqual(a.new.cascaded_rows.invoice_line_allocations.sort((x, y) => x.id.localeCompare(y.id)),
    [kept.alloc1, kept.alloc2].sort((x, y) => x.id.localeCompare(y.id)), 'both invoice allocation lines are kept whole');
  assert.deepEqual(a.new.cascaded_rows.order_line_allocations, [kept.orderAlloc]);
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_line_allocations WHERE allocation_set_id = '${ids.set}';`), '0');
  a = audit(ids.payment);
  assert.deepEqual([a.op, a.entity, a.actor], ['payment_deleted', 'payment', ADMIN]);
  assert.deepEqual(a.old, payRow);
  assert.equal(a.new.cascaded_rows, null, 'a legacy payment has no cascaded children');
  console.log('[prover] service_role hard deletes of a payment set (with its 3 allocation lines kept) and a legacy payment -> payment_deleted rows, actor = JWT subject');

  // 3b. A split-billing (non-payment) allocation set is labelled allocation_set_deleted, not payment_deleted.
  const splitRow = JSON.parse(rowJson('allocation_sets', ids.splitSet));
  r = run(`DELETE FROM public.allocation_sets WHERE id = '${ids.splitSet}';`);
  assert.equal(r.status, 0, r.output);
  a = audit(ids.splitSet);
  assert.deepEqual([a.op, a.entity, a.new.allocation_entity_type], ['allocation_set_deleted', 'allocation_set', 'order']);
  assert.deepEqual(a.old, splitRow);
  assert.deepEqual(a.new.cascaded_rows, { invoice_line_allocations: [], order_line_allocations: [] });
  console.log('[prover] a split-billing allocation set delete -> allocation_set_deleted with its kind recorded');

  // 3c. TRUNCATE (which fires no row trigger) is refused on all three tables, for postgres and service_role.
  for (const table of ['invoices', 'allocation_sets', 'payments']) {
    for (const role of ['postgres', 'service_role']) {
      r = run(`BEGIN; ${role === 'postgres' ? '' : `SET LOCAL ROLE ${role};`} TRUNCATE public.${table} CASCADE; COMMIT;`);
      assert.notEqual(r.status, 0, `${role} TRUNCATE ${table} must refuse`);
      assert.match(r.output, role === 'service_role' && table === 'invoices' ? /permission denied|FINANCIAL_TRUNCATE_REFUSED/ : /FINANCIAL_TRUNCATE_REFUSED/);
    }
  }
  assert.ok(rowJson('invoices', ids.draft2), 'TRUNCATE attempts left the rows in place');
  console.log('[prover] TRUNCATE of invoices, allocation_sets and payments is refused for postgres and service_role');

  // 4. A signed-in user cannot delete, nor call the trigger function; nothing is written.
  r = run(`BEGIN; SET LOCAL request.jwt.claim.sub = '${ADMIN}'; SET LOCAL ROLE authenticated;
    DELETE FROM public.invoices WHERE id = '${ids.draft2}'; COMMIT;`);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /permission denied/);
  assert.equal(audits(ids.draft2), 0);
  assert.ok(rowJson('invoices', ids.draft2), 'the invoice is still there');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', '${FN}', 'EXECUTE');`), 'f', `${role} must not execute ${FN}`);
  }
  console.log('[prover] a signed-in delete is refused with no audit row; no API role can execute the trigger function');

  // 5. The new rows are append-only like every other, and the CHECK keeps every older value and refuses junk.
  r = run(`DELETE FROM public.financial_audit_log WHERE entity_id = '${ids.draft}';`);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /append-only/);
  r = run(`INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id) VALUES ('payment_erased', 'payment', gen_random_uuid());`);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /financial_audit_log_operation_type_check/);
  const listed = lf(CANDIDATE).match(/ARRAY\[([\s\S]*?)\]::text\[\]/)[1].match(/'[a-z_]+'/g).map((v) => v.slice(1, -1));
  const liveDef = scalar("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'financial_audit_log_operation_type_check';");
  for (const v of listed) assert.ok(liveDef.includes(`'${v}'::text`), `CHECK keeps ${v}`);
  assert.equal((liveDef.match(/'[a-z_]+'::text/g) ?? []).length, listed.length, 'CHECK has exactly the listed values');
  assert.deepEqual(listed, [...valuesBefore, 'payment_deleted', 'allocation_set_deleted'], 'the CHECK is the pre-candidate list plus the two new values');
  console.log(`[prover] audit rows stay append-only; the CHECK holds the ${valuesBefore.length} older values plus payment_deleted and allocation_set_deleted and refuses junk`);
  console.log('FINANCIAL_DELETE_SNAPSHOTS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
