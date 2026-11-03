#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-6b's missing-price refusals (20261105120000). Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays migrations up to the
 * candidate, applies it, and checks with invented rows that a quote line, an order line and a
 * tier-priced invoice line (the field-app path) for a product with no price for the line's tier is
 * refused by name; that a stated $0 price, a typed price, a price-later line and a line copied from a
 * quote are not; that untouched columns never fire it; and that with the trigger gone the refused
 * case is accepted again (mutation check).
 *
 * Run: node scripts/smoke/prove-sale-lines-refuse-missing-price-real-schema.mjs   (needs local Docker image)
 * Prints SALE_LINES_PRICE_REQUIRED_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-sale-line-price-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261105120000_sale_lines_refuse_missing_price.sql');
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
const TOUCHED = /(_sale_line_price_required|trigger_b_(quote|order|invoice)_item_price_required)/i;
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


const id = (n) => `6b000000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1') };
const C = { T1: id('c1'), T2: id('c2'), T3: id('c3') };
const P = { UNPRICED: id('f1'), ZERO: id('f2'), T1ONLY: id('f3'), T2ONLY: id('f4') };
const Q = { T1: id('e1'), T2: id('e2'), T3: id('e3') };
const S = { T1: id('51'), T2: id('52'), T3: id('53') };
const O = { T1: id('d1'), T2: id('d2') };
const I = { T1: id('b1') };
const QI_PRICED = id('a01');
const OI_LEGACY = id('a02');
const QI_LEGACY = id('a03');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${U.ADMIN}', 'sale-line-price-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test,
  // including one legacy $0 line of each kind that predates the rule.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${U.ADMIN}';
    INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES
      ('${C.T1}', '[PROVER] Tier One Farm', 1), ('${C.T2}', '[PROVER] Tier Two Farm', 2), ('${C.T3}', '[PROVER] Tier Three Farm', 3);
    INSERT INTO public.products (id, product_name, is_active, tier1_price, tier2_price, tier3_price, current_cost) VALUES
      ('${P.UNPRICED}', '[PROVER] Unpriced', true, NULL, NULL, NULL, 4),
      ('${P.ZERO}', '[PROVER] Stated Zero', true, 0, NULL, NULL, 4),
      ('${P.T1ONLY}', '[PROVER] Tier One Only', true, 10, NULL, NULL, 4),
      ('${P.T2ONLY}', '[PROVER] Tier Two Only', true, NULL, 5, NULL, 4);
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, tier) VALUES
      ('${Q.T1}', 'PV6B-Q1', '${C.T1}', '${U.ADMIN}', 1), ('${Q.T2}', 'PV6B-Q2', '${C.T2}', '${U.ADMIN}', 2),
      ('${Q.T3}', 'PV6B-Q3', '${C.T3}', '${U.ADMIN}', 3);
    INSERT INTO public.quote_sections (id, quote_id) VALUES ('${S.T1}', '${Q.T1}'), ('${S.T2}', '${Q.T2}'), ('${S.T3}', '${Q.T3}');
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, price_per_unit) VALUES
      ('${QI_PRICED}', '${Q.T1}', '${S.T1}', '${P.T1ONLY}', 10),
      ('${QI_LEGACY}', '${Q.T1}', '${S.T1}', '${P.UNPRICED}', 0);
    INSERT INTO public.orders (id, order_number, customer_id) VALUES ('${O.T1}', 'PV6B-O1', '${C.T1}'), ('${O.T2}', 'PV6B-O2', '${C.T2}');
    INSERT INTO public.order_items (id, order_id, product_id, price_per_unit, total_units_needed, quantity_remaining) VALUES
      ('${OI_LEGACY}', '${O.T1}', '${P.UNPRICED}', 0, 5, 5);
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, created_by) VALUES ('${I.T1}', 'PV6B-I1', '${C.T1}', 'field_application', '${U.ADMIN}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded three customers (tiers 1-3), four products, quotes, orders, a field-app invoice and legacy $0 lines');
}

const ONLY_GUARD = `ALTER TABLE public.quote_items DISABLE TRIGGER USER; ALTER TABLE public.quote_items ENABLE TRIGGER trigger_b_quote_item_price_required;
  ALTER TABLE public.order_items DISABLE TRIGGER USER; ALTER TABLE public.order_items ENABLE TRIGGER trigger_b_order_item_price_required;
  ALTER TABLE public.invoice_items DISABLE TRIGGER USER; ALTER TABLE public.invoice_items ENABLE TRIGGER trigger_b_invoice_item_price_required;`;

// One rolled-back transaction; `isolate` leaves only this migration's triggers on (the other
// triggers' own rules are not under test here). Returns null on success, else the error text.
function attempt(sql, { isolate = true } = {}) {
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${isolate ? ONLY_GUARD : ''}\n${sql}\nROLLBACK;`, allowFailure: true,
  });
  return r.status === 0 ? null : r.stderr.trim();
}
const qi = (quote, section, product, ppu, override = 'NULL') => `INSERT INTO public.quote_items (quote_id, section_id, product_id, price_per_unit, price_override)
  VALUES ('${quote}', '${section}', '${product}', ${ppu}, ${override});`;
