#!/usr/bin/env node
/**
 * Real-schema proof for 20261123130000_revoke_truncate_trigger_maintain.sql (KI-07 follow-up).
 * Builds the checked-in baseline plus every post-baseline migration BEFORE the candidate in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs, stopBefore). Then:
 *   1. BEFORE: the grants exist exactly as live had them (the generated rollback equals the live read,
 *      by md5), and as `authenticated` a TRUNCATE of a table, a CREATE TRIGGER on a table and on a view,
 *      a LOCK TABLE on a read-only table and a REINDEX all succeed (each rolled back).
 *   2. A partial apply rolls itself back: with one extra grant to PUBLIC the postflight refuses and
 *      nothing changes; a relation not owned by postgres makes the preflight refuse.
 *   3. The candidate applies once; a second apply is harmless (it only revokes).
 *   4. AFTER: no role-relation pair in public gives authenticated or anon any of the three (effective,
 *      has_table_privilege); every probe above is refused, plus a TRUNCATE of a view; every other grant
 *      is unchanged; a table created now as postgres gets none of the three; the order functions
 *      price_order, cancel_order, void_order, start_and_complete_delivery and process_offline_action
 *      still run as `authenticated` and leave the expected orders.status, and a direct status UPDATE is
 *      still refused; the signature smoke chain (malformed names included) passes, and fails when the
 *      read rule is loosened to a prefix match (the malformed-name checks bite).
 *   5. ROLLBACK: the reviewed rollback in the migration record restores every grant and default.
 *
 * Run: node scripts/smoke/prove-revoke-truncate-trigger-maintain-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a database built up to (not including) the candidate: UNDO_PATHS_CONTAINER=<name> REVOKE_TTM_PROOF_REUSE=1.
 * Prints REVOKE_TTM_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261123130000_revoke_truncate_trigger_maintain.sql';
const STEM = CANDIDATE.replace('.sql', '');
const reuse = process.env.REVOKE_TTM_PROOF_REUSE === '1';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const record = lf(path.join(ROOT, 'docs', 'reference', 'migrations.d', `${STEM}.md`));
// Read live (read-only) 2026-11-06: 239 GRANT statements, 462 grants; md5 of the sorted statements.
const LIVE_ROLLBACK_MD5 = 'c243e7916de833cfa51ab741588aa79b';

const X = (n) => `9e710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUSTOMER = X('c1');
const PRODUCT = X('f1');
const O = { price: X('d1'), cancel: X('d2'), voidord: X('d3'), sac: X('d4'), offline: X('d5'), direct: X('d6'), old: X('d7') };
const OI = Object.fromEntries(Object.keys(O).map((k, i) => [k, X(`e${i + 1}`)]));
const D = { voidord: X('b3'), sac: X('b4'), offline: X('b5'), old: X('b7') };
const DI = { voidord: X('93'), sac: X('94'), offline: X('95') };
const OFFLINE_ACTION = X('aa1');

const REL = `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN pg_roles r ON r.oid = a.grantee WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;
const TARGET = `r.rolname IN ('authenticated', 'anon') AND a.privilege_type IN ('TRUNCATE', 'TRIGGER', 'MAINTAIN')`;
/** The rollback, generated from the database's current grants exactly as it was read live. */
const ROLLBACK_QUERY = `SELECT coalesce(string_agg(stmt, E'\\n' ORDER BY stmt), '') FROM (
  SELECT format('GRANT %s ON public.%I TO %I;', string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), c.relname, r.rolname) AS stmt
  ${REL} AND ${TARGET} GROUP BY c.relname, r.rolname) s`;
