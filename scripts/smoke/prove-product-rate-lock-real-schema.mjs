#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-11a-1 (20261105200000): the "Lock rates" switch, the one rate writer
 * (set_product_rates) and the locked-state correction (correct_product_rates). Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays migrations up to the candidate,
 * seeds invented rows, and checks: rates and per-acre prices to the cent, stale rows refused by
 * name, admins only, retry-safe; while locked every rate write (browser, rate writer, definer
 * functions, rated inserts) is refused and other edits save; a one-product correction with a reason
 * works and is logged; the log is append-only; a lock waits for an upload already saving.
 *
 * Run: node scripts/smoke/prove-product-rate-lock-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_RATE_LOCK_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-rate-lock-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261105200000_product_rate_lock.sql');
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
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(product_rate_lock|product_rate_events|_write_product_rates|set_product_rates|correct_product_rates|FUNCTION\s+(public\.)?"?(is_admin|is_active_profile|product_price_per_acre|recalc_product_price_per_acre|check_idempotency|save_idempotency)\b)/i;
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


const id = (n) => `7a7e1000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
// The smoke chain probes one active profile of each other staff role.
const OTHER_ROLES = [[id('a3'), 'driver'], [id('a4'), 'applicator'], [id('a5'), 'entity_recipient']];
const P = { GAL: id('c1'), OTHER: id('c2'), DRY: id('c3') };

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rl-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'rl-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ${OTHER_ROLES.map(([u, role]) => `('${u}', 'rl-${role}@example.invalid', '{"full_name":"[PROVER] ${role}","role":"${role}"}'::jsonb)`).join(', ')};`);
  // Invented products priced per gallon; their per-acre prices are filled once a rate is set.
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    ${OTHER_ROLES.map(([u, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${u}';`).join(' ')}
    -- Live's factors (read 2026-11-03); the schema baseline carries no unit rows.
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('Lb', 16, 'dry');
    INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'Lb');
    INSERT INTO public.products (id, product_name, sku, inventory_unit, is_active, tier1_price, tier2_price, tier3_price)
    VALUES ('${P.GAL}', '[PROVER] Gal', 'RL-1', 'gal', true, 40.00, 36.00, 32.00),
           ('${P.OTHER}', '[PROVER] Other', 'RL-2', 'gal', true, 40.00, 36.00, 32.00),
           ('${P.DRY}', '[PROVER] Dry', 'RL-7', 'Lb', true, 16.00, 16.00, 16.00);`);
  console.log('[prover] seeded an admin, a sales rep, one of each other staff role and two products priced per gallon and one per pound, all with no rate yet');
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
function ownerRefused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(`${r.stdout}${r.stderr}`, pattern);
}
const rates = (p) => scalar(`SELECT concat_ws('|', rate_per_acre, rate_unit, suggested_rate, tier1_price_per_acre,
  tier2_price_per_acre, tier3_price_per_acre) FROM public.products WHERE id = '${p}';`);
const versionOf = (p) => scalar(`SELECT pricing_version FROM public.products WHERE id = '${p}';`);
// Like a fresh export: the per-acre inputs other than the rates are read from the product as it is now.
const facts = (p) => JSON.parse(scalar(`SELECT json_build_object('pricing_version', pricing_version, 'unit_size', unit_size,
  'inventory_unit', inventory_unit, 'product_form', product_form) FROM public.products WHERE id = '${p}';`));
const row = (p, rate, unit, suggested, expected) => ({ product_id: p, rate_per_acre: rate, rate_unit: unit,
  suggested_rate: suggested, expected: { rate_per_acre: expected[0], rate_unit: expected[1], suggested_rate: expected[2], ...facts(p) } });
const setRates = (rows, key, actor = ADMIN) =>
  `SELECT public.set_product_rates('${JSON.stringify(rows)}'::jsonb, '${actor}', '${key}');`;
const lock = (on, reason, key, actor = ADMIN) =>
  `SELECT public.set_product_rate_lock(${on}, ${reason === null ? 'NULL' : `'${reason}'`}, '${actor}', '${key}');`;
// The confirmed prices default to a fresh preview; pass them to test what was shown.
const correct = (p, rate, unit, suggested, version, reason, key, actor = ADMIN,
  prices = `(public.preview_product_rate_correction('${p}', ${rate}, '${unit}')->'after')`) =>
  `SELECT public.correct_product_rates('${p}', ${rate}, '${unit}', '${suggested}', ${version}, ${prices}, '${reason}', '${actor}', '${key}');`;
const events = () => scalar(`SELECT coalesce(string_agg(event_type, ',' ORDER BY id), '-') FROM public.product_rate_events;`);

function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  assert.equal(scalar('SELECT is_locked FROM public.product_rate_lock;'), 'f');
  assert.equal(rates(P.GAL), '');
  console.log('[prover] installs unlocked and changes no product');

  // Unlocked: the one writer sets rates; per-acre prices follow to the cent (13 oz on a gallon:
  // 40.00 x 13/128 = 4.0625 -> 4.06; 36.00 -> 3.65625 -> 3.66; 32.00 -> 3.25).
  const first = setRates([row(P.GAL, '13', 'oz', '13 oz/A', [null, null, null])], 'k-set-1');
  const answer = JSON.parse(ok(ADMIN, first));
  assert.equal(answer.changed_count, 1);
  assert.equal(answer.rows[0].after.tier1_price_per_acre, 4.06);
  assert.equal(rates(P.GAL), '13|oz|13 oz/A|4.06|3.66|3.25');
  assert.deepEqual(JSON.parse(ok(ADMIN, first)), answer, 'a same-key replay answers the same');
  refused(ADMIN, setRates([row(P.GAL, '14', 'oz', '13 oz/A', [null, null, null])], 'k-set-1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[prover] set_product_rates saves rates and per-acre prices to the cent; a replay answers the same');

  // A row whose rates changed since export is refused by product name, and nothing in the batch saves.
  refused(ADMIN, setRates([row(P.OTHER, '8', 'oz', '', [null, null, null]),
    row(P.GAL, '20', 'oz', '', [null, null, null])], 'k-stale'), /PRODUCT_RATES_STALE: .*\[PROVER\] Gal/);
  assert.equal(rates(P.OTHER), '');
  // Prices, pack size, stock unit or form moved since export: the previewed per-acre prices no longer hold.
  const fresh = row(P.GAL, '20', 'oz', '', ['13', 'oz', '13 oz/A']);
  refused(ADMIN, setRates([{ ...fresh, expected: { ...fresh.expected, pricing_version: fresh.expected.pricing_version - 1 } }], 'k-stale-v'),
    /PRODUCT_RATES_STALE: .*\[PROVER\] Gal/);
  refused(ADMIN, setRates([{ ...fresh, expected: { ...fresh.expected, inventory_unit: 'qt' } }], 'k-stale-u'),
    /PRODUCT_RATES_STALE: .*\[PROVER\] Gal/);
  refused(ADMIN, setRates([{ ...fresh, expected: { ...fresh.expected, unit_size: undefined } }], 'k-shape'), /PRODUCT_RATE_ROW_SHAPE_INVALID/);
  assert.equal(rates(P.GAL), '13|oz|13 oz/A|4.06|3.66|3.25');
  refused(ADMIN, setRates([row(P.GAL, '-1', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-neg'), /PRODUCT_RATE_INVALID: .*\[PROVER\] Gal/);
  refused(ADMIN, setRates([row(P.GAL, '1.1234567', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-scale'), /PRODUCT_RATE_INVALID: .*\[PROVER\] Gal/);
  // An unknown unit would price per acre as one ounce, so it is refused by name.
  refused(ADMIN, setRates([row(P.GAL, '2', 'gallons', '', ['13', 'oz', '13 oz/A'])], 'k-unit'), /PRODUCT_RATE_UNIT_INVALID: .*\[PROVER\] Gal/);
  refused(ADMIN, setRates([{ ...row(P.GAL, '2', 'oz', '', ['13', 'oz', '13 oz/A']), rate_unit: { a: 1 } }], 'k-obj'), /PRODUCT_RATE_ROW_SHAPE_INVALID/);
  // A rate with no unit is ambiguous, so it is refused; a correction is only for locked rates.
  refused(ADMIN, setRates([row(P.OTHER, '8', '', '', [null, null, null])], 'k-nounit'), /PRODUCT_RATE_UNIT_INVALID: .*\[PROVER\]/);
  // Every other writer gets the same unit rule while open: a direct save of an unknown unit is refused.
  refused(ADMIN, `UPDATE public.products SET rate_per_acre = 8, rate_unit = 'gallons' WHERE id = '${P.OTHER}';`, /PRODUCT_RATE_UNIT_INVALID/);
  refused(ADMIN, `UPDATE public.products SET rate_per_acre = 8 WHERE id = '${P.OTHER}';`, /PRODUCT_RATE_UNIT_INVALID/);
  refused(ADMIN, `UPDATE public.products SET rate_per_acre = 1.1234567, rate_unit = 'oz' WHERE id = '${P.OTHER}';`, /PRODUCT_RATE_INVALID/);
  // A kept legacy unit must still be a priced unit, and a zero factor would price per acre at $0.
  asOwner(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Zero', 0, 'liquid');
    UPDATE public.products SET rate_per_acre = 8, rate_unit = 'Bushel' WHERE id = '${P.OTHER}';`);
  refused(ADMIN, setRates([row(P.OTHER, '16', 'Bushel', '', ['8', 'Bushel', null])], 'k-legacy'), /PRODUCT_RATE_UNIT_INVALID: .*\[PROVER\] Other/);
  refused(ADMIN, `UPDATE public.products SET rate_per_acre = 16 WHERE id = '${P.OTHER}';`, /PRODUCT_RATE_UNIT_INVALID/);
  refused(ADMIN, setRates([row(P.OTHER, '16', 'Zero', '', ['8', 'Bushel', null])], 'k-zero'), /PRODUCT_RATE_UNIT_INVALID: .*\[PROVER\] Other/);
  // Clearing the rate still works: no rate prices nothing.
  ok(ADMIN, `UPDATE public.products SET rate_per_acre = NULL WHERE id = '${P.OTHER}';`);
  // A kept unit listed only for the other form, with a real factor, stays (live: two dry products keep liquid oz).
  asOwner(`UPDATE public.products SET product_form = 'dry', inventory_unit = 'Lb', rate_per_acre = 8, rate_unit = 'oz' WHERE id = '${P.OTHER}';`);
  ok(ADMIN, `UPDATE public.products SET rate_per_acre = 9 WHERE id = '${P.OTHER}';`);
  asOwner(`UPDATE public.products SET product_form = DEFAULT, inventory_unit = 'gal', rate_per_acre = NULL, rate_unit = NULL WHERE id = '${P.OTHER}';`);
  asOwner(`DELETE FROM public.unit_conversions WHERE unit = 'Zero';
    UPDATE public.products SET rate_per_acre = NULL, rate_unit = NULL WHERE id = '${P.OTHER}';`);
  refused(ADMIN, lock(true, '	', 'k-tab-reason'), /REASON_REQUIRED/);
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', versionOf(P.GAL), 'label fix', 'k-cor-open'), /PRODUCT_RATES_NOT_LOCKED/);
  // Per-acre prices are whole cents, 0 or more, and finite (triggers off, so the recalculation cannot hide it).
  for (const bad of ['-1', "'NaN'", '1.001']) {
    const r = psql(`SET session_replication_role = replica; UPDATE public.products SET tier1_price_per_acre = ${bad} WHERE id = '${P.GAL}';`,
      { user: 'supabase_admin', allowFailure: true });
    assert.notEqual(r.status, 0, `per-acre ${bad} should be refused`);
    assert.match(`${r.stdout}${r.stderr}`, /whole_cents_chk/);
  }
  // The price workbook cannot change rates: a change row carrying one is refused; a notes row passes the check.
  const infoRow = (changes) => `INSERT INTO public.product_info_change_set_rows (change_set_id, product_id, expected_version,
    before_values, after_values, changes, output_fingerprint) VALUES (gen_random_uuid(), '${P.GAL}', 1, '{}', '{}', '${changes}', 'x');`;
  ownerRefused(infoRow('{"rate_unit":{"before":"oz","after":"Pt"}}'), /PRODUCT_RATES_READ_ONLY_IN_PRICE_WORKBOOK/);
  ownerRefused(infoRow('{"quoting_notes":{"before":null,"after":"n"}}'), /foreign key/);
  refused(ADMIN, setRates([row(P.GAL, '1', 'oz', '', ['13', 'oz', '13 oz/A']), row(P.GAL, '2', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-dup'),
    /PRODUCT_RATE_DUPLICATE_PRODUCT/);
  refused(REP, setRates([row(P.GAL, '20', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-rep', REP), /ADMIN_REQUIRED/);
  refused(REP, setRates([row(P.GAL, '20', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-forge', ADMIN), /ACTOR_MISMATCH/);
  refused(null, setRates([row(P.GAL, '20', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-anon'), /permission denied/);
  assert.equal(rates(P.GAL), '13|oz|13 oz/A|4.06|3.66|3.25');
  console.log('[prover] stale rows are refused by name, all-or-nothing; bad values, duplicates, non-admins, forged actors and signed-out visitors are refused');

  // Locking: admins only, with a reason, logged; locking twice is refused.
  refused(REP, lock(true, 'season set', 'k-lock-rep', REP), /ADMIN_REQUIRED/);
  refused(ADMIN, lock(true, null, 'k-lock-noreason'), /REASON_REQUIRED/);
  const locked = JSON.parse(ok(ADMIN, lock(true, 'season set', 'k-lock')));
  assert.deepEqual([locked.is_locked, locked.reason, locked.changed_by_name], [true, 'season set', '[PROVER] Admin']);
  refused(ADMIN, lock(true, 'again', 'k-lock-2'), /PRODUCT_RATE_LOCK_UNCHANGED/);
  assert.equal(events(), 'locked');
  console.log('[prover] an admin locks rates with a reason; it is logged with who and why');

  // Locked: every route that would change a rate is refused, whoever runs it.
  refused(ADMIN, `UPDATE public.products SET rate_per_acre = 20 WHERE id = '${P.GAL}';`, /PRODUCT_RATES_LOCKED/);
  refused(ADMIN, `UPDATE public.products SET suggested_rate = 'x' WHERE id = '${P.GAL}';`, /PRODUCT_RATES_LOCKED/);
  refused(ADMIN, setRates([row(P.GAL, '20', 'oz', '', ['13', 'oz', '13 oz/A'])], 'k-set-locked'), /PRODUCT_RATES_LOCKED/);
  // The database owner stands in for every SECURITY DEFINER writer (price workbook apply, imports).
  ownerRefused(`UPDATE public.products SET rate_unit = 'pt' WHERE id = '${P.GAL}';`, /PRODUCT_RATES_LOCKED/);
  // Per-acre pricing reads the unit untrimmed, so a trailing space is a unit change.
  refused(ADMIN, `UPDATE public.products SET rate_unit = 'oz ' WHERE id = '${P.GAL}';`, /PRODUCT_RATES_LOCKED/);
  // Switching a product with no rate unit to Seed copies the stock unit into rate_unit: a rate change too.
  // (A different unit already there is refused by validate_product_units.)
  refused(ADMIN, `UPDATE public.products SET product_form = 'seed' WHERE id = '${P.DRY}';`, /PRODUCT_RATES_LOCKED/);
  refused(ADMIN, `INSERT INTO public.products (product_name, sku, inventory_unit, is_active, rate_per_acre, rate_unit)
    VALUES ('[PROVER] Rated new', 'RL-3', 'gal', true, 5, 'oz');`, /PRODUCT_RATES_LOCKED/);
  assert.equal(rates(P.GAL), '13|oz|13 oz/A|4.06|3.66|3.25');
  // Other edits still save: a product with no rate, the label maximum, a name.
  ok(ADMIN, `INSERT INTO public.products (product_name, sku, inventory_unit, is_active) VALUES ('[PROVER] Plain new', 'RL-4', 'gal', true);`);
  ok(ADMIN, `UPDATE public.products SET max_label_rate = 32, max_label_rate_unit = 'oz', product_name = '[PROVER] Gal' WHERE id = '${P.GAL}';`);
  // Spaces are not a rate (the price workbook saves trimmed text).
  ok(ADMIN, `UPDATE public.products SET suggested_rate = '13 oz/A  ' WHERE id = '${P.GAL}';`);
  ok(ADMIN, `UPDATE public.products SET suggested_rate = '13 oz/A' WHERE id = '${P.GAL}';`);
  // A new seed product with no rates saves: the database copies its stock unit into rate_unit.
  ok(ADMIN, `INSERT INTO public.products (product_name, sku, product_form, inventory_unit, is_active)
    VALUES ('[PROVER] Seed new', 'RL-5', 'seed', 'Lb', true);`);
  assert.equal(scalar(`SELECT rate_unit FROM public.products WHERE sku = 'RL-5';`), 'Lb');
  ok(ADMIN, `UPDATE public.products SET product_name = '[PROVER] Seed renamed' WHERE sku = 'RL-5';`);
  refused(ADMIN, `INSERT INTO public.products (product_name, sku, inventory_unit, is_active, rate_per_acre, rate_unit)
    VALUES ('[PROVER] Rated new 2', 'RL-6', 'gal', true, 5, 'oz');`, /save the new product without rates/);
  console.log('[prover] locked: browser edits, the rate writer, definer functions and rated inserts are refused; other edits save');

  // The correction: one product, admin, reason, expected version; logged before and after.
  const v = versionOf(P.GAL);
  refused(REP, correct(P.GAL, 16, 'oz', '16 oz/A', v, 'label fix', 'k-cor-rep', REP), /ADMIN_REQUIRED/);
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', Number(v) - 1, 'label fix', 'k-cor-stale'), /PRODUCT_RATES_STALE: \[PROVER\] Gal/);
  refused(ADMIN, correct(P.GAL, 13, 'oz', '13 oz/A', v, 'label fix', 'k-cor-same'), /PRODUCT_RATE_CORRECTION_NO_CHANGE/);
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', v, ' ', 'k-cor-blank'), /REASON_REQUIRED/);
  refused(ADMIN, correct(P.GAL, 16, 'gallons', '16 oz/A', v, 'label fix', 'k-cor-unit'), /PRODUCT_RATE_UNIT_INVALID/);
  refused(ADMIN, correct(P.GAL, 16.1234567, 'oz', '16 oz/A', v, 'label fix', 'k-cor-scale'), /PRODUCT_RATE_INVALID/);
  // The preview shows the per-acre prices the correction then saves.
  const previewSql = `SELECT public.preview_product_rate_correction('${P.GAL}', 16, 'oz');`;
  refused(REP, previewSql, /ADMIN_REQUIRED/);
  // Pricing takes any one unit row matching regardless of case, so rows that disagree refuse the unit.
  asOwner("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('OZ', 128, 'liquid');");
  refused(ADMIN, previewSql, /PRODUCT_RATE_UNIT_INVALID/);
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', v, 'label fix', 'k-cor-case', ADMIN, "'{}'::jsonb"), /PRODUCT_RATE_UNIT_INVALID/);
  asOwner("UPDATE public.unit_conversions SET factor_oz = 1 WHERE unit = 'OZ';");
  ok(ADMIN, previewSql);
  asOwner("DELETE FROM public.unit_conversions WHERE unit = 'OZ';");
  const preview = JSON.parse(ok(ADMIN, previewSql));
  const shown = `'${JSON.stringify(preview.after)}'::jsonb`;
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', v, 'label fix', 'k-cor-noprice', ADMIN, 'NULL'), /PRODUCT_AND_EXPECTED_VERSION_REQUIRED/);
  // A unit factor changed after the preview moves the prices but not pricing_version: refused, nothing saved.
  asOwner("UPDATE public.unit_conversions SET factor_oz = 2 WHERE unit = 'oz';");
  refused(ADMIN, correct(P.GAL, 16, 'oz', '16 oz/A', v, 'label fix', 'k-cor-moved', ADMIN, shown), /PRODUCT_RATE_PREVIEW_CHANGED/);
  asOwner("UPDATE public.unit_conversions SET factor_oz = 1 WHERE unit = 'oz';");
  assert.equal(events(), 'locked');
  const fix = correct(P.GAL, 16, 'oz', '16 oz/A', v, 'label fix', 'k-cor', ADMIN, shown);
  const corrected = JSON.parse(ok(ADMIN, fix));
  for (const t of [1, 2, 3]) {
    const k = `tier${t}_price_per_acre`;
    assert.deepEqual([preview.before[k], preview.after[k]], [corrected.before[k], corrected.after[k]], `preview ${k}`);
  }
  assert.deepEqual([corrected.before.tier1_price_per_acre, corrected.after.tier1_price_per_acre], [4.06, 5]);
  assert.equal(rates(P.GAL), '16|oz|16 oz/A|5.00|4.50|4.00');
  assert.deepEqual(JSON.parse(ok(ADMIN, fix)), corrected, 'a same-key replay answers the same');
  assert.equal(events(), 'locked,corrected');
  assert.equal(scalar(`SELECT concat_ws('|', product_id, reason, before_values->>'rate_per_acre', after_values->>'rate_per_acre')
    FROM public.product_rate_events WHERE event_type = 'corrected';`), `${P.GAL}|label fix|13|16`);
  // The correction's permission ends with it, inside the same transaction.
  refused(ADMIN, `${correct(P.GAL, 17, 'oz', '17 oz/A', versionOf(P.GAL), 'second', 'k-cor-2')}
    UPDATE public.products SET rate_per_acre = 99 WHERE id = '${P.OTHER}';`, /PRODUCT_RATES_LOCKED/);
  // Nobody can forge the pass: the old session setting is ignored, and the pass table is closed to every API role.
  refused(ADMIN, `SELECT set_config('crx.product_rate_correction', '${P.GAL}:' || txid_current(), true);
    UPDATE public.products SET rate_per_acre = 99 WHERE id = '${P.GAL}';`, /PRODUCT_RATES_LOCKED/);
  refused(ADMIN, `INSERT INTO public.product_rate_correction_passes VALUES (txid_current(), '${P.GAL}');`, /permission denied/);
  assert.equal(rates(P.GAL), '16|oz|16 oz/A|5.00|4.50|4.00');
  console.log('[prover] locked: an admin corrects one product with a reason; prices follow to the cent; it is logged; the permission ends with the correction');

  // The log cannot be edited or emptied.
  ownerRefused('UPDATE public.product_rate_events SET reason = \'x\';', /PRODUCT_RATE_RECORDS_CHANGE_ONLY_THROUGH_THEIR_FUNCTIONS/);
  ownerRefused('DELETE FROM public.product_rate_events;', /PRODUCT_RATE_RECORDS_CHANGE_ONLY_THROUGH_THEIR_FUNCTIONS/);
  ownerRefused('TRUNCATE public.product_rate_events;', /PRODUCT_RATE_RECORDS_CHANGE_ONLY_THROUGH_THEIR_FUNCTIONS/);
  ownerRefused('DELETE FROM public.product_rate_lock;', /PRODUCT_RATE_RECORDS_CHANGE_ONLY_THROUGH_THEIR_FUNCTIONS/);
  refused(ADMIN, 'UPDATE public.product_rate_lock SET is_locked = false;', /permission denied/);
  refused(ADMIN, "INSERT INTO public.product_rate_events (event_type, reason, changed_by) VALUES ('locked', 'x', gen_random_uuid());", /permission denied/);
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_rate_events;'), '2');
  console.log('[prover] the log and the switch cannot be written directly; staff can read them');

  // A switch and a rate write take turns: a lock waits for an upload already saving, then holds.
  ok(ADMIN, lock(false, 'reopen', 'k-unlock'));
  const writer = spawn('docker', ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-c',
    `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
     SET LOCAL ROLE authenticated; ${setRates([row(P.OTHER, '8', 'oz', '8 oz/A', [null, null, null])], 'k-race')} SELECT pg_sleep(4); COMMIT;`],
  { cwd: ROOT, stdio: 'ignore' });
  // Take the lock only once the upload has saved and sleeps inside its open transaction.
  const inFlight = "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%k-race%';";
  for (let tries = 0; scalar(inFlight) !== '1'; tries += 1) {
    assert.ok(tries < 100, 'the racing upload never reached its sleep inside the transaction');
    wait(200);
  }
  const started = Date.now();
  ok(ADMIN, lock(true, 'season set again', 'k-relock'));
  assert.ok(Date.now() - started > 1000, 'the lock waited on the upload in flight');
  writer.unref();
  assert.equal(rates(P.OTHER), '8|oz|8 oz/A|2.50|2.25|2.00');
  refused(ADMIN, setRates([row(P.OTHER, '9', 'oz', '', ['8', 'oz', '8 oz/A'])], 'k-after'), /PRODUCT_RATES_LOCKED/);
  assert.equal(events(), 'locked,corrected,unlocked,locked');
  console.log('[prover] a lock waits for an upload already saving, then refuses the next one');

  // The live smoke chain passes here too, and leaves nothing behind.
  const before = scalar('SELECT count(*) FROM public.product_rate_events;');
  const out = psql(lf(path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke-product_rate_lock.sql')), { allowFailure: true });
  assert.match(`${out.stdout}${out.stderr}`, /SMOKE_PASS_ROLLBACK/, `${out.stdout}${out.stderr}`);
  assert.equal(scalar('SELECT count(*) FROM public.product_rate_events;'), before);
  console.log('[prover] the live smoke chain passes and rolls back');
  console.log('PRODUCT_RATE_LOCK_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
