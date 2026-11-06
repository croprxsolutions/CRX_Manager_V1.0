#!/usr/bin/env node
/**
 * Real-schema proof for 20261116100000_permission_tightening.sql (KI-101 grant item, KI-07, KI-26).
 * Builds the checked-in baseline plus every post-baseline migration on this checkout (the candidate
 * included) in a network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Then:
 *   1. ROLLBACK: re-grants and re-creates exactly what the candidate removed (the policies from the
 *      baseline overlay); their md5s equal the live ones the candidate pins, so the build matched live.
 *   2. BEFORE (old permissions): a signed-in admin's direct UPDATE of orders.status succeeds; profiles
 *      grants TRUNCATE/TRIGGER; an admin can write, replace and delete a signature at the old fixed path
 *      and read an old-path file no delivery records.
 *   3. The candidate applies once; a second apply is refused by its preflight.
 *   4. AFTER: the admin's direct status update is refused (42501) while other order columns still save;
 *      profiles TRUNCATE/TRIGGER are gone; old-path writes, replaces and deletes are refused or touch
 *      nothing, the recorded old signature is still readable by admin, rep and its driver (not by another
 *      driver), the unrecorded one is not; and the real flows still work as the signed-in user:
 *      a driver uploads a signature and completes the delivery (order fulfilled, signature readable),
 *      an admin cancels an order, completes and voids a delivery, and completes and voids an order.
 *
 * Run: node scripts/smoke/prove-permission-tightening-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> PERM_TIGHTEN_PROOF_REUSE=1 (left running).
 * Prints PERMISSION_TIGHTENING_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = '20261116100000_permission_tightening.sql';
const reuse = process.env.PERM_TIGHTEN_PROOF_REUSE === '1';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(MIGRATIONS, CANDIDATE));
const overlay = lf(path.join(ROOT, 'supabase', 'baselines', '20260727174805_platform_overlay.sql'));

const X = (n) => `9e700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DRIVER2 = X('a5');
const CUSTOMER = X('c1');
const PRODUCT = X('f1');
// Orders: sig (driver signs), cancel, voiddel, voidord, direct (direct-update target).
const O = { sig: X('d1'), cancel: X('d2'), voiddel: X('d3'), voidord: X('d4'), direct: X('d5') };
const OI = Object.fromEntries(Object.entries(O).map(([k], i) => [k, X(`e${i + 1}`)]));
const D = { sig: X('b1'), voiddel: X('b3'), voidord: X('b4') };
const DI = { sig: X('91'), voiddel: X('93'), voidord: X('94') };
// Completed before 20261022075000: one recorded old-path signature, one stray old-path file, one with none.
const OLD = { recorded: X('b6'), stray: X('b7'), none: X('b8') };
const OLD_ORDER = X('d6');
const oldPath = (d) => `signatures/${d}.png`;

const POLICIES = ['delivery_signatures_scoped_delete', 'delivery_signatures_scoped_insert',
  'delivery_signatures_scoped_select', 'delivery_signatures_scoped_update'];
const LIVE_MD5 = 'delivery_signatures_scoped_delete=b613f0278f79ff2fb50bca39823fd1ca,'
  + 'delivery_signatures_scoped_insert=8dec52ae49cc1ace8678d320a2d899c9,'
  + 'delivery_signatures_scoped_select=3fa6fdae43648f207c08c3ce3b276397,'
  + 'delivery_signatures_scoped_update=8e1331d356854ab54e419bf0ba9ba037';
const policyMd5 = () => scalar(`SELECT string_agg(policyname || '=' || md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')), ',' ORDER BY policyname)
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN ('${POLICIES.join("','")}');`);

/** The overlay's CREATE POLICY statement for `name` (the rollback re-creates exactly that). */
function overlayPolicy(name) {
  const start = overlay.indexOf(`CREATE POLICY "${name}" ON "storage"."objects"`);
  assert.ok(start >= 0, `${name} not in the overlay`);
  const end = overlay.indexOf(';\n', start);
  return overlay.slice(start, end + 1);
}
const ROLLBACK = `GRANT UPDATE (status) ON public.orders TO authenticated;
GRANT TRUNCATE, TRIGGER ON public.profiles TO authenticated;
DROP POLICY delivery_signatures_scoped_select ON storage.objects;
${POLICIES.map(overlayPolicy).join('\n')}`;

