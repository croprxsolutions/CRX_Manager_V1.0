#!/usr/bin/env node
/**
 * Real-schema proof for 20261231230000_unit_spellings_remap (RT-2 step 1, data only).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds live's 14 unit_conversions rows, the 20
 * listed products (live ids, names, forms and units; made-up prices) and five control products (two of them the
 * dry oz-rate products that wait for step 2), puts 18 of the 20 into one-size product families as live has them
 * (family ids, names and rate units read back from the candidate's pinned family list), then proves
 * (build sheet docs/plans/2026-11-09-product-RT2-BUILD-SHEET.md section 6, step-1 cases):
 *   U7  rate lock on: refused, nothing changed.        U8  an unlisted LB product: refused.
 *   U9  a listed product moved to another family, a second size in a pinned family, a fill-source link, a family
 *       on Qt, or Imazuron no longer matching its family: refused.   Drift: a moved row or unit row: refused.
 *   U10b a product save holding an Oz insert open: the migration waits for it, then refuses.
 *   Apply: exactly the 20 rows move, history records each, pricing_version +1 on the one rate row only,
 *          every price column of every product unchanged, the setup guard is enabled again (U13); the Imazuron
 *          family moves LB -> Lb (version +1), every other family is unchanged, the family-values guard is on
 *          again and still refuses a size-only rate unit change.
 *   Inventory: old-spelling snapshots of the stock products move with them (pinned count; any other count
 *          refuses) and recovery moves them back.
 *   U1  three quotes (tier 1-3) saved through save_quote with every fixture product: identical lines
 *       before, after, after recovery and after re-apply; a line still sent with an old spelling prices the same.
 *   U2  an ordinary edit of every fixture product saves; new products in oz, qt and Lb save.
 *   U5/U6 per-acre prices and the bodies of the functions that read unit_conversions unchanged.
 *   U15 the recovery script restores every unit column exactly; re-apply works; a second run is refused.
 * Not covered here: the net-weight refusal (same query as the family refusal) and the lock-timeout
 * path; step 2's cases (U4, U10-U12, U12b, U14) belong to step 2's PR.
 *
 * Run: node scripts/smoke/prove-unit-spellings-real-schema.mjs   (needs Docker)
 * Prints UNIT_SPELLINGS_STEP1_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-rt2a-units-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261231230000_unit_spellings_remap.sql');
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
  // KI-01 part C and its KI-73 follow-up need live's storage.objects policies, which this database does not have
  // (same approach as prove-document-restore-photo-uploader-real-schema.mjs); neither touches units or products.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(unit_conversions|validate_product_units|guard_product_setup_fields|unit_spellings)/i;
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
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
    // Other one-shot data migrations rewrite live rows this database does not have: ledger only, as live has them.
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    // RT-1's preflight pins live's unit factors; give it live's 14 unit rows (seed() re-seeds the same rows).
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${unitRows().join(', ')};`);
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

const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'rt2a-unit-spellings-remap-reverse.sql');
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ADMIN = '7a7e5000-0000-4000-8000-0000000000a1';
const FAM = '7a7e5000-0000-4000-8000-0000000000f1';
const FIXTURE = "sku LIKE 'RT2A-%'";

// The reviewed map and unit rows, read back from the candidate itself so the proof and the migration cannot drift.
function listed() {
  const rows = [...lf(CANDIDATE).matchAll(/\('([0-9a-f-]{36})'::uuid, '([^']*)', '(liquid|dry)', '(stock|rate)', '([^']*)', '([^']*)'\)/g)]
    .map(([, id, name, form, kind, old, neu]) => ({ id, name, form, kind, old, neu }));
  assert.equal(rows.length, 20, 'the candidate must list 20 products');
  return rows;
}
function unitRows() {
  const rows = [...lf(CANDIDATE).matchAll(/\('([0-9a-f-]{36})', '([^']*)', ([0-9.]+), '(liquid|dry|both)', '([^']*)'\)/g)];
  assert.equal(rows.length, 14, 'the candidate must pin 14 unit rows');
  return rows.map(([, id, unit, f, t, n]) => `('${id}'::uuid, ${q(unit)}, ${f}, '${t}', ${q(n)})`);
}
// The pinned family of each listed product (Milestone has none); other is the family's one other size, if any.
function families() {
  const rows = [...lf(CANDIDATE).matchAll(/\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid, '([^']*)', '([^']*)', (?:NULL|'([0-9a-f-]{36})'::uuid)\)/g)]
    .map(([, product, parent, name, unit, other]) => ({ product, parent, name, unit, other }));
  assert.equal(rows.length, 19, 'the candidate must pin 19 families');
  return rows;
}
const parents = () => scalar(`SELECT md5(string_agg(to_jsonb(pp)::text, ',' ORDER BY pp.id)) FROM public.product_parents pp;`);
const CONTROLS = [
  { id: '7a7e5000-0000-4000-8000-0000000000c1', name: '[PROVER] Gal per qt', form: 'liquid', inv: 'Gal', rate: 'qt', per: 2 },
  { id: '7a7e5000-0000-4000-8000-0000000000c2', name: '[PROVER] Lb per Lb', form: 'dry', inv: 'Lb', rate: 'Lb', per: 1.5 },
  { id: '7a7e5000-0000-4000-8000-0000000000c3', name: '[PROVER] Gal per Pt', form: 'liquid', inv: 'Gal', rate: 'Pt', per: 0.75 },
  // Sol round 10 HIGH: the two dry products on a liquid "oz" rate stay as they are until step 2's watchdog fix.
  { id: '61ac0e28-bdbe-4197-a764-93aa33bf036a', name: 'Autumn Super 51 WDG', form: 'dry', inv: 'Dry oz', rate: 'oz', per: 0.5 },
  { id: '1ec38578-6eaa-4cff-acd5-0ee0ec8dceda', name: 'Cimarron Plus - 10 oz', form: 'dry', inv: 'Dry oz', rate: 'oz', per: 0.25 },
  // Prevent Foam's other size (not listed, never changed); its rate is set to the 1 Qt size's, as a family copy leaves it.
  { id: '9c6d6b1e-b514-48e6-9b24-254eae46a7c0', name: 'Prevent Foam - 1 Gal', form: 'liquid', inv: 'Gal', rate: 'oz', per: null },
];

function seed(rows) {
  const pf = rows.findIndex((r) => r.id === 'e453fc17-c8b9-4e6c-89c1-7468b7875184');
  CONTROLS.find((c) => c.per === null).per = [0.3, 1.25, 10, 6.4, 13.7][pf % 5];
  const products = rows.map((r, i) => {
    const inv = r.kind === 'stock' ? r.old : (r.old === 'LB' ? 'Lb' : 'Dry oz');
    const rate = r.kind === 'rate' ? r.old : 'oz';
    const container = r.old === 'LB' ? "'Lb'" : 'NULL::text';
    const per = [0.3, 1.25, 10, 6.4, 13.7][i % 5];
    const cost = 5 + i * 1.37;
    return `('${r.id}'::uuid, ${q(r.name)}, 'RT2A-${i}', '${r.form}', ${q(inv)}, ${q(inv)}, ${q(rate)}, ${container}, ${per}, ${cost.toFixed(2)}, ${(cost * 1.2).toFixed(2)}, ${(cost * 1.3).toFixed(2)}, ${(cost * 1.4).toFixed(2)})`;
  });
  for (const [i, c] of CONTROLS.entries()) {
    products.push(`('${c.id}'::uuid, ${q(c.name)}, 'RT2A-C${i}', '${c.form}', '${c.inv}', '${c.inv}', '${c.rate}', NULL::text, ${c.per}, 40.00, 48.00, 52.00, 56.00)`);
  }
  raw(`DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${unitRows().join(', ')};
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.product_rate_lock (id, is_locked) VALUES (true, false) ON CONFLICT (id) DO UPDATE SET is_locked = false;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, category, is_active)
      SELECT v.*, 'Herbicide', true FROM (VALUES
      ${products.join(',\n      ')}) v;
    UPDATE public.products SET
        tier1_price_per_acre = public.product_price_per_acre(tier1_price, rate_per_acre, rate_unit, inventory_unit, unit_size),
        tier2_price_per_acre = public.product_price_per_acre(tier2_price, rate_per_acre, rate_unit, inventory_unit, unit_size),
        tier3_price_per_acre = public.product_price_per_acre(tier3_price, rate_per_acre, rate_unit, inventory_unit, unit_size),
        pricing_version = 1, updated_at = '2026-01-01'
      WHERE ${FIXTURE};`);
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE ${FIXTURE};`), String(rows.length + CONTROLS.length));
  assert.equal(scalar('SELECT count(*) FROM public.unit_conversions;'), '14');
  // An admin and a customer for the quote checks (handle_new_user takes role and name from the metadata).
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${ADMIN}', 'rt2a-admin@example.invalid', '{"full_name":"[PROVER] RT2A Admin","role":"admin"}'::jsonb);
    INSERT INTO public.customers (farm_name, is_active) VALUES ('[PROVER] RT2A Farm', true);`);
  assert.equal(scalar(`SELECT role || ',' || is_active FROM public.profiles WHERE id = '${ADMIN}';`), 'admin,true');
  // One-size families as live has them: the family copies its size's values, so each matches its size.
  const fams = families();
  raw(`INSERT INTO public.product_parents (id, name, product_form, rate_unit, rate_per_acre, suggested_rate, category, use_timings,
        created_by, updated_by)
      SELECT f.parent, f.name, p.product_form, f.unit, p.rate_per_acre, p.suggested_rate, p.category, p.use_timings, '${ADMIN}', '${ADMIN}'
        FROM (VALUES ${fams.map((x) => `('${x.product}'::uuid, '${x.parent}'::uuid, ${q(x.name)}, ${q(x.unit)})`).join(', ')}) f(product, parent, name, unit)
        JOIN public.products p ON p.id = f.product;
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by)
      SELECT f.product, f.parent, 'package', '${ADMIN}'
        FROM (VALUES ${fams.flatMap((x) => [x.product, ...(x.other ? [x.other] : [])].map((id) => `('${id}'::uuid, '${x.parent}'::uuid)`)).join(', ')}) f(product, parent);`);
  assert.equal(scalar('SELECT count(*) FROM public.product_parent_members;'), '20');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parents pp JOIN public.product_parent_members m ON m.parent_id = pp.id
      JOIN public.products p ON p.id = m.product_id
     WHERE (pp.rate_unit, pp.rate_per_acre) IS NOT DISTINCT FROM (p.rate_unit, p.rate_per_acre);`), '20', 'each family matches its sizes');
  console.log(`[prover] seeded live's 14 unit rows, the ${rows.length} listed products and ${CONTROLS.length} controls`);
}

// Unit columns, money columns and pricing version of every fixture product.
const units = () => scalar(`SELECT string_agg(id || ':' || coalesce(inventory_unit, '-') || '/' || coalesce(unit_size, '-') || '/'
    || coalesce(rate_unit, '-') || '/' || coalesce(container_unit, '-'), ',' ORDER BY id) FROM public.products WHERE ${FIXTURE};`);
const money = () => scalar(`SELECT md5(string_agg(concat_ws('|', id, rate_per_acre, tier1_price, tier2_price, tier3_price,
    tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, current_cost), ',' ORDER BY id)) FROM public.products;`);
const versions = () => scalar(`SELECT string_agg(id || '=' || pricing_version, ',' ORDER BY id) FROM public.products WHERE ${FIXTURE};`);
const fnBodies = () => scalar(`SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text))
    || ':' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc ILIKE '%unit_conversions%';`);
// Per-acre price recomputed from today's units for every product and tier (U5).
const perAcre = () => scalar(`SELECT md5(string_agg(concat_ws('|', id,
    public.product_price_per_acre(tier1_price, rate_per_acre, rate_unit, inventory_unit, unit_size),
    public.product_price_per_acre(tier2_price, rate_per_acre, rate_unit, inventory_unit, unit_size),
    public.product_price_per_acre(tier3_price, rate_per_acre, rate_unit, inventory_unit, unit_size)), ',' ORDER BY id)) FROM public.products;`);
const state = () => [units(), money(), versions(), fnBodies(), perAcre()].join('\n');

// U1: one quote per tier through the real save_quote RPC as the admin: a rate-and-acres line per fixture product
// sent with the product's current rate unit, plus a line per listed rate product sent with its OLD spelling (a
// stale screen or copied line). Returns every priced line.
let quoteNo = 0;
function quotes(rows) {
  const stale = rows.filter((r) => r.kind === 'rate').map((r) => `('${r.id}'::uuid, ${q(r.old)})`).join(', ');
  const lines = rows.length + CONTROLS.length + rows.filter((r) => r.kind === 'rate').length;
  const out = [];
  for (const tier of [1, 2, 3]) {
    quoteNo += 1;
    const number = `RT2A-Q${quoteNo}`;
    psql(`BEGIN;
      SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
      SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
      SELECT public.save_quote(NULL, jsonb_build_object('quote_number', '${number}', 'status', 'draft', 'tier', ${tier},
          'commission_split', '{"splits": []}'::jsonb, 'customer_id', (SELECT id FROM public.customers WHERE farm_name = '[PROVER] RT2A Farm')),
        jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', (
          SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'sort_order', x.ord, 'calc_mode', 'rate_acres',
                   'actual_rate', p.rate_per_acre, 'acres', 37.5, 'rate_unit', x.unit, 'unit_size', p.unit_size) ORDER BY x.ord)
            FROM (SELECT pr.*, row_number() OVER (ORDER BY pr.id) * 2 AS ord FROM public.products pr WHERE pr.${FIXTURE}) p
            CROSS JOIN LATERAL (SELECT p.ord AS ord, p.rate_unit AS unit
                                UNION ALL SELECT p.ord + 1, o.old FROM (VALUES ${stale}) o(id, old) WHERE o.id = p.id) x))),
        '${ADMIN}', 'rt2a-${number}');
      COMMIT;`);
    const got = scalar(`SELECT count(*) || ';' || string_agg(concat_ws('|', qi.product_id, qi.sort_order, qi.rate_unit, qi.total_units_needed,
        qi.oz_per_acre, qi.price_per_acre, qi.total_price, qi.profit), ',' ORDER BY qi.sort_order)
      FROM public.quotes q JOIN public.quote_items qi ON qi.quote_id = q.id WHERE q.quote_number = '${number}';`);
    assert.ok(got.startsWith(`${lines};`), `quote ${number} has every line: ${got.slice(0, 40)}`);
    // The line's own rate_unit is what was sent; compare prices only, so a respelled current unit still matches.
    out.push(got.split(';')[1].split(',').map((l) => { const f = l.split('|'); f.splice(2, 1); return f.join('|'); }).join(','));
  }
  return out.join('\n');
}

function refused(name, pattern) {
  const before = state();
  const r = apply(name);
  assert.notEqual(r.status, 0, `expected a refusal:\n${r.output}`);
  assert.match(r.output, pattern);
  assert.equal(state(), before, 'a refused run changed something');
}

async function main() {
  const rows = listed();
  buildContainer();
  seed(rows);
  stageText('cand.sql', lf(CANDIDATE));
  stageText('reverse.sql', lf(REVERSE));
  // The candidate with its pinned inventory count raised to the 3 snapshots seeded below, to prove the move itself.
  const PIN = 'v_inv_expected constant integer := 0;';
  assert.equal(lf(CANDIDATE).split(PIN).length, 2, 'the candidate pins 0 inventory snapshots');
  stageText('cand-inv.sql', lf(CANDIDATE).replace(PIN, 'v_inv_expected constant integer := 3;'));
  const s0 = { units: units(), money: money(), versions: versions(), fns: fnBodies(), perAcre: perAcre() };
  assert.match(s0.fns, /:14$/, 'the 14 functions that read unit_conversions are present');
  const q0 = quotes(rows);
  // The fixture quotes name the listed products; remove them so only the open-lines tests below see one.
  const retireQuotes = () => raw(`DELETE FROM public.quote_versions WHERE quote_id IN (SELECT id FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%');
    DELETE FROM public.quote_items WHERE quote_id IN (SELECT id FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%');
    DELETE FROM public.quote_sections WHERE quote_id IN (SELECT id FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%');
    DELETE FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%';`);
  retireQuotes();
  const armezon = rows.find((r) => r.old === 'Oz');
  const imazuron = rows.find((r) => r.old === 'LB');
  const imazFam = families().find((x) => x.product === imazuron.id).parent;
  const p0 = parents();
  const othersNow = (id) => scalar(`SELECT md5(string_agg(to_jsonb(pp)::text, ',' ORDER BY pp.id)) FROM public.product_parents pp WHERE pp.id <> '${id}';`);
  const others0 = othersNow(imazFam);

  // U7. The rate lock on refuses.
  raw('UPDATE public.product_rate_lock SET is_locked = true;');
  refused('cand.sql', /RT2A_RATE_LOCK_ON/);
  raw('UPDATE public.product_rate_lock SET is_locked = false;');
  console.log('[prover] U7: with the rate lock on the migration refuses and changes nothing');

  // Drift: a moved row and a changed unit row refuse.
  raw(`UPDATE public.products SET product_name = 'Renamed' WHERE id = '${armezon.id}';`);
  refused('cand.sql', new RegExp(`RT2A_ROW_MOVED[^\\n]*${esc(armezon.name)}`));
  raw(`UPDATE public.products SET product_name = ${q(armezon.name)} WHERE id = '${armezon.id}';`);
  raw(`UPDATE public.products SET rate_unit = 'Lb' WHERE id = '${imazuron.id}';`);
  refused('cand.sql', /RT2A_ROW_MOVED[^\n]*Imazuron/);
  raw(`UPDATE public.products SET rate_unit = 'LB' WHERE id = '${imazuron.id}';`);
  raw("UPDATE public.unit_conversions SET factor_oz = 33 WHERE unit = 'Qt';");
  refused('cand.sql', /RT2A_UNITS_DRIFT/);
  raw("UPDATE public.unit_conversions SET factor_oz = 32 WHERE unit = 'Qt';");
  console.log('[prover] drift: a renamed or respelled listed product, or a changed unit row, refuses');

  // U8. An unlisted product on a losing spelling refuses.
  raw(`UPDATE public.products SET container_unit = 'LB' WHERE id = '${CONTROLS[1].id}';`);
  refused('cand.sql', /RT2A_UNLISTED_SPELLING[^\n]*Lb per Lb/);
  raw(`UPDATE public.products SET container_unit = NULL WHERE id = '${CONTROLS[1].id}';`);
  raw("INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'LB');");
  refused('cand.sql', /RT2A_UNLISTED_SPELLING[^\n]*seed LB/);
  raw("DELETE FROM public.product_form_units WHERE product_form = 'seed' AND unit = 'LB';");
  console.log('[prover] U8: an unlisted product, or a form-unit entry, using LB refuses');

  // Sol round 2 HIGH: a product whose rate unit moves must not carry a label maximum (it would stop being checked).
  raw(`UPDATE public.products SET max_label_rate = 2, max_label_rate_unit = 'Lb' WHERE id = '${imazuron.id}';`);
  refused('cand.sql', /RT2A_LABEL_RATE[^\n]*Imazuron/);
  raw(`UPDATE public.products SET max_label_rate = NULL, max_label_rate_unit = NULL WHERE id = '${imazuron.id}';`);
  console.log('[prover] label: a moving rate unit with a label maximum refuses');

  // Sol round 10 MED: an old-spelling inventory snapshot of a listed stock product beyond the pinned count refuses.
  raw(`INSERT INTO public.inventory (product_id, location, unit_size) VALUES ('${armezon.id}', 'Main Warehouse', 'Oz');`);
  refused('cand.sql', /RT2A_INVENTORY_DRIFT: 1 inventory rows/);
  raw(`DELETE FROM public.inventory WHERE product_id = '${armezon.id}';`);
  console.log('[prover] inventory: an unexpected old-spelling inventory snapshot refuses');

  // Sol rounds 14-15: a quote of any status, a saved quote version naming a listed product, or a purchase order
  // that is not cancelled (fully received included) on an old spelling refuses; a cancelled order does not count.
  const ozRow = rows.find((r) => r.old === 'Oz');
  quotes(rows);
  raw("UPDATE public.quotes SET status = 'declined' WHERE quote_number LIKE 'RT2A-Q%';");
  refused('cand.sql', /RT2A_OPEN_LINES/);
  raw(`DELETE FROM public.quote_items WHERE quote_id IN (SELECT id FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%');
    INSERT INTO public.quote_versions (quote_id, version_number, sent_by, snapshot_data)
      SELECT id, 1, '${ADMIN}', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', '${ozRow.id}', 'unit_size', 'Oz')))
        FROM public.quotes WHERE quote_number LIKE 'RT2A-Q%' ORDER BY quote_number LIMIT 1;`);
  refused('cand.sql', new RegExp(`RT2A_OPEN_LINES[^\\n]*${esc(ozRow.name)}`));
  retireQuotes();
  raw(`INSERT INTO public.purchase_orders (id, po_number, status, created_by) VALUES ('${FAM}', 'RT2A-PO', 'fully_received', '${ADMIN}');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost, unit_size)
      VALUES ('${FAM}', '${ozRow.id}', 2, 10, 'Oz');`);
  refused('cand.sql', new RegExp(`RT2A_OPEN_LINES[^\\n]*${esc(ozRow.name)}`));
  raw(`UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = '${FAM}';`);
  console.log('[prover] open lines: a declined quote, a quote version, or a fully received purchase order on an old spelling refuses');

  // U9. Families: a listed product moved to another family, a second size in a pinned family, a fill-source link,
  // an unlisted family on a losing spelling, and Imazuron differing from its family each refuse.
  const armFam = families().find((x) => x.product === armezon.id).parent;
  raw(`INSERT INTO public.product_parents (id, name, product_form, created_by, updated_by) VALUES ('${FAM}', 'RT2A family', 'liquid', '${ADMIN}', '${ADMIN}');
    UPDATE public.product_parent_members SET parent_id = '${FAM}' WHERE product_id = '${armezon.id}';`);
  refused('cand.sql', new RegExp(`RT2A_FAMILY_OR_WEIGHT[^\\n]*${esc(armezon.name)}`));
  raw(`UPDATE public.product_parent_members SET parent_id = '${armFam}' WHERE product_id = '${armezon.id}';`);
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role) VALUES ('${CONTROLS[1].id}', '${imazFam}', '${ADMIN}', 'package');`);
  refused('cand.sql', /RT2A_FAMILY_OR_WEIGHT[^\n]*Imazuron/);
  raw(`DELETE FROM public.product_parent_members WHERE product_id = '${CONTROLS[1].id}';`);
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role, fill_source_product_id) VALUES ('${CONTROLS[0].id}', '${FAM}', '${ADMIN}', 'fixed_tote', '${armezon.id}');`);
  refused('cand.sql', new RegExp(`RT2A_FAMILY_OR_WEIGHT[^\\n]*${esc(armezon.name)}`));
  // Prevent Foam's family: a third size refuses, and so does losing its pinned 1 Gal size.
  const pfFam = families().find((x) => x.other);
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role) VALUES ('${CONTROLS[1].id}', '${pfFam.parent}', '${ADMIN}', 'package');`);
  refused('cand.sql', /RT2A_FAMILY_OR_WEIGHT[^\n]*Prevent Foam/);
  raw(`DELETE FROM public.product_parent_members WHERE product_id = '${CONTROLS[1].id}';`);
  raw(`DELETE FROM public.product_parent_members WHERE product_id = '${pfFam.other}';`);
  refused('cand.sql', /RT2A_FAMILY_OR_WEIGHT[^\n]*Prevent Foam/);
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role) VALUES ('${pfFam.other}', '${pfFam.parent}', '${ADMIN}', 'package');`);
  raw(`DELETE FROM public.product_parent_members WHERE parent_id = '${FAM}'; UPDATE public.product_parents SET rate_unit = 'Qt' WHERE id = '${FAM}';`);
  refused('cand.sql', /RT2A_UNLISTED_SPELLING[^\n]*RT2A family/);
  raw(`DELETE FROM public.product_parents WHERE id = '${FAM}';`);
  raw(`UPDATE public.product_parents SET rate_per_acre = rate_per_acre + 1 WHERE id = '${imazFam}';`);
  refused('cand.sql', /RT2A_FAMILY_VALUES[^\n]*Imazuron/);
  raw(`UPDATE public.product_parents SET rate_per_acre = rate_per_acre - 1 WHERE id = '${imazFam}';`);
  raw(`UPDATE public.product_parents SET rate_unit = 'Lb' WHERE id = '${imazFam}';`);
  refused('cand.sql', /RT2A_FAMILY_OR_WEIGHT[^\n]*Imazuron/);
  raw(`UPDATE public.product_parents SET rate_unit = 'LB' WHERE id = '${imazFam}';`);
  assert.equal(parents(), p0, 'the family checks left the families as seeded');
  console.log('[prover] U9: a moved family, a second size, a fill source, a family on Qt, or Imazuron off its family refuses');

  // U10b. A product save adding an Oz product, held open, makes the migration wait; once it commits, the
  // migration sees it and refuses.
  const late = '7a7e5000-0000-4000-8000-0000000000d1';
  const holder = spawn('docker', [...psqlArgs(), '-c', `BEGIN; INSERT INTO public.products (id, product_name, product_form, inventory_unit, unit_size, category, is_active)
      VALUES ('${late}', '[PROVER] Late Oz', 'liquid', 'Oz', 'Oz', 'Herbicide', true); SELECT pg_sleep(4); COMMIT;`], { stdio: 'ignore' });
  try {
    let held = false;
    for (let i = 0; i < 40 && !held; i += 1) {
      held = scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND state = 'active' AND pid <> pg_backend_pid();") === '1';
      if (!held) wait(250);
    }
    assert.ok(held, 'the held product save did not start');
    const started = Date.now();
    const r = apply('cand.sql');
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /RT2A_UNLISTED_SPELLING[^\n]*Late Oz/);
    assert.ok(Date.now() - started >= 1500, 'the migration did not wait for the open save');
  } finally { holder.kill(); }
  assert.equal(scalar(`SELECT inventory_unit FROM public.products WHERE id = '${late}';`), 'Oz', 'the held save committed');
  raw(`DELETE FROM public.products WHERE id = '${late}';`);
  assert.equal(state(), [s0.units, s0.money, s0.versions, s0.fns, s0.perAcre].join('\n'));
  console.log('[prover] U10b: an Oz product saved while the migration starts makes it wait, then refuse');

  // Apply with every live trigger on.
  const historyBefore = Number(scalar('SELECT count(*) FROM public.product_change_history;'));
  const r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  for (const row of rows) {
    const got = scalar(`SELECT concat_ws('/', inventory_unit, unit_size, rate_unit, pricing_version, (updated_at > '2026-01-02')::text) FROM public.products WHERE id = '${row.id}';`);
    const [inv, size, rate] = s0.units.split(',').find((x) => x.startsWith(row.id)).split(':')[1].split('/');
    const want = row.kind === 'stock' ? [row.neu, row.neu, rate, 1] : [inv, size, row.neu, 2];
    assert.equal(got, `${want.join('/')}/true`, row.name);
    for (const f of (row.kind === 'stock' ? ['inventory_unit', 'unit_size'] : ['rate_unit'])) {
      assert.equal(scalar(`SELECT count(*) || '|' || string_agg(old_value || '>' || new_value, ',') FROM public.product_change_history
          WHERE product_id = '${row.id}' AND field_name = '${f}';`), `1|${row.old}>${row.neu}`, `${row.name} ${f} history`);
    }
  }
  const historyRows = Number(scalar('SELECT count(*) FROM public.product_change_history;')) - historyBefore;
  assert.equal(money(), s0.money, 'U5: no price, cost or rate moved on any product');
  assert.equal(perAcre(), s0.perAcre, 'U5: per-acre prices recomputed from the new units are unchanged');
  assert.equal(fnBodies(), s0.fns, 'U6: function bodies unchanged');
  for (const c of CONTROLS) {
    assert.equal(scalar(`SELECT concat_ws('/', rate_unit, pricing_version, updated_at::date) FROM public.products WHERE id = '${c.id}';`), `${c.rate}/1/2026-01-01`, c.name);
  }
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_validate_product_setup_fields';"), 'O', 'U13: setup guard enabled');
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trigger_zz_guard_product_parent_values';"), 'O', 'family guard enabled');
  assert.equal(scalar('SELECT count(*) FROM public.unit_conversions;'), '14', 'unit rows untouched');
  // Families: Imazuron's moved with its size (version +1); every other family is exactly as before.
  assert.equal(scalar(`SELECT rate_unit || '/' || parent_version FROM public.product_parents WHERE id = '${imazFam}';`), 'Lb/2');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parents WHERE rate_unit IN ('Oz', 'Qt', 'LB');`), '0');
  assert.equal(othersNow(imazFam), others0, 'every other family is unchanged');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_events;`), '0', 'no family event without a person');
  console.log(`[prover] apply: ${rows.length} products moved, ${historyRows} history rows, pricing version +1 on the rate row only, every price and per-acre value unchanged, the two dry oz-rate products untouched, setup guard on`);

  // U13. The setup guard still refuses an ordinary stock-unit change.
  const u13 = psql(`UPDATE public.products SET inventory_unit = 'Gal', unit_size = 'Gal' WHERE id = '${armezon.id}';`, { allowFailure: true });
  assert.match(`${u13.stdout}\n${u13.stderr}`, /can't change on a saved product/);
  // 20261229160000: Dry oz on a dry product has a pound equivalent; the two unmoved dry oz-rate products keep theirs.
  for (const c of CONTROLS.filter((x) => x.inv === 'Dry oz')) {
    assert.equal(scalar(`SELECT c.converted_value::text || ' ' || c.converted_unit FROM public.products p,
        public.convert_to_gl_lb(16, p.rate_unit, p.product_form) c WHERE p.id = '${c.id}';`), '1.00000000000000000000 LB', `${c.name} pound equivalent`);
  }
  assert.equal(scalar("SELECT c.converted_value::text || ' ' || c.converted_unit FROM public.convert_to_gl_lb(16, 'Dry oz', 'dry') c;"), '1.00000000000000000000 LB');
  // Sol round 2 LOW: the saved figure trims the unit, as the screen preview does.
  assert.equal(scalar("SELECT c.converted_value::text || ' ' || c.converted_unit FROM public.convert_to_gl_lb(16, ' Dry oz ', 'dry') c;"), '1.00000000000000000000 LB');
  console.log('[prover] gl/lb: 16 Dry oz on a dry product is 1 LB; the two dry oz-rate products keep 1 LB per 16 oz');
  // The family guard still refuses a size-only rate unit change (a family copy is the only way in).
  const fg = psql(`UPDATE public.products SET rate_unit = 'Dry oz' WHERE id = '${imazuron.id}';`, { allowFailure: true });
  assert.notEqual(fg.status, 0, 'the family guard let a size-only rate unit change through');
  console.log('[prover] U13: after the apply a stock-unit change is still refused, and so is a size-only rate unit change');

  // U1 at S1: the same quotes price to the cent.
  assert.equal(quotes(rows), q0, 'U1: quote lines differ after the apply');
  retireQuotes();
  console.log('[prover] U1: three quotes (every fixture product, current and old spellings) equal S0 to the cent');

  // U2. Ordinary edits of every fixture product save; new products in the winning spellings save.
  psql(`UPDATE public.products SET internal_notes = 'RT2A edit' WHERE ${FIXTURE};`);
  psql(`INSERT INTO public.products (product_name, product_form, inventory_unit, unit_size, rate_unit, rate_per_acre, category, is_active) VALUES
      ('[PROVER] New oz', 'liquid', 'oz', 'oz', 'oz', 2, 'Herbicide', true), ('[PROVER] New qt', 'liquid', 'qt', 'qt', 'qt', 1, 'Herbicide', true),
      ('[PROVER] New Lb', 'dry', 'Lb', 'Lb', 'Lb', 1, 'Herbicide', true);`);
  raw("DELETE FROM public.products WHERE product_name LIKE '[PROVER] New %';");
  console.log('[prover] U2: an ordinary edit of all 26 fixture products saves; new oz, qt and Lb products save');

  // U15. A second run is refused; the recovery script restores every unit column; re-apply works.
  refused('cand.sql', /RT2A_ROW_MOVED/);
  raw("UPDATE public.unit_conversions SET factor_oz = 33 WHERE unit = 'Qt';");
  refused('reverse.sql', /RT2A_REVERSE_UNITS_DRIFT/);
  raw("UPDATE public.unit_conversions SET factor_oz = 32 WHERE unit = 'Qt';");
  raw('ALTER TABLE public.products DISABLE TRIGGER trigger_zzz_guard_product_rate_lock;');
  refused('reverse.sql', /RT2A_REVERSE_GUARD_STATE/);
  raw('ALTER TABLE public.products ENABLE TRIGGER trigger_zzz_guard_product_rate_lock;');
  // Sol round 3 HIGH: recovery also refuses a moving rate unit that gained a label maximum.
  raw(`UPDATE public.products SET max_label_rate = 2, max_label_rate_unit = 'Lb' WHERE id = '${imazuron.id}';`);
  refused('reverse.sql', /RT2A_REVERSE_LABEL_RATE[^\n]*Imazuron/);
  raw(`UPDATE public.products SET max_label_rate = NULL, max_label_rate_unit = NULL WHERE id = '${imazuron.id}';`);
  // Recovery refuses while a purchase order that is not cancelled holds a stock product's new spelling.
  raw(`UPDATE public.purchase_order_items SET unit_size = 'oz' WHERE purchase_order_id = '${FAM}';
    UPDATE public.purchase_orders SET status = 'submitted' WHERE id = '${FAM}';`);
  refused('reverse.sql', new RegExp(`RT2A_REVERSE_OPEN_LINES[^\n]*${esc(rows.find((r) => r.old === 'Oz').name)}`));
  raw(`UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = '${FAM}';`);
  // Recovery refuses while Imazuron's family has another size.
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by, size_role) VALUES ('${CONTROLS[1].id}', '${imazFam}', '${ADMIN}', 'package');`);
  refused('reverse.sql', /RT2A_REVERSE_ROW_MOVED[^\n]*Imazuron/);
  raw(`DELETE FROM public.product_parent_members WHERE product_id = '${CONTROLS[1].id}';`);
  raw('ALTER TABLE public.products DISABLE TRIGGER trigger_zz_guard_product_parent_values;');
  refused('reverse.sql', /RT2A_REVERSE_GUARD_STATE/);
  raw('ALTER TABLE public.products ENABLE TRIGGER trigger_zz_guard_product_parent_values;');
  const rv = apply('reverse.sql');
  assert.equal(rv.status, 0, rv.output);
  assert.equal(units(), s0.units, 'U15: recovery restored every unit column');
  assert.equal(money(), s0.money);
  assert.equal(perAcre(), s0.perAcre);
  assert.equal(fnBodies(), s0.fns);
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_validate_product_setup_fields';"), 'O');
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trigger_zz_guard_product_parent_values';"), 'O');
  assert.equal(scalar(`SELECT rate_unit || '/' || parent_version FROM public.product_parents WHERE id = '${imazFam}';`), 'LB/3', 'recovery moved the family back');
  assert.equal(quotes(rows), q0, 'U1: quote lines differ after recovery');
  retireQuotes();
  const again = apply('cand.sql');
  assert.equal(again.status, 0, again.output);
  assert.equal(scalar(`SELECT rate_unit || '/' || parent_version FROM public.product_parents WHERE id = '${imazFam}';`), 'Lb/4');
  assert.equal(money(), s0.money);
  assert.equal(quotes(rows), q0, 'U1: quote lines differ after re-apply');
  retireQuotes();
  console.log('[prover] U15: a second run refuses; recovery restores every unit column exactly; re-apply works; quotes equal throughout');

  // Sol round 10 MED: inventory snapshots move with their product, so the stock card's exact-match total still shows.
  { const back = apply('reverse.sql'); assert.equal(back.status, 0, back.output); }
  const qtRow = rows.find((r) => r.old === 'Qt');
  const inv = () => scalar(`SELECT string_agg(product_id || '@' || location || '=' || coalesce(unit_size, '-'), ',' ORDER BY product_id, location)
      FROM public.inventory WHERE product_id IN ('${armezon.id}', '${qtRow.id}', '${CONTROLS[0].id}');`);
  raw(`INSERT INTO public.inventory (product_id, location, unit_size) VALUES ('${armezon.id}', 'Main Warehouse', 'Oz'),
      ('${armezon.id}', 'North Barn', 'Oz'), ('${qtRow.id}', 'Main Warehouse', 'Qt'), ('${CONTROLS[0].id}', 'Main Warehouse', 'Gal');`);
  const inv0 = inv();
  refused('cand.sql', /RT2A_INVENTORY_DRIFT: 3 inventory rows/);
  assert.equal(inv(), inv0, 'a refused run moved an inventory snapshot');
  { const m = apply('cand-inv.sql'); assert.equal(m.status, 0, m.output); }
  assert.equal(inv(), inv0.replaceAll('=Oz', '=oz').replaceAll('=Qt', '=qt'), 'snapshots moved with their products');
  assert.equal(scalar(`SELECT count(DISTINCT i.unit_size) || '/' || bool_and(i.unit_size = p.unit_size) FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id WHERE i.product_id = '${armezon.id}';`), '1/true', 'stock card total still shows');
  { const back = apply('reverse.sql'); assert.equal(back.status, 0, back.output); }
  assert.equal(inv(), inv0, 'recovery moved the snapshots back');
  console.log('[prover] inventory: 3 old-spelling snapshots move with their products (an unrelated Gal row does not), and recovery moves them back');

  console.log('UNIT_SPELLINGS_STEP1_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
