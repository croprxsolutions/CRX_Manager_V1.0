#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-15a's vendor-link proposal report (DATA-11). Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays migrations up to the
 * candidate, applies it twice, and checks with invented rows: grants, refusals for anon, a rep and
 * no user, every proposal status, purchasing and quote-sheet evidence, no cost fields, no writes,
 * that the existing link writer still refuses a missing field, and that vendor text edits still work.
 *
 * Run: node scripts/smoke/prove-vendor-link-proposals-real-schema.mjs   (needs local Docker image)
 * Prints VENDOR_LINK_PROPOSALS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-vendor-proposals-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261104180000_vendor_link_proposals.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(FUNCTION\s+(public\.)?"?(get_vendor_link_proposals|is_admin|normalize_vendor_alias|upsert_product_supplier_link)\b|product_supplier_links|vendor_aliases|legacy_vendor_resolution|supplier_price_import)/i;
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

const id = (n) => `7c150000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1') };
const V = { ACME: id('e1'), BETA: id('e2'), GAMMA: id('e3'), DELTA: id('e4'), OLD: id('e5') };
const P = {
  SHEET: id('f1'), ALIAS: id('f2'), NOBODY: id('f3'), BLANK: id('f4'), LINKED: id('f5'),
  DIFFERS: id('f6'), NOPREF: id('f7'), AMBIG: id('f8'), INACTIVE: id('f9'), DELETED: id('f10'),
};

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin'], [U.REP, 'sales_rep', 'Rep']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'vendor-proposals-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${u}';`).join('\n    ')}
    INSERT INTO public.vendors (id, name, deleted_at) VALUES
      ('${V.ACME}', '[PROVER] Acme Ag', NULL), ('${V.BETA}', '[PROVER] Beta Supply', NULL),
      ('${V.GAMMA}', '[PROVER] Gamma', NULL), ('${V.DELTA}', '[PROVER] Delta', NULL),
      ('${V.OLD}', '[PROVER] Old Co', now());
    INSERT INTO public.vendor_aliases (vendor_id, alias_raw, alias_display, source, review_status, reviewed_at, reviewed_by) VALUES
      ('${V.ACME}', '[PROVER] Acme Agriculture', 'Acme Agriculture', 'legacy_product', 'approved', now(), '${U.ADMIN}');
    -- The text "Delta" names the Delta vendor and, by a reviewed legacy resolution, Gamma too.
    INSERT INTO public.legacy_vendor_resolution (original_text, vendor_id, review_status, source_table, reviewed_at, reviewed_by) VALUES
      ('[PROVER] Delta', '${V.GAMMA}', 'approved', 'products', now(), '${U.ADMIN}');
    INSERT INTO public.products (id, product_name, sku, vendor, inventory_unit, is_active) VALUES
      ('${P.SHEET}', '[PROVER] Sheet', 'PV-1', '[PROVER] Acme Ag', 'gal', true),
      ('${P.ALIAS}', '[PROVER] Alias', 'PV-2', ' [prover] acme agriculture. ', 'gal', true),
      ('${P.NOBODY}', '[PROVER] Nobody', 'PV-3', '[PROVER] Nobody Inc', 'gal', true),
      ('${P.BLANK}', '[PROVER] Blank', 'PV-4', '  ', 'gal', true),
      ('${P.LINKED}', '[PROVER] Linked', 'PV-5', '[PROVER] Beta Supply', 'gal', true),
      ('${P.DIFFERS}', '[PROVER] Differs', 'PV-6', '[PROVER] Acme Ag', 'gal', true),
      ('${P.NOPREF}', '[PROVER] NoPref', 'PV-7', '[PROVER] Beta Supply', 'gal', true),
      ('${P.AMBIG}', '[PROVER] Ambig', 'PV-8', '[PROVER] Delta', 'gal', true),
      ('${P.INACTIVE}', '[PROVER] Inactive', 'PV-9', '[PROVER] Acme Ag', 'gal', false),
      ('${P.DELETED}', '[PROVER] Deleted', 'PV-10', '[PROVER] Old Co', 'gal', true);
    INSERT INTO public.product_supplier_links (product_id, vendor_id, supplier_sku, supplier_product_name, supplier_uom,
        supplier_pack_description, link_status, is_preferred, confirmed_by, confirmed_at, created_by) VALUES
      ('${P.LINKED}', '${V.BETA}', 'B-5', 'Beta Five', 'case', '2x2.5 gal', 'confirmed', true, '${U.ADMIN}', now(), '${U.ADMIN}'),
      ('${P.DIFFERS}', '${V.BETA}', 'B-6', 'Beta Six', 'case', '2x2.5 gal', 'confirmed', true, '${U.ADMIN}', now(), '${U.ADMIN}'),
      ('${P.NOPREF}', '${V.BETA}', 'B-7', 'Beta Seven', 'case', '2x2.5 gal', 'confirmed', false, '${U.ADMIN}', now(), '${U.ADMIN}'),
      -- A preferred link to a deleted vendor is no link at all.
      ('${P.DELETED}', '${V.OLD}', 'O-10', 'Old Ten', 'case', '1 gal', 'confirmed', true, '${U.ADMIN}', now(), '${U.ADMIN}');
    -- Two live POs from Acme for the Sheet product (one spelled differently), one cancelled, one from Beta.
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${id('c1')}', 'PV-PO-1', '[PROVER] ACME AG.', 'fully_received', '2026-03-01', '${U.ADMIN}'),
      ('${id('c2')}', 'PV-PO-2', '[PROVER] Acme Ag', 'submitted', '2026-05-01', '${U.ADMIN}'),
      ('${id('c3')}', 'PV-PO-3', '[PROVER] Acme Ag', 'cancelled', '2026-09-01', '${U.ADMIN}'),
      ('${id('c4')}', 'PV-PO-4', '[PROVER] Beta Supply', 'submitted', '2026-10-01', '${U.ADMIN}'),
      ('${id('c5')}', 'PV-PO-5', '[PROVER] Acme Ag', 'draft', '2026-10-15', '${U.ADMIN}');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_size) VALUES
      ('${id('c1')}', '${P.SHEET}', 4, '2x2.5 gal'), ('${id('c2')}', '${P.SHEET}', 2, '30 gal drum'),
      ('${id('c3')}', '${P.SHEET}', 9, 'cancelled pack'), ('${id('c4')}', '${P.SHEET}', 1, 'beta pack'), ('${id('c5')}', '${P.SHEET}', 3, 'draft pack');
    -- An approved Acme quote-sheet row for Sheet, and a newer unapproved one that must be ignored.
    INSERT INTO public.supplier_price_imports (id, vendor_id, document_date, ingestion_method, format_version,
        status, request_fingerprint, idempotency_key, created_by, approved_by, approved_at) VALUES
      ('${id('d1')}', '${V.ACME}', '2026-06-01', 'quote_sheet', 'v1', 'approved', 'fp1', 'pv-k1', '${U.ADMIN}', '${U.ADMIN}', now()),
      ('${id('d2')}', '${V.ACME}', '2026-08-01', 'quote_sheet', 'v1', 'needs_review', 'fp2', 'pv-k2', '${U.ADMIN}', NULL, NULL),
      ('${id('d3')}', '${V.ACME}', '2026-09-01', 'quick_quote', 'v1', 'approved', 'fp3', 'pv-k3', '${U.ADMIN}', '${U.ADMIN}', now());
    INSERT INTO public.supplier_price_import_rows (import_id, row_number, submitted_row, product_id, vendor_id,
        supplier_sku, supplier_product_name, price_unit, package_quantity, cost_cents, row_status, observation_id, reviewed_by, reviewed_at) VALUES
      ('${id('d1')}', 1, '{}', '${P.SHEET}', '${V.ACME}', 'AC-1', 'Acme Sheet 2x2.5', 'case', 5, 12345, 'approved', gen_random_uuid(), '${U.ADMIN}', now()),
      ('${id('d2')}', 1, '{}', '${P.SHEET}', '${V.ACME}', 'AC-NEW', 'Unapproved', 'drum', 30, 999, 'new', NULL, NULL, NULL),
      -- A newer approved price correction carries no SKU or name and must not hide the sheet row.
      ('${id('d3')}', 1, '{}', '${P.SHEET}', '${V.ACME}', NULL, NULL, 'case', 5, 13000, 'approved', gen_random_uuid(), '${U.ADMIN}', now());
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a rep, five vendors (one deleted), ten products (one inactive), links, POs and quote-sheet rows');
}

