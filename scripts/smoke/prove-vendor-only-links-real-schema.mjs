#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-15b step 1, vendor-only product links. Builds the checked-in schema
 * baseline in a network-disabled PostgreSQL container, replays migrations up to the candidate,
 * applies it twice, and checks with invented rows: grants and refusals; a vendor-only link with no
 * item facts and no invented ones; the shape rule and the one-vendor-only-link-per-vendor index;
 * reuse of an existing link; preferred switching (always exactly one); idempotent replay; that a
 * vendor-only link is never reusable and is refused for price import; that the strict link writer
 * still refuses a missing field and can fill a vendor-only link in place; and that products.vendor
 * and its direct edit are untouched.
 *
 * Run: node scripts/smoke/prove-vendor-only-links-real-schema.mjs   (needs local Docker image)
 * Prints VENDOR_ONLY_LINKS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-vendor-only-links-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261105090000_vendor_only_product_links.sql');
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
const TOUCHED = /(FUNCTION\s+(public\.)?"?(link_product_vendor|is_admin|upsert_product_supplier_link|stage_supplier_price_import|check_idempotency|save_idempotency)\b|product_supplier_links|vendor_aliases|legacy_vendor_resolution|supplier_price_import)/i;
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
const U = { ADMIN: id('a1'), REP: id('b1') };
const V = { ACME: id('e1'), BETA: id('e2'), OLD: id('e5') };
const P = { PLAIN: id('f1'), FULL: id('f2'), NOPREF: id('f3'), INACTIVE: id('f9') };
const SIG = 'public.link_product_vendor(uuid,uuid,boolean,uuid,text)';

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin'], [U.REP, 'sales_rep', 'Rep']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'vendor-only-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${u}';`).join('\n    ')}
    INSERT INTO public.vendors (id, name, deleted_at) VALUES
      ('${V.ACME}', '[PROVER] Acme Ag', NULL), ('${V.BETA}', '[PROVER] Beta Supply', NULL), ('${V.OLD}', '[PROVER] Old Co', now());
    INSERT INTO public.products (id, product_name, sku, vendor, inventory_unit, is_active) VALUES
      ('${P.PLAIN}', '[PROVER] Plain', 'PV-1', '[PROVER] Acme Ag', 'gal', true),
      ('${P.FULL}', '[PROVER] Full', 'PV-2', '[PROVER] Beta Supply', 'gal', true),
      ('${P.NOPREF}', '[PROVER] NoPref', 'PV-3', '[PROVER] Beta Supply', 'gal', true),
      ('${P.INACTIVE}', '[PROVER] Inactive', 'PV-9', '[PROVER] Acme Ag', 'gal', false);
    INSERT INTO public.product_supplier_links (id, product_id, vendor_id, supplier_sku, supplier_product_name, supplier_uom,
        supplier_pack_description, link_status, is_preferred, confirmed_by, confirmed_at, created_by) VALUES
      ('${id('d1')}', '${P.FULL}', '${V.BETA}', 'B-2', 'Beta Two', 'case', '2x2.5 gal', 'confirmed', true, '${U.ADMIN}', now(), '${U.ADMIN}'),
      ('${id('d2')}', '${P.NOPREF}', '${V.BETA}', 'B-3', 'Beta Three', 'case', '2x2.5 gal', 'confirmed', false, '${U.ADMIN}', now(), '${U.ADMIN}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a rep, three vendors (one deleted), four products (one inactive) and two full links');
}

