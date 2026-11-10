#!/usr/bin/env node
/**
 * Real-schema proof for 20261129100000_deliveries_read_rules_check_role_once.sql. Builds the checked-in baseline
 * plus every post-baseline migration on this checkout (the candidate included) in a network-disabled PostgreSQL
 * container (scripts/smoke/undo-paths/harness.mjs), seeds deliveries and items, then checks:
 *   - del_select and del_items_select now read the role once per query, and every other deliveries and
 *     delivery_items rule is exactly as live had it (2026-11-06);
 *   - for an admin, a sales rep, a driver, an applicator and a deactivated sales rep, the deliveries and items
 *     each can read are identical under the new rules and the old ones (put back in a rolled-back transaction);
 *   - at 60,000 deliveries (rolled back) a sales rep reads deliveries and items at least 3x faster than under
 *     the old rules;
 *   - a second apply is refused by the preflight.
 *
 * Run: node scripts/smoke/prove-deliveries-read-rules-real-schema.mjs   (needs Docker; never touches live)
 * Prints DELIVERIES_READ_RULES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261129100000_deliveries_read_rules_check_role_once.sql';
const reuse = process.env.DELIVERIES_READ_RULES_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const OFF_REP = id('a5');
const OLD = {
  del_select: '(is_admin() OR is_sales_rep() OR (assigned_driver = ( SELECT auth.uid() AS uid)))',
  del_items_select: '(is_admin() OR is_sales_rep() OR (EXISTS ( SELECT 1\n   FROM deliveries d\n  WHERE ((d.id = delivery_items.delivery_id) AND (d.assigned_driver = ( SELECT auth.uid() AS uid))))))',
};
const NEW = {
  del_select: '(( SELECT is_admin() AS is_admin) OR ( SELECT is_sales_rep() AS is_sales_rep) OR (assigned_driver = ( SELECT auth.uid() AS uid)))',
  del_items_select: '(( SELECT is_admin() AS is_admin) OR ( SELECT is_sales_rep() AS is_sales_rep) OR (EXISTS ( SELECT 1\n   FROM deliveries d\n  WHERE ((d.id = delivery_items.delivery_id) AND (d.assigned_driver = ( SELECT auth.uid() AS uid))))))',
};
// Every other rule on the two tables, as live had it on 2026-11-06 (read-only pg_policies read).
const OTHERS = [
  'deliveries|del_delete|DELETE|{authenticated}|PERMISSIVE|is_admin()|',
  'deliveries|del_insert|INSERT|{authenticated}|PERMISSIVE||(is_admin() OR is_sales_rep())',
  "deliveries|del_update|UPDATE|{authenticated}|PERMISSIVE|(is_admin() OR is_sales_rep() OR ((assigned_driver = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text]))))|(is_admin() OR is_sales_rep() OR ((assigned_driver = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text]))))",
  'delivery_items|del_items_delete|DELETE|{authenticated}|PERMISSIVE|(is_admin() OR is_sales_rep())|',
  'delivery_items|del_items_insert|INSERT|{authenticated}|PERMISSIVE||(is_admin() OR is_sales_rep())',
  'delivery_items|del_items_update|UPDATE|{authenticated}|PERMISSIVE|is_admin()|is_admin()',
];
const lit = (s) => `E'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
const restoreOld = `
  ALTER POLICY del_select ON public.deliveries USING (is_admin() OR is_sales_rep() OR (assigned_driver = (SELECT auth.uid())));
  ALTER POLICY del_items_select ON public.delivery_items USING (is_admin() OR is_sales_rep() OR EXISTS (
    SELECT 1 FROM public.deliveries d WHERE d.id = delivery_items.delivery_id AND d.assigned_driver = (SELECT auth.uid())));`;

const probe = (uid, body) => {
  const out = attempt(uid, body);
  assert.ok(out.startsWith('ok|'), `probe as ${uid} failed: ${out}`);
  return out.slice(3);
};
/** What `uid` can read, as one string: delivery count, delivery ids hash, item count, item ids hash. */
const SEEN = `${asUser(`v := concat_ws('|',
  (SELECT count(*) FROM public.deliveries), (SELECT md5(COALESCE(string_agg(id::text, ',' ORDER BY id), '')) FROM public.deliveries),
  (SELECT count(*) FROM public.delivery_items), (SELECT md5(COALESCE(string_agg(id::text, ',' ORDER BY id), '')) FROM public.delivery_items));`)}`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${OFF_REP}', 'rules-off-rep@example.invalid', '{"full_name":"[RULES] Off Rep","role":"sales_rep"}'::jsonb);
    SET session_replication_role = replica; UPDATE public.profiles SET is_active = false WHERE id = '${OFF_REP}'; SET session_replication_role = origin;`);
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { allowFailure: true, input: `
SET session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES ('7c7a0000-0000-4000-9000-00000000c001', '[RULES] Farm');
INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver)
SELECT 'RL-' || lpad(g::text, 5, '0'), gen_random_uuid(), '7c7a0000-0000-4000-9000-00000000c001', '${USERS.admin}', date '2026-06-15' - g % 40,
       (ARRAY['scheduled','in_progress','completed','cancelled','voided'])[1 + g % 5],
       (ARRAY['${USERS.driver}'::uuid, NULL, '${USERS.admin}'::uuid, '${USERS.applicator}'::uuid])[1 + g % 4]
