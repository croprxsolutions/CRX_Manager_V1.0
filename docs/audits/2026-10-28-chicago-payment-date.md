# Chicago payment-date candidate - row 6.7

## Status and design

Local implementation on `codex/chicago-payment-date-20261028` in `C:/CRX_chicago_payment_date`, based on refreshed `origin/main` at `a3423a812`. Parked at Mason's explicit no-merge/no-apply/no-deploy boundary. No production writes, migration applies, deployments, grants, or settings changes were performed.

Live read-only `pg_get_functiondef` on 2026-10-28 confirmed a single `allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)` overload, with `p_payment_date DEFAULT CURRENT_DATE`. Its body matches `20260713060300_harden_allocate_payment_idempotency.sql`, normalized body MD5 `6a945a2510d8e788d4e6f03c0c6d7563`; the local prover independently checks the baseline body against that pin. The live period helper checks the supplied date against closed periods. The live duplicate-key trigger recognizes the existing v1 envelope, preserved here.

Both `src/pages/PaymentAllocation.tsx` and `src/pages/InvoiceDetail.tsx` omit the date. `src/lib/offlineSync.ts` forwards stored arguments. The generated optional date argument remains compatible; no caller/type edits are needed.

The optional date default becomes NULL. New payments resolve `(now() AT TIME ZONE 'America/Chicago')::date` after replay lookup. Explicit dates remain unchanged; explicit NULL now defaults like omission. The fingerprint retains the raw date argument. For omitted-date retries, the cached request's date is used for comparison, including old v1 keys created before this migration. Other fields still compare, and an explicitly supplied different date rejects. Omission means reuse the original date even if the earlier attempt supplied it explicitly. Stored dates are not rewritten on replay. Key expiry policy is unchanged.

Mason's follow-up explicitly includes the season defect. One Chicago business date is captured after replay and used for both the omitted date and current payment/prepay season. The October-to-September season now advances at Chicago midnight on October 1, independent of the database timezone. Explicit backdated payment dates are preserved; new prepay credit still belongs to the current Chicago season rather than the historical payment-date season. Allocation math, invoice status recomputation, actor/role checks, grants, and function identity are preserved. Quote/order/rebate numbering is out of scope.

## Verification and limits

```
node scripts/smoke/prove-chicago-payment-date.mjs
npm run lint
npm run typecheck
npm run build
npm test -- src/lib/rpcContracts.test.ts src/lib/moneyInventoryGauntletFixes.test.ts src/lib/offlineSync.test.ts src/__tests__/paymentAllocationWriteLock.test.ts
```

Lint/typecheck/build passed; all 166 existing focused tests passed. The build reports the existing large-chunk advisory.

The proof uses a network-disabled PostgreSQL 17.6 container and the checked-in 2026-07-27 real schema baseline, its ACL overlay and auth-profile trigger. It compiles the exact candidate and observes the real-clock date, then replaces only clock reads in disposable function copies for deterministic probes. Local replay-key defaults and the existing insert trigger's expiry cleanup use the same controlled clock. No production clock override is added. Fixture initialization and expiry-clock mismatches found during proof development were corrected in the harness.

The old function must fail the Chicago year-end date assertion. The fixed copy must pass 24 cases covering winter/summer midnight, evening, year rollover and both DST transitions across UTC and Asia/Tokyo sessions. A separate mutant restores only the old UTC season calculation and must fail the September 30 evening season assertion. Fifteen season probes cover October 1 and winter year boundaries across UTC/Tokyo/Chicago sessions, checking both payment and prepay seasons and exact prepay cents. Additional cases check explicit backdates and retry across the actual season transition with one original payment/date/season/prepay. Existing checks cover explicit dates, NULL default, changed date/amount refusal, old v1 replay across the migration, admin/rep success, driver/applicator refusal, and closed-period refusal with no payment/key side effects.

This is a real schema snapshot, not every later production migration replayed. Current payment source and relevant live helper semantics were checked read-only. A future release still needs current full-chain evidence and all delivery gates. No browser proof was run: only database behavior changes, and UI argument shapes are unchanged.

