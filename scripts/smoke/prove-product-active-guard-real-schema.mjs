#!/usr/bin/env node
/**
 * Real-schema proof for 20261102101000_product_active_guard.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container and replays ordered post-baseline migrations up to this candidate. It exercises
 * transaction, admin review, blocking and warning, line, race, and mutation checks.
 *
 * Run: node scripts/smoke/prove-product-active-guard-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_ACTIVE_GUARD_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-product-active-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102101000_product_active_guard.sql');
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
const TOUCHED = /product_active_guard|write_product_active_guard/;
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  // The checked-in database baseline predates these Auth service objects. Current profile
  // deactivation updates banned_until and deletes sessions; restore their local shape only.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    GRANT DELETE ON auth.sessions TO postgres;`, { user: 'supabase_admin' });
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const ADMIN = '7c620000-0000-4000-8000-0000000000a1';
const REP = '7c620000-0000-4000-8000-0000000000b1';
function withActor(actor, sql, role = 'authenticated', allowFailure = false) {
  return psql(`BEGIN; SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${actor}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${actor}', 'role', '${role}')::text, true);
    ${sql} COMMIT;`, { allowFailure });
}
function denied(actor, sql, expected, role = 'authenticated') {
  const r = withActor(actor, sql, role, true);
  assert.notEqual(r.status, 0, `unexpected success: ${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, expected);
  return `${r.stdout}\n${r.stderr}`;
}
function preview(id, active = false) {
  return JSON.parse(scalar(`BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    SELECT public.preview_product_active_change(ARRAY['${id}']::uuid[], ${active}); ROLLBACK;`));
}
function turn(id, active, key) {
  const review = preview(id, active);
  withActor(ADMIN, `SELECT public.set_product_active(ARRAY['${id}']::uuid[], ${active},
    '${review.review_token}', '${key}');`);
  return review;
}
function product(name) {
  const id = scalar(`BEGIN;
    SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products(product_name, unit_size, current_cost, tier1_price, product_form)
      VALUES ('${name}', 'gal', 1.00, 2.00, 'liquid') RETURNING id;
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    COMMIT;`);
  assert.match(id, /^[0-9a-f-]{36}$/);
  return id;
}
function order(id, number, status = 'confirmed') {
  psql(`INSERT INTO public.orders(id, order_number, customer_id, status)
    VALUES ('${id}', '${number}', (SELECT id FROM public.customers LIMIT 1), '${status}');`);
}
function orderLine(id, productId) {
  psql(`INSERT INTO public.order_items(order_id, product_id, product_name, total_units_needed,
    quantity_remaining, price_per_unit, cost_per_unit)
    VALUES ('${id}', '${productId}', '[PROVER] chemical', 1, 1, 2, 1);`);
}
function uid(n) { return `7c620000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
function seed(sql) { psql(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`); }
function seedOrderLine(productId, number, status, n) {
  const id = uid(n);
  seed(`INSERT INTO public.orders(id, order_number, customer_id, status)
      VALUES ('${id}', '${number}', (SELECT id FROM public.customers LIMIT 1), '${status}');
    INSERT INTO public.order_items(order_id, product_id, product_name, total_units_needed,
      quantity_remaining, price_per_unit, cost_per_unit, total_price)
      VALUES ('${id}', '${productId}', '[PROVER] chemical', 1, 1, 2, 1, 2);`);
  return { orderId: id, lineId: scalar(`SELECT id FROM public.order_items WHERE order_id = '${id}' AND product_id = '${productId}';`) };
}
function seedPoLine(productId, number, status, n) {
  const id = uid(n);
  seed(`INSERT INTO public.purchase_orders(id, po_number, vendor, status, created_by)
    VALUES ('${id}', '${number}', '[PROVER] vendor', '${status}', '${ADMIN}');
    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, product_name,
      quantity_ordered, unit_cost) VALUES ('${id}', '${productId}', '[PROVER] chemical', 1, 1);`);
  return id;
}
function seedQuoteLine(productId, number, status, n) {
  const id = uid(n);
  const section = uid(n + 1000);
  seed(`INSERT INTO public.quotes(id, quote_number, customer_id, created_by, status)
      VALUES ('${id}', '${number}', (SELECT id FROM public.customers LIMIT 1), '${ADMIN}', '${status}');
    INSERT INTO public.quote_sections(id, quote_id, section_name) VALUES ('${section}', '${id}', 'Chemical');
    INSERT INTO public.quote_items(quote_id, section_id, product_id, price_per_unit,
      current_cost, cost_at_quote_cents, total_units_needed)
      VALUES ('${id}', '${section}', '${productId}', 2, 1, 100, 1);`);
  return id;
}
function seedDelivery(orderId, lineId, productId, n, external = false, invoiced = false) {
  const delivery = uid(n);
  seed(`INSERT INTO public.deliveries(id, delivery_number, order_id, customer_id, status, created_by)
    VALUES ('${delivery}', 'PM3-DEL-${n}', '${orderId}',
      (SELECT customer_id FROM public.orders WHERE id = '${orderId}'), 'completed', '${ADMIN}');
    INSERT INTO public.delivery_items(delivery_id, order_item_id, product_id, quantity, quantity_delivered)
      VALUES ('${delivery}', '${lineId}', '${productId}', 1, 1);
    ${external ? `INSERT INTO public.delivery_external_billings(delivery_id, reason, recorded_by)
      VALUES ('${delivery}', 'Proof outside billing', '${ADMIN}');` : ''}
    ${invoiced ? `INSERT INTO public.invoices(id, invoice_number, order_id, delivery_id, customer_id,
      invoice_type, status, created_by, posted_by, posted_at, total_amount_cents)
      VALUES ('${uid(n + 1000)}', 'PM3-INV-${n}', '${orderId}', '${delivery}',
      (SELECT customer_id FROM public.orders WHERE id = '${orderId}'), 'chemical_sale', 'posted',
      '${ADMIN}', '${ADMIN}', now(), 200);
      INSERT INTO public.invoice_items(invoice_id, order_item_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents)
        VALUES ('${uid(n + 1000)}', '${lineId}', '${productId}', '[PROVER] chemical', 1, 200, 200, 100);` : ''}`);
  return delivery;
}
function backgroundSql(sql) {
  const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.stdin.end(sql);
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, output })));
}
async function waitForLock() {
  for (let i = 0; i < 35; i += 1) {
    if (Number(scalar(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock';`)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('concurrent transaction did not wait on a row lock');
}

try {
  buildContainer();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pm3-admin@example.invalid', '{"full_name":"PM3 Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pm3-rep@example.invalid', '{"full_name":"PM3 Rep","role":"sales_rep"}'::jsonb);`);
  psql(`INSERT INTO public.customers(farm_name) VALUES ('[PROVER] Customer');`);
  const candidate = lf(CANDIDATE);
  stageText('candidate.sql', candidate);
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0);
  assert.match(`${auto.stdout}\n${auto.stderr}`, /PRODUCT_ACTIVE_GUARD_NOT_IN_TRANSACTION/);

  for (const [label, mutation, expected] of [
    ['trigger', 'DROP TRIGGER trigger_a_guard_product_deactivation ON public.products;', 'triggers'],
    ['grant', 'GRANT EXECUTE ON FUNCTION public._product_active_review(uuid[]) TO authenticated;', 'grants'],
  ]) {
    stageText(`mutation-${label}.sql`, candidate.replace('DO $postflight$', `${mutation}\nDO $postflight$`));
    const result = apply(`mutation-${label}.sql`);
    assert.notEqual(result.status, 0, `${label} mutation was accepted`);
    assert.ok(result.output.includes(expected), result.output);
  }
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0);
  assert.match(again.output, /PREFLIGHT_PRODUCT_ACTIVE_GUARD_ALREADY_EXISTS/);

  const p = product('[PROVER] PM3 Open Order');
  const o = '7c620000-0000-4000-8000-0000000000c1';
  order(o, 'PM3-OPEN'); orderLine(o, p);
  assert.equal(preview(p).blockers[0].number, 'PM3-OPEN');
  denied(ADMIN, `UPDATE public.products SET is_active = false WHERE id = '${p}';`, /PRODUCT_DEACTIVATION_BLOCKED:.*PM3-OPEN/, 'postgres');
  const blocked = preview(p);
  denied(ADMIN, `SELECT public.set_product_active(ARRAY['${p}']::uuid[], false, '${blocked.review_token}', 'pm3-blocked');`, /PRODUCT_DEACTIVATION_BLOCKED:.*PM3-OPEN/);
  denied(REP, `SELECT public.preview_product_active_change(ARRAY['${p}']::uuid[], false);`, /NOT_AUTHORIZED/);
  denied(REP, `SELECT public.set_product_active(ARRAY['${p}']::uuid[], false, 'x', 'pm3-rep');`, /NOT_AUTHORIZED/);
  denied(ADMIN, `SELECT public.preview_product_active_change(ARRAY['${p}']::uuid[], false);`, /permission denied/, 'anon');
  denied(ADMIN, `SELECT public.set_product_active(ARRAY['${p}']::uuid[], false, 'x', 'pm3-anon');`,
    /permission denied/, 'anon');

  const clean = product('[PROVER] PM3 Clean');
  const old = preview(clean);
  psql(`INSERT INTO public.inventory(product_id, quantity_available) VALUES ('${clean}', 2);`);
  denied(ADMIN, `SELECT public.set_product_active(ARRAY['${clean}']::uuid[], false, '${old.review_token}', 'pm3-stale');`, /PRODUCT_ACTIVE_REVIEW_STALE/);
  assert.equal(preview(clean).warnings[0].kind, 'stock');
  turn(clean, false, 'pm3-clean');
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${clean}';`), 'f');
  denied(ADMIN, `INSERT INTO public.order_items(order_id, product_id, product_name, total_units_needed)
    VALUES ('${o}', '${clean}', 'inactive', 1);`, /PRODUCT_INACTIVE:.*PM3 Clean/, 'postgres');
  denied(ADMIN, `SELECT public.set_product_active(ARRAY['${clean}']::uuid[], true, 'different', 'pm3-clean');`, /IDEMPOTENCY/);
  turn(clean, true, 'pm3-reactivate');
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${clean}';`), 't');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${clean}'
    AND field_name = 'is_active' AND changed_by = '${ADMIN}';`), '2');

  // Every blocking state is checked against its own line, including fulfilled lines.
  const blockedProduct = product('[PROVER] PM3 More Blockers');
  seedOrderLine(blockedProduct, 'PM3-PARTIAL', 'partially_fulfilled', 201);
  const unbilled = seedOrderLine(blockedProduct, 'PM3-UNBILLED', 'fulfilled', 202);
  seedDelivery(unbilled.orderId, unbilled.lineId, blockedProduct, 203);
  for (const [status, n] of [['draft', 204], ['submitted', 205], ['partially_received', 206]]) {
    seedPoLine(blockedProduct, `PM3-PO-${status}`, status, n);
  }
  const blockerNames = preview(blockedProduct).blockers.map((b) => b.number);
  for (const number of ['PM3-PARTIAL', 'PM3-UNBILLED', 'PM3-PO-draft',
    'PM3-PO-submitted', 'PM3-PO-partially_received']) assert.ok(blockerNames.includes(number), number);
  const directBlockers = denied(ADMIN, `UPDATE public.products SET is_active = false WHERE id = '${blockedProduct}';`,
    /PRODUCT_DEACTIVATION_BLOCKED:.*PM3-UNBILLED/, 'postgres');
  const blockedToken = preview(blockedProduct).review_token;
  const rpcBlockers = denied(ADMIN, `SELECT public.set_product_active(ARRAY['${blockedProduct}']::uuid[],
    false, '${blockedToken}', 'pm3-all-blockers');`, /PRODUCT_DEACTIVATION_BLOCKED/);
  for (const number of blockerNames) {
    assert.ok(directBlockers.includes(number), `direct update omitted ${number}`);
    assert.ok(rpcBlockers.includes(number), `RPC omitted ${number}`);
  }
  const mixed = [clean, blockedProduct];
  const mixedPreview = JSON.parse(scalar(`BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    SELECT public.preview_product_active_change(ARRAY['${mixed.join("','")}']::uuid[], false); ROLLBACK;`));
  denied(ADMIN, `SELECT public.set_product_active(ARRAY['${mixed.join("','")}']::uuid[], false,
    '${mixedPreview.review_token}', 'pm3-mixed');`, /PRODUCT_DEACTIVATION_BLOCKED:.*PM3-UNBILLED/);
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${clean}';`), 't');

  const billedProduct = product('[PROVER] PM3 Billed');
  const billed = seedOrderLine(billedProduct, 'PM3-BILLED', 'fulfilled', 210);
  seedDelivery(billed.orderId, billed.lineId, billedProduct, 211, false, true);
  // Another product's unbilled line must not affect this product's billed line.
  seed(`INSERT INTO public.order_items(order_id, product_id, product_name, total_units_needed,
    quantity_remaining, price_per_unit, cost_per_unit)
    VALUES ('${billed.orderId}', '${p}', 'Other chemical', 1, 1, 2, 1);`);
  assert.deepEqual(preview(billedProduct).blockers, []);
  // Today's real order_items.product_id is NOT NULL. Test forward compatibility
  // with a free-text charge only inside a rolled-back schema relaxation.
  const chargeReview = JSON.parse(scalar(`BEGIN;
    ALTER TABLE public.order_items ALTER COLUMN product_id DROP NOT NULL;
    SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.order_items(order_id, product_id, product_name, total_units_needed,
      quantity_remaining, price_per_unit) VALUES ('${billed.orderId}', NULL, 'Charge', 1, 1, 2);
    SET LOCAL session_replication_role = origin;
    SELECT public.preview_product_active_change(ARRAY['${billedProduct}']::uuid[], false);
    ROLLBACK;`));
  assert.deepEqual(chargeReview.blockers, []);
  turn(billedProduct, false, 'pm3-billed');
  const outsideProduct = product('[PROVER] PM3 Outside Billed');
  const outside = seedOrderLine(outsideProduct, 'PM3-OUTSIDE', 'fulfilled', 212);
  seedDelivery(outside.orderId, outside.lineId, outsideProduct, 213, true);
  assert.deepEqual(preview(outsideProduct).blockers, []);
  turn(outsideProduct, false, 'pm3-outside');
  const unknownProduct = product('[PROVER] PM3 Unknown');
  seedOrderLine(unknownProduct, 'PM3-NO-DELIVERY', 'fulfilled', 214);
  assert.equal(preview(unknownProduct).blockers[0].number, 'PM3-NO-DELIVERY');

  const quoteProduct = product('[PROVER] PM3 Quotes');
  for (const [status, n] of [['draft', 220], ['sent', 221], ['revised', 222],
    ['accepted', 223], ['accepted', 224], ['expired', 225], ['closed_short', 226]]) {
    seedQuoteLine(quoteProduct, `PM3-Q-${n}`, status, n);
  }
  seed(`INSERT INTO public.orders(id, order_number, quote_id, customer_id, status)
    VALUES ('${uid(227)}', 'PM3-CONVERTED', '${uid(223)}',
      (SELECT id FROM public.customers LIMIT 1), 'cancelled');`);
  const quoteWarnings = preview(quoteProduct).warnings.map((w) => w.number);
  assert.deepEqual(quoteWarnings, ['PM3-Q-220', 'PM3-Q-221', 'PM3-Q-222', 'PM3-Q-224']);
  assert.deepEqual(preview(quoteProduct).blockers, []);
  turn(quoteProduct, false, 'pm3-quotes');
  const quietProduct = product('[PROVER] PM3 Soft Deleted');
  const deletedOrder = seedOrderLine(quietProduct, 'PM3-DELETED', 'confirmed', 228);
  const deletedQuote = seedQuoteLine(quietProduct, 'PM3-DELETED-Q', 'draft', 229);
  seed(`UPDATE public.orders SET deleted_at = now() WHERE id = '${deletedOrder.orderId}';
    UPDATE public.quotes SET deleted_at = now() WHERE id = '${deletedQuote}';
    INSERT INTO public.jobs(id, job_number, customer_id, status, job_date, created_by, deleted_at)
      VALUES ('${uid(232)}', 'PM3-DELETED-JOB',
      (SELECT id FROM public.customers LIMIT 1), 'scheduled', current_date, '${ADMIN}', now());
    INSERT INTO public.job_chemicals(job_id, product_id, quantity)
      VALUES ('${uid(232)}', '${quietProduct}', 1);`);
  assert.deepEqual(preview(quietProduct).blockers, []);
  assert.deepEqual(preview(quietProduct).warnings, []);

  const warningProduct = product('[PROVER] PM3 Warnings');
  seed(`INSERT INTO public.inventory(product_id, quantity_available) VALUES ('${warningProduct}', 3);
    INSERT INTO public.app_settings(setting_key, setting_value)
      VALUES ('crop_programs', '[{"items":[{"product_id":"${warningProduct}"}]}]');
    INSERT INTO public.jobs(id, job_number, customer_id, status, job_date, created_by)
      VALUES ('${uid(230)}', 'PM3-JOB', (SELECT id FROM public.customers LIMIT 1),
        'scheduled', current_date, '${ADMIN}');
    INSERT INTO public.job_chemicals(job_id, product_id, quantity)
      VALUES ('${uid(230)}', '${warningProduct}', 1);`);
  assert.deepEqual(preview(warningProduct).warnings.map((w) => w.kind),
    ['job', 'stock', 'crop program']);
  turn(warningProduct, false, 'pm3-warnings');

  const idemProduct = product('[PROVER] PM3 Idempotency');
  const idemToken = preview(idemProduct).review_token;
  const idemCall = `BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    SELECT public.set_product_active(ARRAY['${idemProduct}']::uuid[], false,
      '${idemToken}', 'pm3-repeat'); COMMIT;`;
  const firstResult = scalar(idemCall);
  assert.equal(scalar(idemCall), firstResult, 'replay must return its first result');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${idemProduct}'
    AND field_name = 'is_active';`), '1', 'replay must not make a second write');

  for (const table of ['order_items', 'quote_items', 'purchase_order_items']) {
    const parent = table === 'order_items' ? `order_id, product_name, price_per_unit, cost_per_unit, total_units_needed`
      : table === 'quote_items' ? `quote_id, section_id, price_per_unit, current_cost, total_units_needed`
        : `purchase_order_id, product_name, quantity_ordered, unit_cost`;
    const values = table === 'order_items' ? `'${o}', 'Inactive', 2, 1, 1`
      : table === 'quote_items' ? `'${uid(220)}', '${uid(1220)}', 2, 1, 1`
        : `'${uid(204)}', 'Inactive', 1, 1`;
    denied(ADMIN, `INSERT INTO public.${table}(product_id, ${parent})
      VALUES ('${idemProduct}', ${values});`, /PRODUCT_INACTIVE:.*PM3 Idempotency/, 'postgres');
  }
  const held = seedOrderLine(idemProduct, 'PM3-HELD', 'confirmed', 231);
  const otherLine = scalar(`SELECT id FROM public.order_items WHERE order_id = '${held.orderId}' AND product_id = '${idemProduct}';`);
  seed(`INSERT INTO public.order_items(order_id, product_id, product_name, price_per_unit,
    cost_per_unit, total_units_needed, quantity_remaining)
    VALUES ('${held.orderId}', '${p}', 'Active', 2, 1, 1, 1);`);
  const activeLine = scalar(`SELECT id FROM public.order_items WHERE order_id = '${held.orderId}' AND product_id = '${p}';`);
  const editItems = JSON.stringify([
    { id: otherLine, product_id: idemProduct, product_name: 'Held', price_per_unit: 2, total_units_needed: 1 },
    { id: activeLine, product_id: p, product_name: 'Active edited', price_per_unit: 3, total_units_needed: 1 },
  ]);
  const version = scalar(`SELECT row_version FROM public.orders WHERE id = '${held.orderId}';`);
  withActor(ADMIN, `SELECT public.update_order_items('${held.orderId}', '${editItems}'::jsonb,
    '${ADMIN}', 'pm3-held-edit', ${version});`);
  assert.equal(scalar(`SELECT product_name FROM public.order_items WHERE id = '${activeLine}';`), 'Active edited');
  const secondOff = product('[PROVER] PM3 Second Inactive');
  turn(secondOff, false, 'pm3-second-off');
  const added = JSON.stringify([...JSON.parse(editItems),
    { product_id: secondOff, product_name: 'Second inactive', price_per_unit: 2, total_units_needed: 1 }]);
  const newVersion = scalar(`SELECT row_version FROM public.orders WHERE id = '${held.orderId}';`);
  denied(ADMIN, `SELECT public.update_order_items('${held.orderId}', '${added}'::jsonb,
    '${ADMIN}', 'pm3-held-add', ${newVersion});`, /PRODUCT_INACTIVE:.*PM3 Second Inactive/);
  denied(ADMIN, `UPDATE public.orders SET status = 'partially_fulfilled' WHERE id = '${outside.orderId}';`,
    /PRODUCT_INACTIVE:.*reactivate.*reopening order/, 'postgres');

  const failure = psql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    CREATE OR REPLACE FUNCTION public._product_active_review(p_product_ids uuid[]) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ BEGIN RAISE EXCEPTION 'PM3_REVIEW_FAILURE'; END $$;
    UPDATE public.products SET is_active = false WHERE id = '${quietProduct}'; ROLLBACK;`, { allowFailure: true });
  assert.notEqual(failure.status, 0);
  assert.match(`${failure.stdout}\n${failure.stderr}`, /PM3_REVIEW_FAILURE/);
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${quietProduct}';`), 't');

  const customerId = scalar('SELECT id FROM public.customers LIMIT 1;');
  const directPayload = JSON.stringify([{ product_id: idemProduct, product_name: 'Inactive',
    quantity: 1, price_per_unit: 2, unit_cost: 1, unit_size: 'gal' }]);
  denied(ADMIN, `SELECT public.create_direct_order('${customerId}', current_date, 'PM3 direct', NULL,
    '${directPayload}'::jsonb, '${ADMIN}', 'pm3-direct', NULL);`, /PRODUCT_INACTIVE:.*PM3 Idempotency/);
  const quoteVersion = scalar(`SELECT row_version FROM public.quotes WHERE id = '${uid(224)}';`);
  denied(ADMIN, `SELECT public.convert_quote_to_order('${uid(224)}', '${ADMIN}',
    'pm3-convert', ${quoteVersion}, NULL);`, /PRODUCT_INACTIVE:.*PM3 Quotes/);

  // A return references the already delivered line; it does not create a new sale.
  seed(`UPDATE public.order_items SET quantity_delivered = 1, quantity_remaining = 0
    WHERE id = '${outside.lineId}';`);
  const returnPayload = JSON.stringify({ customer_id: customerId, order_id: outside.orderId,
    reason: 'damaged' });
  const returnItems = JSON.stringify([{ order_item_id: outside.lineId, quantity: 1 }]);
  withActor(ADMIN, `SELECT public.create_return('${returnPayload}'::jsonb,
    '${returnItems}'::jsonb, 'pm3-return');`);
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${outsideProduct}';`), 'f');

  // Both arrival orders use independent psql connections and an observed lock wait.
  const raceA = product('[PROVER] PM3 Race Line First');
  const raceOrderA = uid(240);
  seed(`INSERT INTO public.orders(id, order_number, customer_id, status)
    VALUES ('${raceOrderA}', 'PM3-RACE-A', '${customerId}', 'confirmed');`);
  const firstLine = backgroundSql(`BEGIN;
    INSERT INTO public.order_items(order_id, product_id, product_name, price_per_unit,
      cost_per_unit, total_units_needed, quantity_remaining)
      VALUES ('${raceOrderA}', '${raceA}', 'Race A', 2, 1, 1, 1);
    SELECT pg_sleep(4); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const laterOff = backgroundSql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    UPDATE public.products SET is_active = false WHERE id = '${raceA}'; COMMIT;`);
  await waitForLock();
  assert.equal((await firstLine).status, 0, 'line-first transaction must commit');
  const refusedOff = await laterOff;
  assert.notEqual(refusedOff.status, 0, 'deactivation must wait and then refuse the committed order');
  assert.match(refusedOff.output, /PRODUCT_DEACTIVATION_BLOCKED:.*PM3-RACE-A/);
  assert.equal(scalar(`SELECT is_active FROM public.products WHERE id = '${raceA}';`), 't');
  assert.equal(scalar(`SELECT count(*) FROM public.order_items WHERE order_id = '${raceOrderA}';`), '1');

  const raceB = product('[PROVER] PM3 Race Deactivation First');
  const raceOrderB = uid(241);
  seed(`INSERT INTO public.orders(id, order_number, customer_id, status)
    VALUES ('${raceOrderB}', 'PM3-RACE-B', '${customerId}', 'confirmed');`);
  const firstOff = backgroundSql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${ADMIN}', true);
    UPDATE public.products SET is_active = false WHERE id = '${raceB}';
    SELECT pg_sleep(4); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const laterLine = backgroundSql(`BEGIN;
    INSERT INTO public.order_items(order_id, product_id, product_name, price_per_unit,
      cost_per_unit, total_units_needed, quantity_remaining)
      VALUES ('${raceOrderB}', '${raceB}', 'Race B', 2, 1, 1, 1);
    COMMIT;`);
  await waitForLock();
  assert.equal((await firstOff).status, 0, 'deactivation-first transaction must commit');
  const refusedLine = await laterLine;
  assert.notEqual(refusedLine.status, 0);
  assert.match(refusedLine.output, /PRODUCT_INACTIVE:.*Race Deactivation First/);
  assert.equal(scalar(`SELECT count(*) FROM public.order_items WHERE order_id = '${raceOrderB}';`), '0');
  console.log('PRODUCT_ACTIVE_GUARD_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}

