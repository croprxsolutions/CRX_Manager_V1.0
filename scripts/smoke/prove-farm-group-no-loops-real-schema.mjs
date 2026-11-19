#!/usr/bin/env node
/**
 * Real-schema proof for 20270127200000_ki146_farm_group_no_loops.sql (KI-146).
 * Contract: docs/plans/2026-11-18-ki146-farm-group-loops-CONTRACT.md (proof cases 1-8, plus the two-session race).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), seeds A > B > C, A > E and an unrelated D, then as the signed-in admin
 * (role authenticated) checks every refusal and allowed change, save_customer's message, the farm-group read,
 * a forced loop, a non-office caller, and two sessions re-parenting into each other at once.
 *
 * Run: node scripts/smoke/prove-farm-group-no-loops-real-schema.mjs   (needs Docker; never touches live)
 * Prints FARM_GROUP_NO_LOOPS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, scalar, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270127200000_ki146_farm_group_no_loops.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
// A psql session that runs alongside others (spawnSync would freeze Node while another session still has input queued).
const session = (sql) => new Promise((resolve) => {
  const child = spawn('docker', PSQL, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stderr }));
  child.stdin.end(sql);
});
const sleeping = async () => {
  for (let i = 0; i < 50 && scalar("SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep';") === '0'; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // The race only proves something if the first session really is mid-transaction when the second starts.
  assert.notEqual(scalar("SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep';"), '0', 'first session never reached its sleep');
};
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });

const [A, B, C, D, E] = ['f1', 'f2', 'f3', 'f4', 'f5'].map(id);
const NAMES = { [A]: 'A', [B]: 'B', [C]: 'C', [D]: 'D', [E]: 'E' };
const admin = USERS.admin;
const LOOP = 'Nothing was saved. The chosen parent customer is already below this customer in its farm group, so it cannot be its parent. Choose a customer that is not below this one, or clear the parent.';
const ok = (body) => { const out = attempt(admin, body); assert.ok(out.startsWith('ok|'), out); return out.slice(3); };
const setParent = (child, parent) => `UPDATE public.customers SET parent_customer_id = ${parent ? `'${parent}'` : 'NULL'} WHERE id = '${child}';`;
const refused = (stmt) => ok(`${refuse(stmt)} v := t;`);
const allowed = (stmt) => ok(`${asUser(stmt)} v := 'saved';`);
const group = (who, customer) => attempt(who, `${asUser(`v := (SELECT string_agg(
    CASE id ${Object.entries(NAMES).map(([k, n]) => `WHEN '${k}' THEN '${n}'`).join(' ')} ELSE '?' END || CASE WHEN is_parent THEN '*' ELSE '' END, ',' ORDER BY farm_name)
    FROM public.get_customer_farm_group('${customer}'));`)}`);

try {
  buildContainer({ stopBefore: CANDIDATE });

  const auto = apply();
  assert.notEqual(auto.status, 0, 'autocommit apply must be refused');
  assert.match(auto.stderr, /PREFLIGHT_FAIL/);
  const first = apply(['-1']);
  assert.equal(first.status, 0, `apply failed:\n${first.stderr}`);
  assert.match(first.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.notEqual(again.status, 0, 're-apply must be refused');
  assert.match(again.stderr, /KI146_BASELINE_DRIFT/);

  seedUsers();
  // Real inserts (trigger on): a valid parent on INSERT is allowed.
  seed('ki146', `INSERT INTO public.customers (id, farm_name) VALUES ('${A}', 'Alpha Farms'), ('${D}', 'Delta Farms');
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${B}', 'Bravo Farms', '${A}'), ('${E}', 'Echo Farms', '${A}');
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${C}', 'Charlie Farms', '${B}');`);

  // 1. Its own parent: refused, on UPDATE and on INSERT.
  assert.match(refused(setParent(A, A)), /^Nothing was saved\. A customer cannot be its own parent customer\.$/);
  assert.match(refused(`INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${id('f9')}', 'Self', '${id('f9')}');`), /cannot be its own parent/);
  // 2. A child or a grandchild as the parent: refused, naming both farms.
  assert.equal(refused(setParent(A, B)), LOOP);
  assert.equal(refused(setParent(A, C)), LOOP);
  assert.equal(refused(setParent(B, C)), LOOP);
  // One multi-row insert whose rows name each other (neither stored when the first row is checked): refused, nothing kept.
  const [P, Q, R] = [id('fa'), id('fb'), id('fc')];
  assert.equal(refused(`INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${P}', 'P', '${Q}'), ('${Q}', 'Q', '${P}');`), LOOP);
  assert.equal(refused(`INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${P}', 'P', '${Q}'), ('${Q}', 'Q', '${R}'), ('${R}', 'R', '${P}');`), LOOP);
  // Rewriting ids (the API may update customers.id): rename A away and C to A in one statement, which would make
  // B's parent the old C row (C > B > A, a loop). The guard (BEFORE ROW) refuses it before any key check; nothing changes.
  assert.equal(refused(`UPDATE public.customers SET id = CASE id WHEN '${A}'::uuid THEN '${id('fd')}'::uuid ELSE '${A}'::uuid END WHERE id IN ('${A}', '${C}');`), LOOP);
  // A parent change outside READ COMMITTED is refused (its snapshot could miss a concurrent change); a clear still saves.
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
    const rr = docker(PSQL, { input: `BEGIN ISOLATION LEVEL ${level}; ${setParent(D, E)} ROLLBACK;`, allowFailure: true });
    assert.notEqual(rr.status, 0, `${level} parent change must be refused`);
    assert.ok(rr.stderr.includes('Parent customer changes must run at READ COMMITTED isolation.'), rr.stderr);
    assert.equal(docker(PSQL, { input: `BEGIN ISOLATION LEVEL ${level}; ${setParent(B, null)} ROLLBACK;`, allowFailure: true }).status, 0);
  }
  // A legal forward reference in one insert saves.
  assert.equal(allowed(`INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES ('${P}', 'P', '${Q}'), ('${Q}', 'Q', NULL);`), 'saved');
  // 3. Valid changes save: an unrelated parent, moving under a sibling, clearing the parent.
  assert.equal(allowed(setParent(D, A)), 'saved');
  assert.equal(allowed(setParent(C, E)), 'saved');
  assert.equal(allowed(setParent(B, null)), 'saved');
  assert.equal(allowed(setParent(A, D)), 'saved'); // D is unrelated to A's group

  // 5. Through save_customer as the admin, with the screen's payload shape: refused with the readable message.
  const payload = (c, parent) => `jsonb_build_object('farm_name', (SELECT farm_name FROM public.customers WHERE id = '${c}'),
    'row_version_expected', (SELECT row_version FROM public.customers WHERE id = '${c}'), 'parent_customer_id', '${parent}')`;
  assert.equal(refused(`PERFORM public.save_customer('${A}', ${payload(A, C)}, '[]'::jsonb, '${admin}', 'ki146-sc-loop');`), LOOP);
  assert.equal(ok(`${refuse(`PERFORM public.save_customer('${A}', ${payload(A, C)}, '[]'::jsonb, '${admin}', 'ki146-sc-loop2');`)}
    v := (SELECT coalesce(parent_customer_id::text, '-') FROM public.customers WHERE id = '${A}');`), '-');
  assert.equal(ok(`${asUser(`r := public.save_customer('${D}', ${payload(D, E)}, '[]'::jsonb, '${admin}', 'ki146-sc-ok');`)}
    v := (SELECT parent_customer_id::text FROM public.customers WHERE id = '${D}');`), E);

  // 6. Farm group: the top parent and every descendant, grandchildren included, only the top marked.
  assert.equal(group(admin, A), 'ok|A*,B,C,E');
  assert.equal(group(admin, C), 'ok|A*,B,C,E');
  assert.equal(group(admin, E), 'ok|A*,B,C,E');
  assert.equal(group(admin, D), 'ok|D*');
  assert.equal(group(USERS.rep, C), 'ok|A*,B,C,E');
  assert.equal(group(admin, id('ff')), 'ok|<null>'); // an unknown customer: no rows, as before

  // 7 + 4. A loop forced in past the trigger: the read still ends, and saving a looped customer's other fields works.
  const forced = `SET LOCAL session_replication_role = replica; ${setParent(A, C)} SET LOCAL session_replication_role = origin;`;
  assert.equal(ok(`${forced} SET LOCAL statement_timeout = '5s';
    v := (SELECT string_agg(id::text, ',' ORDER BY id::text) FROM public.get_customer_farm_group('${B}'));`), [A, B, C, E].sort().join(','));
  // save_customer writes parent_customer_id on every save (so the trigger fires); an unchanged parent passes.
  assert.equal(ok(`${forced} ${asUser(`r := public.save_customer('${B}', ${payload(B, A)} || '{"phone":"555-0100"}'::jsonb, '[]'::jsonb, '${admin}', 'ki146-sc-same');`)}
    v := (SELECT phone FROM public.customers WHERE id = '${B}');`), '555-0100');

  // 8. Non-office callers are still refused the farm-group read.
  assert.equal(group(USERS.driver, A), 'P0001|Permission denied: requires admin or sales_rep role');

  // Race: two sessions re-parent X under Y and Y under X at once. The second waits, then is refused.
  const [X, Y] = [id('f6'), id('f7')];
  docker(PSQL, { input: `INSERT INTO public.customers (id, farm_name) VALUES ('${X}', 'Xray Farms'), ('${Y}', 'Yankee Farms');` });
  const slow = session(`BEGIN; UPDATE public.customers SET parent_customer_id = '${Y}' WHERE id = '${X}'; SELECT pg_sleep(4); COMMIT;`);
  await sleeping(); // the first session holds the lock
  const second = await session(`UPDATE public.customers SET parent_customer_id = '${X}' WHERE id = '${Y}';`);
  const firstRace = await slow;
  assert.equal(firstRace.status, 0, `firstRace session failed: ${firstRace.stderr}`);
  assert.notEqual(second.status, 0, 'the second re-parent must be refused');
  assert.ok(second.stderr.includes(LOOP), second.stderr);
  assert.equal(scalar(`SELECT coalesce(parent_customer_id::text, '-') FROM public.customers WHERE id = '${Y}';`), '-');
  assert.equal(scalar(`SELECT parent_customer_id::text FROM public.customers WHERE id = '${X}';`), Y);

  // No deadlock between two valid saves: S1 holds G's row FOR UPDATE (as save_customer does), then moves G under H;
  // meanwhile S2 moves F under G (its foreign-key lock on G must wait BEFORE it takes the shared lock). Both save.
  const [F, G, H] = [id('e1'), id('e2'), id('e3')];
  docker(PSQL, { input: `INSERT INTO public.customers (id, farm_name) VALUES ('${F}', 'F'), ('${G}', 'G'), ('${H}', 'H');` });
  const holding = session(`BEGIN; SELECT 1 FROM public.customers WHERE id = '${G}' FOR UPDATE; SELECT pg_sleep(3);
    UPDATE public.customers SET parent_customer_id = '${H}' WHERE id = '${G}'; COMMIT;`);
  await sleeping();
  const mover = await session(`UPDATE public.customers SET parent_customer_id = '${G}' WHERE id = '${F}';`);
  const holder = await holding;
  assert.equal(holder.status, 0, `holder failed: ${holder.stderr}`);
  assert.equal(mover.status, 0, `the valid move failed: ${mover.stderr}`);
  assert.equal(scalar(`SELECT string_agg(farm_name || '>' || coalesce((SELECT p.farm_name FROM public.customers p WHERE p.id = c.parent_customer_id), '-'), ',' ORDER BY farm_name) FROM public.customers c WHERE id IN ('${F}', '${G}', '${H}');`), 'F>G,G>H,H>-');

  console.log('FARM_GROUP_NO_LOOPS_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
