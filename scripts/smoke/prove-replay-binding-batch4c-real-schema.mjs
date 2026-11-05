#!/usr/bin/env node
/**
 * Full-chain proof for the 20261110100000 candidate: the twelve batch 4c functions
 * (submit/cancel/delete_purchase_order, duplicate_quote, edit/reassign/confirm_delivery,
 * batch_reschedule_deliveries, create_delivery_with_items, create_followup_delivery,
 * cancel_cycle_count, reverse_blend_ticket_approval) replay a stored idempotency receipt only for the
 * same person and the exact same request (batch 4c of the replay-binding fix, KNOWN_ISSUES.md KI-10).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers; batches 1 to 4b are replayed, so the commit-time guard
 * is in its 41-operation state, as on live), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its pinned md5;
 *   1. BEFORE: the new chain fails first at step a (submit_purchase_order hands PO 1's receipt back
 *      as success for PO 2), and every covering chain that passes is recorded;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight; PREFLIGHT: a drifted
 *      body, a drifted inner body, a drifted start_and_complete_delivery, an unexpired receipt, an
 *      unreviewed internal caller, an unknown guard list and the pre-4b guard each abort it before
 *      any change (and the live function that only names confirm_delivery in an error message
 *      does not);
 *   3. APPLY (committed): POSTFLIGHT_OK, the guard lists 41 + 12, no API role can run a renamed body,
 *      start_and_complete_delivery calls the renamed confirm body;
 *   4. AFTER: the new chain passes and rolls back (the sequences it moved are reported), every
 *      covering chain that passed BEFORE still passes, and an unbound receipt for any of the twelve
 *      never commits;
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: with each wrapper's target taken out of its fingerprint, its role check removed, or
 *      its key requirement replaced by a keyless pass-through (and duplicate_quote's below-cost
 *      reason put into its fingerprint), the new chain fails at the step that proves it.
 *
 * Run: node scripts/smoke/prove-replay-binding-batch4c-real-schema.mjs   (needs Docker)
 * Prints REPLAY_BINDING_BATCH4C_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-replay-batch4c-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261110100000_bind_money_inventory_replay_receipts_batch4c.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
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
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CHAIN = path.join(SMOKE, 'smoke-replay-binding-batch4c.sql');
const SPECS = path.join(SMOKE, 'smoke-specs.json');
// Every other chain that calls one of the twelve (or start_and_complete_delivery, which calls
// confirm_delivery). Each must keep passing after the candidate if it passed before it (some need
// live data this database lacks; those are reported, not required).
const COVERING_CHAINS = [
  'smoke-adversarial-money-inventory-closeout.sql',
  'smoke-delivery-completion-evidence.sql',
  'smoke-invoice-resave-keeps-cost.sql',
  'smoke-invoice-resave-keeps-line-cents.sql',
  'smoke-order-invoice-cap-delivery-precision.sql',
  'smoke-order-invoice-cap-edited-quick.sql',
  'smoke-order-invoice-cap-split-rounding.sql',
  'smoke-order-invoice-delivered-cap-pipeline.sql',
  'smoke-save-purchase-order-status-lock.sql',
  'smoke-section9-po-ap-high-remediation.sql',
  'smoke-start-and-complete-delivery.sql',
];
// Chains that assert a batch 4c refusal and so fail BEFORE exactly there: none.
const FAILS_BEFORE_AT_BATCH4C = {};
const WRAPPED = ['submit_purchase_order', 'cancel_purchase_order', 'delete_purchase_order', 'duplicate_quote',
  'edit_delivery', 'reassign_delivery', 'batch_reschedule_deliveries', 'confirm_delivery',
  'create_delivery_with_items', 'create_followup_delivery', 'cancel_cycle_count', 'reverse_blend_ticket_approval'];
const IMPLS = WRAPPED.map((n) => `_${n}_replay_impl_20261015`);
const GUARD = 'require_bound_replay_receipt_20261015';
const START_AND_COMPLETE_MD5 = '59a8dc1e372beb2bd443eebaeb83dd95';

const id = (n) => `4c4c0000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1'), DRIVER: id('d1'), APPLICATOR: id('c1') };

// ------------------------------------------------------------------------------------------------
// Container plumbing (the shared real-schema harness).
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
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its own
// stamp: an older file's high-water check compares versions, so only stamps are used.
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
  // Applied live; later migrations carry their own proofs, so replay only up to the candidate (as #1292).
  const before = all.slice(0, at);
  const touched = new RegExp([...WRAPPED, 'idempotency_keys'].join('|'));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
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
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
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

// ------------------------------------------------------------------------------------------------
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
function md5Of(name) {
  return scalar(`SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}';`);
}
function md5OfSig(sig) {
  return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`);
}
// A pinned (name, args, return type, md5) row; the args may contain doubled quotes (the cancel default).
const PIN_RE = /\('([a-z_]+)', '(?:[^']|'')*', '[a-z]+', '([0-9a-f]{32})'\)/g;
function bodyPins() {
  const block = lf(CANDIDATE).split('replay_binding_batch4c_pins ON COMMIT DROP AS')[1].split(') AS pin(')[0];
  return [...block.matchAll(PIN_RE)].map((m) => [m[1], m[2]]);
}
function innerPins() {
  const block = lf(CANDIDATE).split('replay_binding_batch4c_inner_pins ON COMMIT DROP AS')[1].split(') AS pin(')[0];
  return [...block.matchAll(/\('(public\.[a-z_0-9]+\([a-z,]*\))', '([0-9a-f]{32})', (?:true|false), ARRAY/g)].map((m) => [m[1], m[2]]);
}
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const pins = bodyPins();
  assert.deepEqual(pins.map(([n]) => n).sort(), [...WRAPPED].sort(), 'the preflight pins exactly the twelve wrapped bodies');
  for (const [name, pin] of pins) assert.equal(md5Of(name), pin, `${name} replayed with a body that differs from the live pin`);
  const inner = innerPins();
  assert.equal(inner.length, 5, 'the preflight pins the five inner bodies');
  for (const [sig, pin] of inner) assert.equal(md5OfSig(sig), pin, `${sig} replayed with a body that differs from the live pin`);
  const intent = /p\.proname = 'check_idempotency_intent'[\s\S]*?= '([0-9a-f]{32})'/.exec(sql);
  assert.ok(intent, 'the preflight pins check_idempotency_intent');
  assert.equal(md5Of('check_idempotency_intent'), intent[1], 'check_idempotency_intent replayed with a body that differs from the live pin');
  const helpers = [...sql.matchAll(/\('(public\.[a-z_0-9]+\([a-z,]*\))', '([0-9a-f]{32})', (true|false)\)/g)];
  assert.equal(helpers.length, 3, 'the preflight pins the three batch-1 helpers');
  for (const [, sig, pin] of helpers) assert.equal(md5OfSig(sig), pin, `${sig} replayed with a body that differs from the live pin`);
  assert.ok(/'cdef18c69c4f4cbbced2eaf81e628b49'/.test(sql), 'the preflight pins auth.uid()');
  assert.ok(sql.includes(`'${START_AND_COMPLETE_MD5}'`), 'the preflight pins start_and_complete_delivery');
  assert.equal(md5Of('start_and_complete_delivery'), START_AND_COMPLETE_MD5, 'start_and_complete_delivery replayed with a body that differs from the live pin');
  console.log(`[prover] FIDELITY: all ${pins.length + inner.length + helpers.length + 3} pinned bodies (the twelve, ${inner.map(([s]) => s.split('(')[0]).join(', ')}, the batch-1 helpers, check_idempotency_intent, auth.uid(), start_and_complete_delivery) match the pins`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7], [U.DRIVER, 'driver', 'Driver', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'replay-batch4c-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    -- The covering chains pick any active product.
    INSERT INTO public.products (product_name, unit_size, product_form) VALUES ('[PROVER] batch 4c product', 'GL', 'liquid');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '4c4c0000-%';`),
    'admin:true,admin:true,sales_rep:true,driver:true,applicator:true', 'the seeded roles are not what the proof needs');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '', user = 'postgres') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail };
}
function covering(phase, required) {
  const passed = new Set();
  for (const name of COVERING_CHAINS) {
    const r = chain(path.join(SMOKE, name));
    if (r.pass) passed.add(name);
    else if (required?.has(name)) assert.fail(`${phase}: ${name} passed before the candidate and fails after it: ${r.fail}`);
    else if (!required && FAILS_BEFORE_AT_BATCH4C[name]?.test(r.fail)) {
      passed.add(name);
      console.log(`[prover] ${phase}: ${name} fails only at its batch 4c assertion (required after): ${r.fail}`);
    } else console.log(`[prover] ${phase}: ${name} does not pass in this database (not required): ${r.fail}`);
  }
  console.log(`[prover] ${phase}: ${passed.size}/${COVERING_CHAINS.length} covering chains pass (or fail only at batch 4c) and roll back: ${[...passed].join(', ')}`);
  return passed;
}
function sequences() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], {
    input: "SELECT schemaname || '.' || sequencename, COALESCE(last_value::text, 'null') FROM pg_sequences ORDER BY 1;",
  }).stdout.trim().split(/\r?\n/).filter(Boolean);
  return new Map(rows.map((r) => r.split('|')));
}
// A rollback does not return sequence values. Surrogate row-id sequences moving is harmless; a
// document-number sequence (invoice, payment, credit-memo numbers) moving leaves a visible gap on
// live, which is why this chain is CONTAINER ONLY.
function movedSequences(before, after) {
  return [...after.keys()].filter((k) => after.get(k) !== before.get(k));
}
function documentNumberSequences() {
  return new Set(docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT DISTINCT s.schemaname || '.' || s.sequencename
              FROM pg_sequences s
             WHERE s.sequencename ~ '(number|_no|_num)'
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.prosrc ILIKE '%nextval(%' || s.sequencename || '%'
                              AND p.proname ~ '^next_.*_number$')
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.proname ~ '^next_.*_number$'
                              AND p.prosrc ILIKE '%' || s.sequencename || '%');`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}

/** The guard's covered operations, in trigger order. */
function guardOps() {
  const out = scalar(`SELECT 'GUARD_OPS=' || coalesce(string_agg(m[1], ',' ORDER BY ord), '')
      FROM pg_trigger t,
           regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)''::text', 'g') WITH ORDINALITY AS r(m, ord)
     WHERE t.tgrelid = 'public.idempotency_keys'::regclass AND t.tgname = '${GUARD}';`);
  const m = /GUARD_OPS=([a-z_,]*)/.exec(out);
  assert.ok(m, `could not read the guard's operation list: ${out}`);
  return m[1] ? m[1].split(',') : [];
}
function guardArrays() {
  const block = lf(CANDIDATE).split('$guard$')[1];
  const arr = (name) => {
    const m = new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(block);
    assert.ok(m, `the candidate's $guard$ block declares ${name}`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  return { prior: arr('v_prior'), batch4c: arr('v_batch4c') };
}
function recreateGuardSql(ops) {
  return `DROP TRIGGER ${GUARD} ON public.idempotency_keys;
CREATE CONSTRAINT TRIGGER ${GUARD} AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.operation IN (${ops.map((o) => `'${o}'`).join(', ')}))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();`;
}
/** Nothing of the candidate is left behind after a refused apply. */
function assertUntouched(phase, guardBefore) {
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${IMPLS.map((n) => `'${n}'`).join(', ')});`), '0', `${phase}: a refused apply left a renamed body behind`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${WRAPPED.map((n) => `'${n}'`).join(', ')}) AND prosrc LIKE '%check_idempotency_intent%';`), '0', `${phase}: a refused apply left a wrapper behind`);
  for (const [fn, pin] of bodyPins()) assert.equal(md5Of(fn), pin, `${phase}: ${fn} is no longer the pinned body`);
  assert.deepEqual(guardOps(), guardBefore, `${phase}: a refused apply changed the commit-time guard`);
}

