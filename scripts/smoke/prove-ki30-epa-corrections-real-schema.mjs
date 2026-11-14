#!/usr/bin/env node
/**
 * Real-schema proof for 20261214100000_ki30_epa_registration_corrections (KI-30, data only).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container, replays every post-baseline migration before the candidate, seeds the 48 products
 * with the stored numbers live had on 2026-11-08, then applies the candidate with every live trigger on.
 *
 * Run: node scripts/smoke/prove-ki30-epa-corrections-real-schema.mjs   (needs Docker)
 * Prints KI30_EPA_CORRECTIONS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki30epa-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261214100000_ki30_epa_registration_corrections.sql');
const FOLLOW_UPS = []; // the check-only follow-up was dropped (Mason, 2026-11-09)
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
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
const TOUCHED = /(epa_registration|product_change_history|ki30)/i;
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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f) && !LATER_READ_ONLY.has(path.basename(f)))) {
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// The reviewed list, read back from the candidate itself so the proof and the migration cannot drift.
function targets() {
  const rows = [...lf(CANDIDATE).matchAll(/\('([0-9a-f-]{36})'::uuid, '([^']*)', '([^']*)', '([^']*)'\)/g)]
    .map(([, pid, name, old, neu]) => ({ pid, name, old, neu }));
  assert.equal(rows.length, 48, 'the candidate must list 48 products');
  return rows;
}
const CONTROL = '7a7e4000-0000-4000-8000-0000000000c1';
const PARKED_ID = '7a7e4000-0000-4000-8000-0000000000d1';
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });

function seed(rows) {
  // Blank numbers are seeded both ways live stores them: NULL and empty text.
  let blank = 0;
  const values = rows.map((r, i) => {
    const stored = r.old === '' ? ((blank++ % 2) ? "''" : 'NULL') : q(r.old);
    return `('${r.pid}', ${q(r.name)}, 'KI30-${i}', 'liquid', 'Gal', 'Herbicide', ${stored}, 10.00, 15.00, true)`;
  });
  values.push(`('${CONTROL}', '[PROVER] Control', 'KI30-C', 'liquid', 'Gal', 'Herbicide', '524-475', 10.00, 15.00, true)`);
  raw(`INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid' WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'Gal');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active) VALUES
      ${values.join(',\n      ')};
    UPDATE public.products SET updated_at = '2026-01-01' WHERE sku LIKE 'KI30-%';`);
  console.log(`[prover] seeded the 48 listed products as live stores them (${blank} blank) and one control product`);
}
const snapshot = () => scalar(`SELECT md5(string_agg(id || ':' || product_name || ':' || coalesce(epa_registration, '<null>') || ':' || updated_at, ',' ORDER BY id))
  || '|' || (SELECT count(*) FROM public.product_change_history) FROM public.products WHERE sku LIKE 'KI30-%';`);
function refusedApply(pattern) {
  const before = snapshot();
  const r = apply('cand.sql');
  assert.notEqual(r.status, 0, `expected a refusal:\n${r.output}`);
  assert.match(r.output, pattern);
  assert.equal(snapshot(), before, 'a refused apply changed something');
}

async function main() {
  const rows = targets();
  buildContainer();
  seed(rows);
  stageText('cand.sql', lf(CANDIDATE));
  const pick = rows.find((r) => r.old !== '');

  // 1. A product whose number changed since the review stops the whole migration; nothing changes.
  raw(`UPDATE public.products SET epa_registration = '100-1' WHERE id = '${pick.pid}';`);
  refusedApply(new RegExp(`KI30_ROW_MOVED[^\\n]*${pick.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  raw(`UPDATE public.products SET epa_registration = ${q(pick.old)} WHERE id = '${pick.pid}';`);
  console.log('[prover] case 1: a changed stored number refuses the whole migration and changes nothing');

  // 2. A renamed product refuses.
  raw(`UPDATE public.products SET product_name = 'Renamed' WHERE id = '${pick.pid}';`);
  refusedApply(/KI30_ROW_MOVED/);
  raw(`UPDATE public.products SET product_name = ${q(pick.name)} WHERE id = '${pick.pid}';`);
  console.log('[prover] case 2: a renamed product refuses');

  // 3. A missing product refuses.
  const gone = rows.at(-1);
  raw(`UPDATE public.products SET id = '${PARKED_ID}' WHERE id = '${gone.pid}';`);
  refusedApply(/KI30_ROW_MOVED/);
  raw(`UPDATE public.products SET id = '${gone.pid}' WHERE id = '${PARKED_ID}';`);
  console.log('[prover] case 3: a missing product refuses');

  // 3b. The stored number must match exactly: the same number with stray spaces refuses.
  raw(`UPDATE public.products SET epa_registration = ${q(` ${pick.old} `)} WHERE id = '${pick.pid}';`);
  refusedApply(/KI30_ROW_MOVED/);
  raw(`UPDATE public.products SET epa_registration = ${q(pick.old)} WHERE id = '${pick.pid}';`);
  console.log('[prover] case 3b: a padded stored number refuses');

  // 3c. History that would start showing the new number stops it: a posted invoice line, a job line,
  // a frozen job EPA copy or a spray-record lot on any listed product.
  const CUST = '7a7e4000-0000-4000-8000-0000000000e1';
  const INV = '7a7e4000-0000-4000-8000-0000000000e2';
  const JOB = '7a7e4000-0000-4000-8000-0000000000e3';
  raw(`INSERT INTO public.invoices (id, invoice_number, customer_id, status, created_by, posted_at) VALUES ('${INV}', 'KI30-INV', '${CUST}', 'posted', '${CUST}', now());
    INSERT INTO public.invoice_items (invoice_id, product_id) VALUES ('${INV}', '${pick.pid}');`);
  refusedApply(new RegExp(`KI30_HISTORY_EXISTS[^\\n]*${pick.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  raw(`UPDATE public.invoices SET status = 'draft', posted_at = NULL WHERE id = '${INV}';`);
  const draftOnly = snapshot();
  raw(`INSERT INTO public.jobs (id, job_number, customer_id, job_date) VALUES ('${JOB}', 'KI30-J', '${CUST}', '2026-11-08');
    INSERT INTO public.job_chemicals (job_id, product_id) VALUES ('${JOB}', '${pick.pid}');`);
  refusedApply(/KI30_HISTORY_EXISTS/);
  raw(`DELETE FROM public.job_chemicals WHERE job_id = '${JOB}'; DELETE FROM public.jobs WHERE id = '${JOB}';`);
  raw(`INSERT INTO public.job_product_epa (job_id, product_id) VALUES ('${JOB}', '${pick.pid}');`);
  refusedApply(/KI30_HISTORY_EXISTS/);
  raw(`DELETE FROM public.job_product_epa WHERE job_id = '${JOB}';
    INSERT INTO public.application_record_lots (application_record_id, product_id, lot_number) VALUES ('${JOB}', '${pick.pid}', 'KI30-LOT');`);
  refusedApply(/KI30_HISTORY_EXISTS/);
  raw(`DELETE FROM public.application_record_lots WHERE lot_number = 'KI30-LOT';`);
  assert.equal(snapshot(), draftOnly);
  console.log('[prover] case 3c: a posted invoice line, job line, job EPA copy or spray-record lot on a listed product refuses; a draft invoice line does not block');

  // 3e. A listed product tied to a family any way (fill source of a member, or the family's cost reference) refuses.
  const FAM = '7a7e4000-0000-4000-8000-0000000000f1';
  raw(`INSERT INTO public.product_parents (id, name, product_form, created_by, updated_by) VALUES ('${FAM}', 'KI30 family', 'liquid', '${CUST}', '${CUST}');
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role, fill_source_product_id) VALUES ('${CONTROL}', '${FAM}', '${CUST}', 'fixed_tote', '${pick.pid}');`);
  refusedApply(new RegExp(`KI30_ROW_MOVED[^\\n]*${pick.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  raw(`DELETE FROM public.product_parent_members WHERE parent_id = '${FAM}';
    INSERT INTO public.product_parent_cost_reference (parent_id, reference_product_id, set_by) VALUES ('${FAM}', '${pick.pid}', '${CUST}');`);
  refusedApply(/KI30_ROW_MOVED/);
  raw(`DELETE FROM public.product_parent_cost_reference WHERE parent_id = '${FAM}'; DELETE FROM public.product_parents WHERE id = '${FAM}';`);
  assert.equal(snapshot(), draftOnly);
  console.log('[prover] case 3e: a listed product used as a family fill source or cost reference refuses');

  // 3f. While the migration runs (held open before commit), the draft invoice on a listed product cannot be
  // posted and job_product_epa cannot be written: both wait on its locks.
  const runner = spawn('docker', [...psqlArgs(), '-c', 'BEGIN', '-f', '/tmp/cand.sql', '-c', 'SELECT pg_sleep(25)', '-c', 'ROLLBACK'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80 && scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(25)%' AND state = 'active' AND pid <> pg_backend_pid();") !== '1'; i += 1) wait(250);
    const post = psql(`SET lock_timeout = '2s'; UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV}';`, { allowFailure: true });
    assert.match(`${post.stdout}\n${post.stderr}`, /lock timeout/, 'posting the draft invoice did not wait');
    const epa = psql("SET lock_timeout = '2s'; BEGIN; LOCK TABLE public.job_product_epa IN ROW EXCLUSIVE MODE; ROLLBACK;", { allowFailure: true });
    assert.match(`${epa.stdout}\n${epa.stderr}`, /lock timeout/, 'a job_product_epa write did not wait');
  } finally {
    psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(25)%' AND pid <> pg_backend_pid();", { allowFailure: true });
    runner.kill();
  }
  assert.equal(scalar(`SELECT status FROM public.invoices WHERE id = '${INV}';`), 'draft');
  assert.equal(snapshot(), draftOnly);
  console.log('[prover] case 3f: during the run, posting a draft invoice on a listed product and job EPA writes wait');

  // 3d. The 10-second lock limit holds even when the file runs outside a transaction (no psql -1).
  const holder = spawn('docker', [...psqlArgs(), '-c',
    `BEGIN; SELECT 1 FROM public.products WHERE id = '${pick.pid}' FOR UPDATE; SELECT pg_sleep(60); COMMIT;`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(60)%' AND state = 'active' AND pid <> pg_backend_pid();") !== '1'; i += 1) wait(250);
    const before = snapshot();
    const started = Date.now();
    const r = docker([...psqlArgs(), '-f', '/tmp/cand.sql'], { allowFailure: true });
    const took = Date.now() - started;
    assert.notEqual(r.status, 0, 'expected a lock timeout');
    assert.match(`${r.stdout}\n${r.stderr}`, /lock timeout/);
    assert.ok(took >= 9000 && took < 30000, `lock wait took ${took} ms`);
    assert.equal(snapshot(), before);
  } finally {
    psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(60)%' AND pid <> pg_backend_pid();", { allowFailure: true });
    holder.kill();
  }
  console.log('[prover] case 3d: run outside a transaction, a held row lock stops it after 10 seconds and changes nothing');

  // 4. The real apply with every live trigger on: all 48 change, each logged once, nothing else moves.
  assert.equal(snapshot().split('|')[1], scalar('SELECT count(*) FROM public.product_change_history;'));
  const historyBefore = Number(scalar('SELECT count(*) FROM public.product_change_history;'));
  const r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  for (const row of rows) {
    assert.equal(scalar(`SELECT epa_registration || '|' || (updated_at > '2026-01-02') FROM public.products WHERE id = '${row.pid}';`), `${row.neu}|true`, row.name);
    assert.equal(scalar(`SELECT count(*) || '|' || coalesce(old_value, '<null>') || '|' || new_value || '|' || change_type
        FROM public.product_change_history WHERE product_id = '${row.pid}' AND field_name = 'epa_registration'
       GROUP BY old_value, new_value, change_type;`),
      `1|${row.old === '' ? '<null>' : row.old}|${row.neu}|updated`, `${row.name} history`);
  }
  assert.equal(Number(scalar('SELECT count(*) FROM public.product_change_history;')) - historyBefore, 48, 'one history row per product, no other field logged');
  assert.equal(scalar(`SELECT epa_registration || '|' || updated_at::date FROM public.products WHERE id = '${CONTROL}';`), '524-475|2026-01-01', 'control product untouched');
  assert.equal(scalar("SELECT count(*) FROM pg_class WHERE relname = 'ki30_epa_fix';"), '0', 'the work table is gone');
  console.log('[prover] case 4: all 48 numbers set, 48 change-history rows with old and new, control product untouched');

  // 5. Running it again refuses and changes nothing.
  refusedApply(/KI30_ROW_MOVED/);
  console.log('[prover] case 5: a second run refuses and changes nothing');

  console.log('KI30_EPA_CORRECTIONS_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
