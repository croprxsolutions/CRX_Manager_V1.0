# RT-4a cut-over button: behavior contract (2026-11-23)

Read at `origin/staging` 5b549b9e4. Builds the screen for the settled RT-4a contract
(`2026-11-17-product-RT4-cutover-CONTRACT.md`), which said "No screen"; Mason asked for the button on 2026-11-23
so the pilot is his own click instead of an API call in the browser pane. One database change rides with it
(amendment at the end, Sol round 2): migration `20270227160000_rate_cutover_refuses_unrestorable.sql`, which must be
live before the button reaches production (§3).

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
  object (versions and each size's snapshot and prices) sent back unchanged; the server rebuilds the plan under its
  locks and refuses unless it is equal (`PRODUCT_PARENT_CUTOVER_STALE`). The screen supplies no target rate, unit,
  price or text of its own: the server derives every written value from its plan.
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
- **Existing rows.** `rate_source` is `NOT NULL` with `CHECK (rate_source IN ('legacy','approved'))` (migration line
  49). The screen accepts exactly those two values; a failed read or any other value shows "Couldn't check" and
  offers no switch.

## 3. Delivery

PR to `staging` carrying the button and migration `20270227160000_rate_cutover_refuses_unrestorable.sql` together
(amendment below). Ordering: the migration must be live before the button reaches production, so the two ship in
the same release and the release's migration is applied before its merge (`ship.md`). The rate-switch functions
already live (20270125100000) stay callable meanwhile, but nothing calls them until the button ships. No live call:
the pilot is Mason's own click after release.

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

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-23): 49 findings, settled

- **Corrected in the screen:** (1) a switch with `changes = false` writes no prices, so the table shows the saved
  prices as the outcome, not the recomputed ones; (2) a promote to "no per-acre default" says the rate and per-acre
  prices become blank; (11) only `legacy`/`approved` are accepted, a failed read offers no direction; (22) any
  database refusal on commit retires the preview (only a lost reply, which carries no refusal code, keeps it for the
  same-key retry); (9) the contract wording on what the screen sends.
- **Disproved by source:** (12) the select policy is `is_active_profile()` for every parent, the same audience as
  `get_product_parents`; (17, 18) `rate_source`, `status`, `basis_confirmed` are `NOT NULL`; (6) seed/each sizes show
  their own unit; (15) the button respects `busy`; (14, 25) the source read is keyed on parent ID and version and
  discards late replies, and the modal holds one preview request at a time; (5) the field mapping is per size:
  before = the size's own rate, unit and text in `expected.sizes`, after = `target`.
- **Safe by the server, documented:** (27, 29, 31) a double send or a changed reason after a timeout cannot apply
  twice: the second call either replays the first receipt or is refused `ALREADY_*`, and the screen then reloads
  the true source; (28, 32) closing the modal after a lost reply loses the local key, and reopening reads the true
  source, which is the same as every other modal in the app; (8) JSON round-trip of `expected` is the path
  `correct_parent_rates` already uses live, and the local proof sends it back for real; (10) the written unit's
  spelling comes from `product_rate_units`, which no app screen edits.
- **Settled earlier (RT-4a contract, prover P1–P9):** server freezes, restore scope and blend checks (33–41), who
  may act (44: admins only, unchanged), and rollback (45: switch back first; the RPCs stay callable without the screen).
- **Told to Mason with the pilot:** (38) while any group is on its approved rate, the rate lock cannot be turned off
  (decision 3, 2026-11-17).

## Open business decisions

None. Authority, refusals, undo and the freeze were settled in the RT-4a contract (Mason, 2026-11-17/18).

## Amendment (2026-11-23, Sol round 2; Mason: "DB fix")

- A promote that changes the rate or unit is refused by the database when the old values would fail the switch back's checks (`PRODUCT_PARENT_CUTOVER_NOT_RESTORABLE`) or field-app invoicing cannot convert the approved unit to a size's sold unit (`PRODUCT_PARENT_CUTOVER_UNIT_NOT_INVOICEABLE`). Migration `20270227160000_rate_cutover_refuses_unrestorable.sql`. The screen keeps no copy of these checks; it shows the refusal.

## Amendment (2026-11-23, Sol rounds 3-4; Mason: "A: follow-up issue")

- A general database guard on Add a size, Move a size and rate or unit corrections (refusing a rate unit field-app invoices cannot convert to the sold unit) was tried here and drew a new Sol HIGH in each round. Mason chose to keep only the two refusals on the switch itself in this PR and track the general guard as its own follow-up issue: that gap exists on every group today, with or without this button.

## Amendment (2026-11-24, "Re-check at the switch": #2379, #1813; Mason's night-run decisions D1-D3)

