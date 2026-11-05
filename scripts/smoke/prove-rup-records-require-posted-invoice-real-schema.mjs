#!/usr/bin/env node
/**
 * Real-schema proof for KI-05 (20261108140000_rup_records_require_posted_invoice): restricted-use-pesticide
 * register rows are written only for a posted invoice.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container and replays every ordered
 * post-baseline migration up to the candidate (generate_rup_sales_records then equals live's body, md5
 * 18802cbd..., read 2026-11-05). Seeds an admin, a sales rep, a driver, a licensed customer and one RUP
 * product; a real complete_delivery leaves a real draft delivery invoice. Every probe rolls back.
 *   BEFORE: a sales rep calling generate_rup_sales_records on the draft writes a register row (KI-05).
 *   AFTER:  the rep and an admin are refused on the draft (RUP_INVOICE_NOT_POSTED, naming the invoice and its
 *           status), and on a voided, cancelled, unposted or deleted invoice; an admin posting the draft through
 *           the real post_invoice, post_invoice_group or the deleted-order recovery post still writes exactly one
 *           register row; a second call writes nothing; an admin's direct call on a posted, paid or overdue
 *           invoice with no rows writes one; a driver is still refused by the role
 *           gate; an unknown invoice still returns 0; an idempotent replay still returns its receipt; a refused
 *           call leaves no receipt; the new table trigger refuses an admin's direct insert for the draft and
 *           allows it for a posted invoice. A drifted body aborts the candidate; re-applying it is harmless; grants,
 *           SECURITY DEFINER and search_path are unchanged.
 *
 * Run: node scripts/smoke/prove-rup-records-require-posted-invoice-real-schema.mjs   (needs local Docker image)
 * Prints RUP_RECORDS_REQUIRE_POSTED_INVOICE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-rup-posted-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);  // a kept container still before the candidate
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261108140000_rup_records_require_posted_invoice.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that touches the register writer or its table.
const TOUCHED = /(generate_rup_sales_records|rup_sales_records)/i;
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

const id = (n) => `5a050000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), DRIVER: id('d1') };
const CUSTOMER = id('c1');
const PRODUCT = id('f1');
const ORDER = id('e1');
const LINE = id('e2');
const DELIVERY = id('9d1');
const DELIVERY_ITEM = id('9d2');
const FN = 'public.generate_rup_sales_records(uuid,text)';
const LIVE_MD5 = '18802cbdbbd8a91334dcad11e5303e70';

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${U.ADMIN}', 'ki05-admin@example.invalid', '{"full_name":"[PROVER] KI05 Admin","role":"admin"}'::jsonb),
    ('${U.REP}', 'ki05-rep@example.invalid', '{"full_name":"[PROVER] KI05 Rep","role":"sales_rep"}'::jsonb),
    ('${U.DRIVER}', 'ki05-driver@example.invalid', '{"full_name":"[PROVER] KI05 Driver","role":"driver"}'::jsonb);`);
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${U.ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${U.REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${U.DRIVER}';
    INSERT INTO public.customers (id, farm_name, is_active, assigned_sales_rep, payment_terms)
      VALUES ('${CUSTOMER}', '[PROVER] KI05 Farm', true, '${U.REP}', 'Net 30');
    INSERT INTO public.applicator_licenses (customer_id, license_number, holder_name, expiry_date, is_active)
      VALUES ('${CUSTOMER}', 'PROVER-LIC-05', '[PROVER] Holder', current_date + 365, true);
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active, is_rup, epa_registration, signal_word)
      VALUES ('${PRODUCT}', '[PROVER] KI05 RUP', 'KI05-RUP', 'GL', 6.00, 10.00, true, true, 'PROVER-EPA-05', 'Warning');
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PRODUCT}', 'Main Warehouse', 100, 10, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${ORDER}', 'PROVER-KI05-ORDER', '${CUSTOMER}', current_date, 'confirmed', false, '${U.REP}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${LINE}', '${ORDER}', '${PRODUCT}', '[PROVER] KI05 RUP', 10, 6, 10, 100, 40, 40, 0, 10);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
      VALUES ('${DELIVERY}', 'PROVER-KI05-D1', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'in_progress', current_date);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DELIVERY_ITEM}', '${DELIVERY}', '${LINE}', '${PRODUCT}', 10, 'GL');`);
  // The real completion leaves the real draft delivery invoice.
  psql(`BEGIN;\n${claims(U.ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.complete_delivery('${DELIVERY}', 'No proof — recorded by office', '${U.ADMIN}',
      jsonb_build_object('${DELIVERY_ITEM}', 10), NULL, NULL, 'ki05-complete', NULL, 'no_proof', '[PROVER] no signature');
    COMMIT;`);
  const inv = scalar(`SELECT id || '|' || invoice_number || '|' || status FROM public.invoices WHERE delivery_id = '${DELIVERY}' AND deleted_at IS NULL;`);
  const [invId, number, status] = inv.split('|');
  assert.equal(status, 'draft', `complete_delivery should leave a draft invoice, got "${inv}"`);
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_items ii JOIN public.products p ON p.id = ii.product_id WHERE ii.invoice_id = '${invId}' AND p.is_rup;`), '1',
    'the draft must carry one RUP line');
  assert.equal(scalar('SELECT count(*) FROM public.rup_sales_records;'), '0', 'completing the delivery wrote register rows');
  console.log(`[prover] seeded; complete_delivery left draft invoice ${number} with one RUP line and no register rows`);
  return { invId, number };
}

/** One rolled-back transaction: `fixture` as the owner, then each step as its user. step -> "ok|v" or "<sqlstate>|<message>". */
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    sql.push('RESET ROLE;', claims(s.as), 'SET LOCAL ROLE authenticated;', `DO $probe$
DECLARE v text;
BEGIN
  ${s.stmt ?? `v := (${s.call})::text;`}
  RAISE NOTICE 'RESULT|${s.key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${s.key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;`);
  }
  // Active register rows: count:compliance/licence/written-by-the-rep.
  sql.push('RESET ROLE;', `DO $probe$ BEGIN RAISE NOTICE 'RESULT|rows|ok|%', (SELECT count(*) || ':' || coalesce(string_agg(compliance_status || '/' || buyer_certification_number || '/' || (created_by = '${U.REP}')::text, ','), '') FROM public.rup_sales_records WHERE voided_at IS NULL); END $probe$;`);
  sql.push('ROLLBACK;');
  const text = sql.join('\n');
  const r = docker([...psqlArgs(), '-A', '-t'], { input: text, allowFailure: true });
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of [...steps, { key: 'rows' }]) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}
function expect(out, want) {
  for (const [key, pattern] of Object.entries(want)) assert.match(out[key], pattern, `${key}: got "${out[key]}"`);
}

