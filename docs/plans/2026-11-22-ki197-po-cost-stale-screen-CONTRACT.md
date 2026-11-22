# KI-197: a PO cost correction from a stale screen must not overwrite a newer one — behavior contract

Read at `origin/staging` 2132d7795 (2026-11-22). Lane E, bug sprint.

## Facts
- `set_purchase_order_item_costs(p_po_id, p_items, p_reason, p_performed_by, p_idempotency_key)` is defined once
  (`20261021140000` L513). Admin only (`require_admin`), key required, takes advisory lock 73492009, locks the PO's lines then
  the PO, and per item `{id, unit_cost_cents}` either confirms the same cost (rep line) or writes the new cost. Every change
  lands in `purchase_order_item_cost_changes` (append-only). Later migrations only mention it (closed-short trigger
  `PO_CLOSED_COST_CUT` refuses a lowered cost on a closed PO).
- `PurchaseOrderDetail.tsx` (~L1324-1380) builds each line from the draft and `currentCents` = the line's cost when the page
  loaded, and sends only `{id, unit_cost_cents}`. So if admin B saved $12 after admin A loaded the page at $10, A's save of
  $11 replaces B's $12 with no warning (the history keeps both).
- Product History's "Most recent received PO" (`ProductPriceHistory.tsx` L176) comes from `get_supplier_market_evidence`,
  which keeps received lines but orders by PO submission (or creation) date, not receipt date.

## Outcome and authority
- Each line may also carry `expected_unit_cost_cents` = the cost the admin saw. If sent and the stored cost differs, the
  whole call is refused with `PO_COST_CHANGED_SINCE_LOADED` (nothing saved). The screen always sends it, then reloads the PO
  and cost history so the admin sees the newer cost and decides again.
- Optional on the server, so an old browser tab (PWA can serve an old bundle) keeps working exactly as today until it
  reloads. Same rule for a confirm (unchanged cost on a rep line): a stale confirm is refused too.
- Who: unchanged (active admin). No new table, column, lock or permission. Fingerprint already covers `p_items`, so the
  new key is bound into replay automatically.
- "Most recent received PO": relabel to "Latest received PO (by order date)" — the evidence function's order is unchanged
  (smallest honest fix the KI offers; the audit found the same cost in all 3 differing products).

## State and failure
- Always true: a correction only replaces the cost the admin was looking at. Nothing else changes: same checks, same
  history rows, same PO total recompute, same bill-overage check.
- `expected_unit_cost_cents`, when the key is present, must be a JSON whole number 0..9007199254740991 (else
  `PO_EXPECTED_COST_INVALID`); absent = no check (old clients).
- Replay: checked before the stale check (as today), so a lost-response retry returns the first result.
- Existing rows: none touched. No data migration.
- Undo: a new correction, where the existing rules allow it (closed-short and evidence rules still apply).

## Delivery
- PR 1 (database): `CREATE OR REPLACE` of the one function (same signature; body md5-pinned in preflight; the new body is
  the old body plus one validation block and one compare block), postflight checks SECURITY DEFINER, owner, search_path and
  grants; ledger; proof.
- PR 2 (screen), after PR 1 is on staging: snapshot each line's stored cents when the cost editor opens and send it as
  `expected_unit_cost_cents`; on `PO_COST_CHANGED_SINCE_LOADED` close the editor, drop the drafts, reload, and say the
  whole save was refused and why.
- PR 3 (follow-up, after PR 2 is live everywhere): make `expected_unit_cost_cents` required.
- The "Most recent received PO" label is its own small screen PR.

## Proof cases (local Docker real schema, as the signed-in admin)
1. Expected = stored -> saved, one history row (as today).
2. Expected stale (another admin saved first) -> `PO_COST_CHANGED_SINCE_LOADED`, cost unchanged, no history row, in a
   2-line call the other line is not saved either.
3. No expected field -> saved (old client path).
4. Confirm of a rep line with stale expected -> refused; with matching expected -> confirmed.
5. Bad expected (string, fractional, negative) -> `PO_EXPECTED_COST_INVALID`.
6. Replay with the same key after the cost moved -> returns the first result.
7. Rep -> still refused (unchanged).
8. Browser: open a PO on local app, change a cost in a second tab, save from the first -> clear message, page reloads.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-22, 25 findings) — how each was settled
- Guarantee (1, 5): protects every request that carries the field. Absent = old client, unchanged until PR 3 requires it.
  A present JSON null, string, boolean, fraction, negative or > 9007199254740991 is refused `PO_EXPECTED_COST_INVALID`
  (checked as numeric before any cast) (6).
- Baseline (2, 7, 8): the screen snapshots `unit_cost_cents` from the loaded line when the editor opens (not recomputed on
  refetch); the editor closes and drafts are discarded on a stale refusal, so a retry needs a fresh decision (12).
- Rollout (3): database first (PR 1), screen second.
- "Stale" (4): the stored cents differ from what the admin saw. $10 -> $12 -> $10 passes: the admin's decision was made
  against the cost that is stored. Another admin's same-cost confirm: ours returns 0 confirmed, harmless.
- Placement (13): after replay and after the line is locked, before the same-cost / changed-cost branches. So expected $10,
  requested $11, stored $11 is refused.
- Precedence (14): one pass, first applicable error, whole call rolled back. Not a promise that the stale error wins.
- Concurrency (15): every call takes advisory lock 73492009 before reading lines, so the second caller reads the committed
  winner. Proven with two real sessions (one held open).
- Proof depth (16, 17, 20, 25): stale line last after an earlier change and an earlier confirm; compare line cents, flags,
  history, PO total, activity before/after; re-run `prove-po-cost-admin-only-and-corrections-real-schema.mjs` against the new
  body for every existing control; disjoint-line case.
- Lost response (10, 11): unchanged; replay is checked first, the fingerprint covers `p_items` so a changed expectation under
  the same key is a binding rejection. Proof: same key replays after the cost moved; same key with only expected changed is
  refused.
- Undo (21): reworded below: a new correction where the existing rules allow it.
- Function identity (22): postflight checks signature, SECURITY DEFINER, owner, search_path and grants.
- Overflow (18): pre-existing arithmetic, untouched; per-line cap unchanged. Not in scope.
- Batch UX (19, 23) and label (24): PR 2 / label PR.

## Open business decisions
None (the KI names the fix).
