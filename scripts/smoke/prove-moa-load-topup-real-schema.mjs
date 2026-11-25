#!/usr/bin/env node
/**
 * Real-schema proof for the MOA-1 group load top-up (20270304100000): on the production
 * baseline plus every replayable migration on disk (Docker), it
 *   - fills each of its 12 ingredients with exactly its listed group and one event,
 *   - never touches an ingredient that already has a group row, nor a retired one,
 *   - writes nothing on a second run,
 *   - is independent of the main load (20270205150000): each fills only its own list,
 *   - is not mistaken for the main load by the #2193 prerequisite guard.
 *
 * Run: node scripts/smoke/prove-moa-load-topup-real-schema.mjs   (needs Docker)
 * Prints MOA_LOAD_TOPUP_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { prerequisiteFor } from '../../.claude/hooks/migration-prerequisite-lib.mjs';

process.env.UNDO_PATHS_CONTAINER ||= `crx-moa-topup-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, USERS, ROOT } = await import('./undo-paths/harness.mjs');

const dir = path.join(ROOT, 'supabase', 'migrations');
const file = (re) => readdirSync(dir).find((f) => re.test(f));
const TOPUP = file(/^\d{14}_ingredient_modes_of_action_load_topup\.sql$/);
const LOAD = file(/^\d{14}_ingredient_modes_of_action_load\.sql$/);
const TOPUP_SQL = readFileSync(path.join(dir, TOPUP), 'utf8');
const LOAD_SQL = readFileSync(path.join(dir, LOAD), 'utf8');
const rowsOf = (sql) => [...sql.matchAll(/^\s*\('((?:[^']|'')*)', '([0-9-]+)', '(HRAC|IRAC|FRAC)', '(\w+)'/gm)]
  .map((m) => ({ name: m[1].replace(/''/g, "'"), cas: m[2], code: `${m[3]} ${m[4]}` }));
const LIST = rowsOf(TOPUP_SQL);
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const groupsOf = (cas) => scalar(`SELECT coalesce(string_agg(o.scheme || ' ' || o.group_code, ',' ORDER BY o.scheme, o.group_code), '')
  FROM public.active_ingredient_modes_of_action o JOIN public.active_ingredients a ON a.id = o.ingredient_id
 WHERE a.cas = ${q(cas)} AND o.status = 'active';`);
const counts = () => scalar(`SELECT (SELECT count(*) FROM public.active_ingredient_modes_of_action) || '/' ||
  (SELECT count(*) FROM public.active_ingredient_events WHERE reason LIKE 'MOA-1 group load%');`);

try {
  // The guard keyed on the main load must not mistake the top-up for it (it would refuse: 12 rows, not 123).
  assert.equal(LIST.length, 12);
  assert.equal(prerequisiteFor(TOPUP.replace(/\.sql$/, ''), TOPUP_SQL), null, 'top-up is not the guarded load');
  assert.ok(prerequisiteFor(LOAD.replace(/\.sql$/, ''), LOAD_SQL), 'the main load is still guarded');
  const loadCas = new Set(rowsOf(LOAD_SQL).map((r) => r.cas));
  assert.ok(LIST.every((r) => !loadCas.has(r.cas)), 'no CAS shared with the main load');

  buildContainer(); seedUsers();
  assert.equal(counts(), '0/0', 'replay with no ingredients wrote nothing');

  // The 12 ingredients as they are on live (name and CAS), plus Atrazine from the main load's list.
  psql(`INSERT INTO public.active_ingredients (name, cas, created_by, updated_by) VALUES ${
    [...LIST, { name: 'Atrazine', cas: '1912-24-9' }].map((r) => `(${q(r.name)}, ${q(r.cas)}, '${USERS.admin}', '${USERS.admin}')`).join(', ')};`);
  // Trifluralin already has a group someone saved (never overwritten); Imazamox is retired (never touched).
  psql(`INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
        SELECT id, 'HRAC', '99', 'typed by an admin (proof)', '${USERS.admin}', '${USERS.admin}' FROM public.active_ingredients WHERE cas = '1582-09-8';
        UPDATE public.active_ingredients SET status = 'retired', retire_reason = 'proof' WHERE cas = '114311-32-9';`);

  const run = psql(TOPUP_SQL, { allowFailure: true });
  assert.equal(run.status, 0, run.stderr);
  for (const r of LIST) {
    const want = r.cas === '1582-09-8' ? 'HRAC 99' : r.cas === '114311-32-9' ? '' : r.code;
    assert.equal(groupsOf(r.cas), want, `${r.name}`);
  }
  assert.equal(groupsOf('1912-24-9'), '', 'the main load\'s Atrazine is not the top-up\'s to fill');
  assert.equal(counts(), '11/10', '10 rows + the typed one; one event per filled ingredient');
  assert.equal(scalar(`SELECT count(*) FROM public.active_ingredient_events
    WHERE reason LIKE 'MOA-1 group load top-up%' AND before_values = '{"modes_of_action": []}'::jsonb
      AND jsonb_array_length(after_values -> 'modes_of_action') = 1;`), '10', 'events: before [], after the new group');
  assert.equal(scalar(`SELECT count(*) FROM public.active_ingredient_modes_of_action
    WHERE source_note LIKE '%MOA-1 top-up list, approved by Mason 2026-11-24' AND row_version = 1;`), '10', 'rollback marker on every row');
  console.log('[topup] first run: 10 filled with their listed group, typed Trifluralin kept, retired Imazamox untouched');

  const again = psql(TOPUP_SQL, { allowFailure: true });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(counts(), '11/10', 'second run wrote nothing');
  console.log('[topup] second run: nothing written');

  const load = psql(LOAD_SQL, { allowFailure: true });
  assert.equal(load.status, 0, load.stderr);
  assert.equal(groupsOf('1912-24-9'), 'HRAC 5', 'main load fills its own Atrazine');
  assert.equal(counts(), '12/11', 'main load added only Atrazine');
  for (const r of LIST) if (!['1582-09-8', '114311-32-9'].includes(r.cas)) assert.equal(groupsOf(r.cas), r.code);
  console.log('[topup] main load afterwards: fills only its own list, top-up rows unchanged');
  console.log('MOA_LOAD_TOPUP_PROOF_PASS');
} finally { removeContainer(); }