function main() {
  if (REUSE) {
    assert.match(NAME, /^crx-rup-posted-\d+-[a-z0-9]+$/, 'CRX_PROVER_REUSE_CONTAINER must name a container this proof created');
    assert.equal(docker(['inspect', '--format', '{{.Config.Image}} {{.HostConfig.NetworkMode}}', NAME]).stdout.trim(),
      `${IMAGE} none`, 'the reused container is not a network-disabled prover container');
  } else buildContainer();

  // FIDELITY: the body and grants the candidate replaces are live's (read 2026-11-05).
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${FN}'::regprocedure;`), LIVE_MD5, 'replayed body differs from live');
  const grants = () => scalar(`SELECT string_agg(r.grantee || ':' || r.privilege_type, ',' ORDER BY r.grantee) FROM information_schema.routine_privileges r
    JOIN pg_proc p ON r.specific_name = p.proname || '_' || p.oid WHERE p.oid = '${FN}'::regprocedure;`);
  const settings = () => scalar(`SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${FN}'::regprocedure;`);
  assert.equal(grants(), 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE', 'replayed grants differ from live');
  assert.equal(settings(), 'true search_path=public, pg_temp');
  console.log('[prover] FIDELITY: generate_rup_sales_records body, grants and settings match live (2026-11-05)');

  const { invId, number } = seed();
  const GEN = (key = null) => `public.generate_rup_sales_records('${invId}'::uuid${key ? `, '${key}'` : ''})`;
  const NOT_POSTED = (status) => new RegExp(`^P0001\\|RUP_INVOICE_NOT_POSTED: invoice ${number} is ${status} and not posted`);
  const ownerSet = (sql) => `ALTER TABLE public.invoices DISABLE TRIGGER USER;\n${sql}\nALTER TABLE public.invoices ENABLE TRIGGER USER;`;
  const POST = [
    { key: 'version', as: U.ADMIN, stmt: `RESET ROLE; v := public._invoice_post_version('${invId}'::uuid); PERFORM set_config('prover.ver', v, true);` },
    { key: 'post', as: U.ADMIN, stmt: `PERFORM public.post_invoice('${invId}'::uuid, current_setting('prover.ver'), 'ki05-post'); v := (SELECT status FROM public.invoices WHERE id = '${invId}');` },
  ];

  // BEFORE: the defect.
  expect(scenario([{ key: 'rep on draft', as: U.REP, call: GEN() }]), { 'rep on draft': /^ok\|1$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/true$/ });
  expect(scenario(POST), { post: /^ok\|posted$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  console.log('[prover] BEFORE: a sales rep writes a register row for the draft (KI-05 reproduced); posting writes one row');

  // PREFLIGHT: a drifted body aborts the candidate before any change.
  stageText('candidate.sql', lf(CANDIDATE));
  const drift = docker([...psqlArgs()], { input: `BEGIN;
CREATE OR REPLACE FUNCTION public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN 0; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`, allowFailure: true });
  assert.notEqual(drift.status, 0, 'the candidate applied over a drifted body');
  assert.match(drift.stderr, /RUP_POSTED_PREFLIGHT: live body changed/, `wrong refusal:\n${drift.stderr}`);
  console.log('[prover] PREFLIGHT: a drifted body aborts the candidate');

  const first = apply('candidate.sql');
  assert.equal(first.status, 0, `the candidate failed to apply:\n${first.output}`);
  const again = apply('candidate.sql');
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  assert.equal(grants(), 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE', 'grants changed');
  assert.equal(settings(), 'true search_path=public, pg_temp', 'SECURITY DEFINER or search_path changed');
  console.log('[prover] candidate applied and re-applied; grants, SECURITY DEFINER and search_path unchanged');

  // AFTER: refusals.
  expect(scenario([
    { key: 'rep on draft', as: U.REP, call: GEN() },
    { key: 'admin on draft', as: U.ADMIN, call: GEN() },
    { key: 'rep on draft with key', as: U.REP, call: GEN('ki05-refused') },
    { key: 'driver on draft', as: U.DRIVER, call: GEN() },
    { key: 'unknown invoice', as: U.REP, call: `public.generate_rup_sales_records('${id('ffff')}'::uuid)` },
  ]), {
    'rep on draft': NOT_POSTED('draft'), 'admin on draft': NOT_POSTED('draft'), 'rep on draft with key': NOT_POSTED('draft'),
    'driver on draft': /^P0001\|Not authorized to generate RUP sales records$/, 'unknown invoice': /^ok\|0$/, rows: /^ok\|0:$/,
  });
  // A refused call leaves no idempotency receipt (checked as the owner, in the same transaction).
  assert.equal(scalar(`BEGIN;\n${claims(U.REP)}\nSET LOCAL ROLE authenticated;
    DO $x$ BEGIN PERFORM ${GEN('ki05-refused')}; EXCEPTION WHEN OTHERS THEN NULL; END $x$;
    RESET ROLE;\nSELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'ki05-refused';\nROLLBACK;`), '0', 'a refused call saved a receipt');
  console.log(`[prover] AFTER: rep and admin refused on draft ${number} (RUP_INVOICE_NOT_POSTED, no receipt), driver still refused by role, unknown invoice still 0, nothing written`);

  for (const [label, fixture, status] of [
    ['voided', ownerSet(`UPDATE public.invoices SET status = 'voided', posted_at = now() WHERE id = '${invId}';`), 'voided'],
    ['cancelled', ownerSet(`UPDATE public.invoices SET status = 'cancelled' WHERE id = '${invId}';`), 'cancelled'],
    ['unposted', ownerSet(`UPDATE public.invoices SET status = 'unposted' WHERE id = '${invId}';`), 'unposted'],
    ['deleted posted', ownerSet(`UPDATE public.invoices SET status = 'posted', posted_at = now(), deleted_at = now() WHERE id = '${invId}';`), 'deleted'],
  ]) {
    expect(scenario([{ key: label, as: U.ADMIN, call: GEN() }], fixture), { [label]: NOT_POSTED(status), rows: /^ok\|0:$/ });
  }
  console.log('[prover] AFTER: voided, cancelled, unposted and deleted invoices are refused');

  // AFTER: the table trigger refuses a direct insert (the admin-only rup_sales_insert policy) for an unposted
  // invoice and allows it for a posted one.
  const INSERT_ROW = `INSERT INTO public.rup_sales_records (invoice_id, order_id, customer_id, product_id, sale_date, product_name,
      quantity, unit, unit_price_cents, total_cents, buyer_name, buyer_certification_number, compliance_status, season, created_by)
    VALUES ('${invId}', '${ORDER}', '${CUSTOMER}', '${PRODUCT}', current_date, '[PROVER] KI05 RUP', 10, 'GL', 1000, 10000,
      '[PROVER] KI05 Farm', 'PROVER-LIC-05', 'compliant', 2026, '${U.ADMIN}'); v := 'inserted';`;
  expect(scenario([{ key: 'admin insert on draft', as: U.ADMIN, stmt: INSERT_ROW }]),
    { 'admin insert on draft': NOT_POSTED('draft'), rows: /^ok\|0:$/ });
  expect(scenario([{ key: 'admin insert on posted', as: U.ADMIN, stmt: INSERT_ROW }],
    ownerSet(`UPDATE public.invoices SET status = 'posted', posted_at = now(), posted_by = '${U.ADMIN}' WHERE id = '${invId}';`)),
  { 'admin insert on posted': /^ok\|inserted$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  console.log('[prover] AFTER: an admin\'s direct insert is refused for the draft and allowed for a posted invoice');

  // AFTER: the real posting path still writes its row, once.
  expect(scenario([...POST, { key: 'second call', as: U.REP, call: GEN() }]),
    { post: /^ok\|posted$/, 'second call': /^ok\|0$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  console.log('[prover] AFTER: an admin posts the draft through the real post_invoice and exactly one register row is written; a second call adds none');

  // AFTER: the two other real posting paths still write their row.
  const GROUP = id('6a1');
  expect(scenario([
    { key: 'group post', as: U.ADMIN, stmt: `PERFORM public.post_invoice_group('${GROUP}'::uuid, '${U.ADMIN}'::uuid,
      jsonb_build_object('${invId}', current_setting('prover.gver')), 'ki05-group'); v := (SELECT status FROM public.invoices WHERE id = '${invId}');` },
  ], `${ownerSet(`UPDATE public.invoices SET invoice_group_id = '${GROUP}' WHERE id = '${invId}';`)}
SELECT set_config('prover.gver', public._invoice_post_version('${invId}'), true);`),
  { 'group post': /^ok\|posted$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  expect(scenario([
    { key: 'order state', as: U.ADMIN, stmt: `v := (SELECT status || '/' || (deleted_at IS NOT NULL)::text FROM public.orders WHERE id = '${ORDER}');` },
    { key: 'recovery post', as: U.ADMIN, stmt: `RESET ROLE; PERFORM public._post_deleted_delivery_recovery_invoice_20260719('${invId}'::uuid);
      v := (SELECT status FROM public.invoices WHERE id = '${invId}');` },
  ], `ALTER TABLE public.orders DISABLE TRIGGER USER;
UPDATE public.orders SET deleted_at = now() WHERE id = '${ORDER}';
ALTER TABLE public.orders ENABLE TRIGGER USER;`),
  { 'order state': /^ok\|(fulfilled|partially_fulfilled)\/true$/, 'recovery post': /^ok\|posted$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  console.log('[prover] AFTER: post_invoice_group and the deleted-order recovery post each write exactly one register row');

  // AFTER: direct calls on posted-family invoices with no rows yet, and the idempotent replay.
  for (const status of ['posted', 'paid', 'overdue']) {
    expect(scenario([
      { key: 'admin direct', as: U.ADMIN, call: GEN(`ki05-${status}`) },
      { key: 'replay', as: U.ADMIN, call: GEN(`ki05-${status}`) },
    ], ownerSet(`UPDATE public.invoices SET status = '${status}', posted_at = now(), posted_by = '${U.ADMIN}' WHERE id = '${invId}';`)),
    { 'admin direct': /^ok\|1$/, replay: /^ok\|1$/, rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  }
  console.log('[prover] AFTER: a direct call on a posted, paid or overdue invoice writes its row; the same key replays its receipt');

  // AFTER: a saved key does not replay a cached success once the invoice is no longer posted (Luna round 3).
  expect(scenario([
    { key: 'posted with key', as: U.ADMIN, call: GEN('ki05-reuse') },
    { key: 'back to draft', as: U.ADMIN, stmt: `RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
      UPDATE public.invoices SET status = 'draft' WHERE id = '${invId}'; ALTER TABLE public.invoices ENABLE TRIGGER USER; v := 'draft';` },
    { key: 'reused key on draft', as: U.ADMIN, call: GEN('ki05-reuse') },
  ], ownerSet(`UPDATE public.invoices SET status = 'posted', posted_at = now(), posted_by = '${U.ADMIN}' WHERE id = '${invId}';`)),
  { 'posted with key': /^ok\|1$/, 'back to draft': /^ok\|draft$/, 'reused key on draft': NOT_POSTED('draft'),
    rows: /^ok\|1:compliant\/PROVER-LIC-05\/false$/ });
  console.log('[prover] AFTER: a key saved on a posted invoice is refused, not replayed, once that invoice is a draft');

  console.log('RUP_RECORDS_REQUIRE_POSTED_INVOICE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