function applyCandidate() {
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/perm-candidate.sql'], { input: candidate });
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/perm-candidate.sql'], { allowFailure: true });
}

// As live (read 2026-11-05): storage.objects has row security on and authenticated holds
// SELECT/INSERT/UPDATE/DELETE on it; postgres bypasses row security.
const STORAGE_RLS = `ALTER ROLE postgres BYPASSRLS;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;`;

function seed() {
  if (scalar(`SELECT count(*) FROM public.orders WHERE id = '${O.sig}';`) === '1') return;
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${DRIVER2}', 'perm-driver2@example.invalid', '{"full_name":"[PERM] Driver 2","role":"driver"}'::jsonb);`);
  const order = (k, status = 'confirmed') => `INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O[k]}', 'PERM-${k}', '${CUSTOMER}', current_date, '${status}', false, '${USERS.admin}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${OI[k]}', '${O[k]}', '${PRODUCT}', '[PERM] product', 10, 6, 10, 100, 40, 40, 0, 10);`;
  const delivery = (k, driver) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${D[k]}', 'PERM-D-${k}', '${O[k]}', '${CUSTOMER}', '${USERS.admin}', 'in_progress', current_date, ${driver ? `'${driver}'` : 'NULL'});
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI[k]}', '${D[k]}', '${OI[k]}', '${PRODUCT}', 10, 'GL');`;
  const old = (k, signature) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver, signature_url, signed_by)
      VALUES ('${OLD[k]}', 'PERM-OLD-${k}', '${OLD_ORDER}', '${CUSTOMER}', '${USERS.admin}', 'completed', current_date - 30, '${USERS.driver}', ${signature ? `'${oldPath(OLD[k])}', '[PERM] Old signer'` : 'NULL, NULL'});`;
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PERM] Farm', true);
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
      VALUES ('${PRODUCT}', '[PERM] product', 'PERM-1', 'GL', 6.00, 10.00, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PRODUCT}', 'Main Warehouse', 500, 50, 'GL');
    ${Object.keys(O).map((k) => order(k)).join('\n    ')}
    ${delivery('sig', USERS.driver)}
    ${delivery('voiddel')}
    ${delivery('voidord')}
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${OLD_ORDER}', 'PERM-OLD', '${CUSTOMER}', current_date - 30, 'fulfilled', false, '${USERS.admin}');
    ${old('recorded', true)}
    ${old('stray', false)}
    ${old('none', false)}
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata) VALUES
      ('delivery-signatures', '${oldPath(OLD.recorded)}', '${USERS.driver}', '{"size": 2400, "mimetype": "image/png"}'),
      ('delivery-signatures', '${oldPath(OLD.stray)}', '${USERS.driver}', '{"size": 2400, "mimetype": "image/png"}');`);
}

const status = (k) => `(SELECT status FROM public.orders WHERE id = '${O[k]}')`;
const visible = (uid, name) => attempt(uid, asUser(`SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'delivery-signatures' AND name = '${name}';`) + ' v := n::text;');
const rowsTouched = (uid, stmt) => attempt(uid, `${asUser(`${stmt} GET DIAGNOSTICS n = ROW_COUNT;`)} v := n::text;`);