/** Every table grant in public plus postgres's default privileges: compared before/after/rollback. */
const snapshot = () => scalar(`SELECT md5(coalesce((SELECT string_agg(e, ',' ORDER BY e) FROM (
    SELECT c.relname || '|' || a.grantee::regrole || '|' || a.grantor::regrole || '|' || a.privilege_type || '|' || a.is_grantable AS e
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')) s), '')
  || '#' || coalesce((SELECT string_agg(e, ',' ORDER BY e) FROM (
    SELECT d.defaclnamespace || '|' || a.grantee || '|' || a.privilege_type || '|' || a.is_grantable AS e
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'r') s), ''));`);
/** Effective privileges (direct, PUBLIC, membership or ownership): role-relation-privilege triples held. */
const effective = () => Number(scalar(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('authenticated'), ('anon')) AS r(rolname) CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('MAINTAIN')) AS p(privilege)
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(r.rolname, c.oid, p.privilege);`));
const tablePrivs = (table) => scalar(`SELECT coalesce(string_agg(a.grantee::regrole || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type), '')
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = 'public.${table}'::regclass AND a.grantee IN ('authenticated'::regrole, 'anon'::regrole);`);

function applyCandidate() {
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/ttm-candidate.sql'], { input: candidate });
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/ttm-candidate.sql'], { allowFailure: true });
}

/** The rollback SQL in the migration record (the one fenced sql block). */
function recordRollback() {
  const m = /```sql\n([\s\S]*?)```/.exec(record);
  assert.ok(m, 'the migration record must hold the rollback in a ```sql block');
  return m[1];
}

// As live (read 2026-11-05): storage.objects has row security on; postgres bypasses it.
const STORAGE_RLS = `ALTER ROLE postgres BYPASSRLS;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;`;

function seed() {
  if (scalar(`SELECT count(*) FROM public.orders WHERE id = '${O.price}';`) === '1') return;
  const order = (k, status = 'confirmed') => `INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O[k]}', 'TTM-${k}', '${CUSTOMER}', current_date, '${status}', false, '${USERS.admin}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size, pricing_pending)
      VALUES ('${OI[k]}', '${O[k]}', '${PRODUCT}', '[TTM] product', ${k === 'price' ? '0, 6, 10, 0, 0, 0' : '10, 6, 10, 100, 40, 40'}, 0, 10, 'GL', ${k === 'price'});`;
  const delivery = (k, status, driver) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${D[k]}', 'TTM-D-${k}', '${O[k]}', '${CUSTOMER}', '${USERS.admin}', '${status}', current_date, ${driver ? `'${driver}'` : 'NULL'});
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI[k]}', '${D[k]}', '${OI[k]}', '${PRODUCT}', 10, 'GL');`;
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[TTM] Farm', true);
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
      VALUES ('${PRODUCT}', '[TTM] product', 'TTM-1', 'GL', 6.00, 10.00, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PRODUCT}', 'Main Warehouse', 500, 50, 'GL');
    ${['price', 'cancel', 'voidord', 'sac', 'offline', 'direct'].map((k) => order(k)).join('\n    ')}
    UPDATE public.orders SET pricing_status = 'needs_pricing' WHERE id = '${O.price}';
    ${delivery('voidord', 'in_progress')}
    ${delivery('sac', 'scheduled', USERS.driver)}
    ${delivery('offline', 'in_progress', USERS.driver)}
    -- A completed delivery whose recorded signature is its old fixed-path file (the signature smoke needs one).
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O.old}', 'TTM-OLD', '${CUSTOMER}', current_date - 30, 'fulfilled', false, '${USERS.admin}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver, signature_url, signed_by)
      VALUES ('${D.old}', 'TTM-OLD', '${O.old}', '${CUSTOMER}', '${USERS.admin}', 'completed', current_date - 30, '${USERS.driver}', 'signatures/${D.old}.png', '[TTM] Old signer');
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
      VALUES ('delivery-signatures', 'signatures/${D.old}.png', '${USERS.driver}', '{"size": 2400, "mimetype": "image/png"}');`);
}

/** As `authenticated`, each rolled back: returns 'ok|…' or '<sqlstate>|<message>'. */
function probes(readOnly) {
  const run = (stmt, done) => attempt(USERS.admin, asUser(`EXECUTE ${sqlString(stmt)};`) + ` v := '${done}';`);
  return {
    readOnly,
    truncateTable: run('TRUNCATE public.rate_limit_log', 'truncated'),
    truncateView: run('TRUNCATE public.view_unmigrated_products', 'truncated'),
    triggerTable: run('CREATE TRIGGER ttm_t BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', 'created'),
    triggerView: run('CREATE TRIGGER ttm_v INSTEAD OF INSERT ON public.view_unmigrated_products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', 'created'),
    lock: run(`LOCK TABLE public.${readOnly} IN ACCESS EXCLUSIVE MODE`, 'locked'),
    reindex: run('REINDEX TABLE public.app_settings', 'reindexed'),
  };
}
const sqlString = (s) => `'${s.replaceAll("'", "''")}'`;

