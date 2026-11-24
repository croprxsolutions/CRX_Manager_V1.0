#!/usr/bin/env node
/**
 * Real-schema proof for 20270303140000_price_sheet_refusal_reason.sql.
 * Contract: docs/plans/2026-11-24-price-sheet-refusal-reason-CONTRACT.md
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), then as the signed-in user checks:
 *   1. the caller's own usable v2 export returns NULL;
 *   2. applied -> ALREADY_APPLIED; past expiry or status expired -> EXPIRED; older template -> OLD_TEMPLATE;
 *   3. another admin's export (even applied or old) -> DOWNLOADED_BY_OTHER_USER; applied wins over old and expired;
 *      unknown or null id -> EXPORT_NOT_FOUND;
 *   4. sales rep, driver, applicator and an inactive admin get ADMIN_REQUIRED; anon gets permission denied.
 *
 * Run: node scripts/smoke/prove-price-sheet-refusal-reason-real-schema.mjs   (needs Docker; never touches live)
 * Prints PRICE_SHEET_REFUSAL_REASON_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, psql, scalar, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270303140000_price_sheet_refusal_reason.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const OTHER_ADMIN = id('a5');
const INACTIVE_ADMIN = id('a6');
const V2 = 'crx-product-pricing-phase2-v2';
// [export id, owner, status, expires_at expression, format_version]
const EXPORTS = {
  usable: [id('e1'), USERS.admin, 'active', "now() + interval '6 days'", V2],
  applied: [id('e2'), USERS.admin, 'consumed', "now() + interval '6 days'", V2],
  pastExpiry: [id('e3'), USERS.admin, 'active', "now() - interval '1 minute'", V2],
  statusExpired: [id('e4'), USERS.admin, 'expired', "now() + interval '6 days'", V2],
  oldTemplate: [id('e5'), USERS.admin, 'active', "now() - interval '90 days'", 'crx-product-pricing-phase1a-v1'],
  otherUser: [id('e6'), OTHER_ADMIN, 'active', "now() + interval '6 days'", V2],
  otherUserApplied: [id('e7'), OTHER_ADMIN, 'consumed', "now() + interval '6 days'", V2],
  appliedOldExpired: [id('e8'), USERS.admin, 'consumed', "now() - interval '90 days'", 'crx-product-pricing-phase1a-v1'],
  otherUserOldExpired: [id('e9'), OTHER_ADMIN, 'expired', "now() - interval '90 days'", 'crx-product-pricing-phase1a-v1'],
};
const reason = (exportId, uid = USERS.admin) =>
  attempt(uid, asUser(`v := public.get_pricing_workbook_export_refusal_reason(${exportId === null ? 'NULL' : `'${exportId}'`});`));

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${OTHER_ADMIN}', 'undo-admin2@example.invalid', '{"full_name":"[UNDO] Admin Two","role":"admin"}'::jsonb),
    ('${INACTIVE_ADMIN}', 'undo-admin3@example.invalid', '{"full_name":"[UNDO] Admin Gone","role":"admin"}'::jsonb);
    SET session_replication_role = replica;
    UPDATE public.profiles SET is_active = false WHERE id = '${INACTIVE_ADMIN}';
    INSERT INTO public.pricing_workbook_exports
      (id, created_by, request_fingerprint, manifest_fingerprint, idempotency_key, row_count, status, created_at, expires_at, format_version)
    VALUES ${Object.entries(EXPORTS).map(([key, [eid, owner, status, expires, format]]) =>
      `('${eid}', '${owner}', 'fp', 'mf', 'proof-${key}', 1, '${status}', now() - interval '120 days', ${expires}, '${format}')`).join(',\n      ')};`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id IN ('${OTHER_ADMIN}', '${INACTIVE_ADMIN}');`),
    'admin:true,admin:false', 'second admin active, third admin inactive');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PRICE_SHEET_REFUSAL_REASON_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  const expected = {
    usable: 'ok|<null>',
    applied: 'ok|ALREADY_APPLIED',
    pastExpiry: 'ok|EXPIRED',
    statusExpired: 'ok|EXPIRED',
    oldTemplate: 'ok|OLD_TEMPLATE',
    otherUser: 'ok|DOWNLOADED_BY_OTHER_USER',
    otherUserApplied: 'ok|DOWNLOADED_BY_OTHER_USER',
    appliedOldExpired: 'ok|ALREADY_APPLIED',
    otherUserOldExpired: 'ok|DOWNLOADED_BY_OTHER_USER',
  };
  for (const [key, want] of Object.entries(expected)) {
    assert.equal(reason(EXPORTS[key][0]), want, `${key} export`);
    console.log(`[reason] ${key.padEnd(16)} -> ${want.slice(3)}`);
  }
  assert.equal(reason(id('e99')), 'ok|EXPORT_NOT_FOUND', 'unknown id');
  assert.equal(reason(null), 'ok|EXPORT_NOT_FOUND', 'null id');
  assert.equal(reason(EXPORTS.otherUser[0], OTHER_ADMIN), 'ok|<null>', 'the other admin sees their own sheet as usable');
  console.log('[reason] unknown/null id -> EXPORT_NOT_FOUND; owner of the other sheet -> NULL');

  for (const [uid, who] of [[USERS.rep, 'sales rep'], [USERS.driver, 'driver'], [USERS.applicator, 'applicator'], [INACTIVE_ADMIN, 'inactive admin']]) {
    assert.equal(attempt(uid, `${refuse(`v := public.get_pricing_workbook_export_refusal_reason('${EXPORTS.usable[0]}');`)} v := t;`),
      'ok|ADMIN_REQUIRED', `${who} must be refused`);
    assert.equal(attempt(uid, `${refuse(`v := public.get_pricing_workbook_export_refusal_reason('${id('e99')}');`)} v := t;`),
      'ok|ADMIN_REQUIRED', `${who} must be refused for an unknown id too`);
  }
  assert.match(attempt(USERS.admin, `SET LOCAL ROLE anon; BEGIN v := public.get_pricing_workbook_export_refusal_reason('${EXPORTS.usable[0]}'); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run it');
  assert.equal(attempt(USERS.admin, `PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true); ${refuse(`v := public.get_pricing_workbook_export_refusal_reason('${EXPORTS.usable[0]}');`)} v := t;`),
    'ok|AUTH_REQUIRED', 'no session must be refused');
  console.log('[refuse] sales rep, driver, applicator, inactive admin -> ADMIN_REQUIRED; no session -> AUTH_REQUIRED; anon -> permission denied');

  console.log('\nPRICE_SHEET_REFUSAL_REASON_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