Migration `20270228190000_rate_switch_recheck.sql` adds `_rate_cutover_recheck`, run on every promote by both
`preview_parent_rate_cutover` and `commit_parent_rate_cutover` after the existing planner. Restores are never refused by it.

- **D2, re-approve (#1813).** If any approved rate row of the group no longer passes Rate Review's own outcome checks for
  the group's current form (`basis_confirmed` false, or `_product_rate_unit_fits(form, basis, unit kind)` false), the
  switch refuses: `PRODUCT_PARENT_CUTOVER_REAPPROVE: ... re-approve this rate in Rate Review`, naming each row.
- **D1, over the label (#2379).** For an `approved_default` group, the published approved rate is judged by the same
  function Rate Review uses (`_product_rate_check_values`) against today's label maximum. Status `above` with no
  over-label reason refuses (`PRODUCT_PARENT_CUTOVER_OVER_LABEL`) in preview and commit. A reason (trimmed, at most 500
  characters, the `product_rates.over_label_reason` limit) lets it through, and is recorded with the label check in the
  `rates_promoted` event's `after_values` and in the receipt. A reason sent when the rate is not above is not recorded.
  `not_checked` (no label maximum on file) passes, as it does in Rate Review.
- **Commit re-checks.** A label maximum lowered after the preview refuses the commit. The over-label reason is part of
  the idempotency fingerprint: the same key with another reason is `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- **Signatures.** `preview_parent_rate_cutover(uuid, text, p_over_label_reason text DEFAULT NULL)` and
  `commit_parent_rate_cutover(uuid, text, jsonb, text, p_idempotency_key text DEFAULT NULL, p_over_label_reason text DEFAULT NULL)`;
  the old signatures are dropped, so positional 2- and 5-argument calls keep their meaning.
- **Screen.** When the preview refuses with `OVER_LABEL`, the panel shows an "Over-label reason" box; the admin types a
  reason and previews again. The switch button works only on a preview made with the reason now in the box, and
  commit sends that reason. `REAPPROVE` is shown as the refusal, with no way past it on this screen.
- **D3 (docs).** The suggested-rate rule in the RT-4 contract (rule 4, restore in rule 8) is corrected to what the code
  already does: rewritten from the approved rate on a promote that moves it, restored on switch back.
- **Live read (2026-11-24, select only):** 413 promotable groups; 0 with an approved row failing the form/basis check;
  0 approved defaults carrying an over-label reason. So D2 refuses no group today; D1 refuses only groups whose label
  maximum is below the approved rate.
- **Proof cases (prover `scripts/smoke/prove-rate-switch-recheck-real-schema.mjs`):** R1 over-label refusals (blank,
  none, 501 characters); R2 a reason recorded in event and receipt; R3 replay and fingerprint; R4 switch back needs no
  reason; R5 within the maximum, reason not recorded, positional call; R6 label lowered between preview and commit;
  R7 form changed and basis unconfirmed; R8 no rows changed, second run refuses, old signatures gone, grants.

### Cold challenge (Astra, gpt-6.2-astra high, 2026-11-24): 18 findings, settled

- **Fixed:** (4) the label check joins `expected`, so a maximum lowered after a reasoned preview refuses as stale;
  (5) with no over-label reason the commit fingerprint is the 20270125100000 one, so a pre-migration switch's retry
  replays (proved); (8, 13) the length limit applies only when a reason is needed, after the re-approve check;
  (9) the reason is trimmed like `product_rates.over_label_reason` (no-break space too) and needs a letter or digit;
  (10) a missing approved default refuses as stale and an approved row whose unit has no kind refuses re-approve;
  (11) the receipt carries the label check; (12) the screen's reason box belongs to one group and direction, and shows
  on a too-long refusal; (18) the preflight pins both Rate Review helper bodies (live md5, select only).
- **Disproved / by design:** (1) D2 is #1813's rule: re-check the approved rows "as it is then" with Rate Review's own
  form/basis checks (`_product_rate_review_row_problems`); a row Rate Review would approve today is not refused, and a
  row's basis cannot change without editing the row, which clears the outcome. (2, 3) D1 says "the same rule Rate
  Review uses": label-source rows and `not_checked` pass there too. (7, 17) restore and same-key concurrency are
  unchanged from RT-4a (its prover P1-P9). (14) the refusal's number and unit are the approved row's, as published.
  (15) the screen sends the over-label reason only when typed, so it also works before the migration is applied.
  (16) migrations apply in one transaction (the prover applies the file with `psql -1`); rollback stays its own
  reviewed migration. (6) `_product_rate_check_values` takes the label-registry lock every label writer takes.