// One rolled-back transaction per call; returns the function's JSON or the error.
function call(as) {
  const setup = as === 'anon'
    ? `SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSET LOCAL ROLE anon;`
    : `${claims(as)}\nSET LOCAL ROLE authenticated;`;
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${setup}\nSELECT 'RESULT:' || public.get_vendor_link_proposals()::text;\nROLLBACK;`, allowFailure: true,
  });
  const out = r.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('RESULT:')).at(-1);
  return out ? { ok: JSON.parse(out.slice(7)) } : { error: r.stderr };
}

function main() {
  buildContainer();
  const before = scalar("SELECT count(*) FROM pg_proc WHERE proname = 'get_vendor_link_proposals';");
  assert.equal(before, '0', 'the function must not exist before the candidate');
  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed:\n${applied.output}`);
  const reapplied = apply('candidate.sql');
  assert.equal(reapplied.status, 0, `candidate is not re-runnable:\n${reapplied.output}`);
  console.log('[prover] candidate applied twice cleanly');

  // Shape: read-only, definer with a pinned search_path, executable by authenticated only.
  assert.equal(scalar("SELECT provolatile::text || prosecdef::text FROM pg_proc WHERE oid = 'public.get_vendor_link_proposals()'::regprocedure;"), 'strue');
  assert.equal(scalar("SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.get_vendor_link_proposals()'::regprocedure;"), 'search_path=public, pg_temp');
  assert.equal(scalar(`SELECT string_agg(r || '=' || has_function_privilege(r, 'public.get_vendor_link_proposals()', 'EXECUTE')::text, ',' ORDER BY r)
    FROM unnest(ARRAY['anon','authenticated','service_role']) r;`), 'anon=false,authenticated=true,service_role=false');
  console.log('[prover] STABLE SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only');

  seed();
  const counts = () => scalar(`SELECT concat_ws(',', (SELECT count(*) FROM public.product_supplier_links),
    (SELECT md5(string_agg(id::text || coalesce(vendor, '~'), ',' ORDER BY id)) FROM public.products),
    (SELECT count(*) FROM public.vendor_aliases), (SELECT count(*) FROM public.legacy_vendor_resolution));`);
  const snapshot = counts();

  const anon = call('anon');
  assert.match(anon.error ?? '', /permission denied/, 'anon must not execute it');
  const rep = call(U.REP);
  assert.match(rep.error ?? '', /ADMIN_REQUIRED/, 'a non-admin must be refused');
  const bare = docker([...psqlArgs(), '-A', '-t'], { input: 'BEGIN;\nSELECT public.get_vendor_link_proposals();\nROLLBACK;', allowFailure: true });
  assert.match(bare.stderr, /AUTH_REQUIRED/, 'a call with no signed-in user must be refused');
  console.log('[prover] anon refused (no EXECUTE), sales rep refused ADMIN_REQUIRED, no user refused AUTH_REQUIRED');

  const result = call(U.ADMIN);
  assert.ok(result.ok, `admin call failed:\n${result.error}`);
  const rows = Object.fromEntries(result.ok.rows.map((r) => [r.product_id, r]));
  assert.equal(result.ok.rows.length, 9, 'every active product, and only active ones');
  assert.ok(!(P.INACTIVE in rows), 'an inactive product is left out');
  for (const r of result.ok.rows) {
    for (const key of Object.keys(r)) assert.ok(!/cost|price_cents|tier/.test(key), `no cost field may be returned (${key})`);
  }

  const sheet = rows[P.SHEET];
  assert.equal(sheet.status, 'proposed');
  assert.equal(sheet.proposed_vendor_id, V.ACME);
  assert.deepEqual(sheet.match_sources, ['vendor_name']);
  assert.equal(sheet.po_count, 2, 'two sent Acme POs; the cancelled, draft and Beta ones are not counted');
  assert.equal(sheet.last_po_date, '2026-05-01');
  assert.equal(sheet.last_po_unit_size, '30 gal drum');
  assert.equal(sheet.sheet_supplier_sku, 'AC-1', 'only an approved quote-sheet row is evidence');
  assert.equal(sheet.sheet_supplier_product_name, 'Acme Sheet 2x2.5');
  assert.equal(sheet.sheet_supplier_uom, 'case');
  assert.deepEqual(sheet.missing_fields, ['supplier_pack_description']);

  const alias = rows[P.ALIAS];
  assert.equal(alias.status, 'proposed');
  assert.equal(alias.proposed_vendor_id, V.ACME);
  assert.deepEqual(alias.match_sources, ['vendor_alias']);
  assert.equal(alias.po_count, 0);
  assert.deepEqual(alias.missing_fields, ['supplier_sku', 'supplier_product_name', 'supplier_uom', 'supplier_pack_description']);

  assert.equal(rows[P.NOBODY].status, 'unresolved');
  assert.equal(rows[P.NOBODY].legacy_vendor_text, '[PROVER] Nobody Inc', 'unresolved text is kept for review');
  assert.equal(rows[P.NOBODY].proposed_vendor_id, null);
  assert.equal(rows[P.DELETED].status, 'unresolved', 'a deleted vendor never matches, by text or by link');
  assert.equal(rows[P.DELETED].confirmed_links, 0);
  assert.equal(rows[P.BLANK].status, 'no_vendor');
  assert.equal(rows[P.LINKED].status, 'linked');
  assert.equal(rows[P.LINKED].proposed_vendor_id, V.BETA);
  assert.deepEqual(rows[P.LINKED].missing_fields, [], 'a linked product needs no new link');
  assert.deepEqual(rows[P.NOPREF].missing_fields, []);
  assert.equal(result.ok.rows[0].status, 'ambiguous', 'exceptions sort first');
  assert.equal(result.ok.rows.at(-1).status, 'linked');
  assert.equal(rows[P.DIFFERS].status, 'linked_text_differs');
  assert.equal(rows[P.DIFFERS].proposed_vendor_id, V.BETA, 'evidence follows the preferred link');
  assert.equal(rows[P.DIFFERS].text_vendor_name, '[PROVER] Acme Ag');
  assert.equal(rows[P.NOPREF].status, 'linked_no_preferred');
  assert.equal(rows[P.AMBIG].status, 'ambiguous');
  assert.equal(rows[P.AMBIG].proposed_vendor_id, null, 'an ambiguous name proposes nothing');
  assert.deepEqual(rows[P.AMBIG].candidate_vendor_names, ['[PROVER] Delta', '[PROVER] Gamma'], 'an ambiguous row names its candidates');
  assert.deepEqual(rows[P.NOPREF].links.map((l) => [l.vendor_name, l.link_status, l.is_preferred, l.supplier_sku]),
    [['[PROVER] Beta Supply', 'confirmed', false, 'B-7']], 'existing links are listed by name');
  assert.deepEqual(rows[P.DELETED].links, [], 'a link to a deleted vendor is not listed');
  assert.deepEqual(rows[P.ALIAS].links, []);
  assert.deepEqual(result.ok.summary, {
    proposed: 2, unresolved: 2, no_vendor: 1, linked: 1, linked_text_differs: 1, linked_no_preferred: 1, ambiguous: 1,
  });
  console.log(`[prover] admin sees nine rows: ${JSON.stringify(result.ok.summary)}`);

  assert.equal(counts(), snapshot, 'the report must write nothing');
  console.log('[prover] links, product vendor text, aliases and resolutions unchanged by the report');

  // A proposal with a missing field can never become a confirmed link through the existing writer.
  const writer = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${claims(U.ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.upsert_product_supplier_link('${P.ALIAS}', '${V.ACME}', 'AC-2', 'Acme Alias', 'case', '', NULL, NULL, 'pending', NULL, true, '${U.ADMIN}', 'pv-writer-1', NULL);
    ROLLBACK;`, allowFailure: true });
  assert.match(writer.stderr, /SUPPLIER_LINK_REUSE_FIELDS_REQUIRED/, 'a blank pack description must be refused');
  console.log('[prover] upsert_product_supplier_link refuses a link with no pack description');

  // Existing vendor behaviour is untouched: an admin's direct edit of the vendor text still saves.
  const edit = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${claims(U.ADMIN)}\nSET LOCAL ROLE authenticated;
    UPDATE public.products SET vendor = '[PROVER] Gamma' WHERE id = '${P.NOBODY}' RETURNING vendor;
    ROLLBACK;`, allowFailure: true });
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, /\[PROVER\] Gamma/);
  console.log('[prover] an admin can still edit the vendor text directly (no enforcement yet)');
  console.log('VENDOR_LINK_PROPOSALS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
