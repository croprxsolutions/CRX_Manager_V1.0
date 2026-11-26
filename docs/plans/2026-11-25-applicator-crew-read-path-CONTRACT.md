# Applicator crew read path: behavior contract

Status: settled after one cold challenge (Astra gpt-6.2-astra high, 62 findings, 2026-11-25); targeted re-check of the revised mechanism pending. Read at `origin/staging` 1414a0d35; live probe on a local Docker copy migrated to d3f186d0c (the three later staging migrations touch none of these objects: checked by diff; the local copy is rebuilt from the PR head before the after-proof).

## 1. Outcome and authority

**Business result (Mason, 2026-11-25, "Yes, hide them"; on Sol finding 1 of PR #2574, "fix"):** applicators must not *receive* job selling prices, chemical prices, billing-split percentages, the commission split or the internal memo. Payer names and account numbers stay visible. Admin and sales rep access is unchanged.

**Why a new read path (fact):** every app user is the same Postgres role `authenticated`, so a column grant cannot differ by app role, and RLS hides rows, not columns. Cost is already column-revoked for everyone (`jobs.total_cost_cents`, `job_chemicals.cost_per_unit_cents`: "permission denied" for admin too in the probe) and is out of scope. Leaks today (probe `before.json`; applicator A, dispatchee D):

| Source | Leaked to crew |
|---|---|
| `jobs` | `total_price_cents`, `internal_memo`, `commission_split` |
| `job_chemicals` | `price_per_unit_cents` |
| `job_field_shares` | `split_pct` |
| `field_billing_defaults` | `split_pct` (`price_override_cents`/`pricing_note` are NULL by validated CHECK `field_billing_defaults_no_per_acre_price`) |
| `get_dispatch_board_jobs` (SECURITY DEFINER) | whole job row minus cost |

**Alternative rejected (Astra 60, 62):** column-revoking the money columns for everyone and giving office a separate money endpoint would move every office money screen (Jobs, Job Detail, unbilled field applications, Office Cockpit, Customer Detail, reconciliation, print/list helpers; 12+ files) onto a new path, touching field invoicing and money screens that work today. The crew path changes only what applicators read. Office behavior stays byte-identical.

**Design.** One idea: each "crew" view is the base table minus the protected columns, with **exactly today's row rule** written into the view, so anything that reads the view instead of the base table gets today's rows.

1. Four views, owned by `postgres` (so they read the base table without its RLS and apply their own filter), `security_barrier`, explicit named column lists (never `*`), `SELECT` granted to `authenticated` and `service_role` (everything revoked from `PUBLIC` and `anon`). Each filter is today's SELECT policy text, verbatim, OR'd with one clause: the current database role has `rolbypassrls` (`pg_roles`), so SECURITY DEFINER functions (running as `postgres`) and service contexts keep seeing every row, exactly the roles that skip the base table's RLS today:
   - `jobs_crew`: all `jobs` columns except `total_price_cents`, `total_cost_cents`, `internal_memo`, `commission_split`. Filter = `jobs_select` OR `jobs_select_location_dispatchee`.
   - `job_chemicals_crew`: all except `price_per_unit_cents`, `cost_per_unit_cents`. Filter = `job_chemicals_select` (reading `jobs_crew`) OR `job_chemicals_select_location_dispatchee`.
   - `job_field_shares_crew`: all except `split_pct`. Filter = `job_field_shares_select` verbatim (keeps its `is_applicator()` on the dispatch branch: Astra 1).
   - `field_billing_defaults_crew`: all except `split_pct`, `price_override_cents`, `pricing_note`. Filter = `fbd_select` verbatim (payer identity for field-only screens and legacy jobs without saved shares stays available: Astra 5, 10).
2. **Ripple (24 policies, Appendix A):** in each policy, replace the inline read of `jobs` with `jobs_crew` and nothing else. Every other condition, alias and comparison (including storage's `j.id::text = foldername`) stays identical text, so each policy keeps today's meaning for every caller (Astra 14–18, 32 do not arise: no new helper predicates).
3. **Invoker functions** that read these tables as the caller: `get_notes_for_entity` ('job' case), `worksheet_weight_is_valid`, `get_loader_worksheet_weights`, and the billed-history trigger `_enforce_billed_job_applied_record_immutability`: replace `jobs` with `jobs_crew` and `job_chemicals` with `job_chemicals_crew`, nothing else. None reads a protected column (checked). The trigger stays SECURITY INVOKER; through `jobs_crew` it sees exactly the jobs it sees today, so after lockdown a crew write on an invoiced job is still refused (today's critical gap closed without changing the trigger's identity: Astra 19, 23 do not arise). Not app-callable or office-only, unchanged: `_cost_step2_job_chemicals`, `_field_billing_copy_actual_20270303`, `_job_transfer_shares_20270207` (no EXECUTE for `anon`/`authenticated`), `validate_product_units`, `_enforce_quote_status_transition`.
4. `get_dispatch_board_jobs`: office callers (`is_admin()` / `is_sales_rep()`) unchanged. For any other caller, the job part of each row is `to_jsonb` of the `jobs_crew` row with the board's own authorized job id, plus `_total_count` (a fixed column list, so a future private `jobs` column is never sent automatically: Astra 34). All other keys unchanged.
5. **Lockdown (separate PR):** remove the crew branches from `jobs_select` (keep `is_admin() OR is_sales_rep()`), drop `jobs_select_location_dispatchee`, the same for `job_chemicals_select` / `job_chemicals_select_location_dispatchee`, `job_field_shares_select`, `fbd_select`. Office branches unchanged.

**Who may act:** read paths only; the write policies keep today's meaning (text swap). The screens send locators (job IDs, worksheet IDs, applicator ID for the board); every view and policy derives the actor from `auth.uid()` and the existing role helpers.

**Expected files.** PR 1: one migration, its record, ledger entry, real-schema proof and reverse script. The schema registry is regenerated from the live database after the apply (`regen-schema-registry`); generated types for the views ship with PR 2, which is their first caller. PR 2 (#2574): `src/lib/costFields.ts`, `src/pages/JobDetail.tsx`, `src/pages/Jobs.tsx`, `src/pages/DispatchBoard.tsx`, `src/pages/FieldView.tsx`, `src/lib/applicatorSheetPrintData.ts`, `src/lib/applicatorSheetData.ts`, `src/lib/dispatchDisplay.ts`, report/print helpers that read `jobs`/`job_chemicals` for crew, tests. PR 3: one migration + ledger record.

## 2. State and failure

- **Rules that always hold:** crew see and may write exactly today's rows on every table in Appendix A; after PR 2 + PR 3 they never receive the protected columns; office results are identical.
- **Existing rows:** no data changes.
- **Timing / idempotency:** no new mutating RPC. A role or crew change takes effect on the next request, as today. Already-fetched data in an open tab is not recalled (same as today for any permission change).
- **Print payers (Astra 2–4, 7):** for crew, the field sheet shows payer names and account numbers only, never acres per payer or percent of job (those reveal the split). The split table is already off for crew (#2574). Payers come from `get_job_billed_customers` (it already resolves saved shares, then field defaults, then the primary customer, and already admits applicator, dispatchee and crew), shown as one de-duplicated job-level list of names and account numbers. A failed lookup shows an error toast and stops the print, never a silently empty payer list.
- **Undo / recovery:** PR 1 is reversible by a reviewed corrective migration that restores the old policy/function text and then drops the views (kept in the migration as the rollback block), valid only while PR 2 is not deployed (PR 2 reads the views). After PR 3, the privacy-preserving recovery for a broken crew screen is a PR 2 app fix, not re-opening base access; a full revert of PR 3 re-opens the leak and needs Mason's yes.

## 3. Delivery (database first; each step works with what is deployed)

1. **PR 1, database step 1:** views, ripple swaps, function swaps, board change. With base crew branches still on, every swapped read returns the same rows, so the deployed app is unaffected. Visible change: board rows for crew lose the protected keys (the deployed board reads none of them: grep of `src/pages/DispatchBoard.tsx`, `src/components/dispatch/`, `src/lib/dispatchDisplay.ts` before merge).
2. **PR 2, app (#2574):** crew screens read the crew views and never select protected columns. Merges after PR 1 is live on staging.
3. **PR 3, lockdown:** step 5. Merges after PR 2 is live on staging and verified in the browser there.
4. **Production:** releases carry PR 1 → PR 2 → PR 3 in order. Preferred: PR 3 rides a later release than PR 2, so no old bundle meets the lockdown. If one release carries all three, an open old tab sees empty crew lists until reload; the live app is not in real use yet (memory 2026-11-24, to be re-confirmed in the release PR). The release owner (Taha or Mason) decides at release time.

## 4. Proof cases (local Docker copy, invented data; never staging or production data)

Fixture (local only, `scripts/local-app/access-probe` in the walk checkout): applicator A (whole-job applicator of job A scheduled and job E invoiced yesterday), applicator D (location dispatch on job B), a non-applicator crew member K (driver; active member of a crew dispatched on job C with no applicator), a sales rep S, job C (nobody's), payer P on a 70/30 split, two fields and two chemicals on job A. The probe records **exact row IDs** per table and full payloads per RPC, as A, D, K, S and admin.

1. **After PR 1:** every probe result equals `before.json` except board rows for A, D, K, which keep the same job IDs but contain no protected key (`total_price_cents`, `internal_memo`, `commission_split`, `total_cost_cents`) at any depth.
2. **After PR 1:** each crew view returns, per actor, exactly the row IDs that its base table returns today, and none of the protected columns (`information_schema.columns`); `anon` has no SELECT on any view; `authenticated` has no INSERT/UPDATE/DELETE on any view.
3. **After PR 3:** as A, D, K, the four base tables return no rows; every other result equals `after-PR1`: customers, job fields, applied info/records/fields/crew, attachments and storage objects, loader worksheets and the full loader-weights payload (both entry modes), dispatches, EPA, tags, notes, billed customers, dispatched list, board.
4. **Writes, before = after PR 1 = after PR 3:** A may update job A's applied info, add an attachment and its storage object on job A, and is refused on job B and an invalid folder; A's update and delete of invoiced job E's record, its field rows and crew rows are refused by the billed-history trigger (not a silent zero-row result); D's update of job B's applied info returns today's outcome; K and S as today.
5. **Office:** admin and S see unchanged rows and values on the four base tables, including prices, memo and splits.
6. **Browser (local, PR 2 + PR 3):** as A and K: Jobs list, Job Detail, Field View, field sheet print (payer names and account numbers, no split %, no payer acres), attachment upload and download, loader worksheet, dispatch board all work, and no network response contains a protected key. As admin and sales rep: unchanged.

## Business decisions

Mason, 2026-11-25 (relayed verbatim by the parent session): "Yes, second step". All three are hidden from applicators, in a **separate step 2 PR after this job fix lands**:

1. Product and recipe prices (`products` tier and per-acre prices, current cost, margins; `blend_recipe_items.price_per_unit_cents`). `products` is shared with quoting: flag it to Taha when step 2 starts (office access unchanged).
2. Customer credit limit, prepay balance, standing discount and notes on their jobs' customers.
3. Application service `$/acre` rate and cost (`application_services`).

**Follow-up (step 2, not in PRs 1–3):** same pattern (crew views, then lockdown), with its own contract delta, before/after probe and Sol.

## Challenge settlement (Astra round 1)

- **Corrected:** 1 (shares view keeps `is_applicator()`), 2–4, 7 (crew print shows names and accounts only; errors surface), 5, 10 (fbd crew view keeps payer identity), 14–18, 32 (text-only swap instead of new helper predicates), 19, 23 (trigger stays invoker), 34 (fixed column lists), 41 (per-phase expectations), 42, 45–47 (exact IDs and full payloads), 43, 44 (D writes on B; K, S added), 53 (protected-key list explicit), 54 (PR 1's one visible change named), 55, 58 (production order and recovery stated).
- **Already true / no change:** 3 (no acres or % for crew), 11 (each screen keeps today's audience, enforced by verbatim filters), 13 (jobs `notes`, `loader_comment` and fbd `notes` are operational fields crew use today; no workflow copies price into them was found; `pricing_note` is always NULL), 16 (every job FK is validated, and jobs_quote_section_id_fkey is DEFERRABLE INITIALLY DEFERRED; office branches are unchanged text), 28 (CHECK is validated), 29 (wording fixed), 49–51 (local probe hygiene; fixed where it affects a proof).
- **Out of scope (pre-existing, unchanged by this work; listed as follow-ups):** 20, 22 (billed-history trigger edge cases), 24, 59 (concurrent billing/save), 30, 31, 33 (board vs. dispatch-list membership differences), 32's timezone difference, 39 (performance: checked by timing the after-probe against before).
- **Decision for the release owner, not Mason now:** 56 (whether PR 3 shares a release with PR 2).
- **Declined suggestions:** 60, 62 (see "Alternative rejected"); 61 adopted.

## Challenge settlement (Astra re-check, 22 findings)

- **Corrected:** 1 (bypass clause is `rolbypassrls`, not a role-name test), 2 (`service_role` granted), 7, 8 (probe adds child-row writes on the invoiced job and attachment/storage writes), 9 (`read_at` timestamp excluded from payload comparison), 12 (protected keys scanned at any depth), 13 (K's board is expected empty, A's and D's non-empty), 14–18, 20 (crew print uses `get_job_billed_customers` job-level), 19 (print fails closed), 21, 22 (recovery is a reviewed corrective migration; PR 1 rollback only before PR 2 deploys).
- **Checked, no change:** 3 (no restrictive policies; every base policy is `TO authenticated`), 4 (views carry SELECT only), 5 (policy alias preserved; applied cleanly locally), 6 (`job-attachments` storage policies are `TO authenticated`; `anon` reads none), 10, 11 (`_total_count` carried; payload keyed by the board's authorized id).

## Gate settlement (Luna round 1, Sol round 1 on 589855216: verdict clean)

- **Luna MED (stamp order):** refuted. Every migration here uses the 2027 stamp sequence (the three before it are `20270307140000`–`180000`); the step-3 lockdown takes a later stamp, and its preflight requires the crew views.
- **Sol MED 1 (a restrictive or extra read policy would be bypassed by the owner-run views):** fixed. The preflight refuses if any restrictive policy, or any SELECT/ALL policy other than the six copied ones (all `TO authenticated`), exists on the four tables.
- **Sol MED 2 (the reverse could overwrite a later tightening):** deferred to the rollback itself. The reverse script is the body of a future reviewed migration, which must pin the then-current definitions in its own preflight (as this one does) before it may run.
- **Sol LOW 3 (`metabase_ro` keeps the default SELECT on the views):** refuted. `metabase_ro` already holds SELECT on all four base tables, does not bypass row security, and is not in any policy's role list, so the view filter (`auth.uid()`-based) returns it nothing more than the base tables do.
- **Sol LOW 4 (board proof compared keys only):** fixed. The proof compares every board row minus the protected keys, before and after.
- **Sol LOW 5 (no saved weight in the fixture):** fixed. Each worksheet has a saved, current weight, and the proof asserts it is in A's payload.
- **Sol LOW 6 (reuse mode after a failed run):** deferred. Reuse is a developer shortcut; the gate run builds a fresh database every time.
- **Sol LOW 7 (types and registry):** fixed in this contract's expected-files line (registry after the live apply; types with PR 2).

## Gate settlement (Sol round 2 on d5e03608e: verdict clean)

- **MED 1 (the policy hash ignored roles, command and permissive/restrictive):** fixed. The 24-policy hash now covers each policy's roles, command and mode, so a role-only change to a recreated policy is refused; the proof shows it on `job_attachments_objects_select`.
- **MED 2 (the views copy the read rules once; a later restrictive policy on `jobs` would not reach them):** deferred by design to step 3 and every later migration on these four tables: the views are the crew read path, so any later tightening must be made on the view filter too. The install-time preflight already refuses if one exists now.
- **MED 3 (proof reuse mode could seed into a non-throwaway container):** fixed. Reuse now refuses unless the container is named `crx-undo-paths-*` or `crx-crp-*`.
- **MED 4 (the reverse does not pin current definitions):** deferred, same as Sol round 1 MED 2.
- **LOW 5 (`metabase_ro`):** refuted, same as Sol round 1 LOW 3.
- **LOW 6 (the applicator delete case removes zero rows both times):** deferred. Delete permission is unchanged by this migration (only its `jobs` lookup moved to `jobs_crew`), and before = after is proven for that call; an own-upload delete case belongs to the step-3 proof, where delete rules may change.

## Gate settlement (Sol round 3 on dab876b3c: verdict clean, 0 blocking findings)

- **MED (views outlive a later tightening):** deferred by design, same as round 2 MED 2.
- **MED (an allowed policy name could change to another command with the same text):** deferred. Only a migration landing ahead of this one could do that; the staging-first order puts every such migration through this preflight's review, and no open PR touches these policies (Taha's #2525, #2526, #2537, #2556 checked 2026-11-25).
- **MED (the function check hashes bodies, not execution settings):** deferred on the same grounds. Since round 1, none of the five functions has had a settings-only change (each is recreated with its current settings).
- **MED (the reverse does not check current definitions):** deferred, same as round 1 MED 2.
- **MED (job-tag probe selects a missing `id`):** refuted. The probe reads `t.job_id` (proof line 146) and returns real rows: the applicator sees jobs A and E only; admin sees A, B, C and E. These match before and after.
- **LOW (`metabase_ro`):** refuted, same as round 1 LOW 3.
- **LOW (own-upload delete case):** deferred to the step-3 proof, same as round 2 LOW 6.
- **LOW (reuse trusts a name prefix):** accepted as is. Reuse is a developer shortcut, and the gate run always builds a fresh database.

## Appendix A: policies that read `jobs` inline (local copy, `pg_policies`)

customers: `customers_select`, `customers_select_location_dispatchee` · job_applied_info: insert, update · job_applied_records: insert, update, delete · job_applied_record_fields: insert, update, delete · job_applied_record_crew: insert, update, delete · job_attachments: insert, delete · job_chemicals_select · job_fields_select · job_loader_worksheets_select · job_location_dispatches_select · job_product_epa_select · job_tag_assignments_select · storage.objects: `job_attachments_objects_select/insert/delete`.
