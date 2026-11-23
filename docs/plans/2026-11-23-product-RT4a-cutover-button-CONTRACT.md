# RT-4a cut-over button: behavior contract (2026-11-23)

Read at `origin/staging` 5b549b9e4. Builds the screen for the settled RT-4a contract
(`2026-11-17-product-RT4-cutover-CONTRACT.md`), which said "No screen"; Mason asked for the button on 2026-11-23
so the pilot is his own click instead of an API call in the browser pane. The database is unchanged.

## 1. Outcome and authority

- **Outcome.** On the product page's Parent panel an admin sees which rate the group uses (old or approved) and can
  switch it to the approved rate, or back to the old rate, one group at a time, with a reason.
- **Smallest change.** One modal (`ParentRateCutoverModal.tsx`) beside `ParentRatesModal`, two RPC wrappers and one
  read in `src/lib/productParents.ts`, a button and a "Rate in use" row in `ProductParentPanel.tsx`, the refusal
  token in the sanitizer's rate list (already covered by `PRODUCT_PARENT_[A-Z_]+`), tests, changelog. No new table,
  lock, flag or job.
- **Facts (source).** Both migrations are live: `20270125100000_product_rate_cutover` and
  `20270126100000_product_rate_direct_writes_revoked` (records in `docs/reference/migrations.d/`, "APPLIED LIVE
  2026-11-21", confirmed in the live ledger 2026-11-23). `preview_parent_rate_cutover(uuid,text)` and
  `commit_parent_rate_cutover(uuid,text,jsonb,text,text)` are `SECURITY DEFINER`, `search_path = public, pg_temp`,
  EXECUTE to `authenticated` only, and both call `_product_parent_require_admin()`. `product_parents` has
  `GRANT SELECT TO authenticated` and a select policy, so `rate_source` is readable without a database change.
- **Who may act.** Active admins. The button shows only when `isAdmin`; the server refuses everyone else.
- **What the screen sends.** `parent_id` and `direction` are locators. `p_expected` is the preview's `expected`
  object sent back unchanged; the server rebuilds the plan under its locks and refuses unless it is equal
  (`PRODUCT_PARENT_CUTOVER_STALE`). The screen sends no rate, unit, price or text: the server derives every value.
  The reason is typed by the admin; the server trims, requires and bounds it.

## 2. State and failure

- **Direction** comes from the group's current `rate_source` (read on open and after every save): `legacy` offers
  "Switch to approved rate", `approved` offers "Switch back to old rate". If it changed under the screen, the
  server refuses (`ALREADY_APPROVED` / `ALREADY_LEGACY`) and the screen reloads.
- **Preview** is read-only (advisory). It shows, per size: old → new rate and unit, old → new suggested text, and
  old → new per-acre price at tiers 1–3; plus the open quotes, orders and jobs using the sizes (informational,
  reused `OpenWorkList`). A refusal (`eligible: false`) is shown in a warning box, in the server's own words
  (through `sanitizeError`), and the Switch button stays off.
- **Commit** sends the preview's `expected`, the reason and an idempotency key. Success: toast, close, reload the
  page's parent and the rate source.
- **Every per-acre price must read as an exact dollar amount** before Switch is enabled (same rule as
  `ParentRatesModal`).
- **Timing.**
  - Double click: the button is disabled while saving, and the key makes a second send a replay.
  - Lost reply / timeout: the key stays (`resetKey` only on success); pressing Switch again sends the same key with
    the same payload, and the server returns the first receipt (`_product_parent_replay`, fingerprint covers
    actor, parent, direction, expected and trimmed reason). The key's scope is
    `[parent, direction, expected, trimmed reason]`, so changing the reason or re-previewing is a new intent.
  - Two admins / anything changed since preview: `PRODUCT_PARENT_CUTOVER_STALE` → toast, preview cleared, preview
    again. `ALREADY_*` → toast, reload.
  - A late preview reply after the reason or direction changed: preview results are tied to the direction they
    were asked for; a reload closes the modal.
- **Undo and history.** Switching back is the undo (server restores the snapshot in the `rates_promoted` event;
  `rates_restored` records the actor and reason). Repeating either direction is refused by the server.
- **Existing rows.** Every parent is `legacy` today; the screen treats any value other than `approved` as old.

## 3. Delivery

Screen-only PR to `staging`; the database is already live, so there is no ordering risk. No live call: the pilot
is Mason's own click after release.

## 4. Proof cases

Run in the local test app on invented data (a throwaway copy), as the invented admin, through the real screen:

- **C1.** When an admin opens a `legacy` group with approved RT-3 rates and previews, then each size shows old →
  new rate/unit, suggested text and tier 1–3 per-acre prices, and Switch is off until a reason is typed.
- **C2.** When the admin switches, then the panel shows "Approved rate", the parent's rate/unit/suggested text are
  the approved ones, and the button becomes "Switch back to old rate".
- **C3.** When the admin switches back, then the old rate, unit, suggested text return and the panel shows "Old
  rate".
- **C4.** When the group is refused (e.g. the rate lock is off, or rates are still drafts), then the preview shows
  the server's reason and Switch stays off; nothing changes.
- **C5 (unit).** A lost commit reply retried sends the same key and payload; a stale refusal clears the preview;
  a non-admin sees no button.

## Open business decisions

None. Authority, refusals, undo and the freeze were settled in the RT-4a contract (Mason, 2026-11-17/18).
