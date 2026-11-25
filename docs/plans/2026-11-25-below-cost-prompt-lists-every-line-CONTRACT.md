# Below-cost prompt lists every line (pricing audit fix 1) — behavior contract

Read at `origin/staging` c8f9f8e77 (2026-11-25). Parent audit: `docs/plans/2026-11-25-pricing-audit-top4-CONTRACT.md` on branch `fix/pricing-audit-top4` (section 1 and the fix-1 cold-challenge paragraph). Mason, 2026-11-25 (Q1): fix 1 ships as its own database-first PR, written and reviewed but applied nowhere until he approves.

## 1. Outcome and authority

**Outcome.** When an admin saves a quote, order or invoice through one of the 11 wrapped save operations, and the save has lines that need a fresh below-cost approval, and no reason was given yet, the approval prompt lists every such line the database wrote in that save: product (or line description), price, cost, quantity and shortfall, plus the save's total shortfall. Then the admin types one reason, as today.

**Scope (Astra #8).** "Lines that need a fresh below-cost approval" means exactly the rows that reach today's `BELOW_COST_REASON_REQUIRED` branch. Rows the guard already lets through are not listed and are not changed: rush-order placeholders (`pricing_pending` at $0), exposure-reducing or bookkeeping updates, an invoice line that is an exact descendant of its order line, $0-cost non-product lines, and the field-app grower-share line (judged by its own rule). The blend-ticket RPC's own $0-line prompt is unchanged (see "Not in this PR").

**Facts (where from).**
- `_enforce_below_cost_line()` is a BEFORE row trigger on `order_items`, `quote_items`, `invoice_items` (`zz_crx_below_cost_*`; the invoice trigger skips signed return-credit rows). Newest body: `supabase/migrations/20270201180000_grower_share_rep_needs_price_to_cover_cost.sql:47`, md5 `5fa0a5f975dc2a84b3c6599a84b8cc55` (its postflight pin).
- Context comes from transaction-local settings set by `_begin_below_cost_money_write` (`20260812115237…:246`) for 11 operations, by `create_invoice_from_blend_ticket`, and by the field-app save (`field_app_grower_share`). The reason travels as `app.crx_below_cost_reason`.
- Order of checks for a below-cost, non-exempt row: no context → `BELOW_COST_CONTEXT_REQUIRED`; caller not an active admin → `BELOW_COST_ADMIN_REQUIRED` (detail has no cost); no reason → `BELOW_COST_REASON_REQUIRED:<detail of THIS row>` (first below-cost row only); else one `below_cost_approvals` row per below-cost row write.
- Only `create_invoice_from_blend_ticket` raises `BELOW_COST_REASON_REQUIRED` itself, for its $0 lines (`zero_lines`), BEFORE it writes any line (`20270129190000…:805-811`). It is unchanged.
- No function that writes these tables catches `BELOW_COST_*` (scan of the newest body of every function that inserts/updates the three tables: only `complete_delivery`'s split and bill-split blocks catch `OTHERS`, and they run without a below-cost operation context, so they never reach the reason branch; the blend RPC catches `raise_exception` around a price lookup only). `SET CONSTRAINTS` appears only in `20260723193312` (return items) and `20270305190000` (field splits), neither on these tables' writers.
- Precedent for commit-time errors reaching the screen: `DEFERRABLE INITIALLY DEFERRED` constraint triggers already guard field splits (`20260713060000`) and bulk-PO fingerprints (`20260717063445`). `docs/reference/gotchas.md:30`: a deferred trigger does not run with the RPC's rights, and needs a proof that it fires after the public RPC returns.
- The screen: `src/contexts/BelowCostApprovalContext.tsx` runs the attempt, parses the refusal (`src/lib/belowCostApproval.ts`), shows `src/components/ui/BelowCostApprovalModal.tsx`, then retries with the reason. 15 call sites; only `BlendTicketDetail.tsx` uses the detail (its `zero_lines`).

**Smallest change.** One new migration, `20270307100000_below_cost_prompt_lists_every_line.sql`:
1. `_enforce_below_cost_line` re-created from the `5fa0a5f9…` body with two additions. (a) At the top: if a note exists, drop this row's entry (the row is judged afresh). (b) In the admin "no reason" branch only: instead of raising, note the row's detail (today's detail plus `quantity`, `line_shortfall_cents` and `per` = `unit` or `line`) in the transaction-local setting `app.crx_below_cost_pending`, keyed `<table>:<line id>`, with a write sequence number, and let the row write. Every other branch is unchanged.
2. A new trigger function `_raise_below_cost_reason_list()` (SECURITY DEFINER, `search_path = public, pg_temp`, owner postgres, EXECUTE only postgres and service_role) and one `CONSTRAINT TRIGGER zzz_crx_below_cost_reason_list AFTER INSERT OR UPDATE … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (pending setting is not empty)` on each of the three tables. At commit (after the RPC has returned) the first queued event keeps the noted lines whose row still exists. If any remain, it raises ONE `BELOW_COST_REASON_REQUIRED:` error; the whole save rolls back, as today. If none remain, it clears the note and the commit proceeds.
3. No cap. Every line is listed.

**Wire format (Astra #27).** The JSON keeps today's top-level fields, taken from the first line written (lowest sequence), so the already-deployed screen still shows that line. It adds `lines` (every listed line in write order; each: operation, entity type and id, line id, product id/name, `unit_price_cents`, `locked_unit_cost_cents`, `quantity`, `line_shortfall_cents`, `per`), `line_count` (= number of listed lines), `more_count` (always 0; kept so the parser has one shape) and `total_shortfall_cents` (= the sum of the listed lines).

**Shortfall (Astra #11).** Each line's shortfall is the approval log's own formula, `round((cost cents − price cents) × quantity)`, the number the retry will write to `below_cost_approvals.total_shortfall_cents`. The total is the sum of those. For a non-product invoice line (`per` = `line`) price and cost are already line totals and quantity is 1, as the guard compares them today; the screen shows "(line total)" and no quantity.

Front end: parse `lines` and render a table (product, price, cost, qty, shortfall) and the total. If `lines` is absent (database not yet migrated), keep today's text unchanged. Each prompt is its own dialog instance, so a reason typed for one save never carries into another save's prompt (Astra #33). The reason box takes at most 1,000 characters, what the approval log keeps (Astra #17).

**Why deferred triggers, not an end-of-RPC check (Astra #44).** A finishing call inside each public wrapper would mean re-creating 11 wrapper bodies plus the blend RPC, each with its own pins, for the same result. The setting is needed because a row trigger cannot see the save's other rows; the deferred trigger is needed because the save's last row is only known at commit. The gotchas.md:30 risks are handled: the function is SECURITY DEFINER with a fixed search path and revoked EXECUTE, and the proof commits through a real PostgREST server.

**Who may act.** Unchanged: only an active admin can approve; a rep still gets `BELOW_COST_ADMIN_REQUIRED` at the first below-cost row, inside the RPC (no cost shown, no list); a write with no context still fails at once. The list is built only on the admin branch, so cost reaches only admins.

**What the screen sends.** Unchanged: the reason, in the same transport. The list is display only; the retry sends nothing from it.

## 2. State and failure

- **Rule that always holds:** a line that needs a fresh approval is never saved without an admin's reason and an approval row. Before: the save stopped at the first such row. After: it stops at commit. Either way the transaction rolls back, so no line, header, stock reservation, idempotency row or queued message survives.
- **A line fixed later in the same save (Astra #3, #4, #18):** a row raised to cost or made exempt by a later write in the same save drops its note (it is judged afresh); a row deleted later, or an insert that ON CONFLICT turned into an update of another row, no longer exists at commit and is not listed. A row written below cost twice is listed once, at its latest values.
- **Error order (Astra #23):** the RPC now runs past the first below-cost row to its end. If it hits another error first (stock, validation, a rep-only refusal on a later row), that error is shown on the FIRST attempt, with no prompt, and nothing is saved. The admin fixes that problem and saves again, and then sees the list. Sequence numbers consumed by a rolled-back save are lost, as today.
- **Locks (Astra #25):** a refused no-reason save now holds its `FOR SHARE` product locks until the end of the RPC instead of the first below-cost row. These are share locks; they block only a cost change on those products for the length of one save.
- **Existing rows:** none change. `below_cost_approvals` rows are written exactly as today (only on the retry with a reason).
- **Rollout:** old screen + new database: the old parser reads the top-level fields and shows the first line, as today. New screen + old database: no `lines`, today's prompt. So either order works; the feature appears once both are live.
- **Timing:** double click or two admins: each save fails on its own with its own list. A retry runs in a new transaction and re-judges every line against cost at that moment; the reason covers whatever is below cost then (unchanged from today; see the follow-up below).
- **Undo:** `scripts/smoke/below-cost-prompt-lists-every-line-reverse.sql` refuses unless the installed body and triggers are exactly this migration's, drops the three triggers and the new function, restores the `5fa0a5f9…` body and checks it in one transaction.

## 3. Delivery

This PR is the database change plus the screen that reads it; the screen is backward compatible, so one PR. Into `staging` as a DRAFT. Not applied anywhere (staging or production) until Mason approves the apply himself.

## 4. Proof cases

Container prover `scripts/smoke/prove-below-cost-prompt-lists-every-line-real-schema.mjs`, on a replayed real schema, as the real `authenticated` caller with JWT claims, each call COMMITTED so the deferred trigger fires after the RPC returns.

1. An admin calls `create_direct_order` with three lines, two below cost and one above, and no reason: every statement runs, COMMIT fails with `BELOW_COST_REASON_REQUIRED`, `lines` has exactly the two (name, price, cost, quantity, shortfall), the total is their sum, and no order or approval row exists afterwards.
2. The admin retries with a reason: the order saves and exactly two approval rows are written under that admin, matching the listed lines field for field.
3. A sales rep does case 1: `BELOW_COST_ADMIN_REQUIRED` at the first line, inside the RPC, with no cost and no `lines`.
6. In one save: a below-cost line raised to cost saves with no prompt; one deleted saves with no prompt; one written twice is listed once at its latest price.
7. 300 below-cost lines: all 300 listed, total = their sum, nothing saved.
8. No context: `BELOW_COST_CONTEXT_REQUIRED` at once. `SET CONSTRAINTS ALL IMMEDIATE` fires the list refusal at the write: still a refusal, never a save.
9. A second apply stops at the preflight; the reverse restores the old body (first-line refusal, no list; an approved save still works) and the candidate re-applies.
10. Screen (unit tests): the provider passes `lines` to the prompt; the prompt lists every line, each shortfall and the total; with no `lines` it shows today's text; a rep's refusal makes no prompt; a second save's prompt starts with an empty reason.
11. The real HTTP path: a disposable PostgREST server in front of the same database. The admin's `create_direct_order` returns an HTTP error whose JSON is `{code: P0001, message: "BELOW_COST_REASON_REQUIRED:{…}"}` with both lines and the total; nothing is saved; a rep gets `BELOW_COST_ADMIN_REQUIRED` with no cost; the retry with a reason returns 200 and logs the two listed lines.
12. `save_invoice` re-saving a draft invoice's kept order-linked line that an earlier approved save repriced below the order's price and below cost, with no reason (it re-inserts the line under a new id, then restores the saved id): before the change, refused inside the RPC; after, still refused, at COMMIT, listing that line under its real id; the draft is unchanged. Found by the security review: without carrying the note to the restored id the re-save would have saved silently, with no approval row. The note moves only when the restored row keeps its product, price, cost and quantity (or less); case 12b: a line written below cost, then given another id and raised to cost in the same save, saves with no prompt (Luna round 2). Case 12c: a kept line restored with a lower quantity is listed at the restored quantity and shortfall; only product lines carry a note, so a non-product line restored with a changed line total is judged afresh (Luna round 3).

Not proven in the container (named in the PR): `save_quote` server re-pricing and `save_invoice` fee lines through their RPCs (the same branch and the same note code serve them; the screen's `per: line` rendering is unit-tested); a live browser check, which needs the migration applied and is a step after Mason's apply approval.

## Not in this PR (follow-ups)

- **Blend tickets (Astra #6, #7; existing behavior, unchanged).** `create_invoice_from_blend_ticket` asks about its $0 lines before writing any line. If the ticket also has a line priced above $0 but below cost, the retry's reason approves that line too, though the prompt did not show it; and a blend with only such lines asks, then refuses the retry as `BELOW_COST_APPROVAL_STALE`. Both happen today exactly the same way. Fixing them means changing the blend RPC's own pre-check; a separate fix.
- **Retry bound to what was shown (Astra #9; business decision for Mason).** Today and after this PR, the retry re-judges lines at that moment: if cost, price or quantity changed while the prompt was open, the same reason covers the new amounts. Refusing when the set or amounts changed would be a new rule.
- **A line written twice in one reasoned save logs twice (Luna round 1 MED; existing).** The prompt lists a line written twice once, at its latest price; the retry with a reason logs one approval row per below-cost write, as it does today (for example `save_invoice` restoring a repriced order-linked line judges it at the insert and again at the restore, so two rows, before and after this PR). Changing which writes log an approval row is outside this PR (the approval log is unchanged by brief).
- **Overlapping saves share one prompt (Luna round 2 MED; existing).** If a second save is refused while the first save's prompt is open, the newer refusal replaces the prompt and the first save is cancelled (nothing saved); unchanged by this PR, which only gives each prompt a fresh reason box.
- **Cents beyond 9 quadrillion are not listed (Luna round 3 LOW; refuted).** The screen reads only whole cents JavaScript holds exactly (up to about $90 trillion). Supplier costs are capped at $10,000,000 a quote line (migration `20270304140000`), so no real line comes near; such a line would still be refused, only shown with the first line's detail.
- **Second refusal inside the shared flow (Astra #35; existing).** A refusal on the retry itself reaches the caller as a raw error, as today.

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-25: 45 findings, BLOCKED)

| # | Disposition |
|---|---|
| 1 BLOCKER cap hides lines | Fixed: no cap; proof case 7 (300 lines). |
| 2 overflow double count | Fixed: no overflow path. |
| 3 corrected/exempt/deleted line still blocks | Fixed: note dropped at the top of every judged write; rows gone at commit are not listed; case 6. |
| 4 row id may change | Covered by keying on the final row: a rebuilt line that is deleted and re-inserted lists only the row that exists at commit. |
| 5 one displayed line, two approval rows | Existing retry behavior (one approval row per below-cost write), unchanged; case 2 shows one row per line on the direct order path. |
| 6 BLOCKER blend mixed case | Existing, unchanged; follow-up above. |
| 7 blend positive-only | Existing, unchanged; follow-up above. |
| 8 scope | Stated in "Scope". |
| 9 retry covers a different loss | Existing; follow-up, Mason's decision. |
| 10 multi-document saves | Each line carries its entity type and id; the 11 wrapped operations each save one document. |
| 11 shortfall formula | The approval log's formula; stated. |
| 12 fee quantity | `per: line` rows show "(line total)" and no quantity; unit-tested. |
| 13 misc charge combinations | The guard's existing branch computes them; unchanged. Not container-proven (named). |
| 14 legacy values | The guard's existing validation runs before the note; no new arithmetic beyond the approval formula. |
| 15 approved descendant | Existing exemption, unchanged; such lines are not listed. |
| 16 old reason in payload | Existing transport, unchanged. |
| 17 reason length | Fixed: reason box limited to 1,000 characters. |
| 18 WHEN at queue time / phantoms | The raise checks the note at commit and keeps only rows that exist; a later unrelated event finds an empty note. |
| 19 failure path for every write | Every noted row's own AFTER event is queued with a non-empty note (the BEFORE trigger set it); postflight pins the three triggers (deferred, enabled, function, WHEN); cases 1, 6, 7, 8. |
| 20 filtered UPDATE triggers | A column outside the guard's list cannot change the row's price, cost or quantity; the note keeps the values judged. |
| 21 nested / subtransactions | The note is transaction-local and rolls back with a subtransaction like the rows; nested calls share it; `set_config(..., true)` ends with the transaction (pooled connections start empty). |
| 22 early firing | `SET CONSTRAINTS ALL IMMEDIATE` only fires the refusal earlier (case 8); no writer of these tables sets it. |
| 23 error order | Fixed in the contract text (section 2). |
| 24 side effects | Same transaction, rolls back as before; outbox rows are table rows. |
| 25 locks | Stated (share locks, one save). |
| 26 size | Case 7 measures 300 lines through PostgreSQL; the HTTP case covers delivery. |
| 27 wire format | Stated. |
| 28 BLOCKER HTTP proof | Fixed: case 11, real PostgREST. |
| 29 deferred authority | Fixed: SECURITY DEFINER, pinned; case 11 runs as the real caller. |
| 30 rep boundary | Rep path unchanged and refused inside the RPC; cases 3 and 11 inspect the whole error for cost and lines. |
| 31 malformed detail | Existing parser behavior, unchanged. |
| 32 numeric limits | Cents per line are bigint and parsed only as safe integers; quantity is a finite number. |
| 33 BLOCKER reason inherited | Fixed: one dialog instance per prompt; unit test fails without the fix. |
| 34 cancel lifecycle | Existing, unchanged. |
| 35 second refusal | Existing; follow-up. |
| 36 double click | Existing idempotency, unchanged. |
| 37 entry points | The change is in the one shared trigger every entry point hits; the screen change is in the one shared provider. |
| 38 modal copy | The list replaces the first-line text when `lines` is present; legacy copy kept only for an old database. |
| 39 long lists | The modal scrolls; not browser-checked (named). |
| 40 disclosure surface | Same class of data as today's admin refusal (cost for admins only). |
| 41 BLOCKER atomic install | Preflight pins the old body, header, grants and absence of the new objects; postflight pins the new body, the new function and the three triggers, in one transaction. |
| 42 reverse drift | The reverse pins the installed body and triggers first; case 9 proves undo and re-apply. |
| 43 rollout matrix | Old screen/new DB reads the top-level fields (unchanged shape); new screen/old DB unit-tested. |
| 44 end-of-RPC design | Considered; not taken (section 1). |
| 45 compare shown vs approved | Cases 2 and 11 compare the listed lines with the approval rows field for field. |

## Open business decisions

None for this PR. The follow-up "retry bound to what was shown" is Mason's call when he wants it.
