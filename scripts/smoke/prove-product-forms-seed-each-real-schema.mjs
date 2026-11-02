#!/usr/bin/env node
/**
 * Real-schema proof for 20261102210000_product_forms_seed_each.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container and replays ordered post-baseline migrations up to this candidate. It exercises
 * form units, conversion parity, roles, replay and mutation checks against the real schema.
 *
 * Run: node scripts/smoke/prove-product-forms-seed-each-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_FORMS_SEED_EACH_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-product-forms-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102210000_product_forms_seed_each.sql');
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
const TOUCHED = /product_form_units|validate_product_units|field_app_priced_quantity|convert_to_gl_lb|products_product_form_check|guard_seed_each_quote_item_units/;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};

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
function bodyFrom(file, expression) {
  const match = expression.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  assert.ok(match, `${file} no longer contains its pinned function body`);
  return match[1];
}
function restoreLiveBodies() {
  // Historical replay uses LF staging; validate_product_units had CRLF in live prosrc.
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/);
  const field = bodyFrom('20260630180000_field_app_pricing_unit_fix.sql',
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/);
  const seededConvert = bodyFrom(path.basename(CANDIDATE),
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  restoreLiveBodies();
  // The checked-in database baseline predates these Auth service objects. Current profile
  // deactivation updates banned_until and deletes sessions; restore their local shape only.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    GRANT DELETE ON auth.sessions TO postgres;`, { user: 'supabase_admin' });
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

function functionDef(signature) {
  return docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT pg_get_functiondef('${signature}'::regprocedure);`,
  }).stdout.replaceAll('\r\n', '\n').trim();
}
function refused(sql, pattern) {
  const result = psql(sql, { allowFailure: true });
  assert.notEqual(result.status, 0, `unexpectedly accepted: ${sql}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}
function product(name, form, inventory, container = inventory) {
  return `INSERT INTO public.products(product_name, category, product_form, inventory_unit, container_unit)
    VALUES ('${name}', 'Herbicide', '${form}', '${inventory}', '${container}');`;
}
function quoteLine(productName, rateUnit, priceUnit) {
  return `INSERT INTO public.quote_items (quote_id, section_id, product_id, price_per_unit,
    current_cost, rate_unit, price_unit, total_units_needed, unit_size, total_price)
    SELECT 'aa110000-0000-0000-0000-000000000003', 'aa110000-0000-0000-0000-000000000004',
      id, 12.50, 5.00, ${rateUnit === null ? 'NULL' : `'${rateUnit}'`}, ${priceUnit === null ? 'NULL' : `'${priceUnit}'`}, 2, inventory_unit, 25.00
    FROM public.products WHERE product_name = '${productName}';`;
}
function priced(qty, rate, inventory, form) {
  const value = scalar(`SELECT public.field_app_priced_quantity(${qty}, '${rate}', '${inventory}', '${form}');`);
  return value === '' ? null : Number(value);
}
function equivalent(qty, unit, form) {
  return scalar(`SELECT coalesce(converted_value::text, 'NULL') || ':' || coalesce(converted_unit, 'NULL')
    FROM public.convert_to_gl_lb(${qty}, '${unit}', '${form}');`);
}
function mutation(sql, query) {
  const result = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN; SAVEPOINT mutation; ${sql} ${query} ROLLBACK TO SAVEPOINT mutation; COMMIT;`,
  });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

try {
  buildContainer();
  psql(`INSERT INTO public.unit_conversions(unit, factor_oz, unit_type) VALUES
    ('Gal',128,'liquid'),('fl oz',1,'liquid'),('oz',1,'liquid'),('Qt',32,'liquid'),
    ('Lb',16,'dry'),('Dry oz',1,'dry'),('Ea',1,'both'),('Unit',1,'both')
    ON CONFLICT (unit) DO NOTHING;`);
  const pricedSig = 'public.field_app_priced_quantity(numeric,text,text,text)';
  const equivalentSig = 'public.convert_to_gl_lb(numeric,text,text)';
  const oldPriced = functionDef(pricedSig);
  const oldEquivalent = functionDef(equivalentSig);
  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  const newPriced = functionDef(pricedSig);
  const newEquivalent = functionDef(equivalentSig);
  const pricedNeedle = "  IF r = '' OR i = '' THEN RETURN NULL; END IF;";
  const pricedLine = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN NULL; END IF;  -- no conversions for seed/each";
  assert.equal(oldPriced.split(pricedNeedle).length - 1, 1);
  assert.equal(newPriced, oldPriced.replace(pricedNeedle, `${pricedNeedle}\n${pricedLine}`));
  const equivalentNeedle = "    RETURN;\n  END IF;\n\n  IF p_product_form = 'dry' THEN";
  const equivalentLine = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;";
  assert.equal(oldEquivalent.split(equivalentNeedle).length - 1, 1);
  assert.equal(newEquivalent, oldEquivalent.replace(equivalentNeedle,
    `    RETURN;\n  END IF;\n\n${equivalentLine}\n  IF p_product_form = 'dry' THEN`));

  assert.equal(scalar(`SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres'
    AND proconfig @> ARRAY['search_path=public, pg_temp']
    FROM pg_proc WHERE oid = 'public.guard_seed_each_quote_item_units()'::regprocedure;`), 't');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.guard_seed_each_quote_item_units()', 'EXECUTE');"), 'f');
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.quote_items'::regclass
    AND tgname = 'trg_guard_seed_each_quote_item_units' AND tgenabled IN ('O','A')
    AND NOT tgisinternal;`), '1');

  assert.equal(scalar('SELECT count(*) FROM public.product_form_units;'), '4');
  const postflight = /DO \$postflight\$[\s\S]*?END \$postflight\$;/.exec(lf(CANDIDATE))?.[0];
  assert.ok(postflight, 'candidate postflight body missing');
  refused(`BEGIN; DELETE FROM public.product_form_units WHERE product_form = 'seed' AND unit = 'Lb'; ${postflight}`,
    /PRODUCT_FORM_UNITS_RULE_ROWS_DRIFT/);
  assert.equal(scalar("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.product_form_units'::regclass;"), 't');
  assert.equal(scalar("SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_form_units'::regclass;"), '1');
  for (const [role, privilege, expected] of [
    ['anon', 'SELECT', 'f'],
    ['authenticated', 'SELECT', 't'], ['authenticated', 'INSERT', 'f'],
    ['authenticated', 'UPDATE', 'f'], ['authenticated', 'DELETE', 'f'],
    ['service_role', 'SELECT', 't'],
    ['authenticated', 'TRUNCATE', 'f'], ['metabase_ro', 'SELECT', 'f'],
  ]) {
    assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.product_form_units', '${privilege}');`), expected);
  }
  for (const role of ['authenticated', 'service_role']) {
    const result = docker([...psqlArgs(), '-A', '-t'], {
      input: `BEGIN; SET LOCAL ROLE ${role}; SELECT count(*) FROM public.product_form_units; ROLLBACK;`,
    });
    assert.equal(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1),
      role === 'service_role' ? '4' : '0');
  }
  for (const statement of [
    'INSERT INTO public.product_form_units(product_form, unit) VALUES (\'seed\', \'Ea\');',
    "UPDATE public.product_form_units SET unit = 'Ea' WHERE product_form = 'seed';",
    "DELETE FROM public.product_form_units WHERE product_form = 'seed';",
  ]) {
    refused(`BEGIN; SET LOCAL ROLE authenticated; ${statement}`, /permission denied/);
  }

  for (const [name, form, inventory, container] of [
    ['Seed Lb', 'seed', 'Lb', 'Lb'], ['Seed Unit', 'seed', 'Unit', 'Lb'],
    ['Each Ea', 'each', 'Ea', 'Ea'], ['Each Unit', 'each', 'Unit', 'Unit'],
    ['Liquid Gal', 'liquid', 'Gal', 'Gal'], ['Liquid Ea', 'liquid', 'Ea', 'Ea'],
    ['Dry Lb', 'dry', 'Lb', 'Lb'], ['Dry Unit', 'dry', 'Unit', 'Unit'],
  ]) psql(product(name, form, inventory, container));
  refused("INSERT INTO public.products(product_name, category, product_form, inventory_unit) VALUES ('Seed missing stock', 'Herbicide', 'seed', NULL);",
    /A seed or each product needs a stock unit \(inventory_unit\)\./);
  refused("INSERT INTO public.products(product_name, category, product_form, inventory_unit) VALUES ('Seed blank stock', 'Herbicide', 'seed', ' ');",
    /A seed or each product needs a stock unit \(inventory_unit\)\./);
  assert.equal(mutation('DROP TRIGGER trg_validate_product_units ON public.products;',
    "INSERT INTO public.products(product_name, category, product_form, inventory_unit) VALUES ('Mutated blank stock', 'Herbicide', 'seed', NULL); SELECT count(*) FROM public.products WHERE product_name = 'Mutated blank stock';"), '1');
  for (const [name, form, inventory, rate] of [
    ['Seed rate Lb', 'seed', 'Lb', 'Lb'], ['Seed rate lb', 'seed', 'Lb', 'lb'],
    ['Each rate Ea', 'each', 'Ea', 'Ea'], ['Liquid rate oz', 'liquid', 'Gal', 'oz'],
  ]) psql(`INSERT INTO public.products(product_name, category, product_form, inventory_unit, container_unit, rate_unit)
    VALUES ('${name}', 'Herbicide', '${form}', '${inventory}', '${inventory}', '${rate}');`);
  for (const [name, form, inventory, rate] of [
    ['Seed rate Unit refused', 'seed', 'Lb', 'Unit'], ['Seed rate oz refused', 'seed', 'Lb', 'oz'],
    ['Each rate Unit refused', 'each', 'Ea', 'Unit'],
  ]) refused(`INSERT INTO public.products(product_name, category, product_form, inventory_unit, container_unit, rate_unit)
    VALUES ('${name}', 'Herbicide', '${form}', '${inventory}', '${inventory}', '${rate}');`,
  /rate_unit .* must match inventory_unit .* for product_form/);
  for (const [form, unit] of [
    ['seed', 'Gal'], ['seed', 'Ea'], ['seed', 'fl oz'],
    ['each', 'Lb'], ['each', 'Gal'], ['liquid', 'Lb'],
  ]) refused(product(`Rejected ${form} ${unit}`, form, unit), /inventory_unit.*not valid/);
  refused("INSERT INTO public.products(product_name, category, product_form) VALUES ('Rejected grain', 'Herbicide', 'grain');", /products_product_form_check/);
  psql("INSERT INTO public.products(product_name, category, inventory_unit, container_unit) VALUES ('Legacy allowed', 'Herbicide', 'Lb', 'Lb'), ('Legacy refused', 'Herbicide', 'Gal', 'Gal');");
  psql("UPDATE public.products SET product_form = 'seed' WHERE product_name = 'Legacy allowed';");
  refused("UPDATE public.products SET product_form = 'seed' WHERE product_name = 'Legacy refused';", /inventory_unit.*not valid/);
  refused("UPDATE public.products SET product_form = 'each' WHERE product_name = 'Seed Lb';", /This can't change on a saved product yet/);

  psql("UPDATE public.products SET rate_unit = 'Lb', rate_per_acre = 2 WHERE product_name = 'Seed Lb';");
  assert.equal(scalar("SELECT rate_unit FROM public.products WHERE product_name = 'Seed Unit';"), 'Unit');
  psql("UPDATE public.products SET rate_unit = 'lb' WHERE product_name = 'Seed Lb';");
  refused("UPDATE public.products SET rate_unit = 'Unit' WHERE product_name = 'Seed Lb';", /rate_unit "Unit" must match inventory_unit "Lb" for product_form "seed"/);
  refused("UPDATE public.products SET rate_unit = 'oz' WHERE product_name = 'Seed Lb';", /rate_unit "oz" must match inventory_unit "Lb" for product_form "seed"/);
  psql("UPDATE public.products SET rate_unit = 'Ea' WHERE product_name = 'Each Ea';");
  refused("UPDATE public.products SET rate_unit = 'Unit' WHERE product_name = 'Each Ea';", /rate_unit "Unit" must match inventory_unit "Ea" for product_form "each"/);
  psql("UPDATE public.products SET rate_unit = 'oz' WHERE product_name = 'Liquid Gal';");
  // Fixture only: governed pricing needs a full preview/approval context. Set its
  // catalog amounts with triggers off, then exercise the per-acre trigger normally.
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE public.products SET current_cost = 5.00, tier1_price = 12.50
      WHERE product_name IN ('Seed Lb', 'Liquid Gal');
    COMMIT;`);
  psql("UPDATE public.products SET rate_unit = '', rate_per_acre = 2 WHERE product_name = 'Seed Lb';");
  assert.equal(scalar("SELECT rate_unit FROM public.products WHERE product_name = 'Seed Lb';"), 'Lb');
  assert.equal(scalar(`SELECT array_position(array_agg(tgname ORDER BY tgname), 'trg_validate_product_units')
    < array_position(array_agg(tgname ORDER BY tgname), 'trigger_recalc_product_price_per_acre')
    FROM pg_trigger WHERE tgrelid = 'public.products'::regclass;`), 't');
  assert.equal(scalar("SELECT tier1_price_per_acre::text FROM public.products WHERE product_name = 'Seed Lb';"), '25.00');

  psql(`INSERT INTO auth.users (id, email) VALUES
    ('aa110000-0000-0000-0000-000000000001', 'forms-prover@example.invalid');`);
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true
      WHERE id = 'aa110000-0000-0000-0000-000000000001';
    COMMIT;`);
  assert.equal(scalar(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = 'aa110000-0000-0000-0000-000000000001';
    SELECT count(*) FROM public.product_form_units; ROLLBACK;`), '4');
  psql(`INSERT INTO public.customers (id, farm_name) VALUES
      ('aa110000-0000-0000-0000-000000000002', '[PROVER] Forms Farm');
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, salesman_id)
      VALUES ('aa110000-0000-0000-0000-000000000003', 'PROVER-FORMS-1',
        'aa110000-0000-0000-0000-000000000002', 'aa110000-0000-0000-0000-000000000001',
        'aa110000-0000-0000-0000-000000000001');
    INSERT INTO public.quote_sections (id, quote_id, section_name)
      VALUES ('aa110000-0000-0000-0000-000000000004',
        'aa110000-0000-0000-0000-000000000003', 'Seed');`);
  psql(quoteLine('Seed Lb', 'Lb', 'Lb'));
  refused(quoteLine('Seed Lb', '', 'Lb'), /Seed and each quote lines need their unit set \(Lb\)\./);
  refused(quoteLine('Seed Lb', null, 'Lb'), /Seed and each quote lines need their unit set \(Lb\)\./);
  refused(quoteLine('Seed Lb', 'Lb', ''), /Seed and each quote lines need their unit set \(Lb\)\./);
  refused(quoteLine('Seed Lb', 'Lb', null), /Seed and each quote lines need their unit set \(Lb\)\./);
  assert.equal(mutation('DROP TRIGGER trg_guard_seed_each_quote_item_units ON public.quote_items;',
    `${quoteLine('Seed Lb', '', 'Lb')} SELECT count(*) FROM public.quote_items WHERE rate_unit = '' AND price_unit = 'Lb';`), '1');
  assert.equal(mutation('DROP TRIGGER trg_guard_seed_each_quote_item_units ON public.quote_items;',
    `${quoteLine('Seed Lb', 'Lb', '')} SELECT count(*) FROM public.quote_items WHERE rate_unit = 'Lb' AND price_unit = '';`), '1');
  const quotedUnitError = /Seed and each products are quoted only in their own unit \(Lb\); "(?:Unit|oz)" can't be converted\./;
  refused(quoteLine('Seed Lb', 'Unit', 'Lb'), quotedUnitError);
  refused(quoteLine('Seed Lb', 'Lb', 'oz'), quotedUnitError);
  refused("UPDATE public.quote_items SET price_unit = 'Unit' WHERE rate_unit = 'Lb' AND price_unit = 'Lb';", quotedUnitError);
  psql(quoteLine('Liquid Gal', 'oz', 'Gal'));
  psql("INSERT INTO public.products(product_name, category, product_form, inventory_unit, container_unit) VALUES ('Legacy quote form', 'Herbicide', NULL, 'Lb', 'Lb');");
  // Quote cost snapshots require a governed positive catalog cost; fixture it without
  // inventing a pricing approval, then exercise quote and form triggers normally.
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.products SET current_cost = 5.00 WHERE product_name = 'Legacy quote form'; COMMIT;`);
  psql(quoteLine('Legacy quote form', 'Unit', 'Lb'));
  refused("UPDATE public.products SET product_form = 'seed' WHERE product_name = 'Legacy quote form';",
    /Existing quote lines use another unit; fix them before setting this form\./);
  assert.equal(mutation('DROP TRIGGER trg_validate_product_units ON public.products;',
    "UPDATE public.products SET product_form = 'seed' WHERE product_name = 'Legacy quote form'; SELECT product_form FROM public.products WHERE product_name = 'Legacy quote form';"), 'seed');
  psql("UPDATE public.quote_items SET rate_unit = 'Lb' WHERE product_id = (SELECT id FROM public.products WHERE product_name = 'Legacy quote form');");
  psql("UPDATE public.products SET product_form = 'seed' WHERE product_name = 'Legacy quote form';");
  assert.equal(scalar("SELECT rate_unit FROM public.products WHERE product_name = 'Legacy quote form';"), 'Lb');
  assert.equal(mutation('DROP TRIGGER trg_guard_seed_each_quote_item_units ON public.quote_items;',
    `${quoteLine('Seed Lb', 'Unit', 'Lb')} SELECT count(*) FROM public.quote_items WHERE rate_unit = 'Unit' AND price_unit = 'Lb';`), '1');
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_seed_each_quote_item_units';"), '1');

  for (const [qty, rate, stock, form, expected] of [
    [16, 'Lb', 'Lb', 'seed', 16], [16, 'lb', 'Lb', 'seed', 16],
    [16, 'oz', 'Lb', 'seed', null], [16, 'Unit', 'Lb', 'seed', null],
    [16, 'gal', 'Unit', 'seed', null], [5, 'Ea', 'Ea', 'each', 5],
    [5, 'Unit', 'Ea', 'each', null], [128, 'oz', 'gal', 'liquid', 1],
    [16, 'oz', 'lb', 'dry', 1],
  ]) assert.equal(priced(qty, rate, stock, form), expected);
  for (const form of ['seed', 'each']) for (const unit of ['oz', 'lb', 'gal']) {
    assert.equal(equivalent(16, unit, form), 'NULL:NULL');
  }
  assert.equal(scalar("SELECT converted_value = 1 AND converted_unit = 'GL' FROM public.convert_to_gl_lb(4, 'qt', 'liquid');"), 't');
  assert.equal(scalar("SELECT converted_value = 1 AND converted_unit = 'LB' FROM public.convert_to_gl_lb(16, 'oz', 'dry');"), 't');

  const ruleMutation = docker([...psqlArgs(), '-v', 'ON_ERROR_STOP=0'], { allowFailure: true,
    input: `BEGIN; SAVEPOINT mutation;
      DELETE FROM public.product_form_units WHERE product_form = 'seed' AND unit = 'Lb';
      ${product('Mutated seed rule', 'seed', 'Lb')}
      ROLLBACK TO SAVEPOINT mutation; COMMIT;`,
  });
  assert.match(`${ruleMutation.stdout}\n${ruleMutation.stderr}`, /inventory_unit "Lb" is not valid for product_form "seed"/);
  assert.equal(scalar("SELECT count(*) FROM public.product_form_units WHERE product_form = 'seed' AND unit = 'Lb';"), '1');
  assert.notEqual(mutation(`${oldPriced};`, "SELECT coalesce(public.field_app_priced_quantity(16, 'oz', 'Gal', 'seed')::text, 'NULL');"), 'NULL');
  assert.notEqual(mutation(`${oldEquivalent};`, "SELECT coalesce((SELECT converted_value::text FROM public.convert_to_gl_lb(16, 'oz', 'seed')), 'NULL');"), 'NULL');
  assert.equal(priced(16, 'oz', 'Lb', 'seed'), null);
  assert.equal(equivalent(16, 'oz', 'seed'), 'NULL:NULL');
  console.log('PRODUCT_FORMS_SEED_EACH_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
}

