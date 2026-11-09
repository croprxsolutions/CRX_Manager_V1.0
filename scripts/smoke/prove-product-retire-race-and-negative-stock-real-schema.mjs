#!/usr/bin/env node
/**
 * Real-schema proof for two product turn-off cases (KI-90 and KI-91), on main's current schema.
 *
 * KI-90: an order reopening races an admin turning its product off through set_product_active
 * (the real preview + confirm path, not a direct flag write). Whichever commits first wins and the
 * other is refused, so no open order ever keeps a turned-off product with quantity left to fill.
 * KI-91: a turned-off product with a NEGATIVE stock balance stays in the inventory position report
 * (its negative balance shown, never flagged low) and in the admin cost report (its negative value
 * counted), so the shortfall is not hidden by retiring the product.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * post-baseline migration, seeds invented rows and checks each case.
 *
 * Run: node scripts/smoke/prove-product-retire-race-and-negative-stock-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_RETIRE_RACE_AND_NEGATIVE_STOCK_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-retire-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
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
      expected, `${signature} is not the pinned live body before 20261104150000`);
  }
}
function plan() {
  // Every post-baseline migration on this branch: the proof checks main's current schema, not one candidate.
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  for (const name of PARKED) assert.ok(all.some((f) => path.basename(f) === name), `${name} must be in the replay plan (re-check the PARKED list)`);
  return all;
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
  // has them: 20261022075000 (replayed first) checks that shape in its preflight.
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
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const uid = (n) => `7c690000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = uid('a1');
const CUSTOMER = uid('c1');
let keyN = 0;
const key = () => `ki90-91-${++keyN}`;

function seed(sql) { psql(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`); }
function asAdmin(sql) {
  return `BEGIN; SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    ${sql}`;
}
function adminScalar(sql) { return scalar(`${asAdmin(sql)} ROLLBACK;`); }
function product(n, name) {
  const id = uid(n);
  seed(`INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, current_cost, tier1_price, is_active)
    VALUES ('${id}', '[PROVER] ${name}', 'KI9X-${n}', 'liquid', 'Gal', 'Herbicide', 1.00, 2.00, true);`);
  return id;
}
function preview(id) { return JSON.parse(adminScalar(`SELECT public.preview_product_active_change(ARRAY['${id}']::uuid[], false);`)); }
function turnOffSql(id, token, sleep) {
  return `${asAdmin(`SELECT public.set_product_active(ARRAY['${id}']::uuid[], false, '${token}', '${key()}');`)}
    ${sleep ? 'SELECT pg_sleep(4);' : ''} COMMIT;`;
}
function backgroundSql(sql) {
  const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.stdin.end(sql);
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, output })));
}
// The second transaction must really wait on the first's product row lock, not just run later.
async function waitForLock(productId) {
  for (let i = 0; i < 35; i += 1) {
    const blocked = Number(scalar(`SELECT count(*) FROM pg_stat_activity waiting
      WHERE waiting.wait_event_type = 'Lock'
        AND EXISTS (SELECT 1 FROM pg_locks holder
          WHERE holder.pid = ANY(pg_blocking_pids(waiting.pid))
            AND holder.relation = 'public.products'::regclass);`)) > 0;
    const probe = psql(`SELECT 1 FROM public.products WHERE id = '${productId}' FOR NO KEY UPDATE NOWAIT;`, { allowFailure: true });
    if (blocked && probe.status !== 0 && /could not obtain lock on row/.test(probe.stderr)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`concurrent transaction did not wait on product ${productId}`);
}
// The first transaction has done its write (and holds its lock) once it reaches pg_sleep.
async function waitForSleeper() {
  for (let i = 0; i < 100; i += 1) {
    if (scalar(`SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid()
      AND state = 'active' AND query ILIKE '%pg_sleep(4)%';`) !== '0') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the first transaction never reached its pause');
}
const openLinesOnInactive = (orderId) => scalar(`SELECT count(*) FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id JOIN public.products p ON p.id = oi.product_id
  WHERE o.id = '${orderId}' AND o.status IN ('confirmed', 'partially_fulfilled')
    AND NOT p.is_active AND coalesce(oi.quantity_remaining, 0) > 0;`);

try {
  buildContainer();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki90-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  seed(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid'
     WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE lower(unit) = 'gal' AND unit_type = 'liquid');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUSTOMER}', '[PROVER] Customer');`);
  assert.equal(scalar(`SELECT role FROM public.profiles WHERE id = '${ADMIN}';`), 'admin');

  // KI-90: reopen vs set_product_active, both arrival orders, separate connections, observed lock wait.
  for (const [arrival, n] of [['reopen-first', 10], ['turn-off-first', 20]]) {
    const productId = product(n, `KI90 ${arrival}`);
    const orderId = uid(n + 1);
    seed(`INSERT INTO public.orders (id, order_number, customer_id, status)
        VALUES ('${orderId}', 'KI90-${arrival}', '${CUSTOMER}', 'fulfilled');
      INSERT INTO public.order_items (order_id, product_id, product_name, total_units_needed,
        quantity_remaining, price_per_unit, cost_per_unit, total_price)
        VALUES ('${orderId}', '${productId}', '[PROVER] chemical', 1, 1, 2, 1, 2);`);
    // The admin reviews while the order is still closed: no blockers, so the screen would offer Confirm.
    const review = preview(productId);
    assert.deepEqual(review.blockers, [], `${arrival}: a closed order must not block the preview`);
    const reopenSql = `BEGIN; SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
      SELECT set_config('app.admin_override', 'true', true);
      UPDATE public.orders SET status = 'partially_fulfilled' WHERE id = '${orderId}';
      ${arrival === 'reopen-first' ? 'SELECT pg_sleep(4);' : ''} COMMIT;`;
    const turnOff = turnOffSql(productId, review.review_token, arrival === 'turn-off-first');
    const first = backgroundSql(arrival === 'reopen-first' ? reopenSql : turnOff);
    try { await waitForSleeper(); } catch (e) { throw new Error(`${e.message}: ${(await first).output}`); }
    const second = backgroundSql(arrival === 'reopen-first' ? turnOff : reopenSql);
    try { await waitForLock(productId); } catch (e) {
      throw new Error(`${e.message}\nfirst: ${(await first).output}\nsecond: ${(await second).output}`);
    }
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.status, 0, `${arrival} first transaction: ${firstResult.output}`);
    assert.notEqual(secondResult.status, 0, `${arrival} second transaction should be refused: ${secondResult.output}`);
    if (arrival === 'reopen-first') {
      // The stale preview's Confirm re-reviews under the row lock and sees the reopened order.
      assert.match(secondResult.output, /PRODUCT_DEACTIVATION_BLOCKED:.*KI90-reopen-first/);
      assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${productId}';`), 't');
      assert.equal(scalar(`SELECT status FROM public.orders WHERE id = '${orderId}';`), 'partially_fulfilled');
    } else {
      assert.match(secondResult.output, /PRODUCT_INACTIVE:.*reopening order KI90-turn-off-first/);
      assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${productId}';`), 'f');
      assert.equal(scalar(`SELECT status FROM public.orders WHERE id = '${orderId}';`), 'fulfilled');
    }
    assert.equal(openLinesOnInactive(orderId), '0', `${arrival}: an open order kept a turned-off product`);
    console.log(`[prover] KI-90 ${arrival}: first committed, second refused`);
  }

  // KI-91: a product with a negative balance is turned off through the real path.
  const negative = product(30, 'KI91 Negative');
  seed(`INSERT INTO public.inventory (product_id, location, quantity_available, reorder_point)
    VALUES ('${negative}', 'Main Warehouse', -2.5, 5);`);
  const review = preview(negative);
  assert.deepEqual(review.blockers, []);
  assert.deepEqual(review.warnings.map((w) => w.kind), ['stock'], 'a negative balance is still stock to review');
  const off = psql(turnOffSql(negative, review.review_token, false), { allowFailure: true });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${negative}';`), 'f');

  const positions = JSON.parse(adminScalar('SELECT public.get_inventory_position();'));
  const row = positions.find((r) => r.product_id === negative);
  assert.ok(row, 'a retired product with a negative balance must stay in the position report');
  assert.equal(Number(row.quantity_available), -2.5);
  assert.equal(Number(row.net_position), -2.5);
  assert.equal(row.is_low_stock, false, 'a retired product is never flagged low, even when negative');
  assert.equal(adminScalar(`SELECT quantity_available || '|' || total_cost_value || '|' || below_reorder
    FROM public.get_inventory_cost_report() WHERE product_id = '${negative}';`), '-2.5|-2.50|false',
    'the admin cost report must keep the negative balance and its negative value');
  // The same balance on an active product is flagged low: turning it off, not the number, clears the flag.
  seed(`UPDATE public.products SET is_active = true WHERE id = '${negative}';`);
  const active = JSON.parse(adminScalar('SELECT public.get_inventory_position();')).find((r) => r.product_id === negative);
  assert.equal(active.is_low_stock, true, 'an active product with a negative balance must be flagged low');
  console.log('[prover] KI-91 retired negative balance: listed at -2.5, not low, cost -2.50');

  console.log('PRODUCT_RETIRE_RACE_AND_NEGATIVE_STOCK_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}