FROM generate_series(1, 1200) g;
INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity)
SELECT d.id, gen_random_uuid(), gen_random_uuid(), 1 FROM public.deliveries d, generate_series(1, 3) k
 WHERE d.delivery_number LIKE 'RL-%' AND k <= 1 + right(d.delivery_number, 1)::int % 3;
SET session_replication_role = origin;` });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar("SELECT count(*) FROM public.deliveries WHERE delivery_number LIKE 'RL-%';") === '0') seed();

  // 1. The two read rules changed as intended; every other rule is untouched.
  for (const [name, qual] of Object.entries(NEW)) {
    assert.equal(scalar(`SELECT qual = ${lit(qual)} FROM pg_policies WHERE schemaname = 'public' AND policyname = '${name}' AND cmd = 'SELECT' AND roles = '{authenticated}'::name[] AND permissive = 'PERMISSIVE';`), 't', `${name}: new rule text`);
  }
  const others = scalar(`SELECT string_agg(concat_ws('|', tablename, policyname, cmd, roles::text, permissive, COALESCE(qual, ''), COALESCE(with_check, '')), E'\\x1e' ORDER BY tablename, policyname)
    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('deliveries', 'delivery_items') AND policyname NOT IN ('del_select', 'del_items_select');`);
  assert.deepEqual(others.split('\x1e'), OTHERS, 'the other deliveries and delivery_items rules must be unchanged');
  assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('deliveries', 'delivery_items');"), '8');
  console.log('[read-rules] del_select and del_items_select check the role once; the 6 other rules unchanged');

  // 2. Every role reads exactly the same rows under the new rules as under the old ones.
  const users = { admin: USERS.admin, rep: USERS.rep, driver: USERS.driver, applicator: USERS.applicator, deactivated_rep: OFF_REP };
  const seen = {};
  const full = {};
  for (const [role, uid] of Object.entries(users)) {
    const now = probe(uid, SEEN);
    const before = probe(uid, `${restoreOld} ${SEEN}`);
    assert.equal(now, before, `${role}: reads different rows under the new rules (${now}) than the old (${before})`);
    full[role] = now;
    seen[role] = now.split('|').filter((_, i) => i % 2 === 0).join('/');
  }
  assert.equal(full.rep, full.admin, 'a sales rep reads exactly the rows an admin reads');
  assert.notEqual(seen.driver, seen.admin, 'a driver reads only their own');
  assert.equal(seen.deactivated_rep.split('/')[0], scalar(`SELECT count(*) FROM public.deliveries WHERE assigned_driver = '${OFF_REP}';`), 'a deactivated rep reads only deliveries assigned to them');
  console.log(`[read-rules] same rows before and after for every role (deliveries/items): ${JSON.stringify(seen)}`);

  // 3. Speed at 60,000 deliveries (rolled back): a sales rep's full read of both tables, new rules vs old.
  const ms = (label, stmt) => `f0 := clock_timestamp(); ${asUser(stmt)} t := concat_ws(',', t, '${label}=' || round(extract(epoch FROM clock_timestamp() - f0::timestamptz) * 1000));`;
  const reads = (tag) => `${ms(`${tag}_del`, 'n := (SELECT count(*) FROM public.deliveries);')} ${ms(`${tag}_items`, 'n := (SELECT count(*) FROM public.delivery_items);')}`;
  const timed = probe(USERS.rep, `
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver)
    SELECT 'RLV-' || lpad(g::text, 6, '0'), gen_random_uuid(), '7c7a0000-0000-4000-9000-00000000c001', '${USERS.admin}', date '2026-06-15' - g % 1500,
           'completed', (ARRAY['${USERS.driver}'::uuid, NULL])[1 + g % 2] FROM generate_series(1, 60000) g;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity)
    SELECT d.id, gen_random_uuid(), gen_random_uuid(), 1 FROM public.deliveries d, generate_series(1, 3) k
     WHERE d.delivery_number LIKE 'RLV-%' AND k <= 1 + right(d.delivery_number, 1)::int % 3;
    SET LOCAL session_replication_role = origin;
    ANALYZE public.deliveries; ANALYZE public.delivery_items;
    ${reads('warm')} ${reads('new')} ${restoreOld} ${reads('old')}
    v := t;`);
  const times = Object.fromEntries(timed.split(',').map((kv) => kv.split('=')).map(([k, n]) => [k, Number(n)]));
  console.log(`[read-rules] sales rep, 60,000 deliveries, ms: ${JSON.stringify(times)}`);
  for (const k of ['del', 'items']) {
    assert.ok(times[`new_${k}`] * 3 < times[`old_${k}`], `${k}: new rules ${times[`new_${k}`]} ms is not 3x faster than old ${times[`old_${k}`]} ms`);
  }

  // 4. A second apply is refused by the preflight.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/rules-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/rules-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /READ_RULES_PREFLIGHT/);
  console.log('[read-rules] second apply refused by the preflight');
  console.log('\nDELIVERIES_READ_RULES_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
