#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-15b enforcement (20261105110000): a product with vendor links has
 * exactly one preferred link, and products.vendor is a read-only copy of its name. Builds the
 * checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations up to
 * the candidate, seeds invented rows, and checks: it refuses to install until every product with
 * links has one preferred link; preferring, renaming, unlinking and deleting keep the copy in sync
 * or refuse with an actionable message; product inserts still work and auto-link; a full link
 * replaces a vendor-only one; the vendor list reaches staff with cost for admins only.
 *
 * Run: node scripts/smoke/prove-preferred-vendor-enforcement-real-schema.mjs   (needs local Docker image)
 * Prints PREFERRED_VENDOR_ENFORCEMENT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-pv-enforce-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261105110000_preferred_vendor_enforcement.sql');
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
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105100000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(product_supplier_links|vendor_aliases|legacy_vendor_resolution|normalize_vendor_alias|supplier_price_observations|FUNCTION\s+(public\.)?"?(is_admin|is_active_profile|save_vendor|delete_vendor)\b)/i;
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




const id = (n) => `7c15b000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const V = { A: id('b1'), B: id('b2'), C: id('b3') };
const P = { ONE: id('c1'), NEW: id('c2'), LOOSE: id('c3') };
const LINK_A = id('d1');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pv-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pv-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.vendors (id, name) VALUES
      ('${V.A}', '[PROVER] Acme Ag'), ('${V.B}', '[PROVER] Beta Supply'), ('${V.C}', '[PROVER] Spare Co');
    INSERT INTO public.products (id, product_name, sku, vendor, inventory_unit, is_active) VALUES
      ('${P.ONE}', '[PROVER] One', 'PV-1', '[PROVER] Acme Ag', 'gal', true);
    INSERT INTO public.product_supplier_links (id, product_id, vendor_id, comparison_status, link_status, is_preferred,
        confirmed_by, confirmed_at, created_by) VALUES
      ('${LINK_A}', '${P.ONE}', '${V.A}', 'pending', 'confirmed', false, '${ADMIN}', now(), '${ADMIN}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a sales rep, three vendors and one product whose only link is not yet preferred');
}
function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
// One transaction as a signed-in browser session (role authenticated, live's JWT claims), or as a
// signed-out visitor (role anon) when uid is null.
function as(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const vendorOf = (p) => scalar(`SELECT coalesce(vendor, '~') FROM public.products WHERE id = '${p}';`);
const preferredOf = (p) => scalar(`SELECT coalesce(string_agg(vendor_id::text, ','), '-') FROM public.product_supplier_links
  WHERE product_id = '${p}' AND is_active AND link_status = 'confirmed' AND is_preferred;`);
const link = (p, v, pref, key) => `SELECT public.link_product_vendor('${p}', '${v}', ${pref}, '${ADMIN}', '${key}');`;

function main() {
  buildContainer();
  seed();

  // Installing it while a product with links has no preferred link refuses, changing nothing.
  stageText('cand.sql', lf(CANDIDATE));
  const early = apply('cand.sql');
  assert.notEqual(early.status, 0);
  assert.match(early.output, /PREFERRED_VENDOR_ENFORCEMENT_NOT_READY: 1 products with links/);
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_product_supplier_links_prepare';"), '0');
  asOwner(`UPDATE public.product_supplier_links SET is_preferred = true WHERE id = '${LINK_A}';`);
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  console.log('[prover] it refuses to install until every product with links has one preferred link, then installs');

  // Adding a vendor leaves the preferred one; making it preferred copies its name.
  ok(ADMIN, link(P.ONE, V.B, false, 'k-add-b'));
  assert.deepEqual([preferredOf(P.ONE), vendorOf(P.ONE)], [V.A, '[PROVER] Acme Ag']);
  ok(ADMIN, link(P.ONE, V.B, true, 'k-pref-b'));
  assert.deepEqual([preferredOf(P.ONE), vendorOf(P.ONE)], [V.B, '[PROVER] Beta Supply']);
  console.log('[prover] a second vendor stays secondary until made preferred; then the product shows its name');

  // Remove a non-preferred vendor (and replay it); the preferred one cannot be removed.
  const unlinkA = `SELECT public.unlink_product_vendor('${LINK_A}', '${ADMIN}', 'k-unlink-a');`;
  const first = ok(ADMIN, unlinkA);
  assert.equal(ok(ADMIN, unlinkA), first, 'a same-key replay answers the same');
  assert.equal(scalar(`SELECT is_active FROM public.product_supplier_links WHERE id = '${LINK_A}';`), 'f');
  const linkB = scalar(`SELECT id FROM public.product_supplier_links WHERE product_id = '${P.ONE}' AND vendor_id = '${V.B}' AND is_active;`);
  refused(ADMIN, `SELECT public.unlink_product_vendor('${linkB}', '${ADMIN}', 'k-unlink-b');`, /PREFERRED_VENDOR_REQUIRED: this is the preferred vendor/);
  refused(REP, `SELECT public.unlink_product_vendor('${linkB}', '${REP}', 'k-unlink-rep');`, /ADMIN_REQUIRED/);
  // Any writer that leaves links without a preferred one is refused at commit.
  const direct = docker([...psqlArgs()], { allowFailure: true, input: `BEGIN;
    UPDATE public.product_supplier_links SET is_preferred = false WHERE id = '${linkB}';
    COMMIT;` });
  assert.notEqual(direct.status, 0);
  assert.match(`${direct.stdout}${direct.stderr}`, /PREFERRED_VENDOR_REQUIRED/);
  assert.equal(preferredOf(P.ONE), V.B);
  console.log('[prover] removing a secondary vendor works and replays; the preferred vendor cannot be removed or unpreferred');

  // products.vendor is read-only to writers; saves that leave it alone still work.
  refused(ADMIN, `UPDATE public.products SET vendor = 'Someone Else' WHERE id = '${P.ONE}';`,
    /PRODUCT_VENDOR_FOLLOWS_PREFERRED_VENDOR: .*Vendors section/);
  ok(ADMIN, `UPDATE public.products SET product_name = '[PROVER] One edited', vendor = vendor WHERE id = '${P.ONE}';`);
  assert.equal(vendorOf(P.ONE), '[PROVER] Beta Supply');
  console.log('[prover] a direct vendor-text edit is refused with an actionable message; other edits still save');

  // A new product's vendor text that names one vendor becomes its preferred vendor-only link.
  // The browser role cannot choose a product id (live column grants), so read it back by sku.
  P.NEW = ok(ADMIN, `INSERT INTO public.products (product_name, sku, vendor, inventory_unit, is_active)
    VALUES ('[PROVER] New', 'PV-2', '  [prover]  acme ag ', 'gal', true) RETURNING id;`);
  assert.deepEqual([preferredOf(P.NEW), vendorOf(P.NEW)], [V.A, '[PROVER] Acme Ag']);
  P.LOOSE = ok(ADMIN, `INSERT INTO public.products (product_name, sku, vendor, inventory_unit, is_active)
    VALUES ('[PROVER] Loose', 'PV-3', 'Nobody We Know', 'gal', true) RETURNING id;`);
  assert.deepEqual([preferredOf(P.LOOSE), vendorOf(P.LOOSE)], ['-', 'Nobody We Know']);
  console.log('[prover] new products still save; text naming one vendor becomes its preferred link and exact name');

  // A full link replaces that vendor's vendor-only link and inherits its preferred flag.
  ok(ADMIN, `SELECT public.upsert_product_supplier_link('${P.NEW}', '${V.A}', 'ACME-9', 'Acme Nine', 'case', '2x2.5 gal',
    '5', 'gal', 'comparable', NULL, false, '${ADMIN}', 'k-full-a');`);
  const rows = JSON.parse(scalar(`SELECT json_agg(json_build_object('name', supplier_product_name, 'active', is_active,
    'pref', is_preferred) ORDER BY created_at, id) FROM public.product_supplier_links WHERE product_id = '${P.NEW}';`));
  assert.deepEqual(rows, [{ name: null, active: false, pref: false }, { name: 'Acme Nine', active: true, pref: true }]);
  assert.equal(vendorOf(P.NEW), '[PROVER] Acme Ag');
  console.log('[prover] a full link replaces the vendor-only one and stays preferred');

  // Cost reaches admins only; vendors reach staff; a signed-out visitor gets nothing.
  const fullLink = scalar(`SELECT id FROM public.product_supplier_links WHERE product_id = '${P.NEW}' AND is_active;`);
  asOwner(`INSERT INTO public.supplier_price_imports (id, vendor_id, document_date, ingestion_method, format_version,
      status, request_fingerprint, idempotency_key, created_by, approved_by, approved_at)
    VALUES ('${id('e1')}', '${V.A}', current_date - 1, 'quick_quote', 'v1', 'approved', 'pv', 'k-import', '${ADMIN}', '${ADMIN}', now());
    INSERT INTO public.supplier_price_import_rows (id, import_id, row_number, submitted_row, product_id, vendor_id,
        price_unit, package_quantity, cost_cents, row_status, observation_id, reviewed_by, reviewed_at)
      VALUES ('${id('e2')}', '${id('e1')}', 1, '{}', '${P.NEW}', '${V.A}', 'case', 1, 5000, 'approved', '${id('e3')}', '${ADMIN}', now());
    INSERT INTO public.supplier_price_observations (id, import_row_id, import_id, product_id, vendor_id, product_supplier_link_id, price_kind,
      cost_cents, price_unit, package_quantity, effective_from, observed_at, created_by)
    VALUES ('${id('e3')}', '${id('e2')}', '${id('e1')}', '${P.NEW}', '${V.A}', '${fullLink}', 'quote', 5000, 'case', 1, current_date - 1, now(), '${ADMIN}');`);
  const adminView = JSON.parse(ok(ADMIN, `SELECT public.get_product_vendors('${P.NEW}');`));
  assert.deepEqual(adminView.map((v) => [v.vendor_name, v.is_preferred, v.item_details_known, v.last_cost_cents, v.last_quoted_package_cost_cents]),
    [['[PROVER] Acme Ag', true, true, 1000, 5000]]);
  const repView = JSON.parse(ok(REP, `SELECT public.get_product_vendors('${P.NEW}');`));
  assert.deepEqual(repView.map((v) => [v.vendor_name, v.last_cost_cents, v.last_quoted_package_cost_cents, v.last_cost_as_of]),
    [['[PROVER] Acme Ag', null, null, null]]);
  refused(null, `SELECT public.get_product_vendors('${P.NEW}');`, /permission denied/);
  console.log('[prover] the vendor list reaches staff, cost reaches admins only, a signed-out visitor is refused');

  // The proposals report tells vendor-only links apart and still lists their missing item fields.
  const report = JSON.parse(ok(ADMIN, 'SELECT public.get_vendor_link_proposals();'));
  const one = report.rows.find((r) => r.product_id === P.ONE);
  assert.equal(one.links[0].item_details_known, false);
  assert.ok(one.missing_fields.includes('supplier_product_name'));
  assert.deepEqual(report.rows.find((r) => r.product_id === P.NEW).missing_fields, []);
  console.log('[prover] the proposals report marks vendor-only links and their missing item fields');

  // A rename reaches every product that prefers the vendor; a preferred vendor cannot be deleted.
  ok(ADMIN, `SELECT public.save_vendor('${V.B}', '{"name":"[PROVER] Beta Renamed"}'::jsonb, 'k-rename');`);
  assert.equal(vendorOf(P.ONE), '[PROVER] Beta Renamed');
  refused(ADMIN, `SELECT public.delete_vendor('${V.B}', 'k-del-b');`, /VENDOR_IS_PREFERRED: 1 products/);
  ok(ADMIN, `SELECT public.delete_vendor('${V.C}', 'k-del-c');`);
  console.log('[prover] a vendor rename reaches its products; a preferred vendor cannot be deleted, a spare one can');

  // Every product with links still has exactly one preferred link, whose name it shows.
  assert.equal(scalar(`SELECT count(*) FROM public.products p WHERE EXISTS (SELECT 1 FROM public.product_supplier_links l
      WHERE l.product_id = p.id AND l.is_active AND l.link_status = 'confirmed')
    AND (SELECT count(*) FROM public.product_supplier_links l JOIN public.vendors v ON v.id = l.vendor_id
      WHERE l.product_id = p.id AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred AND v.name = p.vendor) <> 1;`), '0');
  console.log('PREFERRED_VENDOR_ENFORCEMENT_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
