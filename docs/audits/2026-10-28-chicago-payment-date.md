# Chicago payment-date candidate - row 6.7

## Status and design

Local implementation on `codex/chicago-payment-date-20261028` in `C:/CRX_chicago_payment_date`, based on refreshed `origin/main` at `a3423a812`. Parked at Mason's explicit no-merge/no-apply/no-deploy boundary. No production writes, migration applies, deployments, grants, or settings changes were performed.

Live read-only `pg_get_functiondef` on 2026-10-28 confirmed a single `allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)` overload, with `p_payment_date DEFAULT CURRENT_DATE`. Its body matches `20260713060300_harden_allocate_payment_idempotency.sql`, normalized body MD5 `6a945a2510d8e788d4e6f03c0c6d7563`; the local prover independently checks the baseline body against that pin. The live period helper checks the supplied date against closed periods. The live duplicate-key trigger recognizes the existing v1 envelope, preserved here.

Both `src/pages/PaymentAllocation.tsx` and `src/pages/InvoiceDetail.tsx` omit the date. `src/lib/offlineSync.ts` forwards stored arguments. The generated optional date argument remains compatible; no caller/type edits are needed.

The optional date default becomes NULL. New payments resolve `(now() AT TIME ZONE 'America/Chicago')::date` after replay lookup. Explicit dates remain unchanged; explicit NULL now defaults like omission. The fingerprint retains the raw date argument. For omitted-date retries, the cached request's date is used for comparison, including old v1 keys created before this migration. Other fields still compare, and an explicitly supplied different date rejects. Omission means reuse the original date even if the earlier attempt supplied it explicitly. Stored dates are not rewritten on replay. Key expiry policy is unchanged.

Allocation math, invoice status recomputation, prepay accounting, the existing current-season calculation, actor/role checks, grants, and function identity are preserved. Quote/order/rebate numbering is out of scope.

## Verification and limits

```
node scripts/smoke/prove-chicago-payment-date.mjs
npm run lint
npm run typecheck
npm run build
npm test -- src/lib/rpcContracts.test.ts src/lib/moneyInventoryGauntletFixes.test.ts src/lib/offlineSync.test.ts src/__tests__/paymentAllocationWriteLock.test.ts
```

Lint/typecheck/build passed; all 166 existing focused tests passed. The build reports the existing large-chunk advisory.

The proof uses a network-disabled PostgreSQL 17.6 container and the checked-in 2026-07-27 real schema baseline, its ACL overlay and auth-profile trigger. It compiles the exact candidate and observes the real-clock date, then replaces only clock reads in disposable function copies for deterministic probes. Local replay-key expiry uses the same controlled clock. No production clock override is added. Fixture initialization and expiry-clock mismatches found during proof development were corrected in the harness.

The old function must fail the Chicago year-end date assertion. The fixed copy must pass 24 cases covering winter/summer midnight, evening, year rollover and both DST transitions across UTC and Asia/Tokyo sessions. Other checks cover explicit dates, NULL default, one original payment/date after midnight replay, changed date/amount refusal, old v1 replay across the migration, admin/rep success, driver/applicator refusal, and closed-period refusal with no payment/key side effects.

This is a real schema snapshot, not every later production migration replayed. Current payment source and relevant live helper semantics were checked read-only. A future release still needs current full-chain evidence and all delivery gates. No browser proof was run: only database behavior changes, and UI argument shapes are unchanged.

## Review and parking

Security, drift, compliance and TypeScript independent reviewers found no code blocker/high issue. The drift review requested the parked migration-history record, now included. Runtime completion and Luna status are added at closeout below.

Luna round 1 reported two MED and one LOW. The copied historical permission tail was removed entirely before final proof: this candidate contains no GRANT/REVOKE. The proof now executes the whole migration. The old-v1 replay probe now advances across Chicago midnight and checks the original date. The remaining MED is a named deferral: the existing current-season calculation uses the session date, so a September 30 Chicago evening can already create a next-season prepay credit. This predates the candidate and is deliberately preserved and tested here; changing season allocation would add a financial business-rule change to this narrowly assigned date-default task. It needs a separate scoped fix before claiming all business-time issues resolved.

No final Sol proof, CodeRabbit current-head review or green CI is claimed. These delivery gates remain required before release. No draft PR is required to preserve local work. Do not merge/apply under this task's authority. A later release must refresh source/live evidence and migration ordering and use all guarded delivery paths.

Rollback, if ever applied: a new reviewed forward migration can restore the prior function without rewriting payment rows. Verify default/explicit dates, period guards and replay behavior locally before release.

Proposed shared-list status, returned without editing TO_DO_LIST/CURRENT_STATE/DECISION_LOG: **6.7 locally implemented and tested; parked, not shipped. Release reviews/CI/live apply remain pending under the no-merge boundary.**

Graphify was built from `a3423a81`. `graphify explain allocate_payment` returned an older season-calendar definition. Current callers, the latest migration and the live definition supplied authoritative evidence.

## Observed closeout

- Final full migration SHA256: `455287e603b678835a9db8d7323ea21435dab8b19b18b5f32083bbaa160de630`.
- Final disposable proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`, including the extended legacy-midnight case, all four roles and the preserved season boundary.
- Final script lint and SQL changed-only audit passed. SQL audit: 0 violations, 1 reviewed alias warning (`v_customer_name` is populated from `customers.farm_name`; it is not a nonexistent direct column).
- `npm run check:agent-guidance` passed. Staged diff whitespace check passed. Existing lint/typecheck/build and 166 focused tests passed as recorded above.
- Read-only live migration-name query returned `candidate_applied_count = 0` on 2026-10-28. No production writes were used for verification.
- Security reviewer rechecked the final SHA after removal of the historical permission tail: no RLS/grant finding. Luna: no BLOCKER/HIGH; two findings fixed, one pre-existing MED season issue explicitly deferred above. No final Sol or public delivery gate is claimed.
- Park this as local work. No PR was opened or branch pushed. Not merged; no migration applied or deployment performed.
