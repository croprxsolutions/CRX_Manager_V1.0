#!/usr/bin/env node
/**
 * Real-schema proof for the MOA-1 group load top-up (20270304100000): on the production
 * baseline plus every replayable migration on disk (Docker), it
 *   - carries exactly the 12 groups Mason approved (fixed answer key below, not read from the SQL),
 *   - run after the main load (20270205150000, stamp order), fills each of its ingredients with
 *     exactly its listed group and one event, and leaves the main load's rows alone,
 *   - never touches an ingredient that already has a group row, nor a retired one,
 *   - writes nothing on a second run,
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
// Mason's approval, 2026-11-24 (docs/manual/decision-log.d/2026-11-24-moa1-topup-list.md), by CAS.
const APPROVED = {
  '1928-43-4': 'HRAC 4', '2921-88-2': 'IRAC 1B', '2300-66-5': 'HRAC 4', '70901-12-1': 'HRAC 9',
  '100784-20-1': 'HRAC 2', '114311-32-9': 'HRAC 2', '101917-66-2': 'HRAC 2', '66423-09-4': 'HRAC 4',
  '51218-45-2': 'HRAC 15', '1910-42-5': 'HRAC 22', '62476-59-9': 'HRAC 14', '1582-09-8': 'HRAC 3',
};
const TYPED = '1582-09-8'; // Trifluralin: an admin already saved a group
const RETIRED = '114311-32-9'; // Imazamox: retired
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const groupsOf = (cas) => scalar(`SELECT coalesce(string_agg(o.scheme || ' ' || o.group_code, ',' ORDER BY o.scheme, o.group_code), '')
  FROM public.active_ingredient_modes_of_action o JOIN public.active_ingredients a ON a.id = o.ingredient_id
 WHERE a.cas = ${q(cas)} AND o.status = 'active';`);
const counts = () => scalar(`SELECT (SELECT count(*) FROM public.active_ingredient_modes_of_action) || '/' ||
  (SELECT count(*) FROM public.active_ingredient_events WHERE reason LIKE 'MOA-1 %group load%');`);
const apply = (sql) => { const r = psql(sql, { allowFailure: true }); assert.equal(r.status, 0, r.stderr); };

try {
  assert.equal(LIST.length, 12);
  assert.deepEqual(Object.fromEntries(LIST.map((r) => [r.cas, r.code])), APPROVED, 'the migration carries exactly the approved groups');
  // The guard keyed on the main load must not mistake the top-up for it (it would refuse: 12 rows, not 123).
  assert.equal(prerequisiteFor(TOPUP.replace(/\.sql$/, ''), TOPUP_SQL), null, 'top-up is not the guarded load');
  assert.ok(prerequisiteFor(LOAD.replace(/\.sql$/, ''), LOAD_SQL), 'the main load is still guarded');
  const loadCas = new Set(rowsOf(LOAD_SQL).map((r) => r.cas));
  assert.ok(LIST.every((r) => !loadCas.has(r.cas)), 'no CAS shared with the main load');

  buildContainer(); seedUsers();
  assert.equal(counts(), '0/0', 'replay with no ingredients wrote nothing');

  // The 12 ingredients as they are on live (name and CAS), plus Atrazine from the main load's list.
  psql(`INSERT INTO public.active_ingredients (name, cas, created_by, updated_by) VALUES ${
    [...LIST, { name: 'Atrazine', cas: '1912-24-9' }].map((r) => `(${q(r.name)}, ${q(r.cas)}, '${USERS.admin}', '${USERS.admin}')`).join(', ')};`);
  psql(`INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
        SELECT id, 'HRAC', '99', 'typed by an admin (proof)', '${USERS.admin}', '${USERS.admin}' FROM public.active_ingredients WHERE cas = '${TYPED}';
        UPDATE public.active_ingredients SET status = 'retired', retire_reason = 'proof' WHERE cas = '${RETIRED}';`);

  apply(LOAD_SQL);
  assert.equal(groupsOf('1912-24-9'), 'HRAC 5', 'main load fills its own Atrazine');
  assert.equal(counts(), '2/1', 'main load added only Atrazine (beside the typed row)');
  console.log('[topup] main load first (stamp order): fills only its own list');

  apply(TOPUP_SQL);
  for (const r of LIST) assert.equal(groupsOf(r.cas), r.cas === TYPED ? 'HRAC 99' : r.cas === RETIRED ? '' : APPROVED[r.cas], r.name);
  assert.equal(groupsOf('1912-24-9'), 'HRAC 5', 'the main load\'s row is left alone');
  assert.equal(counts(), '12/11', '10 new rows; one event per filled ingredient');
  assert.equal(scalar(`SELECT count(*) FROM public.active_ingredient_events
    WHERE reason LIKE 'MOA-1 group load top-up%' AND before_values = '{"modes_of_action": []}'::jsonb
      AND jsonb_array_length(after_values -> 'modes_of_action') = 1;`), '10', 'events: before [], after the new group');
  assert.equal(scalar(`SELECT count(*) FROM public.active_ingredient_modes_of_action
    WHERE source_note LIKE '%MOA-1 top-up list, approved by Mason 2026-11-24' AND row_version = 1;`), '10', 'rollback marker on every row');
  console.log('[topup] top-up: 10 filled with their approved group, typed Trifluralin kept, retired Imazamox untouched');

  apply(TOPUP_SQL);
  assert.equal(counts(), '12/11', 'second run wrote nothing');
  console.log('[topup] second run: nothing written');

  // Imazamox reactivated gets its approved code; Trifluralin's typed group retired (an admin emptied its list) stays empty.
  psql(`UPDATE public.active_ingredient_modes_of_action SET status = 'retired', row_version = row_version + 1
         WHERE source_note = 'typed by an admin (proof)';
        UPDATE public.active_ingredients SET status = 'active', retire_reason = NULL WHERE cas = '${RETIRED}';`);
  apply(TOPUP_SQL);
  assert.equal(groupsOf(RETIRED), APPROVED[RETIRED], 'Imazamox, once active');
  assert.equal(groupsOf(TYPED), '', 'Trifluralin\'s list was emptied by an admin, so it stays empty');
  console.log('[topup] reactivated Imazamox filled; an ingredient that ever had a group row is never refilled');
  console.log('MOA_LOAD_TOPUP_PROOF_PASS');
} finally { removeContainer(); }
