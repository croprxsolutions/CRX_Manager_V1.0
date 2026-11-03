#!/usr/bin/env node
/**
 * Real-schema proof for the WP-PM-15b data step (DATA-11): every active product gets exactly one
 * preferred vendor link. Builds the checked-in schema baseline in a network-disabled PostgreSQL
 * container, replays migrations up to the candidate, seeds invented rows (sharing only the ids the
 * migration names), and checks: bound to the approved live plan it refuses on any other data and
 * writes nothing; a non-admin approver, a count mismatch, vendor text that does not name the vendor to prefer, or a product left with no preferred link
 * refuse as a whole; bound to its own plan it writes vendor-only preferred links for products whose
 * vendor text names one vendor (directly, by approved alias, or by approved legacy resolution) and
 * for the two hand-assigned products, marks a lone existing link preferred, and changes nothing else
 * (no vendor text, no inactive product, no already-preferred product); a second run refuses.
 *
 * Run: node scripts/smoke/prove-data11-preferred-links-real-schema.mjs   (needs local Docker image)
 * Prints DATA11_PREFERRED_LINKS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-data11-links-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261105100000_data11_preferred_vendor_links.sql');
// The live plan Mason approved on 2026-11-03 (see the migration header).
const APPROVED = { fingerprint: '6c8955cb8d658f89d45546d22e225dde', links: 586, prefers: 10 };
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
const TOUCHED = /(product_supplier_links|vendor_aliases|legacy_vendor_resolution|normalize_vendor_alias|FUNCTION\s+(public\.)?"?is_admin\b)/i;
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
// The approver, the two hand-assigned products and their vendors carry the ids the migration names;
// every row here is invented ([PROVER] names), only the ids are shared.
const APPROVER = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
const V = {
  SPINNER: '54f3e209-c3f9-44f1-98ff-2cb062838b7c', CRX: '3c2f7804-72f3-4311-af61-2be4c4a7f0af',
  ACME: id('e1'), BETA: id('e2'), LEGACY: id('e3'), DUP1: id('e6'), DUP2: id('e7'), OLD: id('e5'),
};
const P = {
  TEXT: id('f1'), ALIAS: id('f2'), LEGACY: id('f3'), ONE: id('f4'), DONE: id('f5'),
  EXP1: '1a3c082a-1603-4eff-a4db-316af555ff87', EXP2: '4983d7c2-45cc-4acd-b915-45e92184c563',
  INACTIVE: id('f9'), AMBIGUOUS: id('fa'),
};

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${APPROVER}', 'data11-approver@example.invalid', '{"full_name":"[PROVER] Approver","role":"admin"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${APPROVER}';
    INSERT INTO public.vendors (id, name, deleted_at) VALUES
      ('${V.SPINNER}', '[PROVER] Spinner', NULL), ('${V.CRX}', '[PROVER] Crop Rx', NULL),
      ('${V.ACME}', '[PROVER] Acme Ag', NULL), ('${V.BETA}', '[PROVER] Beta Supply', NULL),
      ('${V.LEGACY}', '[PROVER] Legacy Co', NULL), ('${V.DUP1}', '[PROVER] Twin', NULL),
      ('${V.DUP2}', '[PROVER] Dup Two', NULL), ('${V.OLD}', '[PROVER] Old Co', now());
    INSERT INTO public.vendor_aliases (vendor_id, alias_raw, alias_display, source, review_status, reviewed_by, reviewed_at) VALUES
      ('${V.BETA}', '[PROVER] Beta Co.', '[PROVER] Beta Co.', 'manual', 'approved', '${APPROVER}', now()),
      ('${V.DUP2}', 'PROVER twin', 'PROVER twin', 'manual', 'approved', '${APPROVER}', now());
    INSERT INTO public.vendor_aliases (vendor_id, alias_raw, alias_display, source) VALUES
      (NULL, '[PROVER] Pending Alias', '[PROVER] Pending Alias', 'manual');
    INSERT INTO public.legacy_vendor_resolution (original_text, vendor_id, review_status, source_table, reviewed_by, reviewed_at) VALUES
      ('[PROVER] LGCY', '${V.LEGACY}', 'approved', 'products', '${APPROVER}', now());
    INSERT INTO public.products (id, product_name, sku, vendor, inventory_unit, is_active) VALUES
      ('${P.TEXT}', '[PROVER] Text', 'D11-1', '  [prover]  acme ag ', 'gal', true),
      ('${P.ALIAS}', '[PROVER] Alias', 'D11-2', '[PROVER] Beta Co.', 'gal', true),
      ('${P.LEGACY}', '[PROVER] Legacy', 'D11-3', '[PROVER] LGCY', 'gal', true),
      ('${P.ONE}', '[PROVER] One link', 'D11-4', '[PROVER] Beta Supply', 'gal', true),
      ('${P.DONE}', '[PROVER] Done', 'D11-5', '[PROVER] Acme Ag', 'gal', true),
      ('${P.EXP1}', '[PROVER] Hand one', 'D11-6', NULL, 'gal', true),
      ('${P.EXP2}', '[PROVER] Hand two', 'D11-7', '', 'gal', true),
      ('${P.INACTIVE}', '[PROVER] Inactive', 'D11-9', '[PROVER] Acme Ag', 'gal', false);
    INSERT INTO public.product_supplier_links (id, product_id, vendor_id, supplier_sku, supplier_product_name, supplier_uom,
        supplier_pack_description, link_status, is_preferred, confirmed_by, confirmed_at, created_by) VALUES
      ('${id('d1')}', '${P.ONE}', '${V.BETA}', 'B-4', 'Beta Four', 'case', '2x2.5 gal', 'confirmed', false, '${APPROVER}', now(), '${APPROVER}'),
      ('${id('d2')}', '${P.DONE}', '${V.ACME}', 'A-5', 'Acme Five', 'case', '2x2.5 gal', 'confirmed', true, '${APPROVER}', now(), '${APPROVER}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin approver, eight vendors (one deleted, one named by another vendor alias), eight products (one inactive) and two full links');
}

// Seed-only edits, with triggers skipped as in seed().
function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
const linkState = () => scalar(`SELECT md5(coalesce(string_agg(id::text || product_id::text || vendor_id::text || is_preferred::text
  || coalesce(supplier_product_name, '~'), ',' ORDER BY id), '')) FROM public.product_supplier_links;`);
const vendorText = () => scalar("SELECT md5(string_agg(id::text || coalesce(vendor, '~'), ',' ORDER BY id)) FROM public.products;");
// Runs the candidate with its approved constants swapped; returns the psql result.
function run(text, name) { stageText(name, text); return apply(name); }
function bound(fingerprint, links, prefers) {
  const source = lf(CANDIDATE);
  for (const pin of [`c_fingerprint constant text := '${APPROVED.fingerprint}'`, `v_inserted <> ${APPROVED.links} OR v_updated <> ${APPROVED.prefers}`]) {
    assert.equal(source.split(pin).length - 1, 1, `the candidate no longer pins: ${pin}`);
  }
  return source
    .replace(`c_fingerprint constant text := '${APPROVED.fingerprint}'`, `c_fingerprint constant text := '${fingerprint}'`)
    .replace(`v_inserted <> ${APPROVED.links} OR v_updated <> ${APPROVED.prefers}`, `v_inserted <> ${links} OR v_updated <> ${prefers}`);
}
function planOf(output) {
  const m = /DATA11_PLAN_CHANGED: (\d+) products, (\d+) links, (\d+) preferred flags, fingerprint ([0-9a-f]{32})/.exec(output);
  assert.ok(m, `expected DATA11_PLAN_CHANGED, got:\n${output}`);
  return { products: Number(m[1]), links: Number(m[2]), prefers: Number(m[3]), fingerprint: m[4] };
}

function main() {
  buildContainer();
  seed();
  const linksBefore = linkState();
  const textBefore = vendorText();

  // As written (bound to the live plan Mason approved) it refuses here and changes nothing.
  const asIs = run(lf(CANDIDATE), 'as-is.sql');
  assert.notEqual(asIs.status, 0);
  const seeded = planOf(asIs.output);
  assert.deepEqual([seeded.products, seeded.links, seeded.prefers], [7, 5, 1],
    'plan: text, alias, legacy-resolution and two hand-assigned products get a link; the one-link product gets preferred');
  assert.equal(linkState(), linksBefore, 'a refused run wrote nothing');
  console.log('[prover] bound to a different plan, it refuses with DATA11_PLAN_CHANGED and writes nothing');

  // The approver must be an active admin.
  asOwner(`UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${APPROVER}';`);
  assert.match(run(bound(seeded.fingerprint, seeded.links, seeded.prefers), 'not-admin.sql').output, /DATA11_APPROVER_NOT_ACTIVE_ADMIN/);
  asOwner(`UPDATE public.profiles SET role = 'admin' WHERE id = '${APPROVER}';`);
  // A count that does not match what was written rolls the whole step back.
  assert.match(run(bound(seeded.fingerprint, seeded.links + 1, seeded.prefers), 'count.sql').output, /DATA11_COUNT_MISMATCH/);
  assert.equal(linkState(), linksBefore);
  console.log('[prover] a non-admin approver and a count mismatch are refused, with nothing written');

  // Vendor text edited after approval: the approved plan no longer matches, and a plan that would
  // prefer a vendor the text does not name refuses even when bound to it.
  asOwner(`UPDATE public.products SET vendor = '[PROVER] Acme Ag' WHERE id = '${P.ONE}';`);
  assert.match(run(bound(seeded.fingerprint, seeded.links, seeded.prefers), 'drift.sql').output, /DATA11_PLAN_CHANGED/);
  const drifted = planOf(run(lf(CANDIDATE), 'drift-plan.sql').output);
  assert.notEqual(drifted.fingerprint, seeded.fingerprint, 'the vendor text is part of the fingerprint');
  assert.match(run(bound(drifted.fingerprint, drifted.links, drifted.prefers), 'mismatch.sql').output, /DATA11_PREFER_TEXT_MISMATCH: 1 products/);
  assert.equal(linkState(), linksBefore);
  asOwner(`UPDATE public.products SET vendor = '[PROVER] Beta Supply' WHERE id = '${P.ONE}';`);
  console.log('[prover] vendor text changed after approval is refused, and so is preferring a vendor the text does not name');

  // The confirmed link was replaced by another link to the same vendor after approval: the plan
  // names the link it marks preferred, so the approved plan no longer matches.
  asOwner(`UPDATE public.product_supplier_links SET id = '${id('d9')}' WHERE id = '${id('d1')}';`);
  const replaced = linkState();
  assert.match(run(bound(seeded.fingerprint, seeded.links, seeded.prefers), 'replaced.sql').output, /DATA11_PLAN_CHANGED/);
  assert.equal(linkState(), replaced);
  asOwner(`UPDATE public.product_supplier_links SET id = '${id('d1')}' WHERE id = '${id('d9')}';`);
  assert.equal(linkState(), linksBefore);
  console.log('[prover] a preferred-to-be link replaced after approval, even to the same vendor, is refused');

  // A product whose vendor text names two vendors gets no link, so the step refuses as a whole.
  asOwner(`INSERT INTO public.products (id, product_name, sku, vendor, inventory_unit, is_active)
    VALUES ('${P.AMBIGUOUS}', '[PROVER] Ambiguous', 'D11-A', '[PROVER] Twin', 'gal', true);`);
  const twin = planOf(run(lf(CANDIDATE), 'twin-plan.sql').output);
  assert.deepEqual([twin.products, twin.links, twin.prefers], [8, 5, 1]);
  assert.match(run(bound(twin.fingerprint, twin.links, twin.prefers), 'twin.sql').output, /DATA11_PREFERRED_INVARIANT: 1 active products/);
  assert.equal(linkState(), linksBefore);
  asOwner(`DELETE FROM public.products WHERE id = '${P.AMBIGUOUS}';`);
  console.log('[prover] a product left without a preferred link makes the whole step refuse');

  // Bound to this plan, it writes exactly the plan.
  const ok = run(bound(seeded.fingerprint, seeded.links, seeded.prefers), 'bound.sql');
  assert.equal(ok.status, 0, ok.output);
  const rows = JSON.parse(scalar(`SELECT json_agg(json_build_object('p', product_id, 'v', vendor_id, 'pref', is_preferred,
      'name', supplier_product_name, 'status', link_status, 'cmp', comparison_status, 'by', confirmed_by, 'created_by', created_by,
      'reusable', is_reusable) ORDER BY product_id, vendor_id) FROM public.product_supplier_links;`));
  const only = (p) => rows.filter((r) => r.p === p).map(({ v, pref, name }) => [v, pref, name]);
  for (const [p, v] of [[P.TEXT, V.ACME], [P.ALIAS, V.BETA], [P.LEGACY, V.LEGACY], [P.EXP1, V.SPINNER], [P.EXP2, V.CRX]]) {
    assert.deepEqual(only(p), [[v, true, null]], `${p} gets one vendor-only preferred link to ${v}`);
  }
  assert.deepEqual(only(P.ONE), [[V.BETA, true, 'Beta Four']], 'the single existing link becomes preferred');
  assert.deepEqual(only(P.DONE), [[V.ACME, true, 'Acme Five']], 'an already-preferred product is untouched');
  assert.deepEqual(only(P.INACTIVE), [], 'inactive products are left alone');
  for (const r of rows.filter((x) => x.name === null)) {
    assert.deepEqual([r.status, r.cmp, r.by, r.created_by, r.reusable], ['confirmed', 'pending', APPROVER, APPROVER, false]);
  }
  const texts = JSON.parse(scalar("SELECT json_object_agg(id, vendor) FROM public.products;"));
  assert.deepEqual([texts[P.EXP1], texts[P.EXP2]], ['[PROVER] Spinner', '[PROVER] Crop Rx'], 'the two hand-assigned blanks get their vendor name');
  asOwner(`UPDATE public.products SET vendor = NULL WHERE id = '${P.EXP1}'; UPDATE public.products SET vendor = '' WHERE id = '${P.EXP2}';`);
  assert.equal(vendorText(), textBefore, 'no other product vendor text changed');
  asOwner(`UPDATE public.products SET vendor = '[PROVER] Spinner' WHERE id = '${P.EXP1}'; UPDATE public.products SET vendor = '[PROVER] Crop Rx' WHERE id = '${P.EXP2}';`);
  assert.equal(scalar(`SELECT count(*) FROM public.products p WHERE p.is_active AND (SELECT count(*) FROM public.product_supplier_links l
      WHERE l.product_id = p.id AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred) <> 1;`), '0');
  console.log('[prover] bound to its plan: five vendor-only preferred links, one existing link made preferred, the two blank vendor names filled, nothing else changed');

  // Run again: the plan is now "nothing to do", so it refuses rather than doubling anything.
  const after = linkState();
  const again = planOf(run(bound(seeded.fingerprint, seeded.links, seeded.prefers), 'again.sql').output);
  assert.deepEqual([again.links, again.prefers], [0, 0]);
  assert.equal(linkState(), after);
  console.log('[prover] a second run refuses (the plan changed to nothing) and writes nothing');
  console.log('DATA11_PREFERRED_LINKS_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
