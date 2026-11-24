#!/usr/bin/env node
/**
 * Real-schema proof for 20270228190000_rate_switch_recheck (#2379, #1813; contract
 * docs/plans/2026-11-23-product-RT4a-cutover-button-CONTRACT.md, amendment "Re-check at the switch", cases R1 to R8).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate (the shared undo-paths harness, so the RT-4a switch and its
 * 20270227160000 planner are in place), creates invented groups through the real parent RPCs while rates are
 * unlocked, puts approved RT-3 rows, outcomes and EPA label maximums in place, turns the rate lock on, applies the
 * candidate (a second run refuses), then checks each case through the real RPCs as a signed-in admin, a sales rep and
 * anon. Refusal probes run in rolled-back transactions.
 *
 * Run: node scripts/smoke/prove-rate-switch-recheck-real-schema.mjs   (needs Docker)
 * Prints RATE_SWITCH_RECHECK_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-rsr-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, claims, USERS, ROOT, NAME, docker } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270228190000_rate_switch_recheck.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const REP = USERS.rep;
const sq = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const raw = (sql) => psql(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`, { user: 'supabase_admin' });
const runCandidate = () => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
  { input: candidate, allowFailure: true });

// name, EPA number, label maximum (fl oz/acre). Every group: liquid, one Gal size at $30, old rate 48 oz, approved
// default 40 fl oz/acre.
const GROUPS = [
  ['Over', '100-1', 32],      // the approved 40 is above a 32 maximum
  ['Within', '100-2', 64],
  ['Lowered', '100-3', 64],   // lowered to 32 between preview and commit
  ['FormChanged', null, null], // a second approved row in lb no longer fits a liquid group
  ['Unconfirmed', null, null], // a second approved row whose basis is no longer confirmed
];

const MK = `
CREATE SCHEMA IF NOT EXISTS rsr_proof;
CREATE TABLE IF NOT EXISTS rsr_proof.ids (name text PRIMARY KEY, parent uuid NOT NULL, product uuid NOT NULL);
CREATE OR REPLACE FUNCTION rsr_proof.mk(p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_parent uuid; v_prev jsonb;
BEGIN
  r := public.create_product_with_parent(jsonb_build_object('name', '[RSR] ' || p_name, 'product_form', 'liquid'),
    jsonb_build_object('product_name', '[RSR] ' || p_name || ' 1', 'sku', 'RSR-' || left(md5(p_name), 10), 'inventory_unit', 'Gal'), 'rsr-mk-' || p_name);
  v_parent := (r->>'parent_id')::uuid;
  INSERT INTO rsr_proof.ids VALUES (p_name, v_parent, (r->>'product_id')::uuid);
END $$;
CREATE OR REPLACE FUNCTION rsr_proof.rates(p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_parent uuid := (SELECT parent FROM rsr_proof.ids WHERE name = p_name); v_prev jsonb;
BEGIN
  v_prev := public.preview_parent_rates(v_parent, 48, 'oz', NULL);
  PERFORM public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', v_parent,
    'expected_parent_version', (v_prev->>'parent_version')::bigint, 'rate_per_acre', '48', 'rate_unit', 'oz',
    'suggested_rate', NULL, 'sizes', v_prev->'sizes')), 'rsr-rates-' || p_name);
END $$;`;

const P = {};
const ok = (out) => { assert.match(out, /^ok\|/, out); return out.slice(3); };
const okJson = (out) => JSON.parse(ok(out));
const refused = (out, pattern) => { assert.doesNotMatch(out, /^ok\|/, `expected a refusal, got ${out}`); assert.match(out, pattern, out); };
const row = (sql) => scalar(sql);
const md5Of = (table) => scalar(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM public.${table} t;`);
const overArg = (over) => (over === undefined ? '' : `, p_over_label_reason => ${sq(over)}`);
const preview = (parent, dir, { uid = ADMIN, over } = {}) =>
  attempt(uid, `${asUser(`r := public.preview_parent_rate_cutover('${parent}', ${sq(dir)}${overArg(over)});`)} v := r::text;`);
const previewJson = (...args) => okJson(preview(...args));
const ineligible = (parent, dir, pattern, opts) => {
  const r = previewJson(parent, dir, opts);
  assert.equal(r.eligible, false, `${parent} ${dir} should be refused: ${JSON.stringify(r)}`);
  assert.match(r.refusal, pattern, r.refusal);
};
// Preview then commit in one transaction. `previewOver` is the over-label reason sent to the preview, `over` to commit;
// `between` is SQL run (as postgres) after the preview and before the commit.
const cutover = (parent, dir, key, { uid = ADMIN, reason = 'RSR test', over, previewOver = over, between = '', commit = false } = {}) => attempt(uid,
  `${asUser(`r := public.preview_parent_rate_cutover('${parent}', ${sq(dir)}${overArg(previewOver)});`)}
   ${between}
   ${asUser(`r2 := public.commit_parent_rate_cutover('${parent}', ${sq(dir)}, r->'expected', ${sq(reason)}, ${sq(key)}${overArg(over)});`)}
   v := jsonb_build_object('preview', r, 'receipt', r2)::text;`, { commit });
const go = (...args) => okJson(cutover(...args));

function seedFixtures() {
  seedUsers();
  raw('UPDATE public.product_rate_lock SET is_locked = false WHERE id;');
  psql(MK);
  for (const [name] of GROUPS) {
    ok(attempt(ADMIN, `PERFORM rsr_proof.mk(${sq(name)});`, { commit: true }));
  }
  for (const line of row("SELECT string_agg(name || '=' || parent || '=' || product, ';') FROM rsr_proof.ids;").split(';')) {
    const [name, parent, product] = line.split('=');
    P[name] = parent; P[`${name}Size`] = product;
  }
  raw(GROUPS.map(([name]) => `UPDATE public.products SET tier1_price = 30, tier2_price = 30, tier3_price = 30 WHERE id = '${P[`${name}Size`]}';`).join('\n'));
  for (const [name] of GROUPS) ok(attempt(ADMIN, `PERFORM rsr_proof.rates(${sq(name)});`, { commit: true }));
  const rates = []; const regs = [];
  for (const [name, epa, max] of GROUPS) {
    rates.push(`('${P[name]}', 'per_acre', 'house_standard', 40, 'fl_oz', true, true)`);
    if (epa) regs.push(`('${epa}', ${max}, 'fl oz/acre', '${ADMIN}', '${ADMIN}')`);
  }
  // Rows an approval would have refused, as they look after the group's form changed (lb on a liquid group) or the
  // basis lost its confirmation.
  rates.push(`('${P.FormChanged}', 'per_100_gal', 'label', 1, 'lb', false, true)`);
  rates.push(`('${P.Unconfirmed}', 'per_100_gal', 'label', 1, 'qt', false, false)`);
  raw(`INSERT INTO public.epa_registrations (epa_registration, max_label_rate, max_label_rate_unit, created_by, updated_by) VALUES ${regs.join(',\n')};
    ${GROUPS.filter(([, epa]) => epa).map(([name, epa]) => `UPDATE public.product_parents SET generic_epa_registration = '${epa}' WHERE id = '${P[name]}';`).join('\n')}
    INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, is_quoting_default, basis_confirmed, status, approved_by, approved_at, origin, created_by, updated_by)
      SELECT v.parent::uuid, v.basis, v.source, v.rec, v.unit, v.dflt, v.conf, 'approved', '${ADMIN}', now(), 'manual', '${ADMIN}', '${ADMIN}'
        FROM (VALUES ${rates.join(',\n')}) v(parent, basis, source, rec, unit, dflt, conf);
    INSERT INTO public.product_parent_rate_outcomes (parent_id, outcome, decided_by, decided_at)
      SELECT parent, 'approved_default', '${ADMIN}', now() FROM rsr_proof.ids;
    UPDATE public.product_rate_lock SET is_locked = true WHERE id;`);
  // The seed check _product_rate_check_values needs (live has run it; the harness seeds it during replay).
  assert.equal(row('SELECT count(*) FROM public.epa_registration_seed_run;'), '1');
}

function main() {
  buildContainer({ stopBefore: CANDIDATE });
  seedFixtures();

  // Before the candidate: the switch publishes the over-label rate with no reason (the #2379 gap), rolled back.
  const before = okJson(cutover(P.Over, 'promote', 'rsr-before'));
  assert.equal(before.receipt.rate_source, 'approved', 'the old switch should have accepted the over-label rate');
  // A switch committed before the migration whose reply was lost: its same-key retry must still replay afterwards.
  const legacy = go(P.Within, 'promote', 'rsr-legacy', { commit: true });
  go(P.Within, 'restore', 'rsr-legacy-back', { commit: true });

  // R8: the migration changes no row; a second run refuses; old signatures are gone; grants as designed.
  const productsBefore = md5Of('products'); const parentsBefore = md5Of('product_parents'); const ratesBefore = md5Of('product_rates');
  const applied = runCandidate();
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  assert.notEqual(runCandidate().status, 0, 'a second run must refuse');
  assert.equal(md5Of('products'), productsBefore); assert.equal(md5Of('product_parents'), parentsBefore); assert.equal(md5Of('product_rates'), ratesBefore);
  assert.equal(row(`SELECT coalesce(to_regprocedure('public.preview_parent_rate_cutover(uuid,text)')::text, 'gone') || '|'
    || coalesce(to_regprocedure('public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)')::text, 'gone');`), 'gone|gone');
  refused(preview(P.Within, 'promote', { uid: REP }), /ADMIN_REQUIRED/);
  refused(attempt(ADMIN, `SET LOCAL ROLE anon; r := public.preview_parent_rate_cutover('${P.Within}', 'promote'); RESET ROLE;`), /permission denied/);
  refused(attempt(ADMIN, `SET LOCAL ROLE anon; r := public.commit_parent_rate_cutover('${P.Within}', 'promote', '{}'::jsonb, 'x', 'k'); RESET ROLE;`), /permission denied/);
  refused(attempt(ADMIN, asUser(`r := public._rate_cutover_recheck('${P.Within}', '{}'::jsonb, NULL);`)), /permission denied/);
  const legacyRetry = okJson(attempt(ADMIN, `${asUser(`r := public.commit_parent_rate_cutover('${P.Within}', 'promote',
    ${sq(JSON.stringify(legacy.preview.expected))}::jsonb, 'RSR test', 'rsr-legacy');`)} v := r::text;`));
  assert.equal(legacyRetry.event_id, legacy.receipt.event_id, 'a pre-migration receipt must replay with the same five arguments');

  // R1 (D1): over the current label maximum with no reason: preview and commit refuse, in the server's words.
  const overRefusal = /PRODUCT_PARENT_CUTOVER_OVER_LABEL: the approved rate of "\[RSR\] Over" \(40 oz\/acre\) is above the current label maximum on EPA 100-1 \(32 fl oz\/acre\); type an over-label reason/;
  ineligible(P.Over, 'promote', overRefusal);
  ineligible(P.Over, 'promote', overRefusal, { over: '   ' }); // blank is no reason
  refused(attempt(ADMIN, asUser(`r := public.commit_parent_rate_cutover('${P.Over}', 'promote', '{}'::jsonb, 'x', 'rsr-over-0');`)), overRefusal);
  refused(cutover(P.Over, 'promote', 'rsr-over-long', { over: 'x'.repeat(501) }), /OVER_LABEL_REASON_TOO_LONG/);
  ineligible(P.Over, 'promote', overRefusal, { over: '\u00a0 . \u00a0' }); // no-break spaces and punctuation are no reason
  // A reason given for the maximum the admin saw does not cover a lower one set after the preview.
  refused(cutover(P.Over, 'promote', 'rsr-over-lower', { over: 'trial',
    between: `UPDATE public.epa_registrations SET max_label_rate = 20, registration_version = registration_version + 1 WHERE epa_registration = '100-1';`,
  }), /PRODUCT_PARENT_CUTOVER_STALE/);

  // R2 (D1): with a reason, preview shows the label check; the switch records the reason and the check.
  const plan = previewJson(P.Over, 'promote', { over: '  Mason OK for this field trial  ' });
  assert.equal(plan.eligible, true); assert.equal(plan.label_check.status, 'above');
  assert.equal(plan.over_label_reason, 'Mason OK for this field trial');
  // The preview names the maximum the reason is given for; `expected` binds it by a text fingerprint (Sol MED 3).
  assert.deepEqual(plan.label_check.above.map((m) => `${m.epa_registration} ${m.max_label_rate} ${m.max_label_rate_unit}`), ['100-1 32 fl oz/acre']);
  assert.equal(typeof plan.expected.label_check_md5, 'string'); assert.equal(plan.expected.label_check, undefined);
  // Sol MED 4: a switch in a repeatable read transaction (an older snapshot of the maximum) is refused.
  const rr = psql(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${claims(ADMIN)}
    SET LOCAL ROLE authenticated;
    SELECT public.commit_parent_rate_cutover('${P.Over}', 'promote', '{}'::jsonb, 'x', 'rsr-rr', 'reason');
    ROLLBACK;`, { allowFailure: true });
  assert.match(`${rr.stdout}${rr.stderr}`, /PRODUCT_PARENT_CUTOVER_ISOLATION/);
  const over = go(P.Over, 'promote', 'rsr-over-1', { over: '  Mason OK for this field trial  ', commit: true });
  assert.equal(over.receipt.rate_source, 'approved'); assert.equal(over.receipt.rate_per_acre, '40');
  assert.equal(over.receipt.over_label_reason, 'Mason OK for this field trial');
  assert.equal(over.receipt.label_check.status, 'above');
  assert.equal(row(`SELECT (after_values->>'over_label_reason') || '|' || (after_values->'label_check'->>'status') || '|' || (after_values->'legacy'->>'rate_per_acre')
    FROM public.product_parent_events WHERE id = ${over.receipt.event_id} AND event_type = 'rates_promoted';`), 'Mason OK for this field trial|above|48');
  // R3: the same key and reason replay the receipt; the same key with another over-label reason is another request.
  const sent = `${sq(JSON.stringify(over.preview.expected))}::jsonb`;
  const replayed = okJson(attempt(ADMIN, `${asUser(`r := public.commit_parent_rate_cutover('${P.Over}', 'promote', ${sent}, 'RSR test', 'rsr-over-1', p_over_label_reason => 'Mason OK for this field trial');`)} v := r::text;`));
  assert.equal(replayed.event_id, over.receipt.event_id);
  refused(attempt(ADMIN, asUser(`r := public.commit_parent_rate_cutover('${P.Over}', 'promote', ${sent}, 'RSR test', 'rsr-over-1', p_over_label_reason => 'other');`)), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  // R4: switching back is never refused by the label check, and needs no over-label reason.
  const back = go(P.Over, 'restore', 'rsr-over-2', { reason: 'switch back', commit: true });
  assert.equal(back.receipt.rate_source, 'legacy');
  assert.equal(row(`SELECT rate_per_acre || ' ' || rate_unit FROM public.products WHERE id = '${P.OverSize}';`), '48 oz');

  // R5: within the maximum: no reason needed; a reason sent anyway is not recorded; the 5-argument call still works.
  const within = go(P.Within, 'promote', 'rsr-within-1', { over: 'not needed '.repeat(60), commit: true }); // length matters only when needed
  assert.equal(within.preview.label_check.status, 'within'); assert.equal(within.preview.over_label_reason, null);
  assert.equal(row(`SELECT coalesce(after_values->>'over_label_reason', 'none') || '|' || (after_values->'label_check'->>'status')
    FROM public.product_parent_events WHERE id = ${within.receipt.event_id};`), 'none|within');
  go(P.Within, 'restore', 'rsr-within-2', { commit: true });
  const positional = okJson(attempt(ADMIN, `${asUser(`r := public.preview_parent_rate_cutover('${P.Within}', 'promote');
    r2 := public.commit_parent_rate_cutover('${P.Within}', 'promote', r->'expected', 'positional', 'rsr-within-3');`)} v := r2::text;`));
  assert.equal(positional.rate_source, 'approved');

  // R6 (D1): the label maximum lowered after the preview: commit re-checks and refuses without a reason.
  refused(cutover(P.Lowered, 'promote', 'rsr-lowered-1', {
    between: `UPDATE public.epa_registrations SET max_label_rate = 32, registration_version = registration_version + 1 WHERE epa_registration = '100-3';`,
  }), /PRODUCT_PARENT_CUTOVER_OVER_LABEL: the approved rate of "\[RSR\] Lowered"/);

  // R7 (D2): an approved row whose unit no longer fits the group's form, or whose basis is no longer confirmed.
  const reapprove = /PRODUCT_PARENT_CUTOVER_REAPPROVE: the form or rate basis of "\[RSR\] (FormChanged|Unconfirmed)" changed since its rate was approved \(.+\); re-approve this rate in Rate Review/;
  ineligible(P.FormChanged, 'promote', reapprove);
  assert.match(previewJson(P.FormChanged, 'promote').refusal, /label per_100_gal: lb does not fit a liquid product/);
  refused(cutover(P.FormChanged, 'promote', 'rsr-form-1', { previewOver: undefined }), reapprove);
  ineligible(P.Unconfirmed, 'promote', reapprove);
  assert.match(previewJson(P.Unconfirmed, 'promote').refusal, /label per_100_gal: basis not confirmed/);

  console.log('RATE_SWITCH_RECHECK_PROOF_PASS');
}

try { main(); } finally { if (!KEEP) removeContainer(); else console.log(`[rsr] kept ${NAME}`); }