/** The permission checks whose answers change: returns an object for before/after comparison. */
function permissionProbes() {
  return {
    directStatus: attempt(USERS.admin, asUser(`UPDATE public.orders SET status = 'fulfilled' WHERE id = '${O.direct}'; GET DIAGNOSTICS n = ROW_COUNT;`) + ` v := n::text || ' ' || ${status('direct')};`),
    directNotes: attempt(USERS.admin, asUser(`UPDATE public.orders SET notes = '[PERM] note', is_planned = true WHERE id = '${O.direct}'; GET DIAGNOSTICS n = ROW_COUNT;`) + ' v := n::text;'),
    profilesTruncTrig: scalar(`SELECT has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')::text || has_table_privilege('authenticated', 'public.profiles', 'TRIGGER')::text
      || has_table_privilege('anon', 'public.profiles', 'TRUNCATE')::text || has_table_privilege('anon', 'public.profiles', 'TRIGGER')::text;`),
    oldInsert: attempt(USERS.admin, asUser(`INSERT INTO storage.objects (bucket_id, name, owner_id, metadata) VALUES ('delivery-signatures', '${oldPath(OLD.none)}', '${USERS.admin}', '{"size": 2400, "mimetype": "image/png"}');`) + " v := 'inserted';"),
    oldReplace: rowsTouched(USERS.admin, `UPDATE storage.objects SET metadata = '{"size": 9999, "mimetype": "image/png"}' WHERE bucket_id = 'delivery-signatures' AND name = '${oldPath(OLD.recorded)}';`),
    oldReplaceDriver: rowsTouched(USERS.driver, `UPDATE storage.objects SET metadata = '{"size": 9999, "mimetype": "image/png"}' WHERE bucket_id = 'delivery-signatures' AND name = '${oldPath(OLD.recorded)}';`),
    oldDelete: rowsTouched(USERS.admin, `DELETE FROM storage.objects WHERE bucket_id = 'delivery-signatures' AND name = '${oldPath(OLD.recorded)}';`),
    readRecorded: ['admin', 'rep', 'driver'].map((r) => visible(USERS[r], oldPath(OLD.recorded))).join(',') + ',' + visible(DRIVER2, oldPath(OLD.recorded)),
    readStray: visible(USERS.admin, oldPath(OLD.stray)),
  };
}

/** The real flows, each rolled back, as the signed-in user: returns the order status each one leaves. */
function flows() {
  const key = 'perm-sig-complete-1';
  const sigPath = scalar(`SELECT 'signatures/${D.sig}/' || left(encode(sha256(convert_to('${key}', 'UTF8')), 'hex'), 32) || '.png';`);
  const out = {};
  out.signature = attempt(USERS.driver, `${asUser(`INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
      VALUES ('delivery-signatures', '${sigPath}', '${USERS.driver}', '{"size": 2400, "mimetype": "image/png"}');
    r := public.complete_delivery('${D.sig}', '[PERM] Customer', '${USERS.driver}', jsonb_build_object('${DI.sig}', 10),
      NULL, NULL, '${key}', NULL, 'signature', '${sigPath}');
    SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'delivery-signatures' AND name = '${sigPath}';`)}
    v := ${status('sig')} || ' ' || (SELECT status || ' ' || coalesce(signature_url = '${sigPath}', false)::text FROM public.deliveries WHERE id = '${D.sig}') || ' driver-reads=' || n;`);
  out.cancel = attempt(USERS.admin, `${asUser(`r := public.cancel_order('${O.cancel}', '${USERS.admin}', 'perm-cancel-1');`)} v := ${status('cancel')};`);
  const completeNoProof = (k, uid) => `r := public.complete_delivery('${D[k]}', 'No proof — recorded by office', '${uid}',
      jsonb_build_object('${DI[k]}', 10), NULL, NULL, 'perm-complete-${k}', NULL, 'no_proof', '[PERM] no signature taken');`;
  out.voidDelivery = attempt(USERS.admin, `${asUser(completeNoProof('voiddel', USERS.admin))} t := ${status('voiddel')};
    ${asUser(`r2 := public.void_delivery('${D.voiddel}', '[PERM] wrong delivery', '${USERS.admin}', 'perm-void-del-1');`)}
    v := t || ' -> ' || ${status('voiddel')};`);
  out.voidOrder = attempt(USERS.admin, `${asUser(completeNoProof('voidord', USERS.admin))} t := ${status('voidord')};
    ${asUser(`r2 := public.void_order('${O.voidord}', '${USERS.admin}', '[PERM] wrong order', 'perm-void-ord-1');`)}
    v := t || ' -> ' || ${status('voidord')};`);
  return out;
}

