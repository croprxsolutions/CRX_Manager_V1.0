# Behavior contract: warn when a draft's parent rate changed (#1722 item 4)

Read at `origin/staging` 6a6462d4c. Decision: Mason, 2026-11-21, "yes i agree warn but allow it" (recorded on #1722).

## 1. Outcome and authority

- **Outcome.** Approving a draft product rate that was derived from its parent's rate, after that parent's rate changed, still approves. The preview and the commit result show a warning naming the value the draft came from and the parent's value now. The `approved` history event records the same warning.
- **Smallest change.** No new column, table or lock. A derived row's `source_text` is the parent's value at derive time:
  - `derived_house`: `concat_ws(' ', parent.rate_per_acre::text, house_unit)` (`20261229110000` `_product_rate_derive_parent`); `house_unit` is `btrim(parent.rate_unit)` for liquid/dry, the members' stock unit for seed/each.
  - `derived_text`: `parent.suggested_rate` as it was.
  - `source_text` is written only by `_product_rate_insert_derived`; `save_draft_product_rate` never sets it; `authenticated` has no UPDATE on `product_rates` (live read 2026-11-21).
- **Comparison (inlined in `_product_rate_review_approve`, after every existing refusal; no new function or grant):**
  - `manual` rows, and derived rows with an empty `source_text`: never warn.
  - `derived_house`: warn unless the first token of `source_text` is a number equal to `parent.rate_per_acre` (numeric compare: 4 = 4.00) and, for liquid/dry, the rest equals `btrim(parent.rate_unit)`. Seed/each keep the stock unit, so only the number counts. A non-numeric token never throws (CASE + regex guard); it warns.
  - `derived_text`: warn unless `NULLIF(btrim(parent.suggested_rate), '')` equals `btrim(source_text)`.
  - Result: `parent_changed: {was, now}`; `now` is null when the parent value is cleared (screen shows "none"). No key when nothing changed. Any textual difference warns (an alias such as oz -> fl oz included); the was/now text stays truthful.
- **Files.** New migration re-issuing `_product_rate_review_approve` (adds the check, the return key `parent_changed` and the event key) and `_product_rate_review_run` (passes `parent_changed` through on the approve phase); `src/types/index.ts`; `src/lib/rateReviewWorkbook.ts` (`parentChangedText`); `RateReviewWorkbookModal.tsx` (amber line per preview row, again per row on the saved result, stored-retry validator); a screen test; a real-schema prover; `migrations.d` record; changelog. Item 3 doc typo (1e12 -> 1e9) in the RT1 build sheet.
- **Authority.** Unchanged: `preview_rate_review` / `commit_rate_review` stay admin-only (`_product_parent_require_admin`); the re-issued functions are private (postgres-only EXECUTE, same ACL as today, pinned in preflight). The screen sends only locators and values, as today; the warning is derived server-side.

## 2. State and failure

- **Rule.** A warning never blocks: approval rules (`row_version`, active parent, basis confirmed, unit fits, label reason) are unchanged.
- **Existing rows (live read 2026-11-21).** 705 rates, all `approved`, 0 drafts; 0 derived rows differ from their parent today. Expected after apply: no visible change until a draft exists (new parent derive, or a reopen).
- **Deployed app during rollout.** The new key is extra JSON; the deployed preview validator checks only named fields, so it ignores it. The DB PR is safe alone.
- **Timing.** The check runs inside the approve, after `_product_rate_review_lock` (parent `FOR NO KEY UPDATE`), so it reads the parent value the approval commits against. Preview and commit each compute it; a parent change between them shows on the commit result (the value approved against). Preview still rolls back everything. Retry with the same idempotency key returns the stored receipt (unchanged path).
- **Undo/history.** The `approved` event's `after_values` gains `parent_changed` when warned. Reopen keeps values and `source_text`; a later re-approve re-checks.

## 3. Delivery

Database change and screen change are one PR into `staging`: the screen only reads an optional key (absent = no warning), so the screen works with or without the migration applied. No deadlock risk.

## 4. Proof cases (real migrated database via prover; screen via component test)

1. When a `derived_house` draft's parent `rate_per_acre` changed after derive, then commit approves it and returns `parent_changed` {was "<old> <unit>", now "<new> <unit>"}; the `approved` event holds it.
2. When a `derived_text` draft's parent `suggested_rate` changed, then same, with the text values.
3. When the parent rate is unchanged (or changed and changed back), or the row is `manual`, then no `parent_changed`.
4. When the parent's rate equals the derived one with a different scale (1.5 vs 1.50), then no warning.
5. When the preview runs, then it shows the warning and nothing is saved (status of the row unchanged after preview).
6. When a non-admin calls preview/commit, then refused (unchanged; prover asserts).
7. When an upload mixes a warned approval with a refused row, then the commit is refused and nothing (approval or warning event) is saved; a caller cannot send `parent_changed` in (unexpected field).
8. When the same idempotency key is retried after the parent moves again, then the original receipt comes back and only one `approved` event exists.
9. Screen: a preview row with `parent_changed` shows the amber warning and Confirm stays enabled; the saved result repeats it by sheet row ("none" for a cleared value); a stored retry with a malformed warning is treated as damaged.

## Challenge (Astra, gpt-6.2-astra high, 2026-11-21): 24 findings, settled

- Fixed in this contract: warning per sheet row in preview and on the receipt (#1-3); `now` null + omitted key (#4); stored-retry validator + tests (#5-6); non-throwing comparison (#7); inlined, no new helper or grant (#24).
- Disproved by live read-only evidence (2026-11-21: 705 rates, all approved, 0 drafts; 0 derived rows without a snapshot, 0 unparseable house rows, 0 whose source_text differs from its 'derived' event, 0 that would warn today; event-type CHECK widened in 20270104110000): #7-9, #20, #21.
- Accepted as wording/scope under Mason's warn-but-allow decision: aliases warn (#10), seed/each number only (#11-12), original derive baseline (#13), rule is "differs now" (#14).
- Unchanged: lock order (#15; the check is a plain read under the existing parent lock), reopen behavior (#19). Pre-existing timing gap out of scope (#16). Prover covers replay, preview rollback and mixed-batch rollback (#17-18). One PR, the screen tolerates a missing key (#22). Rollback in the migration header (#23).

## Open business decisions

None (Mason decided warn-but-allow, 2026-11-21).