// Runs statements as a signed-in user (or anon); commits unless asked to roll back.
function as(uid, sql, { rollback = false } = {}) {
  const setup = uid === 'anon'
    ? `SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSET LOCAL ROLE anon;`
    : `${claims(uid)}\nSET LOCAL ROLE authenticated;`;
  return docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${setup}\n${sql}\n${rollback ? 'ROLLBACK' : 'COMMIT'};`, allowFailure: true });
}
function link(uid, product, vendor, preferred, key) {
  const r = as(uid, `SELECT 'RESULT:' || public.link_product_vendor('${product}', '${vendor}', ${preferred}, '${uid === 'anon' ? U.ADMIN : uid}', ${key === null ? 'NULL' : `'${key}'`})::text;`);
  const out = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).at(-1);
  return out ? { ok: JSON.parse(out.slice(7)) } : { error: r.stderr };
}
function links(product) {
  return JSON.parse(scalar(`SELECT coalesce(json_agg(json_build_object('vendor', vendor_id, 'name', supplier_product_name, 'sku', supplier_sku,
      'pref', is_preferred, 'status', link_status, 'reusable', is_reusable, 'by', confirmed_by) ORDER BY created_at, id), '[]')
    FROM public.product_supplier_links WHERE product_id = '${product}' AND is_active;`));
}

function main() {
  buildContainer();
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = 'link_product_vendor';"), '0', 'the function must not exist before the candidate');
  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed:\n${applied.output}`);
  const reapplied = apply('candidate.sql');
  assert.equal(reapplied.status, 0, `candidate is not re-runnable:\n${reapplied.output}`);
  console.log('[prover] candidate applied twice cleanly');

  assert.equal(scalar(`SELECT provolatile::text || prosecdef::text FROM pg_proc WHERE oid = '${SIG}'::regprocedure;`), 'vtrue');
  assert.equal(scalar(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${SIG}'::regprocedure;`), 'search_path=public, pg_temp');
  assert.equal(scalar(`SELECT string_agg(r || '=' || has_function_privilege(r, '${SIG}', 'EXECUTE')::text, ',' ORDER BY r)
    FROM unnest(ARRAY['anon','authenticated','service_role']) r;`), 'anon=false,authenticated=true,service_role=false');
  assert.equal(scalar("SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_supplier_links' AND column_name = 'supplier_product_name';"), 'YES');
  console.log('[prover] SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only; supplier_product_name nullable');

  seed();
  const vendorText = () => scalar("SELECT md5(string_agg(id::text || coalesce(vendor, '~'), ',' ORDER BY id)) FROM public.products;");
  const textBefore = vendorText();

  assert.match(link('anon', P.PLAIN, V.ACME, true, 'k-anon').error ?? '', /permission denied/, 'anon must not execute it');
  assert.match(link(U.REP, P.PLAIN, V.ACME, true, 'k-rep').error ?? '', /ADMIN_REQUIRED/, 'a rep is refused');
  assert.match(link(U.ADMIN, P.PLAIN, V.ACME, true, null).error ?? '', /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(link(U.ADMIN, P.PLAIN, V.ACME, 'NULL', 'k-null').error ?? '', /PRODUCT_VENDOR_AND_PREFERRED_REQUIRED/);
  assert.match(link(U.ADMIN, P.INACTIVE, V.ACME, true, 'k-inactive').error ?? '', /PRODUCT_NOT_FOUND/);
  assert.match(link(U.ADMIN, P.PLAIN, V.OLD, true, 'k-old').error ?? '', /VENDOR_NOT_FOUND/, 'a deleted vendor is refused');
  const forged = as(U.ADMIN, `SELECT public.link_product_vendor('${P.PLAIN}', '${V.ACME}', true, '${U.REP}', 'k-forge');`, { rollback: true });
  assert.match(forged.stderr, /ACTOR_MISMATCH/);
  const bare = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\nSELECT public.link_product_vendor('${P.PLAIN}', '${V.ACME}', true, NULL, 'k');\nROLLBACK;`, allowFailure: true });
  assert.match(bare.stderr, /AUTH_REQUIRED/);
  assert.equal(links(P.PLAIN).length, 0, 'no refusal wrote a link');
  console.log('[prover] anon, rep, no user, forged actor, no key, null flag, inactive product and deleted vendor all refused; nothing written');

  // First link, asked for as not preferred: it becomes preferred anyway, since the product has none.
  const first = link(U.ADMIN, P.PLAIN, V.ACME, false, 'k-1');
  assert.ok(first.ok, first.error);
  assert.deepEqual([first.ok.is_preferred, first.ok.item_details_known, first.ok.created], [true, false, true]);
  assert.deepEqual(links(P.PLAIN), [{ vendor: V.ACME, name: null, sku: null, pref: true, status: 'confirmed', reusable: false, by: U.ADMIN }],
    'a vendor-only link has no item facts and none are invented');
  // The same call again with the same key replays; a different payload under that key is refused.
  assert.deepEqual(link(U.ADMIN, P.PLAIN, V.ACME, false, 'k-1').ok, first.ok);
  assert.match(link(U.ADMIN, P.PLAIN, V.BETA, false, 'k-1').error ?? '', /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  // A second vendor, not preferred, stays not preferred.
  const second = link(U.ADMIN, P.PLAIN, V.BETA, false, 'k-2');
  assert.deepEqual([second.ok.is_preferred, second.ok.created], [false, true]);
  // Make Beta preferred: Acme loses it in the same call, so exactly one is preferred.
  const switched = link(U.ADMIN, P.PLAIN, V.BETA, true, 'k-3');
  assert.deepEqual([switched.ok.id, switched.ok.is_preferred, switched.ok.created], [second.ok.id, true, false], 'the existing link is reused');
  assert.deepEqual(links(P.PLAIN).map((l) => [l.vendor, l.pref]), [[V.ACME, false], [V.BETA, true]]);
  // Linking Acme again (a new key) reuses its link rather than adding a duplicate.
  assert.deepEqual([link(U.ADMIN, P.PLAIN, V.ACME, false, 'k-4').ok.id, links(P.PLAIN).length], [first.ok.id, 2]);
  console.log('[prover] vendor-only link recorded; first link auto-preferred; switching keeps exactly one preferred; replay and reuse hold');

  // A product with a full preferred link: linking another vendor without preferred leaves it alone.
  assert.equal(link(U.ADMIN, P.FULL, V.ACME, false, 'k-5').ok.is_preferred, false);
  assert.deepEqual(links(P.FULL).map((l) => [l.vendor, l.pref, l.name]), [[V.BETA, true, 'Beta Two'], [V.ACME, false, null]]);
  // NoPref's full, unpreferred link: linking the same vendor reuses it and makes it preferred.
  const nopref = link(U.ADMIN, P.NOPREF, V.BETA, true, 'k-6');
  assert.deepEqual([nopref.ok.id, nopref.ok.created, nopref.ok.is_preferred, nopref.ok.item_details_known], [id('d2'), false, true, true]);
  console.log('[prover] a full link is reused and made preferred; another vendor does not take preference it was not given');

  // Both kinds for one vendor: making that vendor preferred hands it to the full link, not the vendor-only one.
  const acmeFull = scalar(`INSERT INTO public.product_supplier_links (product_id, vendor_id, supplier_sku, supplier_product_name, supplier_uom,
      supplier_pack_description, link_status, created_by, confirmed_by, confirmed_at)
    VALUES ('${P.FULL}', '${V.ACME}', 'AC-9', 'Acme Full', 'case', '4x1 gal', 'confirmed', '${U.ADMIN}', '${U.ADMIN}', now()) RETURNING id;`);
  const both = link(U.ADMIN, P.FULL, V.ACME, true, 'k-both');
  assert.deepEqual([both.ok.id, both.ok.is_preferred, both.ok.item_details_known, both.ok.created], [acmeFull, true, true, false], both.error);
  assert.deepEqual(links(P.FULL).map((l) => [l.vendor, l.pref, l.name]),
    [[V.BETA, false, 'Beta Two'], [V.ACME, false, null], [V.ACME, true, 'Acme Full']]);
  console.log('[prover] with a full and a vendor-only link to one vendor, the full link takes preferred');

  // The shape rule: no item facts on a link without an item name, and one active vendor-only link per vendor.
  const shape = psql(`UPDATE public.product_supplier_links SET supplier_sku = 'X-1' WHERE id = '${first.ok.id}';`, { allowFailure: true });
  assert.match(shape.stderr, /product_supplier_links_vendor_only_shape/);
  const dupe = psql(`INSERT INTO public.product_supplier_links (product_id, vendor_id, link_status, created_by, confirmed_by, confirmed_at)
    VALUES ('${P.PLAIN}', '${V.ACME}', 'confirmed', '${U.ADMIN}', '${U.ADMIN}', now());`, { allowFailure: true });
  assert.match(dupe.stderr, /uq_product_supplier_links_vendor_only/);
  console.log('[prover] item facts without an item name, and a second vendor-only link to one vendor, are refused by the table');

  // Never reusable: the quote sheet leaves it out, and staging a price row against it is refused.
  const sheet = as(U.ADMIN, `SELECT 'RESULT:' || public.get_supplier_quote_sheet('${V.ACME}')::text;`, { rollback: true });
  assert.equal(sheet.status, 0, sheet.stderr);
  assert.ok(!sheet.stdout.includes(first.ok.id), 'a vendor-only link is not on the quote sheet');
  const stage = as(U.ADMIN, `SELECT 'RESULT:' || public.stage_supplier_price_import('${V.ACME}', '2026-11-01', 'quote_sheet', 'v1', NULL, NULL, NULL,
      jsonb_build_array(jsonb_build_object('product_supplier_link_id', '${first.ok.id}', 'product_id', '${P.PLAIN}', 'cost', '10.00', 'price_unit', 'gal')),
      '${U.ADMIN}', 'k-stage')::text;`, { rollback: true });
  assert.match(`${stage.stdout}\n${stage.stderr}`, /LINK_NOT_CONFIRMED_FOR_REUSE/, 'a price row against a vendor-only link is refused');
  console.log('[prover] a vendor-only link is never reusable: not on the quote sheet, refused for a price row');

  // The strict writer still refuses a missing field, and can fill the vendor-only link in place.
  const strict = as(U.ADMIN, `SELECT public.upsert_product_supplier_link('${P.PLAIN}', '${V.ACME}', 'AC-1', 'Acme Plain', 'case', '', NULL, NULL, 'pending', NULL, false, '${U.ADMIN}', 'k-strict', NULL);`, { rollback: true });
  assert.match(strict.stderr, /SUPPLIER_LINK_REUSE_FIELDS_REQUIRED/);
  const fill = as(U.ADMIN, `SELECT public.upsert_product_supplier_link('${P.PLAIN}', '${V.ACME}', 'AC-1', 'Acme Plain', 'case', '2x2.5 gal', NULL, NULL, 'pending', NULL, false, '${U.ADMIN}', 'k-fill', '${first.ok.id}');`);
  assert.equal(fill.status, 0, fill.stderr);
  assert.deepEqual(links(P.PLAIN).find((l) => l.vendor === V.ACME),
    { vendor: V.ACME, name: 'Acme Plain', sku: 'AC-1', pref: false, status: 'confirmed', reusable: true, by: U.ADMIN });
  console.log('[prover] upsert_product_supplier_link still refuses a blank pack, and fills a vendor-only link in place');

  // products.vendor and its direct edit are untouched.
  assert.equal(vendorText(), textBefore, 'no product vendor text changed');
  const edit = as(U.ADMIN, `UPDATE public.products SET vendor = '[PROVER] Beta Supply' WHERE id = '${P.PLAIN}' RETURNING vendor;`, { rollback: true });
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, /\[PROVER\] Beta Supply/);
  console.log('[prover] product vendor text unchanged, and an admin can still edit it directly (no enforcement yet)');
  console.log('VENDOR_ONLY_LINKS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