try {
  if (!reuse) buildContainer();
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${USERS.admin}';`) === '0') seedUsers();
  psql(STORAGE_RLS, { user: 'supabase_admin' });
  seed();
  const isAdminRep = scalar(`SELECT role FROM public.profiles WHERE id = '${USERS.rep}';`);
  assert.equal(isAdminRep, 'sales_rep');

  // The build replayed the candidate; check its result, then roll it back to live's current state.
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${CANDIDATE.replace('.sql', '')}';`), '1', 'the harness must have replayed the candidate');
  psql(ROLLBACK);
  assert.equal(policyMd5(), LIVE_MD5, 'the rolled-back signature policies must equal the live ones the candidate pins');
  assert.equal(scalar("SELECT has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE')::text || has_table_privilege('authenticated', 'public.orders', 'UPDATE')::text;"), 'truefalse',
    'before: authenticated holds a column (not table-wide) UPDATE on orders.status, as live');
  console.log('[perm] rollback recreates live\'s grants and the four policies (md5s match live)');

  const before = permissionProbes();
  console.log('[perm] BEFORE', JSON.stringify(before));
  assert.equal(before.directStatus, 'ok|1 fulfilled', 'before: an admin could set order status directly');
  assert.equal(before.profilesTruncTrig, 'truetruefalsefalse');
  assert.equal(before.oldInsert, 'ok|inserted', 'before: an admin could write an old-path signature on a completed delivery');
  assert.equal(before.oldReplace, 'ok|1');
  assert.equal(before.oldReplaceDriver, 'ok|1', 'before: the assigned driver could replace an old signature');
  assert.equal(before.oldDelete, 'ok|1');
  assert.equal(before.readRecorded, 'ok|1,ok|1,ok|1,ok|0');
  assert.equal(before.readStray, 'ok|1', 'before: an old-path file no delivery records was readable');

  const first = applyCandidate();
  assert.equal(first.status, 0, first.stderr);
  const again = applyCandidate();
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /PERMISSION_TIGHTENING_PREFLIGHT: the four older delivery-signature policies drifted/);
  console.log('[perm] candidate applied; a second apply is refused by its preflight');

  const after = permissionProbes();
  console.log('[perm] AFTER ', JSON.stringify(after));
  assert.match(after.directStatus, /^42501\|permission denied for table orders/, 'after: the direct status update must be refused');
  assert.equal(after.directNotes, 'ok|1', 'after: other order columns still save directly');
  assert.equal(after.profilesTruncTrig, 'falsefalsefalsefalse');
  assert.match(after.oldInsert, /^42501\|new row violates row-level security policy/);
  assert.equal(after.oldReplace, 'ok|0');
  assert.equal(after.oldReplaceDriver, 'ok|0');
  assert.equal(after.oldDelete, 'ok|0');
  assert.equal(after.readRecorded, 'ok|1,ok|1,ok|1,ok|0', 'after: the recorded old signature reads as before');
  assert.equal(after.readStray, 'ok|0', 'after: an unrecorded old-path file is no longer readable');

  const done = flows();
  console.log('[perm] FLOWS ', JSON.stringify(done));
  assert.equal(done.signature, 'ok|fulfilled completed true driver-reads=1', 'driver signature upload + completion');
  assert.equal(done.cancel, 'ok|cancelled');
  assert.equal(done.voidDelivery, 'ok|fulfilled -> confirmed');
  assert.equal(done.voidOrder, 'ok|fulfilled -> voided');
  console.log('[perm] after: signature completion, cancel, void delivery and void order all work as the signed-in user');
  console.log('\nPERMISSION_TIGHTENING_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
