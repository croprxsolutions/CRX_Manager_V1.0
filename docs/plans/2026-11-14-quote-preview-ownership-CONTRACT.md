# Quote preview and draft ownership — #1881

Baseline: staging `73e17efcd`, containing main `a52195dbe`, November 14, 2026.

## Outcome and authority

The quote's admin cost, profit and margin preview must use the database's existing line-first cent rounding. Two lines costing $0.005 each must total $0.02, not $0.01. Rewrite the existing buggy computeQuoteTotals using quoteCalc's exact decimal/BigInt rounding; remove QuoteBuilder's duplicate aggregate. Sum rounded lines as integer cents and derive profit from price cents minus cost cents. Round margin with exactRound2([profit,100],[price]), including $2.01 profit / $200 price =1.01%. Saved server calculations, customer prices/PDFs and access to cost remain authoritative and unchanged. A zero-cost case is preview-only because the server requires a positive cost basis for saved lines.

An existing draft opened by a non-admin who did not create it has its chemical-sale edits disabled. Use its already-loaded created_by, not its salesperson label. Disable Save, draft editing and draft mutation affordances and give an ownership explanation. Guard the shared save handler and email/version action too. Missing creator information must not enable editing for a non-admin. New drafts, the creator's drafts and admin edits continue normally. Sent/revised booking price changes by other reps remain as decided November 1 (DECISION_LOG.md, any rep changes booked prices); do not restrict those paths or cross-rep booking conversion. Schedule Job and existing job links stay unchanged, including on another rep's planned draft; the edit-disabled groups must not contain those actions.

Expected files: src/lib/quoteCalc.ts and its tests (including existing financeChargeCalc.test.ts callers); src/pages/QuoteBuilder.tsx and its tests. No new dependency, table, RPC, permission, timer or background work. No migration. Invoice footer work is excluded because billing/PDF PR #1873 owns it.

## Facts and limits

- QuoteBuilder currently rounds a raw aggregate at lines2127 onward and checks draft/revised status only for canEdit.
- Latest underlying save implementation is in 20261204100000_ki18_batch1_chicago_today.sql: actor-bound admin/rep access, created_by ownership with existing narrow booked-price exception, receipt binding and version checks, SUM(ROUND(current_cost * total_units_needed,2)). Public save_quote is in 20261104130000_any_rep_changes_booked_prices.sql. No server source is edited.
- Existing isolated PostgreSQL17 fixture reports save_quote body MD5 0d3d7e3ed2da614079e054ff081de316 and implementation393f4fe11538d55bb849d1224901b0f7. Compare actual bodies with repository before relying on the fixture. Fresh production source inspection is UNVERIFIED because the native hook refused the read-only query; do not retry through another live route. The November14 chemical-sales gauntlet separately observed local server refusal with unchanged notes/version.
- quoteCalc computeQuoteTotals has only test callers today. Wire the real screen to it. Its exactRound2 callers retain their behavior. Missing cost keeps the existing zero preview; a real save still refuses missing/zero cost at the server. Do not change that existing presentation behavior in this issue. No refused typed money input is converted to zero. Totals also enter the save payload (server overwrites them, existing receipt binding retained) and PDF data (only price prints); cover those callers.

## State and failure

No stored data or historical totals are rewritten. The current RPC still derives costs, scope and actor, checks expected row_version and binds retry requests. Double clicks, unanswered requests, stale ownership and races retain the server's existing refusal/receipt behavior. An ownership change outside this tab can still produce a server refusal; the UI does not replace authorization. Install creator with the same complete, generation-guarded quote snapshot as status/items. Do not infer ownership from an old route's header. No new undo/history path.

## Proof cases

- Two $0.005 cost extensions total$0.02, with profit and margin matching rounded line cents: unit checks, isolated PostgreSQL numeric comparison and actual browser cost preview. Exact0.145 cost extension and $2.01/$200 margin tie are unit/SQL cases; the screen renders margin to one decimal and cannot visually distinguish1.00 from1.01. Zero/missing cost is unit/browser preview-only, never a successful database save case.
- Admin customer view and sales reps still see no cost/profit/margin. Existing tests and browser.
- Another rep's draft shows read-only ownership guidance, disabled Save and inputs, no draft send/book/cancel action, and no save request; its creator and admin can still save. Component and browser cases; isolated existing server refusal remains authoritative.
- A saved sent/revised booking's established cross-rep price path and booking conversion are unchanged. Focused existing suites and explicit revised-price affordance regression.
- Switching quote/profile cannot install old creator data or unlock another rep's draft. Existing load ownership guards and targeted component case.
- New draft saves, exact retries, customer pricing/PDF totals and shared rounding callers keep working. Focused suites, typecheck, lint, build and full suite; distinguish the inherited billing fixture failure from own defects.

## Delivery and recovery

One frontend PR against staging after all required reviews/checks, including actual Opus5.5. No push while gates are red and no merge. No production mutation, apply or deployment. Revert the eventual frontend commit to undo; no business data rollback.

## Cold challenge and settlement

Actual Opus5.5 high challenge6f8d5348 was VERIFIED with0 denials. Its margin-tie and zero-cost proof findings are corrected above. PostgreSQL fixture bodies now mechanically match both complete current repository bodies after LF normalization (MD5s above); read-only numeric comparison returned cost0.02/profit0.98 for the concrete two-line case. Fresh live verification remains unavailable. The complete local sales-stack rebuild refused another checkout's ownership; no stack was changed. Screen proof must clearly distinguish a synthetic API from real local SQL. Do not claim a fresh full sales-stack journey.

Mason answered both app-native questions November14: "Keep creator/admin editing and leave Schedule Job unchanged." This keeps the server's existing creator ownership even on a rollover/admin-created draft naming another salesperson; no new permission or reassignment path. Account for Save/Email/Mark Presented/Cancel/planned toggle/splits/lines, install creator with the existing complete guarded quote snapshot, and establish creator after successful new creation without a false lock flash. Keep scheduling outside the disabled edit groups and test actual Schedule Anyway dispatch without save_quote. Preserve current cross-rep sent/revised booked-price permission; its non-price edit UX remains a named existing deferral, application-maintenance owner. No server permission change is part of the current proposal.

The independent rounding fix has no unresolved business choice. A targeted re-check covers only its settled exact-cent aggregation, exact margin, preview-only zero cost and proof limits; the pending ownership questions do not hold that independent work.

Targeted Opus re-check b3786238: no B/H/M math defects; its three wording/proof findings are settled above without a design change. Missing cost is explicitly the unchanged preview-only behavior; no new business decision. Additional PostgreSQL tie comparisons must be observed, not inferred. No further plan loop is needed.

## Rebase onto the quote redesign (November 16)

At Taha's request, staging (with redesign PRs #1900 and #1901) was merged in and both fixes re-applied to the new screen rather than restoring the old one. The redesign's single totals rule `quoteTotals` now calls `computeQuoteTotals`. The draft lock folds into `canEdit`, so the redesign's own read-only mode hides Save draft, Add product and Add a section and disables the form; `canSend`, `canCancel` and the More menu's Book as order also exclude a locked draft, and the shared save handler and Email to grower still refuse it. Schedule job stays outside the lock.