## Review and parking

Security, drift, compliance and TypeScript independent reviewers found no code blocker/high issue. The drift review requested the parked migration-history record, now included. Runtime completion and Luna status are added at closeout below.

Earlier Luna findings about the copied permission tail and the legacy retry test were fixed; there are no GRANT/REVOKE statements, and the legacy test crosses Chicago midnight. The previously deferred MED season issue is now included by Mason's explicit follow-up request and fixed using the shared Chicago business date. The new season tests replace the earlier test that deliberately preserved that defect.

No final Sol proof, CodeRabbit current-head review or green CI is claimed. These delivery gates remain required before release. No draft PR is required to preserve local work. Do not merge/apply under this task's authority. A later release must refresh source/live evidence and migration ordering and use all guarded delivery paths.

Rollback, if ever applied: a new reviewed forward migration can restore the prior function without rewriting payment rows. Verify default/explicit dates, period guards and replay behavior locally before release.

Proposed shared-list status, returned without editing TO_DO_LIST/CURRENT_STATE/DECISION_LOG: **6.7 locally implemented and tested; parked, not shipped. Release reviews/CI/live apply remain pending under the no-merge boundary.**

Graphify was built from `a3423a81`. `graphify explain allocate_payment` returned an older season-calendar definition. Current callers, the latest migration and the live definition supplied authoritative evidence.

## Historical closeout before the season follow-up

- Final full migration SHA256: `455287e603b678835a9db8d7323ea21435dab8b19b18b5f32083bbaa160de630`.
- Final disposable proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`, including the extended legacy-midnight case, all four roles and the preserved season boundary.
- Final script lint and SQL changed-only audit passed. SQL audit: 0 violations, 1 reviewed alias warning (`v_customer_name` is populated from `customers.farm_name`; it is not a nonexistent direct column).
- `npm run check:agent-guidance` passed. Staged diff whitespace check passed. Existing lint/typecheck/build and 166 focused tests passed as recorded above.
- Read-only live migration-name query returned `candidate_applied_count = 0` on 2026-10-28. No production writes were used for verification.
- Security reviewer rechecked the final SHA after removal of the historical permission tail: no RLS/grant finding. Luna: no BLOCKER/HIGH; two findings fixed, one pre-existing MED season issue explicitly deferred above. No final Sol or public delivery gate is claimed.
- Park this as local work. No PR was opened or branch pushed. Not merged; no migration applied or deployment performed.

## Season follow-up closeout - 2026-10-28

- Mason explicitly requested fixing the deferred season issue, followed by Luna at xhigh, while retaining no merge/apply/deploy authority.
- Current migration SHA256: `a32e3853f4803afba0b1e1781fef6c134ff428ae17913e80d2cccc45a202b425`. This supersedes the historical hash above; the parked migration-history pin matches.
- The final local PostgreSQL proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`: all 24 date cases, 15 season cases, old-UTC-season mutant rejection, explicit backdate, allocation/prepay season and cent parity, season-crossing retry, legacy replay, roles and closed-period refusal passed.
- Lint, typecheck, build and all 166 focused tests passed again. Final script lint and changed-only SQL audit passed, with zero SQL violations and the same verified variable/alias warning. No TypeScript API/type change was needed.
- Independent security, migration-drift, type-compatibility and compliance re-reviews found no findings in the season follow-up.
- Adversarial CLI reviewer: `gpt-6-luna`, reasoning `xhigh`, isolated read-only, session `01a183cb-bbc0-71f0-908f-65129e7eee66`. Verdict: `LUNA_REVIEW: CLEAN`, no actionable findings. The reviewer received the exact current migration/proof and diff against `80e022cc7`. It explicitly identifies its review as static; the executed local proof is supporting evidence from the implementing session.
- No final Sol, CodeRabbit, CI, full current-production-schema replay or live release proof is claimed. The former season MED is resolved locally rather than deferred. Do not treat this as shipped.
- Keep the same local branch/worktree parked. No push or PR, no merge, no live migration apply, no deployment, and no production data/settings/grant changes occurred.