const status = (k) => `(SELECT status FROM public.orders WHERE id = '${O[k]}')`;
/** The order functions as the signed-in user, each rolled back: returns the status each leaves. */
function flows() {
  const out = {};
  out.price = attempt(USERS.admin, `${asUser(`r := public.price_order('${O.price}', jsonb_build_array(jsonb_build_object('order_item_id', '${OI.price}', 'price', 10)), '${USERS.admin}', 'ttm-price-1');`)}
    v := ${status('price')} || ' ' || coalesce((SELECT pricing_status FROM public.orders WHERE id = '${O.price}'), '<null>') || ' line=' || (SELECT price_per_unit FROM public.order_items WHERE id = '${OI.price}');`);
  out.cancel = attempt(USERS.admin, `${asUser(`r := public.cancel_order('${O.cancel}', '${USERS.admin}', 'ttm-cancel-1');`)} v := ${status('cancel')};`);
  out.voidOrder = attempt(USERS.admin, `${asUser(`r := public.complete_delivery('${D.voidord}', 'No proof — recorded by office', '${USERS.admin}',
      jsonb_build_object('${DI.voidord}', 10), NULL, NULL, 'ttm-complete-voidord', NULL, 'no_proof', '[TTM] no signature taken');`)} t := ${status('voidord')};
    ${asUser(`r2 := public.void_order('${O.voidord}', '${USERS.admin}', '[TTM] wrong order', 'ttm-void-ord-1');`)}
    v := t || ' -> ' || ${status('voidord')};`);
  // Deliveries list "Mark Delivered" without proof is admin-only (NO_PROOF_ADMIN_ONLY).
  out.startAndComplete = attempt(USERS.admin, `${asUser(`r := public.start_and_complete_delivery('${D.sac}', 'No proof — recorded by office', current_date, '${USERS.admin}',
      jsonb_build_object('${DI.sac}', 10), NULL, NULL, 'ttm-sac-1', 'no_proof', '[TTM] no signature taken');`)}
    v := ${status('sac')} || ' ' || (SELECT status FROM public.deliveries WHERE id = '${D.sac}');`);
  // An offline delivery completion carries no evidence, so since 20261022075000 the server keeps it for
  // office review instead of completing it: the function runs and the order is untouched.
  out.offline = attempt(USERS.driver, `${asUser(`r := public.stage_offline_action('${OFFLINE_ACTION}', 'complete_delivery', '${D.offline}', 1, now(),
      jsonb_build_object('signed_by', '[TTM] Customer', 'quantities', jsonb_build_object('${DI.offline}', 10)), 'ttm-offline-1', (SELECT updated_at FROM public.deliveries WHERE id = '${D.offline}'));`)}
    t := r->>'status';
    BEGIN ${asUser(`r2 := public.process_offline_action('${OFFLINE_ACTION}', 'ttm-offline-1');`)} t2 := coalesce(r2->>'status', '<none>');
    EXCEPTION WHEN OTHERS THEN t2 := SQLSTATE || ':' || SQLERRM; END;
    v := 'staged=' || coalesce(t, '<none>') || ' processed=' || t2 || ' ' || ${status('offline')} || ' ' || (SELECT status FROM public.deliveries WHERE id = '${D.offline}')
      || ' receipt=' || (SELECT status || '/' || coalesce(failure_code, '-') FROM public.offline_action_receipts WHERE client_action_id = '${OFFLINE_ACTION}');`);
  out.directStatus = attempt(USERS.admin, asUser(`UPDATE public.orders SET status = 'fulfilled' WHERE id = '${O.direct}';`) + " v := 'updated';");
  out.directNotes = attempt(USERS.admin, asUser(`UPDATE public.orders SET notes = '[TTM] note' WHERE id = '${O.direct}'; GET DIAGNOSTICS n = ROW_COUNT;`) + ' v := n::text;');
  return out;
}

