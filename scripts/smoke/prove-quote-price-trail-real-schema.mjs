#!/usr/bin/env node
/**
 * Real-schema proof for 20261101100000_quote_price_trail_and_expiry_grant.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container, replays every ordered post-baseline migration up to the candidate, seeds an admin and a
 * sales rep, then:
 *   1. BEFORE: the chain fails at (A) and (G), both reproduced live on 2026-11-01. The existing quote
 *      chains each record an outcome, and must end the same way after the candidate.
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the candidate stops at its preflight.
 *   3. MUTATIONS: the candidate with one safeguard removed (and its postflight dropped so the chain,
 *      not the postflight, has to notice) runs in a transaction that never commits.
 *   4. The candidate applies; a second apply is refused by its preflight.
 *   5. AFTER: the chain passes, the existing chains end as they did, and the sweep predicate
 *      quote-price-lock-boundary returns no rows. Its body pin is what this replay produces.
 *   6. SWEEP: each thing that predicate watches is broken in a rolled-back transaction, and it reports.
 *
 * smoke-quote-sent-price-lock.sql stops at its first step here and on main: it still expects
 * today + 15 from before #1201. It is held to that same outcome, so it covers nothing past V1.
 *
 * Run: node scripts/smoke/prove-quote-price-trail-real-schema.mjs   (needs Docker)
 * Prints QUOTE_PRICE_TRAIL_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionContractSql } from '../../.claude/hooks/live-testdata-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-quote-trail-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const ALLOWLIST = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'allowlist.json');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'quote-price-lock-boundary.sql');
const CANDIDATE = path.join(MIGRATIONS, '20261101100000_quote_price_trail_and_expiry_grant.sql');
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
// A later or parked file that (re)defines anything the candidate re-emits or relies on.
const TOUCHED = /_save_quote_below_cost_impl_20260810|_assert_quote_prices_as_sent|quote_price_changes/;
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const CHAIN = 'smoke-quote-price-trail-and-expiry.sql';
// Existing chains over the two re-emitted functions and the expiry.
const REGRESSION = [
  'smoke-quote-sent-price-lock.sql',
  'smoke-convert-sent-quote-in-one-step.sql',
  'smoke-save-quote-repeated-product-line-ids.sql',
  'smoke-quote-version-restore-trust.sql',
  'smoke-quote-version-write-boundary.sql',
  'smoke-save-quote-drawn-guard.sql',
  'smoke-save-quote-customer-row-version.sql',
  'smoke-quotes-rep-own-name.sql',
];
// Each safeguard removed in turn, and the step that must notice.
const MUTATIONS = [
  ['check ties a row to the last send', `                 WHERE c.quote_id = p_quote_id
                   AND c.quote_item_id = qi.id AND c.product_id = qi.product_id
                   AND c.sent_version = v_version_number
                 ORDER BY`, `                 WHERE c.quote_id = p_quote_id
                   AND c.quote_item_id = qi.id AND c.product_id = qi.product_id
                 ORDER BY`, '(L) Convert accepted a row from before the last send'],
  ['a price above the sent one needs a tick', `                ROUND(qi.price_per_unit * 100) <= ROUND((i.item->>'price_per_unit')::numeric * 100)
                OR EXISTS (`, `                true
                OR EXISTS (`, '(I) Convert billed above the last sent price'],
  ['a later cut keeps the tick it follows', 'AND c.new_price_cents >= ROUND(qi.price_per_unit * 100))', 'AND c.new_price_cents = ROUND(qi.price_per_unit * 100))', 'QUOTE_RESEND_REQUIRED'],
  ['save names the send', '        (SELECT max(version_number) FROM quote_versions WHERE quote_id = v_quote_id));', '        NULL);', 'SMOKE_FAIL: (B) the trail row does not name V1'],
  ['browser cannot write the expiry', 'REVOKE INSERT (expires_at), UPDATE (expires_at) ON public.quotes FROM anon, authenticated;\n', '', '(G) the owning rep set expires_at directly'],
  ['insert is revoked too', 'REVOKE INSERT (expires_at), UPDATE (expires_at)', 'REVOKE UPDATE (expires_at)', '(G) the rep inserted a quote with its own expires_at'],
];
// Each thing the sweep watches broken in turn (rolled back), and the violation that must appear.
const ASSERT_FN = 'public._assert_quote_prices_as_sent(uuid)';
const SWEEP_MUTATIONS = [
  ['GRANT UPDATE (expires_at) ON public.quotes TO authenticated;', 'quotes.expires_at:browser-write-privilege'],
  ['GRANT INSERT (expires_at) ON public.quotes TO anon;', 'quotes.expires_at:browser-write-privilege'],
  ['GRANT INSERT ON public.quote_price_changes TO authenticated;', 'quote_price_changes:browser-write-privilege'],
  ['GRANT UPDATE (new_price_cents) ON public.quote_price_changes TO authenticated;', 'quote_price_changes:browser-write-privilege'],
  ['GRANT SELECT ON public.quote_price_changes TO anon;', 'quote_price_changes:browser-write-privilege'],
  ['ALTER TABLE public.quote_price_changes DISABLE ROW LEVEL SECURITY;', 'quote_price_changes:rls-off'],
  ['CREATE POLICY sweep_probe ON public.quote_price_changes FOR INSERT TO authenticated WITH CHECK (true);', 'quote_price_changes:external-mutation-policy'],
  ['DROP POLICY quote_price_changes_select ON public.quote_price_changes;', 'quote_price_changes:read-path-regressed'],
  ['ALTER POLICY quote_price_changes_select ON public.quote_price_changes USING (true);', 'quote_price_changes:read-path-regressed'],
  ['REVOKE SELECT ON public.quote_price_changes FROM authenticated;', 'quote_price_changes:read-path-regressed'],
  ['CREATE FUNCTION public.sweep_probe() RETURNS void LANGUAGE sql AS $f$ DELETE FROM public.quote_price_changes $f$;', 'quote_price_changes:foreign-reference:'],
  ["CREATE SCHEMA sweep_probe; CREATE FUNCTION sweep_probe.f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'TRUNCATE TABLE quote_price_changes'; END $f$;", 'quote_price_changes:foreign-reference:'],
  ['CREATE FUNCTION public._assert_quote_prices_as_sent(uuid, text) RETURNS void LANGUAGE sql AS $f$ SELECT $f$;', '_assert_quote_prices_as_sent:overload-count'],
  [`ALTER FUNCTION ${ASSERT_FN} SECURITY DEFINER;`, '_assert_quote_prices_as_sent:shape'],
  [`ALTER FUNCTION ${ASSERT_FN} RESET search_path;`, '_assert_quote_prices_as_sent:shape'],
  [`GRANT EXECUTE ON FUNCTION ${ASSERT_FN} TO authenticated;`, '_assert_quote_prices_as_sent:external-execute'],
  [`GRANT EXECUTE ON FUNCTION ${ASSERT_FN} TO service_role;`, '_assert_quote_prices_as_sent:external-execute'],
  [`UPDATE pg_proc SET prosrc = replace(prosrc, 'AND c.sent_version = v_version_number', '') WHERE oid = '${ASSERT_FN}'::regprocedure;`, '_assert_quote_prices_as_sent:body-pinned'],
  ...[['_save_quote_below_cost_impl_20260810', 'v_quote_id'], ['_convert_quote_to_order_below_cost_impl_20260810', 'p_quote_id'],
    ['_draw_down_quote_intent_impl_20260819', 'p_quote_id'], ['create_job_from_quote_section', 'p_quote_id']].map(([fn, arg]) => [
    `UPDATE pg_proc SET prosrc = replace(prosrc, 'PERFORM public._assert_quote_prices_as_sent(${arg});', 'NULL;') WHERE proname = '${fn}';`,
    `_assert_quote_prices_as_sent:caller-lost:public.${fn}(`]),
  ["UPDATE pg_proc SET prosrc = replace(prosrc, 'PERFORM public._assert_quote_prices_as_sent(p_quote_id);', '/* PERFORM public._assert_quote_prices_as_sent(p_quote_id); */') WHERE proname = 'create_job_from_quote_section';", '_assert_quote_prices_as_sent:caller-lost:public.create_job_from_quote_section('],
];
const USERS = {
  ADMIN: '7c600000-0000-4000-8000-0000000000a1',
  REP: '7c600000-0000-4000-8000-0000000000b1',
  OTHER_REP: '7c600000-0000-4000-8000-0000000000b2',
  DRIVER: '7c600000-0000-4000-8000-0000000000d1',
};