const oi = (order, product, ppu, extra = {}) => {
  const cols = { order_id: `'${order}'`, product_id: `'${product}'`, price_per_unit: ppu, total_units_needed: 5, ...extra };
  return `INSERT INTO public.order_items (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')});`;
};
const ii = (product, cents, source) => {
  const cols = { invoice_id: `'${I.T1}'`, product_id: product ? `'${product}'` : 'NULL', unit_price_cents: cents, price_source: source, quantity: 3 };
  return `INSERT INTO public.invoice_items (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')});`;
};

function refused(label, sql, code, name, options) {
  const error = attempt(sql, options);
  assert.ok(error, `${label}: must be refused`);
  assert.ok(error.includes(`${code}: [PROVER] ${name} has no price`), `${label}: wrong refusal:\n${error}`);
}
function allowed(label, sql, options) {
  const error = attempt(sql, options);
  assert.equal(error, null, `${label}: must be allowed:\n${error}`);
}

const REFUSED_QUOTE = qi(Q.T1, S.T1, P.UNPRICED, 0);
// Every sale line already needs a cost, and a $0 line is below cost: today only an admin with a
// below-cost reason saves one. That approval is the gap: it never says the product had no price.
const asAdmin = (operation) => `SELECT set_config('request.jwt.claim.sub', '${U.ADMIN}', true),
  set_config('app.crx_below_cost_operation', '${operation}', true), set_config('app.crx_below_cost_reason', 'prover giveaway', true);
`;
const GAP_QUOTE = asAdmin('save_quote') + REFUSED_QUOTE;
const GAP_ORDER = asAdmin('update_order_items') + oi(O.T1, P.UNPRICED, 0);
const GAP_INVOICE = asAdmin('save_invoice') + ii(P.UNPRICED, 0, "'tier'");

