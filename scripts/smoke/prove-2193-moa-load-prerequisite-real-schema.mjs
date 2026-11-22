#!/usr/bin/env node
/**
 * Real-schema proof for #2193: the live-apply prerequisite check for the
 * modes-of-action load runs its count query against the real schema (production
 * baseline plus the replayable migrations on disk, in Docker; the image may be pulled once) and
 *   - refuses while the EPA batch fill has not run (no active ingredients),
 *   - refuses one short of the threshold,
 *   - allows once enough of the list's ingredients exist.
 * The live read is swapped for psql in the container; everything else is the
 * code apply-migration-file.mjs runs.
 *
 * Run: node scripts/smoke/prove-2193-moa-load-prerequisite-real-schema.mjs   (needs Docker)
 * Prints MOA_LOAD_PREREQUISITE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { checkLivePrerequisite, MOA_MIN_MATCHED } from '../../.claude/hooks/migration-prerequisite-lib.mjs';

process.env.UNDO_PATHS_CONTAINER ||= `crx-2193-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, USERS, ROOT } = await import('./undo-paths/harness.mjs');

const LOAD = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((f) => /^\d{14}_ingredient_modes_of_action_load\.sql$/.test(f)).replace(/\.sql$/, '');
const SQL = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${LOAD}.sql`), 'utf8');
// Distinct CAS numbers on the load's list, in list order.
const CAS = [...new Set([...SQL.matchAll(/^\s*\('(?:[^']|'')*', '([0-9-]+)', '(?:HRAC|IRAC|FRAC)'/gm)].map((m) => m[1]))];

const dbFetch = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  const out = scalar(`SELECT json_agg(t) FROM (${query.replace(/;\s*$/, '')}) t;`);
  return { ok: true, status: 200, json: async () => JSON.parse(out) };
};
const check = () => checkLivePrerequisite({ fetchImpl: dbFetch, projectId: 'local', token: 'none', name: LOAD, sql: SQL });
const seedIngredients = (list, from) => psql(`INSERT INTO public.active_ingredients (name, cas, created_by, updated_by) VALUES ${
  list.map((cas, i) => `('[2193] ingredient ${from + i}', '${cas}', '${USERS.admin}', '${USERS.admin}')`).join(', ')};`);

try {
  buildContainer(); seedUsers();
  console.log(`[2193] the load lists ${CAS.length} distinct CAS numbers; threshold ${MOA_MIN_MATCHED} of 123 rows`);

  const before = await check();
  assert.equal(before.ok, false);
  console.log(`[2193] before the fill (${scalar("SELECT count(*) FROM public.active_ingredients WHERE status = 'active';")} active ingredients): REFUSED: ${before.reason}`);

  // Add ingredients one CAS at a time until the count reaches the threshold: the
  // count just below it is refused, the count at it is allowed.
  let added = 0, last = before;
  while (last.matched < MOA_MIN_MATCHED) {
    const prev = last;
    seedIngredients([CAS[added]], added); added += 1;
    last = await check();
    if (last.matched >= MOA_MIN_MATCHED) {
      assert.equal(prev.ok, false);
      console.log(`[2193] at ${prev.matched} matched: REFUSED (one CAS short)`);
    }
  }
  assert.equal(last.ok, true, last.reason);
  console.log(`[2193] after ${added} ingredients: ALLOWED: ${last.matched} of ${last.listed} list rows match`);

  seedIngredients(CAS.slice(added), added);
  const all = await check();
  assert.equal(all.ok, true);
  console.log(`[2193] every list CAS present: ALLOWED: ${all.matched} of ${all.listed}`);
  console.log('MOA_LOAD_PREREQUISITE_PROOF_PASS');
} finally { removeContainer(); }