/** Insert an unbound receipt for `op` and force the deferred guard to run now. */
function unboundReceipt(op) {
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('prover-unbound-' || gen_random_uuid(), '${op}', '{"success":true}'::jsonb);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'UNBOUND_RECEIPT_ACCEPTED';
ROLLBACK;`,
    allowFailure: true,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  return /UNBOUND_RECEIPT_ACCEPTED/.test(out) ? 'accepted' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-300));
}

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not created by the candidate`);
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(start))[1];
  const a = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const header = sql.slice(start, a).replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf(`${tag};`, a)), tag };
}
function mutate(fn, find, replacement, label) {
  const { header, body, tag } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}${tag};`;
}

/** Run the candidate inside a rolled-back transaction after `prefix`; it must refuse with `expected`. */
function refusedAfter(label, prefix, expected, guardBefore) {
  const r = docker([...psqlArgs()], { input: `BEGIN;\n${prefix}\n\\i /tmp/candidate.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(r.status, 0, `${label}: the candidate applied`);
  assert.match(r.stderr, expected, `${label}: wrong refusal:\n${r.stderr}`);
  assertUntouched(label, guardBefore);
}

// Each wrapper's request fingerprint with its target taken out, the role refusal it raises before
// the replay, and the step the chain fails at without them.
const TARGET_HUNKS = {
  submit_purchase_order: ["'actor_id', v_actor, 'po_id', p_po_id));", "'actor_id', v_actor));", "submit_purchase_order replayed PO 1's receipt as success for PO 2"],
  cancel_purchase_order: ["'actor_id', v_actor, 'po_id', p_po_id, 'reason', p_reason));", "'actor_id', v_actor, 'reason', p_reason));", "cancel_purchase_order replayed PO 3's receipt as success for PO 4"],
  delete_purchase_order: ["'actor_id', v_actor, 'po_id', p_po_id));", "'actor_id', v_actor));", "delete_purchase_order replayed PO 5's receipt as success for PO 6"],
  duplicate_quote: ["'actor_id', v_actor, 'source_quote_id', p_source_quote_id));", "'actor_id', v_actor));", "duplicate_quote replayed quote 1's receipt as success for quote 2"],
  edit_delivery: ["'actor_id', v_actor, 'delivery_id', p_delivery_id,\n", "'actor_id', v_actor,\n", "edit_delivery replayed delivery 1's receipt as success for delivery 2"],
  reassign_delivery: ["'actor_id', v_actor, 'delivery_id', p_delivery_id, 'new_driver'", "'actor_id', v_actor, 'new_driver'", "reassign_delivery replayed delivery 3's receipt as success for delivery 4"],
  batch_reschedule_deliveries: ["    'delivery_ids', (SELECT jsonb_agg(d ORDER BY d) FROM (SELECT DISTINCT unnest(p_delivery_ids) AS d) s),\n", '', "batch_reschedule_deliveries replayed delivery 5's receipt as success for delivery 6"],
  confirm_delivery: ["'actor_id', v_actor, 'delivery_id', p_delivery_id));", "'actor_id', v_actor));", "confirm_delivery replayed delivery 7's receipt as success for delivery 8"],
  create_delivery_with_items: ["'scheduled_date', p_scheduled_date, 'items', p_items,", "'scheduled_date', p_scheduled_date,", "create_delivery_with_items replayed line 1's receipt as success for line 2"],
  create_followup_delivery: ["'actor_id', v_actor, 'original_delivery_id', p_original_delivery_id,\n", "'actor_id', v_actor,\n", "create_followup_delivery replayed delivery 9's receipt as success for delivery 10"],
  cancel_cycle_count: ["'actor_id', v_actor, 'cycle_count_id', p_cycle_count_id));", "'actor_id', v_actor));", "cancel_cycle_count replayed count 1's receipt as success for count 2"],
  reverse_blend_ticket_approval: ["'actor_id', v_actor, 'ticket_id', p_ticket_id, 'reason', p_reason));", "'actor_id', v_actor, 'reason', p_reason));", "reverse_blend_ticket_approval replayed ticket 1's receipt as success for ticket 2"],
};
// confirm_delivery keeps its role check in the body, after its own receipt lookup (as today).
const ROLE_RAISES = {
  submit_purchase_order: "RAISE EXCEPTION 'INSUFFICIENT_ROLE';",
  cancel_purchase_order: "RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can cancel purchase orders';",
  delete_purchase_order: "RAISE EXCEPTION 'Only admins can delete purchase orders';",
  // Two layered role checks run before the replay (the shared below-cost guard, then the
  // implementation's own); the mutation removes both, since either alone refuses the applicator.
  duplicate_quote: [
    '  PERFORM public._begin_below_cost_money_write(',
    "    'duplicate_quote', p_performed_by,",
    "    jsonb_build_object('below_cost_reason', p_below_cost_reason)",
    '  );',
    "  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;",
    '  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN',
    "    RAISE EXCEPTION 'ACTOR_MISMATCH';",
    '  END IF;',
    '  IF NOT EXISTS (',
    '    SELECT 1 FROM public.profiles',
    "    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')",
    '  ) THEN',
    "    RAISE EXCEPTION 'INSUFFICIENT_ROLE';",
    '  END IF;',
  ].join('\n'),
  edit_delivery: "RAISE EXCEPTION 'INSUFFICIENT_ROLE';",
  reassign_delivery: "RAISE EXCEPTION 'Not authorized to reassign deliveries';",
  batch_reschedule_deliveries: "RAISE EXCEPTION 'Not authorized to reschedule deliveries';",
  create_delivery_with_items: "RAISE EXCEPTION 'FORBIDDEN';",
  create_followup_delivery: "RAISE EXCEPTION 'INSUFFICIENT_ROLE';",
  cancel_cycle_count: "RAISE EXCEPTION 'Admin access required to cancel a cycle count';",
  reverse_blend_ticket_approval: "RAISE EXCEPTION 'INSUFFICIENT_ROLE';",
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main() {
  buildContainer();
  fidelity();
  seed();
  const { prior, batch4c } = guardArrays();
  assert.equal(prior.length, 41, 'the candidate lists the 41 operations batches 1 to 4b cover');
  assert.deepEqual(batch4c, WRAPPED, 'the candidate adds exactly the twelve batch 4c operations');
  const guardBefore = guardOps();
  assert.deepEqual(guardBefore, prior, 'the replayed database is not in the batch-1 to 4b guard state');

  // 1. BEFORE.
  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the replay-binding chain passed on the unbound bodies');
  assert.match(before.fail, /SMOKE_FAIL: submit_purchase_order replayed PO 1's receipt as success for PO 2/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step a: ${before.fail}`);
  const passedBefore = covering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /REPLAY_BINDING_BATCH4C_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assertUntouched('AUTOCOMMIT', guardBefore);
  refusedAfter('PREFLIGHT drift',
    `CREATE OR REPLACE FUNCTION public.cancel_cycle_count(p_cycle_count_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;`,
    /PREFLIGHT_REPLAY_BATCH4C_BODY_DRIFT: [^\n]*cancel_cycle_count/, guardBefore);
  refusedAfter('PREFLIGHT inner drift',
    'ALTER FUNCTION public._section9_delete_purchase_order_serialized(uuid, uuid, text) SET search_path = public;',
    /PREFLIGHT_REPLAY_BATCH4C_INNER_DRIFT: [^\n]*_section9_delete_purchase_order_serialized/, guardBefore);
  refusedAfter('PREFLIGHT start_and_complete drift',
    `CREATE OR REPLACE FUNCTION public.start_and_complete_delivery(p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN public.confirm_delivery(p_delivery_id, auth.uid(), NULL); END; $$;`,
    /PREFLIGHT_START_AND_COMPLETE_DRIFT/, guardBefore);
  refusedAfter('PREFLIGHT pending receipt',
    "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-pending-receipt', 'confirm_delivery', '{\"success\":true}'::jsonb);",
    /PREFLIGHT_UNEXPIRED_RECEIPTS/, guardBefore);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-pending-receipt';"), '0', 'PREFLIGHT: the pending receipt fixture was left behind');
  refusedAfter('PREFLIGHT internal caller',
    `CREATE FUNCTION public.prover_calls_cancel_cycle_count(p uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN public."cancel_cycle_count"(p, NULL, NULL); END; $$;`,
    /PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: [^\n]*: public\.prover_calls_cancel_cycle_count/, guardBefore);
  refusedAfter('PREFLIGHT guard drift', recreateGuardSql([...prior, 'allocate_payment']), /PREFLIGHT_RECEIPT_GUARD_DRIFT/, guardBefore);
  refusedAfter('PRE-4B GUARD', recreateGuardSql(prior.slice(0, 38)),
    /PREFLIGHT_RECEIPT_GUARD_DRIFT: [^\n]*is not the batch 1 to 4b trigger/, guardBefore);
  // The replayed body that names confirm_delivery only inside an error message is present and did not refuse it.
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = '_complete_delivery_authorized_impl' AND prosrc ~ 'confirm_delivery';`), '1',
    'the message-only mention is not in the replayed database');
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over a drifted body, inner body or start_and_complete_delivery, with an unexpired receipt, with an unreviewed internal caller, over an unknown guard list, or over the pre-4b guard, the candidate stops and leaves nothing behind');

  // 3. APPLY (committed).
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.deepEqual(guardOps(), [...prior, ...batch4c], 'APPLY: the guard does not list 41 + 12 operations in order');
  for (const api of ['anon', 'authenticated', 'service_role']) {
    for (const impl of IMPLS) {
      assert.equal(scalar(`SELECT has_function_privilege('${api}', (SELECT p.oid FROM pg_proc p WHERE p.proname = '${impl}'), 'EXECUTE');`), 'f', `APPLY: ${api} can run ${impl}`);
    }
    assert.equal(scalar(`SELECT bool_and(has_function_privilege('${api}', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.proname IN (${WRAPPED.map((n) => `'${n}'`).join(', ')});`), api === 'anon' ? 'f' : 't', `APPLY: ${api} has the wrong EXECUTE on the wrappers`);
  }
  assert.equal(scalar(`SELECT prosrc LIKE '%PERFORM public._confirm_delivery_replay_impl_20261015(p_delivery_id, v_actor, NULL);%' AND prosrc NOT LIKE '%public.confirm_delivery(%' FROM pg_proc WHERE proname = 'start_and_complete_delivery';`), 't',
    'APPLY: start_and_complete_delivery does not call the renamed confirm body');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)', 'EXECUTE');"), 't',
    'APPLY: start_and_complete_delivery lost its authenticated grant');
  console.log(`[prover] candidate applied (with the message-only mention present); POSTFLIGHT_OK; the guard lists ${prior.length} + ${batch4c.length} operations; no API role can run the renamed bodies; the wrappers keep authenticated/service_role only; start_and_complete_delivery calls the renamed confirm body`);

  // 4. AFTER.
  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the replay-binding chain failed: ${after.fail}`);
  const moved = movedSequences(seqBefore, sequences());
  const docNumbers = documentNumberSequences();
  assert.ok(docNumbers.size > 0, 'AFTER: no document-number sequence was found to check');
  const movedDoc = moved.filter((s) => docNumbers.has(s));
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs.replay_binding_batch4c;
  assert.ok(spec && spec.chain === path.basename(CHAIN), 'smoke-specs.json has no entry for the chain');
  assert.equal(spec.container_only, true, 'the spec must be marked container_only');
  assert.match(spec.description, /^CONTAINER ONLY/, 'the spec description must start with CONTAINER ONLY');
  console.log(`[prover] AFTER: the chain passes and rolls back; document-number sequences moved: ${movedDoc.join(', ') || 'none'} (${docNumbers.size} checked; CONTAINER ONLY); all sequences moved: ${moved.join(', ') || 'none'}`);
  covering('AFTER', passedBefore);
  for (const op of WRAPPED) {
    assert.match(unboundReceipt(op), /REPLAY_RECEIPT_UNBOUND/, `AFTER: an unbound ${op} receipt was not refused at commit`);
  }
  const autocommit = docker([...psqlArgs()], {
    input: "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-unbound-autocommit', 'confirm_delivery', '{\"success\":true}'::jsonb);",
    allowFailure: true,
  });
  assert.match(autocommit.stderr, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an autocommit unbound confirm_delivery receipt was not refused:\n${autocommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-unbound-autocommit';"), '0', 'AFTER: the refused unbound receipt was committed');
  for (const op of ['void_payment', 'release_inventory_hold', 'void_order', 'transition_rebate_claim', 'price_order', 'mark_inventory_row_verified']) {
    assert.match(unboundReceipt(op), /REPLAY_RECEIPT_UNBOUND/, `AFTER: the guard no longer covers ${op}`);
  }
  console.log('[prover] AFTER: an unbound receipt for any of the twelve never commits (immediate check and an autocommit INSERT), and batch 1 to 4b operations stay covered');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_REPLAY_BATCH4C_BODY_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  assert.deepEqual(guardOps(), [...prior, ...batch4c], 'RE-APPLY: the refused second apply changed the guard');
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION.
  const mutations = [];
  for (const fn of WRAPPED) {
    const [find, replacement, step] = TARGET_HUNKS[fn];
    mutations.push([`${fn} target`, fn, find, replacement, new RegExp(`SMOKE_FAIL: ${esc(step)}`)]);
    if (ROLE_RAISES[fn]) {
      mutations.push([`${fn} role-before-replay`, fn, ROLE_RAISES[fn], 'NULL;',
        new RegExp(`SMOKE_FAIL: wrong refusal \\(${esc(fn)} answered an applicator\\): \\S+ IDEMPOTENCY_ACTOR_MISMATCH`)]);
    }
    const body = candidateBody(fn).body;
    const call = new RegExp(`v_result := (public\\._${fn}_replay_impl_20261015\\([\\s\\S]*?\\));`).exec(body);
    assert.ok(call, `${fn}: the wrapper's call to its renamed body was not found`);
    mutations.push([`${fn} key requirement`, fn,
      `    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: ${fn} requires p_idempotency_key' USING ERRCODE = '22023';\n`,
      `    RETURN ${call[1].replace('p_idempotency_key', 'NULL')};\n`,
      new RegExp(`SMOKE_FAIL: ${esc(fn)} ran without an idempotency key`)]);
  }
  mutations.push(['duplicate_quote reason in fingerprint', 'duplicate_quote',
    "'actor_id', v_actor, 'source_quote_id', p_source_quote_id));",
    "'actor_id', v_actor, 'source_quote_id', p_source_quote_id, 'below_cost_reason', p_below_cost_reason));",
    /SMOKE_FAIL: the exact duplicate_quote \(with an approved reason\) retry was refused: IDEMPOTENCY_INTENT_MISMATCH/]);
  for (const [label, fn, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }
  console.log(`[prover] MUTATION: all ${mutations.length} mutations are caught`);

  console.log('REPLAY_BINDING_BATCH4C_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