function seed() {
  // handle_new_user takes the role and name from the metadata only for a direct postgres session.
  const users = [[USERS.ADMIN, 'admin', 'Admin', 9], [USERS.REP, 'sales_rep', 'Rep', 8],
    [USERS.OTHER_REP, 'sales_rep', 'Other Rep', 7], [USERS.DRIVER, 'driver', 'Driver', 6]];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ${users.map(([u, role, label]) => `('${u}', 'quote-trail-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] Quote Trail ${label}","role":"${role}"}'::jsonb)`).join(',\n    ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}`);
  assert.equal(scalar("SELECT string_agg(role || ',' || is_active, ';' ORDER BY created_at) FROM public.profiles;"),
    'admin,true;sales_rep,true;sales_rep,true;driver,true', 'the seeded profiles are not the expected active users');
  // A product with a cost and a sent quote of it, for the chains that look for existing data.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${USERS.ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${USERS.ADMIN}', true);
    INSERT INTO public.customers (farm_name, is_active) VALUES ('[PROVER] Quote Trail Farm', true);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price, tier1_margin, product_form, is_active)
      VALUES ('[PROVER] Quote Trail Chem', 'gal', 5.00, 6.25, 20, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    DO $seed$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.save_quote(NULL, jsonb_build_object(
          'quote_number', 'PROVER-QT-1', 'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
          'customer_id', (SELECT id FROM public.customers WHERE farm_name = '[PROVER] Quote Trail Farm')),
        jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(
          jsonb_build_object('product_id', (SELECT id FROM public.products WHERE product_name = '[PROVER] Quote Trail Chem'),
            'sort_order', 0, 'calc_mode', 'units_direct', 'total_units_needed', 2, 'unit_size', 'gal')))),
        '${USERS.ADMIN}', 'prover-qt-seed-save');
      PERFORM public.create_quote_version((v_res->>'quote_id')::uuid, '${USERS.ADMIN}', 'presented',
        'prover-qt-seed-present', (v_res->>'row_version')::bigint);
    END
    $seed$;
    COMMIT;`);
  assert.equal(scalar("SELECT status FROM public.quotes WHERE quote_number = 'PROVER-QT-1';"), 'sent', 'the seeded quote is not sent');
}
// What the sweep predicate reports, after an optional change that is always rolled back.
function sweep(setup = '') {
  return docker([...psqlArgs('supabase_admin'), '-A', '-t'],
    { input: `BEGIN;\n${setup}\n${lf(PREDICATE).trimEnd().replace(/;$/, '')};\nROLLBACK;\n` }).stdout.trim();
}
// One rolled-back chain, optionally after the (possibly mutated) candidate inside the same
// never-committed transaction. Returns the first error line psql printed.
function runChain(file, prefix = '') {
  const name = `chain-${path.basename(file)}`;
  stageText(name, `${prefix}${lf(path.join(SMOKE, file))}`);
  const r = docker([...psqlArgs(), '-f', `/tmp/${name}`], { allowFailure: true });
  const output = `${r.stdout}\n${r.stderr}`;
  return output.split(/\r?\n/).find((line) => /ERROR:/.test(line)) ?? `NO ERROR (exit ${r.status}):\n${output.trim()}`;
}
// Comparable outcome of a regression chain: PASS, or its error with ids and random suffixes masked.
function outcome(line) {
  if (line.includes('SMOKE_PASS_ROLLBACK')) return 'PASS';
  return line.replace(/^psql:[^:]+:\d+: /, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b[0-9a-f]{8}\b/g, '<suffix>');
}
function withoutPostflight(text) {
  const at = text.indexOf('DO $postflight$');
  assert.ok(at > 0, 'the candidate has no postflight block');
  return text.slice(0, at);
}
const NOT_APPLIED = "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.quote_price_changes'::regclass AND attname = 'sent_version' AND NOT attisdropped;";

try {
  buildContainer();
  seed();
  const candidate = lf(CANDIDATE);

  // 1. BEFORE.
  const before = runChain(CHAIN);
  assert.ok(before.includes('(A) Convert billed') && before.includes('(G) the owning rep set expires_at directly'),
    `BEFORE: the chain should report both gaps, got: ${before}`);
  console.log(`[prover] BEFORE ${CHAIN}: ${before.replace(/^.*ERROR:\s*/, '')}`);
  // This replay reproduces live's digest of the save implementation (read 2026-11-01), so the digest
  // it gives after the candidate is the one live will show after the apply.
  const SAVE_KEY = 'public._save_quote_below_cost_impl_20260810(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text)';
  const contract = () => scalar('SELECT contract_md5 FROM (' + functionContractSql([SAVE_KEY]) + ') c;');
  assert.equal(contract(), '66cf2c6986dbe03ae94c2dbf6ba3e46f', 'the replay does not reproduce the live save implementation digest');
  console.log('[prover] FIDELITY: the replay reproduces the live save implementation digest');
  const expected = new Map();
  for (const chain of REGRESSION) {
    expected.set(chain, outcome(runChain(chain)));
    assert.ok(!expected.get(chain).includes('SMOKE_SETUP'), `BEFORE: ${chain} never ran, so it proves nothing: ${expected.get(chain)}`);
    console.log(`[prover] BEFORE ${chain}: ${expected.get(chain)}`);
  }

  // 2. AUTOCOMMIT: statement by statement, the preflight stops the file before any change.
  stageText('candidate.sql', candidate);
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.match(`${auto.stdout}\n${auto.stderr}`, /QUOTE_PRICE_TRAIL_NOT_IN_TRANSACTION/, 'autocommit run was not refused');
  assert.equal(scalar(NOT_APPLIED), '0', 'autocommit run changed the database');
  console.log('[prover] AUTOCOMMIT: refused at the preflight, nothing changed');

  // 3. MUTATIONS.
  const mutationBase = withoutPostflight(candidate);
  for (const [label, find, replace, want] of MUTATIONS) {
    assert.equal(mutationBase.split(find).length - 1, 1, `mutation "${label}": anchor not found exactly once`);
    const line = runChain(CHAIN, `BEGIN;\n${mutationBase.replace(find, () => replace)}\n`);
    assert.ok(line.includes(want), `mutation "${label}" was not caught (${want}); got: ${line}`);
    console.log(`[prover] MUTATION ${label}: caught (${want})`);
  }
  assert.equal(scalar(NOT_APPLIED), '0', 'a mutation run committed');

  // 4. The candidate applies; a second apply is refused by its own preflight.
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `the candidate failed to apply:\n${applied.output}`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply succeeded');
  assert.match(again.output, /PREFLIGHT/, `a second apply failed outside the preflight:\n${again.output}`);
  console.log('[prover] APPLY: applied; re-apply refused by the preflight');

  // 5. AFTER.
  const after = runChain(CHAIN);
  assert.ok(after.includes('SMOKE_PASS_ROLLBACK'), `AFTER: the chain did not pass: ${after}`);
  console.log(`[prover] AFTER ${CHAIN}: ${after.replace(/^.*ERROR:\s*/, '')}`);
  for (const chain of REGRESSION) {
    const result = outcome(runChain(chain));
    assert.equal(result, expected.get(chain), `AFTER: ${chain} changed from "${expected.get(chain)}" to "${result}"`);
    console.log(`[prover] AFTER ${chain}: unchanged (${result})`);
  }
  const rows = sweep();
  assert.equal(rows, '', `the sweep predicate reported violations:\n${rows}`);
  console.log('[prover] AFTER quote-price-lock-boundary: no rows');
  // The save_quote exception pins this body, so a re-emit that forgets the pin fails here.
  const pinned = JSON.parse(lf(ALLOWLIST)).entries.flatMap((e) => Object.entries(e.reviewed_contracts ?? {})).filter(([k]) => k === SAVE_KEY);
  const live = contract();
  assert.ok(pinned.length > 0 && pinned.every(([, d]) => d === live), `allowlist pin for the save implementation is stale: want ${live}`);
  console.log(`[prover] AFTER allowlist pin matches the replayed save implementation (${live})`);
  // 6. The sweep's silence means something: each break is reported, and only under its own key.
  for (const [setup, key] of SWEEP_MUTATIONS) {
    const reported = sweep(setup);
    assert.ok(reported.includes(key), `the sweep missed "${setup}" (${key}); got:\n${reported}`);
    console.log(`[prover] SWEEP caught: ${key}`);
  }
  assert.equal(sweep(), '', 'a sweep mutation was not rolled back');
  console.log('QUOTE_PRICE_TRAIL_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}