function smokeChain() {
  const chain = lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-delivery_signature_storage_access.sql'));
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1'], { input: chain, allowFailure: true }).stderr;
}

try {
  if (!reuse) buildContainer({ stopBefore: CANDIDATE });
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${STEM}';`), '0', 'the build must stop before the candidate');
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${USERS.admin}';`) === '0') seedUsers();
  psql(STORAGE_RLS, { user: 'supabase_admin' });
  seed();

  // 1. BEFORE: grants as live.
  const generated = scalar(`SELECT md5((${ROLLBACK_QUERY}));`);
  assert.equal(generated, LIVE_ROLLBACK_MD5, 'the rebuilt grants must equal the live read (md5 of the GRANT list)');
  assert.equal(scalar(`SELECT md5(${sqlString(recordRollback().split('\n').filter((l) => l.startsWith('GRANT ')).join('\n'))});`), LIVE_ROLLBACK_MD5,
    'the rollback in the migration record must be exactly the live GRANT list');
  assert.equal(effective(), 462, 'before: 462 role-relation-privilege grants, as live');
  const snapBefore = snapshot();
  // A table authenticated can only read, so LOCK needs MAINTAIN (UPDATE/DELETE/TRUNCATE would also allow it).
  const readOnly = scalar(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('authenticated', c.oid, 'SELECT')
      AND has_table_privilege('authenticated', c.oid, 'MAINTAIN') AND NOT has_table_privilege('authenticated', c.oid, 'UPDATE')
      AND NOT has_table_privilege('authenticated', c.oid, 'DELETE') AND NOT has_table_privilege('authenticated', c.oid, 'TRUNCATE')
    ORDER BY c.relname LIMIT 1;`);
  assert.ok(readOnly, 'a read-only table with MAINTAIN must exist for the LOCK probe');
  const before = probes(readOnly);
  console.log('[ttm] BEFORE', JSON.stringify(before));
  for (const k of ['truncateTable', 'triggerTable', 'triggerView', 'lock', 'reindex']) assert.match(before[k], /^ok\|/, `before: ${k} was allowed`);
  console.log('[ttm] BEFORE grants equal live (462); TRUNCATE, CREATE TRIGGER (table and view), LOCK and REINDEX allowed');

  // 2. A partial apply rolls itself back.
  psql('GRANT TRUNCATE ON public.app_settings TO PUBLIC;');
  const partial = applyCandidate();
  assert.notEqual(partial.status, 0, 'an apply leaving a PUBLIC grant must be refused');
  assert.match(partial.stderr, /REVOKE_TTM_POSTFLIGHT: authenticated or anon still has/);
  psql('REVOKE TRUNCATE ON public.app_settings FROM PUBLIC;');
  assert.equal(snapshot(), snapBefore, 'a refused apply changes nothing');
  psql('CREATE TABLE public.ttm_foreign_owner (id int); ALTER TABLE public.ttm_foreign_owner OWNER TO supabase_admin;', { user: 'supabase_admin' });
  const owned = applyCandidate();
  psql('DROP TABLE public.ttm_foreign_owner;', { user: 'supabase_admin' });
  assert.match(owned.stderr, /REVOKE_TTM_PREFLIGHT: a public table or view is not owned by postgres/);
  assert.equal(snapshot(), snapBefore, 'a refused apply changes nothing');
  console.log('[ttm] a PUBLIC grant makes the postflight refuse and roll back; a foreign-owned table makes the preflight refuse');

  // 3. Apply once; a second apply is harmless.
  const first = applyCandidate();
  assert.equal(first.status, 0, first.stderr);
  const second = applyCandidate();
  assert.equal(second.status, 0, `a second apply only revokes and must succeed: ${second.stderr}`);

  // 4. AFTER.
  assert.equal(effective(), 0, 'after: authenticated and anon hold none of the three on any public relation');
  assert.equal(scalar(`SELECT count(*) ${REL} AND ${TARGET};`), '0');
  const after = probes(readOnly);
  console.log('[ttm] AFTER ', JSON.stringify(after));
  for (const k of ['truncateTable', 'triggerTable', 'triggerView', 'lock', 'reindex']) assert.match(after[k], /^42501\|/, `after: ${k} must be refused`);
  assert.doesNotMatch(after.truncateView, /^ok\|/, 'after: TRUNCATE of a view is refused');
  psql('CREATE TABLE public.ttm_new_table (id int);');
  const fresh = tablePrivs('ttm_new_table');
  psql('DROP TABLE public.ttm_new_table;');
  assert.equal(fresh, 'anon:SELECT,authenticated:DELETE,authenticated:INSERT,authenticated:REFERENCES,authenticated:SELECT,authenticated:UPDATE',
    'after: a table created now as postgres gets only the everyday privileges (REFERENCES as live)');
  console.log(`[ttm] AFTER none held; every probe refused; a new table gets ${fresh}`);

  const done = flows();
  console.log('[ttm] FLOWS ', JSON.stringify(done));
  assert.match(done.price, /^ok\|confirmed /, 'price_order runs and leaves the order confirmed');
  assert.match(done.price, / line=10(\.0+)?$/, 'price_order priced the line');
  assert.equal(done.cancel, 'ok|cancelled');
  assert.equal(done.voidOrder, 'ok|fulfilled -> voided');
  assert.equal(done.startAndComplete, 'ok|fulfilled completed');
  assert.equal(done.offline, 'ok|staged=received processed=needs_review confirmed in_progress receipt=needs_review/PAYLOAD_INVALID',
    'process_offline_action runs to completion as the driver and parks an evidence-less completion for office review');
  assert.match(done.directStatus, /^42501\|permission denied for table orders/, 'a direct status update is still refused');
  assert.equal(done.directNotes, 'ok|1', 'other order columns still save directly');
  console.log('[ttm] price_order, cancel_order, void_order, start_and_complete_delivery and process_offline_action work as the signed-in user');

  assert.match(smokeChain(), /SMOKE_PASS_ROLLBACK/, 'the signature smoke chain (malformed names included) must pass');
  // Backwards: a read rule that matches by prefix must make the malformed-name checks fail.
  const policy = scalar("SELECT regexp_replace(qual, '\\s+', ' ', 'g') FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'delivery_signatures_scoped_select';");
  const loose = policy.replace("(objects.name = (('signatures/'::text || (d.id)::text) || '.png'::text))", "(objects.name ~~ (('signatures/'::text || (d.id)::text) || '%'::text))");
  assert.notEqual(loose, policy, 'the read rule shape changed; update this mutation');
  psql(`ALTER POLICY delivery_signatures_scoped_select ON storage.objects USING (${loose});`, { user: 'supabase_admin' });
  const mutated = smokeChain();
  psql(`ALTER POLICY delivery_signatures_scoped_select ON storage.objects USING (${policy});`, { user: 'supabase_admin' });
  assert.match(mutated, /SMOKE_FAIL: user .* can read malformed signature name/, `a prefix-matching read rule must fail the smoke:\n${mutated}`);
  console.log('[ttm] signature smoke chain passes (malformed names denied, canonical readable); a prefix rule fails it');

  // 5. The reviewed rollback restores every grant and default.
  psql(recordRollback());
  assert.equal(snapshot(), snapBefore, 'the rollback restores every grant and default exactly');
  assert.equal(effective(), 462);
  console.log('[ttm] the rollback in the migration record restores all 462 grants and the defaults');
  console.log('\nREVOKE_TTM_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
