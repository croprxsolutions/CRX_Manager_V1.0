#!/usr/bin/env node
/**
 * Real-schema proof for the local tier-order warning candidate. Builds the checked-in schema
 * baseline in a network-disabled PostgreSQL container, replays migrations up to the candidate,
 * and checks the five pinned live function bodies before replacement. Rollback-only scenarios
 * compare all existing warning codes and details, then prove the new TIER_ORDER code and exact
 * adjacent-tier cents for price-driven, margin-driven, stated $0, and workbook changes. They also
 * prove approval acknowledgement, apply, history, and the old body's missing warning.
 *
 * Run: node scripts/smoke/prove-pricing-tier-order-real-schema.mjs   (needs local Docker image)
 * Prints PRICING_TIER_ORDER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-tier-order-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261103230000_pricing_tier_order_warning.sql');
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
const TOUCHED = /(FUNCTION\s+(public\.)?"?(preview_product_cost_basis_changes|apply_product_cost_basis_change_set|write_product_pricing_history|approve_pricing_change_set|_pricing_change_set_warnings|_pricing_change_set_warning_set|_pricing_change_set_warning_inputs|preview_product_pricing_changes|apply_product_pricing_change_set|_apply_product_cost_basis_change_set_serialized_inner|_resolve_product_cost_basis_row|_product_cost_basis_row_required|is_admin|check_idempotency_intent|save_idempotency|_bind_replay_receipt_20261015|_replay_fingerprint_20261015|_cost_step2_try_uuid)\b|pricing_change_set|product_margin_floor|cost_history)/i;
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

// The candidate is pinned to these five live bodies captured on 2026-11-02.
function fidelity() {
  for (const [signature, expected] of [
    ['public._pricing_change_set_warnings(uuid)', '2197e2c7410aeda9fed177c4046c3b32'],
    ['public._pricing_change_set_warning_set(uuid)', '52f7938fe4019436d861cd257fe2b217'],
    ['public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)', '15dd6f1bce81c8c26022acf190e8e5a6'],
    ['public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)', 'eccd562fd43c8f6ebe1946b26929dcba'],
    ['public.apply_product_cost_basis_change_set(uuid,text,uuid,text)', 'ac5b75bd83c3c98c2420c93849804ada'],
  ]) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${signature}'::regprocedure;`), expected, signature);
  }
  console.log('[prover] five live-body md5 pins hold before the candidate');
}

const id = (n) => `7c320000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN2: id('a2'), REP: id('b1') };
const PROD = id('f1'); // cost 10.00; prices 15.00 / 14.00 / 13.00; on a sent quote
const PROD_B = id('f2'); // cost 20.00; prices 30.00 / 28.00 / (blank = tier 1); floor 30%
const CUST = id('c1');
const QUOTE = id('901');
const SECTION = id('902');
const QITEM = id('903');
const q = (value) => `'${value}'`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN2, 'admin', 'Admin Two', 8], [U.REP, 'sales_rep', 'Rep', 7]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'price-sheet-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role, , minutes]) => `UPDATE public.profiles SET role = '${role}', is_active = true, created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    ${claims(U.ADMIN)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost,
        tier1_price, tier2_price, tier3_price, tier1_margin, tier2_margin, tier3_margin, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Sheet A', 'SHEET-A', 'gal', 10.00, 15.00, 14.00, 13.00,
        0.33333333, 0.28571429, 0.23076923, 'liquid', true),
      ('${PROD_B}', '[PROVER] Sheet B', 'SHEET-B', 'gal', 20.00, 30.00, 28.00, NULL,
        0.33333333, 0.28571429, NULL, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    COMMIT;`);
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES ('${CUST}', '[PROVER] Farm', 1);
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, tier, status, sent_at, valid_days)
      VALUES ('${QUOTE}', 'Q-PROVER-1', '${CUST}', '${U.ADMIN}', 1, 'sent', now(), 30);
    INSERT INTO public.quote_sections (id, quote_id, sort_order) VALUES ('${SECTION}', '${QUOTE}', 0);
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed)
      VALUES ('${QITEM}', '${QUOTE}', '${SECTION}', '${PROD}', 0, 15.00, 10);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`INSERT INTO public.product_margin_floors (product_id, margin_floor, set_by) VALUES ('${PROD_B}', 0.30, '${U.ADMIN}');`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT string_agg(pricing_version::text, ',' ORDER BY id) FROM public.products WHERE id IN ('${PROD}', '${PROD_B}');`), '1,1');
  console.log('[prover] seeded two admins and a rep, two products (B has a 30% floor and a blank tier 3), and a sent quote holding product A');
}

// Probes: one transaction per scenario, always rolled back. Each step runs as a role inside its own
// sub-transaction, so a refused step leaves the scenario going. A step yields "ok|<value>" or
// "<sqlstate>|<message>". Steps share values through transaction-local settings (crx.p.*).
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  if (as === 'bare') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '', true);\nSELECT set_config('request.jwt.claim.sub', '', true);`;
  if (as === 'anon') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSELECT set_config('request.jwt.claim.sub', '', true);\nSET LOCAL ROLE anon;`;
  return `RESET ROLE;\n${claims(as)}\nSET LOCAL ROLE authenticated;`;
}
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    const body = s.stmt ? s.stmt : `v := (${s.call})::text;`;
    const key = s.key.replaceAll('%', '%%');
    sql.push(who(s.as), `DO $probe$
DECLARE v text;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|${key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;`);
  }
  sql.push('ROLLBACK;');
  const text = sql.join('\n');
  const r = docker([...psqlArgs(), '-A', '-t'], { input: text, allowFailure: true });
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of steps) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}

// A products_inline preview row, price-driven, as src/lib/productPricing.ts sends it.
function row(product, cost, t1, t2, t3, extra = {}) {
  return {
    product_id: product, row_version: 1, pricing_mode: 'price_driven', new_cost: cost,
    tier1_price: t1, tier2_price: t2, tier3_price: t3,
    basis_type: 'manual_override', basis_source: 'products_inline', basis_reason: 'prover', basis_selection: false,
    ...extra,
  };
}
const SOURCED = { change_reason: 'Wells letter 10/20', price_source: 'Wells price letter 2026-10-20' };
const jb = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
// Preview; remember the change set as crx.p.<tag>. Yields "<status>|<warnings>|<row errors>".
const preview = (tag, rows, key) => `(SELECT CASE WHEN set_config('crx.p.${tag}', r->>'change_set_id', true) IS NOT NULL
    AND set_config('crx.p.${tag}_fp', r->>'request_fingerprint', true) IS NOT NULL THEN
    (r->>'status') || '|' || COALESCE((SELECT string_agg(w->>'product_id' || '=' || (SELECT string_agg(c, '+' ORDER BY c) FROM jsonb_array_elements_text(w->'warning_codes') c), ',' ORDER BY w->>'product_id')
      FROM jsonb_array_elements(COALESCE(r->'warnings', '[]'::jsonb)) w), '-')
    || '|' || COALESCE((SELECT string_agg(x->>'error_code', ',') FROM jsonb_array_elements(r->'rows') x WHERE x->>'error_code' IS NOT NULL), '-') END
  FROM (SELECT public.preview_product_cost_basis_changes('products_inline', NULL, ${jb(rows)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const CS = (tag) => `current_setting('crx.p.${tag}')::uuid`;
const FP = (tag) => `current_setting('crx.p.${tag}_fp')`;
const approve = (tag, acks, key, file = null) => `(SELECT r->>'status' || ':' || (r->>'acknowledged_count') FROM (SELECT public.approve_pricing_change_set(${CS(tag)}, ${FP(tag)}, ${jb(acks)}, ${file === null ? 'NULL' : jb(file)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const applyCs = (tag, key) => `(SELECT r->>'status' FROM (SELECT public.apply_product_cost_basis_change_set(${CS(tag)}, ${FP(tag)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const ack = (product, codes, reason = 'checked against the supplier letter') => ({ product_id: product, warning_codes: codes, reason });
const LAST_HIST = (product) => `(SELECT COALESCE(change_reason, '-') || '|' || COALESCE(to_jsonb(h)->>'price_source', '-') || '|' || change_source || '|' || COALESCE(to_jsonb(h)->>'new_rate_per_acre', '-')
  FROM public.cost_history h WHERE product_id = '${product}' ORDER BY changed_at DESC, id DESC LIMIT 1)`;
const A = PROD;
const B = PROD_B;

function warningSnapshot(rows, tag, raw = false) {
  const result = scenario([
    { key: 'preview', as: U.ADMIN, call: preview(tag, rows, `${tag}-preview`) },
    { key: 'snapshot', as: 'owner', call: `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'product_id', product_id, 'warning_codes', warning_codes, 'details', details)
        ORDER BY product_id)::text, '[]') FROM public._pricing_change_set_warnings(${CS(tag)}))` },
  ]);
  assert.match(result.preview, /^ok\|previewed\|.*\|-$/, `${tag} preview must have no row errors`);
  assert.match(result.snapshot, /^ok\|\[/);
  const snapshot = result.snapshot.slice(3);
  return raw ? snapshot : JSON.parse(snapshot);
}

function codes(snapshot) {
  return snapshot.flatMap((warning) => warning.warning_codes);
}

function testParity() {
  const cases = {
    cost: [row(B, '23.00', '30.00', '30.00', '30.00', SOURCED)],
    price: [row(A, '10.00', '20.00', '20.00', '20.00', SOURCED)],
    below: [row(B, '20.00', '19.00', '19.00', '19.00', SOURCED)],
    floor: [row(B, '20.00', '25.00', '25.00', '25.00', SOURCED)],
    quote: [row(A, '10.00', '15.50', '15.50', '15.50', SOURCED)],
    none: [row(B, '20.00', '30.00', '30.00', '30.00', SOURCED)],
  };
  return Object.fromEntries(Object.entries(cases).map(([name, rows]) => [name, warningSnapshot(rows, `parity_${name}`, true)]));
}

function checkNewWarning() {
  const tier2 = row(B, '20.00', '30.00', '29.00', '30.00', SOURCED);
  const tier3 = row(B, '20.00', '30.00', '32.00', '31.00', SOURCED);
  const second = warningSnapshot([tier2], 'tier2');
  assert.deepEqual(codes(second), ['TIER_ORDER']);
  assert.deepEqual(second[0].details.tier_order, [{
    lower_tier: 1, higher_tier: 2, lower_cents: '3000', higher_cents: '2900',
  }]);
  const third = warningSnapshot([tier3], 'tier3');
  assert.ok(codes(third).includes('TIER_ORDER'));
  assert.deepEqual(third[0].details.tier_order, [{
    lower_tier: 2, higher_tier: 3, lower_cents: '3200', higher_cents: '3100',
  }]);
  const both = warningSnapshot([row(B, '20.00', '30.00', '29.00', '28.00', SOURCED)], 'both');
  assert.deepEqual(both[0].details.tier_order, [
    { lower_tier: 1, higher_tier: 2, lower_cents: '3000', higher_cents: '2900' },
    { lower_tier: 2, higher_tier: 3, lower_cents: '2900', higher_cents: '2800' },
  ]);
  for (const [tag, rowValue] of [
    ['equal', row(B, '20.00', '30.00', '30.00', '30.00', SOURCED)],
    ['ascending', row(B, '20.00', '30.00', '31.00', '32.00', SOURCED)],
  ]) assert.ok(!codes(warningSnapshot([rowValue], tag)).includes('TIER_ORDER'), tag);

  // Existing blank prices are covered by the equal/ascending previews above. The public
  // price parser refuses blank proposed cells and the change-set output columns are NOT NULL.
  assert.equal(scalar(`SELECT tier3_price IS NULL FROM public.products WHERE id = '${B}';`), 't');
  assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'pricing_change_set_rows' AND is_nullable = 'NO'
    AND column_name IN ('output_tier1_price_cents', 'output_tier2_price_cents', 'output_tier3_price_cents',
      'output_tier1_margin', 'output_tier2_margin', 'output_tier3_margin');`), '6');
  const zero = scenario([
    { key: 'preview', as: U.ADMIN, call: preview('zero',
      [row(B, '0.00', '30.00', '0.00', '0.00', SOURCED)], 'zero-preview') },
    { key: 'codes', as: 'owner', call: `(SELECT to_jsonb(warning_codes)::text
      FROM public._pricing_change_set_warnings(${CS('zero')}))` },
    { key: 'details', as: 'owner', call: `(SELECT (details->'tier_order')::text
      FROM public._pricing_change_set_warnings(${CS('zero')}))` },
    { key: 'acks', as: 'owner', call: `(SELECT set_config('crx.p.zero_acks',
      jsonb_agg(jsonb_build_object('product_id', product_id,
        'warning_codes', warning_codes, 'reason', 'checked stated zero against source'))::text, true)
      FROM public._pricing_change_set_warnings(${CS('zero')}))` },
    { key: 'approve', as: U.ADMIN, call: `(SELECT r->>'status' || ':' || (r->>'acknowledged_count')
      FROM (SELECT public.approve_pricing_change_set(${CS('zero')}, ${FP('zero')},
        current_setting('crx.p.zero_acks')::jsonb,
        NULL, current_setting('request.jwt.claim.sub')::uuid, 'zero-ack') AS r) s)` },
    { key: 'apply', as: U.ADMIN, call: applyCs('zero', 'zero-apply') },
    { key: 'saved tier 2', as: 'owner', call: `(SELECT tier2_price = 0.00
      FROM public.products WHERE id = '${B}')` },
  ]);
  assert.match(zero.preview, /^ok\|previewed\|.*\|-$/, 'stated $0 preview must have no row errors');
  assert.ok(JSON.parse(zero.codes.slice(3)).includes('TIER_ORDER'), 'stated $0 Tier 2 must fire TIER_ORDER');
  assert.deepEqual(JSON.parse(zero.acks.slice(3))[0].warning_codes, JSON.parse(zero.codes.slice(3)));
  assert.deepEqual(JSON.parse(zero.details.slice(3)), [
    { lower_tier: 1, higher_tier: 2, lower_cents: '3000', higher_cents: '0' },
  ]);
  assert.equal(zero.approve, 'ok|approved:1');
  assert.equal(zero.apply, 'ok|applied');
  assert.equal(zero['saved tier 2'], 'ok|true');

  const margin = { ...row(B, '20.00', undefined, undefined, undefined, SOURCED),
    pricing_mode: 'margin_driven', tier1_margin_percent: '30',
    tier2_margin_percent: '28', tier3_margin_percent: '30' };
  const marginWarnings = warningSnapshot([margin], 'margin');
  assert.ok(codes(marginWarnings).includes('TIER_ORDER'), 'margin output must be checked');
  assert.deepEqual(marginWarnings[0].details.tier_order, [
    { lower_tier: 1, higher_tier: 2, lower_cents: '2857', higher_cents: '2778' },
  ]);

  const applied = scenario([
    { key: 'preview', as: U.ADMIN, call: preview('apply', [tier2], 'apply-preview') },
    { key: 'missing ack', as: U.ADMIN, call: approve('apply', [], 'apply-no-ack') },
    { key: 'approve', as: U.ADMIN, call: approve('apply', [ack(B, ['TIER_ORDER'])], 'apply-ack') },
    { key: 'apply', as: U.ADMIN, call: applyCs('apply', 'apply-run') },
    { key: 'history', as: 'owner', call: LAST_HIST(B) },
  ]);
  assert.match(applied['missing ack'], /^P0001\|PRICING_WARNINGS_UNACKNOWLEDGED/);
  assert.equal(applied.approve, 'ok|approved:1');
  assert.equal(applied.apply, 'ok|applied');
  assert.match(applied.history, /Wells letter 10\/20\|Wells price letter 2026-10-20/);

  const original = lf(path.join(MIGRATIONS, '20261027050000_price_sheet_warnings_and_approval.sql'));
  const oldBody = original.match(/CREATE FUNCTION public\._pricing_change_set_warnings\([\s\S]*?\$function\$;/)?.[0];
  assert.ok(oldBody, 'old warning function is available for mutation');
  const mutant = scenario([
    { key: 'preview', as: U.ADMIN, call: preview('mutant', [tier2], 'mutant-preview') },
    { key: 'codes', as: 'owner', call: `(SELECT COALESCE(array_to_string(warning_codes, ','), '-')
        FROM public._pricing_change_set_warnings(${CS('mutant')}))` },
  ], `SAVEPOINT old_body;\n${oldBody.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')}`);
  assert.equal(mutant.codes, 'ok|<null>', 'old body must miss the inverted-order warning');
  console.log('[prover] price, margin, approval, apply, blank/equal/ascending and old-body mutation passed');
}

function checkWorkbook() {
  const exportCall = `(SELECT CASE WHEN
      set_config('crx.p.wb_export', e->>'export_id', true) IS NOT NULL
      AND set_config('crx.p.wb_row', (e->'rows'->0)::text, true) IS NOT NULL
      THEN e->>'export_id' END
    FROM (SELECT public.create_pricing_workbook_export(ARRAY['${B}'::uuid],
      '${U.ADMIN}', 'wb-export') AS e) s)`;
  const workbookRow = `current_setting('crx.p.wb_row')::jsonb || jsonb_build_object(
    'pricing_mode', 'price_driven', 'new_cost', '20.00',
    'tier1_price', '30.00', 'tier2_price', '29.00', 'tier3_price', '30.00',
    'has_formula', false, 'change_reason', 'Worksheet update', 'price_source', 'Vendor price list',
    'basis_type', 'manual_override', 'basis_source', 'pricing_worksheet',
    'basis_reason', 'Worksheet update', 'basis_selection', false)`;
  const previewCall = `(SELECT CASE WHEN
      set_config('crx.p.wb', r->>'change_set_id', true) IS NOT NULL
      AND set_config('crx.p.wb_fp', r->>'request_fingerprint', true) IS NOT NULL
      THEN r->>'status' || '|' || COALESCE((SELECT string_agg(c, ',')
        FROM jsonb_array_elements(COALESCE(r->'warnings', '[]'::jsonb)) w
        CROSS JOIN LATERAL jsonb_array_elements_text(w->'warning_codes') c), '-') END
    FROM (SELECT public.preview_product_cost_basis_changes('pricing_worksheet',
      current_setting('crx.p.wb_export')::uuid, jsonb_build_array(${workbookRow}),
      '${U.ADMIN}', 'wb-preview') AS r) s)`;
  const result = scenario([
    { key: 'export', as: U.ADMIN, call: exportCall },
    { key: 'preview', as: U.ADMIN, call: previewCall },
    { key: 'warnings', as: 'owner', call: `(SELECT array_to_string(warning_codes, ',')
      FROM public._pricing_change_set_warnings(${CS('wb')}))` },
    { key: 'details', as: 'owner', call: `(SELECT (details->'tier_order')::text
      FROM public._pricing_change_set_warnings(${CS('wb')}))` },
    { key: 'approve', as: U.ADMIN, call: approve('wb', [ack(B, ['TIER_ORDER'])],
      'wb-approve', { name: 'sheet.xlsx', sha256: 'a'.repeat(64) }) },
    { key: 'apply', as: U.ADMIN, call: applyCs('wb', 'wb-apply') },
  ]);
  assert.match(result.export, /^ok\|[0-9a-f-]{36}$/);
  assert.match(result.preview, /^ok\|previewed\|TIER_ORDER$/);
  assert.equal(result.warnings, 'ok|TIER_ORDER');
  assert.deepEqual(JSON.parse(result.details.slice(3)), [
    { lower_tier: 1, higher_tier: 2, lower_cents: '3000', higher_cents: '2900' },
  ]);
  assert.equal(result.approve, 'ok|approved:1');
  assert.equal(result.apply, 'ok|applied');
  console.log('[prover] workbook export, preview, warning, approval and apply passed');
}

function main() {
  if (!REUSE) buildContainer();
  else {
    const original = lf(path.join(MIGRATIONS, '20261027050000_price_sheet_warnings_and_approval.sql'));
    const oldBody = original.match(/CREATE FUNCTION public\._pricing_change_set_warnings\([\s\S]*?\$function\$;/)?.[0];
    assert.ok(oldBody, 'old warning function needed to reset the disposable container');
    psql(oldBody.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  }
  fidelity();
  if (!REUSE) seed();
  const before = testParity();
  const beforeMixed = warningSnapshot([row(B, '23.00', '30.00', '29.00', '30.00', SOURCED)], 'mixed_before');
  assert.ok(beforeMixed.length === 1 && beforeMixed[0].warning_codes.length > 0);
  assert.ok(!beforeMixed[0].warning_codes.includes('TIER_ORDER'));
  const expected = ['COST_MOVE_OVER_10_PERCENT', 'PRICE_MOVE_OVER_10_PERCENT',
    'PRICE_BELOW_COST', 'MARGIN_UNDER_FLOOR', 'OPEN_SENT_QUOTE'];
  const observed = new Set(Object.values(before).flatMap((raw) => codes(JSON.parse(raw))));
  for (const code of expected) assert.ok(observed.has(code), `parity did not exercise ${code}`);
  assert.equal(before.none, '[]', 'no-warning fixture');
  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed: ${applied.output}`);
  assert.deepEqual(testParity(), before, 'all existing code/details must be identical');
  const afterMixed = warningSnapshot([row(B, '23.00', '30.00', '29.00', '30.00', SOURCED)], 'mixed_after');
  assert.deepEqual(afterMixed[0].warning_codes, [...beforeMixed[0].warning_codes, 'TIER_ORDER']);
  const { tier_order: mixedTierOrder, ...oldDetails } = afterMixed[0].details;
  assert.deepEqual(oldDetails, beforeMixed[0].details, 'existing detail keys must be unchanged');
  assert.deepEqual(mixedTierOrder, [
    { lower_tier: 1, higher_tier: 2, lower_cents: '3000', higher_cents: '2900' },
  ]);
  console.log('[prover] five existing codes and details match byte-for-byte before/after');
  checkNewWarning();
  checkWorkbook();
  console.log('PRICING_TIER_ORDER_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }

