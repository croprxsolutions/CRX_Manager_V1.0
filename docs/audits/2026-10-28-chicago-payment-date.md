# Chicago payment-date candidate - row 6.7

## Status and design

Current implementation is on `codex/chicago-payment-retry-intent-20261028` in `C:/CRX_payment_retry_intent`, based on refreshed `origin/main` at `5b0246530` plus the two earlier parked commits. The original reviewed branch/worktree at `741273f2b` remains unchanged. Mason now authorizes publication as a draft PR after a clean Sonnet 5.5/high review. The current boundary is draft only: no ready-for-review switch, auto-merge, merge, live migration apply, or deployment. No production data/settings/grants have changed.

Live read-only `pg_get_functiondef` on 2026-10-28 confirmed a single `allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)` overload, with `p_payment_date DEFAULT CURRENT_DATE`. Its body matches `20260713060300_harden_allocate_payment_idempotency.sql`, normalized body MD5 `6a945a2510d8e788d4e6f03c0c6d7563`; the local prover independently checks the baseline body against that pin. The live period helper checks the supplied date against closed periods. The live duplicate-key trigger recognizes the existing v1 envelope, preserved here.

Both `src/pages/PaymentAllocation.tsx` and `src/pages/InvoiceDetail.tsx` omit the date. `src/lib/offlineSync.ts` forwards stored arguments. The generated optional date argument remains compatible; no caller/type edits are needed.

The optional date default becomes NULL. New payments resolve `(now() AT TIME ZONE 'America/Chicago')::date` after replay lookup. Explicit dates remain unchanged; explicit NULL defaults like omission. The fingerprint retains the raw date argument. New claims and cached results retain `_contract = allocate_payment_v1` for the existing trigger, and add top-level `_date_intent_version = 1`. For marked keys, explicit-to-omitted/NULL, omitted-to-explicit and changed explicit dates reject. Identical explicit dates and omitted/NULL defaults replay. Only older v1 entries without that marker normalize an omitted date using the cached date, because those entries cannot distinguish the old eager default from an explicit date. Older bare cached results retain their previous replay path. Other request fields still compare; stored dates and expiry policy remain unchanged.

Mason's follow-up explicitly includes the season defect. One Chicago business date is captured after replay and used for both the omitted date and current payment/prepay season. The October-to-September season now advances at Chicago midnight on October 1, independent of the database timezone. Explicit backdated payment dates are preserved; new prepay credit still belongs to the current Chicago season rather than the historical payment-date season. Allocation math, invoice status recomputation, actor/role checks, grants, and function identity are preserved. Quote/order/rebate numbering is out of scope.

Deliberate scope limit: the shared `current_season()` helper still calls `compute_season(CURRENT_DATE)` (re-read live on 2026-10-28). During the roughly five-hour September 30 Chicago evening window, workflows that use that UTC helper can already default to the next season while this corrected payment/prepay path remains in the current Chicago season. This migration does not change those other workflows or the shared helper.

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

No final Sol delivery proof, CodeRabbit current-head review or green CI is claimed. These delivery gates remain required before release. Publication as a draft PR is authorized after Sonnet's clean review; keep it draft. Do not merge/apply/deploy under this task's authority. A later release must refresh source/live evidence and migration ordering and use all guarded delivery paths.

Rollback, if ever applied: use a new reviewed forward migration without rewriting payment rows. It must retain compatibility with the new raw-date-intent marker and older unmarked/bare receipts; blindly restoring the old eager-date function could reject retries of marked omitted-date entries. Verify default/explicit dates, seasons, period guards and all receipt formats locally before release.

Proposed shared-list status: **6.7 implemented and tested for draft review, not shipped. Release reviews/CI/live apply remain pending under the draft-only boundary.** CURRENT_STATE/KNOWN_ISSUES receive only the fresh, scoped read-only checks needed by the pre-PR documentation gate; the broader old reconciliation is not re-dated.

Graphify was built from `a3423a81`. `graphify explain allocate_payment` returned an older season-calendar definition. Current callers, the latest migration and the live definition supplied authoritative evidence.

## Historical closeout before the season follow-up

The historical closeouts below describe the earlier local-only stages. Their no-push/no-PR statements were true at those checkpoints and do not override the current draft-publication authorization above.

- Final full migration SHA256: `455287e603b678835a9db8d7323ea21435dab8b19b18b5f32083bbaa160de630`.
- Final disposable proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`, including the extended legacy-midnight case, all four roles and the preserved season boundary.
- Final script lint and SQL changed-only audit passed. SQL audit: 0 violations, 1 reviewed alias warning (`v_customer_name` is populated from `customers.farm_name`; it is not a nonexistent direct column).
- `npm run check:agent-guidance` passed. Staged diff whitespace check passed. Existing lint/typecheck/build and 166 focused tests passed as recorded above.
- Read-only live migration-name query returned `candidate_applied_count = 0` on 2026-10-28. No production writes were used for verification.
- Security reviewer rechecked the final SHA after removal of the historical permission tail: no RLS/grant finding. Luna: no BLOCKER/HIGH; two findings fixed, one pre-existing MED season issue explicitly deferred above. No final Sol or public delivery gate is claimed.
- Park this as local work. No PR was opened or branch pushed. Not merged; no migration applied or deployment performed.

## Historical season follow-up closeout - 2026-10-28

- Mason explicitly requested fixing the deferred season issue, followed by Luna at xhigh, while retaining no merge/apply/deploy authority.
- Historical season-follow-up migration SHA256: `a32e3853f4803afba0b1e1781fef6c134ff428ae17913e80d2cccc45a202b425`. This was the parked migration-history pin at that checkpoint; later retry-intent work and the landing restamp supersede it.
- The final local PostgreSQL proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`: all 24 date cases, 15 season cases, old-UTC-season mutant rejection, explicit backdate, allocation/prepay season and cent parity, season-crossing retry, legacy replay, roles and closed-period refusal passed.
- Lint, typecheck, build and all 166 focused tests passed again. Final script lint and changed-only SQL audit passed, with zero SQL violations and the same verified variable/alias warning. No TypeScript API/type change was needed.
- Independent security, migration-drift, type-compatibility and compliance re-reviews found no findings in the season follow-up.
- Adversarial CLI reviewer: `gpt-6-luna`, reasoning `xhigh`, isolated read-only, session `01a183cb-bbc0-71f0-908f-65129e7eee66`. Verdict: `LUNA_REVIEW: CLEAN`, no actionable findings. The reviewer received the exact current migration/proof and diff against `80e022cc7`. It explicitly identifies its review as static; the executed local proof is supporting evidence from the implementing session.
- No final Sol, CodeRabbit, CI, full current-production-schema replay or live release proof is claimed. The former season MED is resolved locally rather than deferred. Do not treat this as shipped.
- Keep the same local branch/worktree parked. No push or PR, no merge, no live migration apply, no deployment, and no production data/settings/grant changes occurred.

## Historical retry-date-intent follow-up closeout - 2026-10-28

- Sol's review of `741273f2b` found one MED: a new explicit-date key could be retried with the date omitted and silently match. Mason explicitly requested fixing that while retaining older-key compatibility and repeating Sol at high, with no push/merge/live apply/deploy.
- Work continues in `C:/CRX_payment_retry_intent`, branch `codex/chicago-payment-retry-intent-20261028`, based on current main `5b0246530` with the original two parked commits cherry-picked. No history or files in the original worktree were changed.
- Historical retry-intent migration SHA256 before the landing restamp: `5ced6a5e8e3d8a40d7ecca4985d2bd5e3d25ca6f980f2dee1e6bacabff9b93dd`. The 2026-10-29 landing status below records the current restamped hash and history-row pin.
- The fix stores `_date_intent_version: 1` in both the initial claim and committed envelope, retaining `_contract = allocate_payment_v1`. Only unmarked v1 records normalize incoming omitted dates. New keys bind raw date intent strictly; unmarked v1 and bare cached results retain their earlier replay paths.
- The full disposable proof printed `CHICAGO_PAYMENT_DATE_PROOF_PASS`. The exact reported explicit-to-omitted case now rejects; a mutant restoring the prior permissive comparison fails that regression. Identical explicit dates and omitted/NULL defaults replay; explicit-to-NULL/changed-date and omitted-to-explicit reject without changing the original payment. Both old v1 date shapes and bare cached responses replay, and other changed fields still reject.
- All 24 date cases, 15 season cases, old-date/season mutants, legacy-cutover replay, explicit backdating, role checks and closed-period refusal passed again. The private envelope metadata assertion runs only as the owner in the rolled-back fixture after authenticated behavior checks; app permissions were not changed.
- Luna/xhigh found no SQL defect and one LOW proof gap for concurrent replay. The added synchronized two-session PostgreSQL probe observed the contender blocked on the winner's uncommitted claim, then both returned the identical committed result. It verified one payment, one 100-cent prepay credit and a 100-cent customer balance, closing that proof gap. The fixture's committed rows exist only inside the disposable container, which was removed.
- Lint, typecheck, build and all 166 focused tests passed. Final proof script lint and SQL changed-only audit passed (0 violations, same verified variable/alias warning). Schema setup in the final run was slow on local disk I/O; activity inspection showed progress, and the run completed normally.
- Independent security, drift, type and compliance re-reviews found no findings in the retry-intent change.
- Requested final advisory reviewer: `gpt-6-sol`, reasoning `high`, isolated read-only CLI, session `01a183ef-13d6-7413-958c-3f3ceef8762e`. Verdict `PAYMENT_REVIEW: CLEAN`, no actionable finding. The reviewer received frozen migration/proof/diff and the unchanged shared insert-trigger source. This was static source review; runtime proof was executed separately by the implementing session.
- No formal Sol delivery proof, CodeRabbit, green CI, fresh production verification, or full current-production-schema replay is claimed. Keep parked. No branch was pushed, PR opened, merge performed, live migration applied, deployment performed, or production data/settings/grants changed.

## Draft preparation and Sonnet review - 2026-10-28

- First requested review was VERIFIED on `claude-sonnet-5-5`, effort `high`, with no permission denials. It found no code, BLOCKER, HIGH or MED finding; two LOW documentation findings required changes before a clean result: disclose the UTC shared-season-helper limit, and replace current local-only delivery wording with the newly authorized draft-only scope. Both are corrected above and in the changelog/history notes. The earlier no-push checkpoints remain explicitly historical.
- Fresh read-only `list_migrations` returned 1075 rows, latest version `20261028121259` / name `20261027080300_notification_sender_recorded`; the candidate is absent. Fresh `pg_get_functiondef` confirms `allocate_payment` still defaults `CURRENT_DATE` and computes its current season from `CURRENT_DATE`; `current_season()` still calls `compute_season(CURRENT_DATE)`. These observations supersede earlier inability to refresh the catalog, and confirm this candidate is not live. No production writes occurred.
- The documentation freshness gate initially failed CURRENT_STATE/KNOWN_ISSUES dated 2026-10-27. Their new 2026-10-28 entries are limited to the executed payment/ledger checks and explicitly retain the earlier broad-reconciliation dates and issue counts.
- Optional NIT dispositions: retain the existing inline season calculation and `now()` convention rather than change reviewed financial SQL; retain the dated changelog chronology; full Docker proof remains an explicit local command, not an automatic CI claim. The legacy changed-explicit-date branch is present and source-reviewed, though a separate probe for that legacy mismatch and automatic proof wiring remain optional coverage improvements. The named history row is machine-readable and can receive an ordinal when release accounting assigns it.
- The SQL file, behavior proof and SHA256 `5ced6a5e8e3d8a40d7ecca4985d2bd5e3d25ca6f980f2dee1e6bacabff9b93dd` are unchanged by this documentation follow-up. The recorded runtime proof remains applicable. No merge/live apply/deployment is authorized by draft publication. (Historical: this is the hash before the 2026-10-29 restamp; see the landing status below.)
- Sonnet's documentation follow-up confirmed the prior shared-season disclosure but found the remaining migration-history heading said "Parked"; that heading now says "Unapplied payment-date candidate (draft review)".
- Freshness-finding reconciliation: Sonnet also inferred that the freshness stamp requires a full re-audit. The pre-change CURRENT_STATE stamp explicitly said "for the migration ledger only"; the pre-change KNOWN_ISSUES stamp covered the shipment reconciliation and earlier targeted checks, explicitly "not a fresh full security audit". Thus scoped stamps are pre-existing, not a newly relaxed convention. The actual checker requires re-reading the document against live state and was not changed. This task re-read the affected payment/season claims and refreshed the ledger from 1071 to 1075 live entries; it verified the candidate remains absent and both live function definitions retain their UTC behavior. Other dates/counts remain explicitly historical. `docs/reference/coding-guidelines.md:3` and `AGENTS.md:27` additionally require topic searches rather than reading these large logs whole. No claim of a full re-audit or owner waiver is made. This evidence is submitted to the next independent review for reconciliation, not silently counted as an approval.

## Landing status - 2026-10-29

- Mason confirmed retaining the existing payment-season behavior: an explicitly backdated September 29 prepay entered October 2 still goes to the new season. This release changes the Chicago business-day boundary and retry intent without changing that rule.

- The candidate is now `20261029160200_chicago_payment_business_date.sql` (history row 1004; authored as `20261028175551`). Only its two status-comment lines changed in the restamp, so the SQL sha256 is now `91119fc1759d66785f25cc4fc0bc7cdb97a4dd4a9990a65fa85802dbc837f553` (LF line endings) and the earlier `5ced6a5e...` hashes above are historical.
- Live read-only checks on 2026-10-29 (about 4:30 PM Central): exactly one `allocate_payment` overload; body md5 `6a945a2510d8e788d4e6f03c0c6d7563`, which equals the pre-migration body the proof uses as its baseline; no `anon` or `PUBLIC` execute; security-definer, `search_path=public, pg_temp`, owner `postgres`. The ledger high-water at that read was `20261029143642` (`20261028185500_order_edit_and_number_concurrency`).
- Not live: the PR is awaiting the release gates (CI, Sol, apply proofs, smoke chain, sweeps).