function main() {
  buildContainer();
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = '_sale_line_price_required';"), '0', 'the function must not exist before the candidate');
  seed();
  // BEFORE: the gap. Each line below is stored at $0 for a product with no price.
  allowed('before: quote line, admin below-cost approval', GAP_QUOTE, { isolate: false });
  allowed('before: order line, admin below-cost approval', GAP_ORDER, { isolate: false });
  allowed('before: tier invoice line, admin below-cost approval', GAP_INVOICE, { isolate: false });
  const unnamed = attempt(REFUSED_QUOTE, { isolate: false });
  assert.ok(unnamed?.includes('BELOW_COST_CONTEXT_REQUIRED'), `before: without approval only the below-cost check stops it:
${unnamed}`);
  console.log('[prover] BEFORE: an admin below-cost approval saves a $0 line for a product with no price on all three tables; otherwise only the below-cost check (which never says "no price") stops it');

  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed:\n${applied.output}`);
  assert.match(applied.output, /POSTFLIGHT_OK/);
  const reapplied = apply('candidate.sql');
  assert.notEqual(reapplied.status, 0, 'a second run must refuse');
  assert.match(reapplied.output, /SALE_LINE_PRICE_REQUIRED_EXISTS/);
  console.log('[prover] candidate applied once; a second run is refused');

  assert.equal(scalar(`SELECT prosecdef::text || ',' || array_to_string(proconfig, ',') || ',' || pg_get_userbyid(proowner)
    FROM pg_proc WHERE oid = 'public._sale_line_price_required()'::regprocedure;`), 'true,search_path=public, pg_temp,postgres');
  assert.equal(scalar(`SELECT string_agg(r || '=' || has_function_privilege(r, 'public._sale_line_price_required()', 'EXECUTE')::text, ',' ORDER BY r)
    FROM unnest(ARRAY['anon','authenticated','service_role']) r;`), 'anon=false,authenticated=false,service_role=false');
  console.log('[prover] SECURITY DEFINER, search_path pinned, owned by postgres, no API role may execute it');

  // Quote lines: the quote's tier; own tier price, else tier 1; a stated $0 is a price.
  refused('quote: unpriced at 0', REFUSED_QUOTE, 'QUOTE_PRICE_MISSING', 'Unpriced');
  refused('quote: unpriced at NULL', qi(Q.T1, S.T1, P.UNPRICED, 'NULL'), 'QUOTE_PRICE_MISSING', 'Unpriced');
  refused('quote: tier-2-only on a tier-1 quote', qi(Q.T1, S.T1, P.T2ONLY, 0), 'QUOTE_PRICE_MISSING', 'Tier Two Only');
  refused('quote: tier-2-only on a tier-3 quote', qi(Q.T3, S.T3, P.T2ONLY, 0), 'QUOTE_PRICE_MISSING', 'Tier Two Only');
  allowed('quote: tier-2-only on a tier-2 quote', qi(Q.T2, S.T2, P.T2ONLY, 0));
  allowed('quote: unpriced with a typed price', qi(Q.T1, S.T1, P.UNPRICED, 12));
  allowed('quote: unpriced with a typed $0 override', qi(Q.T1, S.T1, P.UNPRICED, 0, 0));
  allowed('quote: stated $0 on tier 1', qi(Q.T1, S.T1, P.ZERO, 0));
  allowed('quote: stated tier-1 $0 on a tier-2 quote', qi(Q.T2, S.T2, P.ZERO, 0));
  allowed('quote: tier-1 price on a tier-3 quote', qi(Q.T3, S.T3, P.T1ONLY, 0));
  refused('quote: a priced line rewritten to $0 for an unpriced product',
    `UPDATE public.quote_items SET product_id = '${P.UNPRICED}', price_per_unit = 0 WHERE id = '${QI_PRICED}';`, 'QUOTE_PRICE_MISSING', 'Unpriced');
  allowed('quote: a legacy $0 line whose notes change', `UPDATE public.quote_items SET notes = 'x' WHERE id = '${QI_LEGACY}';`);
  refused('quote: a price under a cent is $0', qi(Q.T1, S.T1, P.UNPRICED, 0.001), 'QUOTE_PRICE_MISSING', 'Unpriced');
  // save_quote writes a changed tier after the lines, so the tier write re-checks them.
  refused('quote: tier changed so a $0 line has no price', `${qi(Q.T2, S.T2, P.T2ONLY, 0)}
    UPDATE public.quotes SET tier = 1 WHERE id = '${Q.T2}';`, 'QUOTE_PRICE_MISSING', 'Tier Two Only');
  allowed('quote: tier rewritten unchanged', `${qi(Q.T2, S.T2, P.T2ONLY, 0)}
    UPDATE public.quotes SET tier = tier WHERE id = '${Q.T2}';`);
  allowed('quote: tier changed, lines still priced', `${qi(Q.T2, S.T2, P.ZERO, 0)}
    UPDATE public.quotes SET tier = 3 WHERE id = '${Q.T2}';`);
  console.log('[prover] a quote tier change re-checks its $0 lines by name');
  console.log('[prover] quote lines: missing refused by name (tier 1, NULL price, tier 2/3 fallback, rewrite); stated $0, typed price, typed $0 and untouched legacy lines allowed');

  // Order lines: price_tier_at_sale, else the customer's tier.
  refused('order: unpriced at 0', oi(O.T1, P.UNPRICED, 0), 'ORDER_PRICE_MISSING', 'Unpriced');
  refused('order: tier-2-only, sold at tier 1 to a tier-2 customer', oi(O.T2, P.T2ONLY, 0, { price_tier_at_sale: 1 }), 'ORDER_PRICE_MISSING', 'Tier Two Only');
  allowed('order: tier-2-only, sold at tier 2 to a tier-1 customer', oi(O.T1, P.T2ONLY, 0, { price_tier_at_sale: 2 }));
  allowed('order: tier-2-only for a tier-2 customer', oi(O.T2, P.T2ONLY, 0));
  allowed('order: stated $0', oi(O.T1, P.ZERO, 0));
  allowed('order: priced line', oi(O.T1, P.UNPRICED, 9));
  allowed('order: price-later line', oi(O.T1, P.UNPRICED, 0, { pricing_pending: true }));
  allowed('order: copied from a quote line the quote set at $0', oi(O.T1, P.UNPRICED, 0, { quote_item_id: `'${QI_LEGACY}'` }));
  refused('order: quote-copied line moved to a product with no price', oi(O.T1, P.UNPRICED, 0, { quote_item_id: `'${QI_PRICED}'` }), 'ORDER_PRICE_MISSING', 'Unpriced');
  refused('order: quote-copied $0 line moved to another product with no price', oi(O.T1, P.T2ONLY, 0, { quote_item_id: `'${QI_LEGACY}'` }), 'ORDER_PRICE_MISSING', 'Tier Two Only');
  refused('order: a price-later line priced at $0', `UPDATE public.order_items SET pricing_pending = true WHERE id = '${OI_LEGACY}';
    UPDATE public.order_items SET pricing_pending = false WHERE id = '${OI_LEGACY}';`, 'ORDER_PRICE_MISSING', 'Unpriced');
  allowed('order: the editor re-sends a legacy $0 line unchanged', `UPDATE public.order_items
    SET price_per_unit = price_per_unit, product_id = product_id, pricing_pending = pricing_pending WHERE id = '${OI_LEGACY}';`);
  allowed('order: legacy line re-sent unchanged, full stack', `UPDATE public.order_items
    SET price_per_unit = price_per_unit, product_id = product_id WHERE id = '${OI_LEGACY}';`, { isolate: false });
  refused('order: a legacy $0 line moved to another unpriced product', `UPDATE public.order_items SET product_id = '${P.T2ONLY}' WHERE id = '${OI_LEGACY}';`, 'ORDER_PRICE_MISSING', 'Tier Two Only');
  allowed('order: a delivery against a legacy $0 line', `UPDATE public.order_items SET quantity_delivered = 2, quantity_remaining = 3 WHERE id = '${OI_LEGACY}';`);
  console.log('[prover] order lines: missing refused by name (incl. tier at sale); stated $0, priced, price-later, a quote-set $0 copy and delivery updates allowed; a quote-copied line moved to an unpriced product refused');

  // Invoice lines priced from the tier (the field-app path).
  refused('invoice: tier-priced unpriced at 0', ii(P.UNPRICED, 0, "'tier'"), 'INVOICE_PRICE_MISSING', 'Unpriced');
  refused('invoice: tier-priced unpriced at NULL', ii(P.UNPRICED, 'NULL', "'tier'"), 'INVOICE_PRICE_MISSING', 'Unpriced');
  allowed('invoice: tier-priced stated $0', ii(P.ZERO, 0, "'tier'"));
  allowed('invoice: tier-priced with a price', ii(P.UNPRICED, 900, "'tier'"));
  allowed('invoice: manual $0', ii(P.UNPRICED, 0, "'manual'"));
  allowed('invoice: quoted $0', ii(P.UNPRICED, 0, "'quoted'"));
  allowed('invoice: no price source (charge line)', ii(P.UNPRICED, 0, 'NULL'));
  allowed('invoice: no product', ii(null, 0, "'tier'"));
  console.log('[prover] tier-priced invoice lines: missing refused by name; stated $0, priced, manual, quoted, charge and product-less lines allowed');

  // With every other trigger on, this refusal (not "below cost") is what the user sees.
  refused('quote: full trigger stack', REFUSED_QUOTE, 'QUOTE_PRICE_MISSING', 'Unpriced', { isolate: false });
  refused('order: full trigger stack', oi(O.T1, P.UNPRICED, 0), 'ORDER_PRICE_MISSING', 'Unpriced', { isolate: false });
  refused('invoice: full trigger stack', ii(P.UNPRICED, 0, "'tier'"), 'INVOICE_PRICE_MISSING', 'Unpriced', { isolate: false });
  refused('quote: full stack, admin below-cost approval', GAP_QUOTE, 'QUOTE_PRICE_MISSING', 'Unpriced', { isolate: false });
  refused('order: full stack, admin below-cost approval', GAP_ORDER, 'ORDER_PRICE_MISSING', 'Unpriced', { isolate: false });
  refused('invoice: full stack, admin below-cost approval', GAP_INVOICE, 'INVOICE_PRICE_MISSING', 'Unpriced', { isolate: false });
  allowed('quote: full stack, stated $0 with admin approval', asAdmin('save_quote') + qi(Q.T1, S.T1, P.ZERO, 0), { isolate: false });
  console.log('[prover] with every trigger on, each table names the missing price first');

  // MUTATION: without the trigger the refused case is accepted again.
  const mutated = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\nDROP TRIGGER trigger_b_quote_item_price_required ON public.quote_items;\n${GAP_QUOTE}\nROLLBACK;`, allowFailure: true,
  });
  assert.equal(mutated.status, 0, `with the trigger dropped the line must save:\n${mutated.stderr}`);
  console.log('[prover] MUTATION: dropping the quote trigger lets the no-price $0 line save again');
  console.log('SALE_LINES_PRICE_REQUIRED_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
