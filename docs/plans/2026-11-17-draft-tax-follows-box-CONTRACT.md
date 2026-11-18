# Behavior contract: a draft's sales tax must follow its sale's box to post (2026-11-17)

Read at `origin/staging` 86942997c. Source: Sol HIGH on #1940 round 21, `20270117120000_billing_sol_fixes_staging.sql:361`.

## Outcome and authority
- **Business result:** a chemical-sale draft never leaves draft (posted, or straight to unposted) with sales tax that
  contradicts its sale's Sales tax box, except the M4-switch-off case below. Already-posted/unposted invoices keep
  what they were first posted with.
- **Facts:** `set_order_sales_tax` keeps the tax of a draft the save path can't re-save (a Bill Split payer's draft
  with a no-quantity line, or a governed field split: `_invoice_resave_locked_20270109`) and lists it in
  `drafts_kept` (20270117120000 (D)). Posting checked only that the tax line matches the draft's own rate
  (`guard_sales_tax_current_on_post_20261231`), not the box. So a kept draft posted with the wrong tax.
- **Smallest change:** one more `BEFORE UPDATE OF status` trigger on `invoices`, beside the stale-line guard, for a
  chemical-sale draft leaving draft (to unposted, posted, paid or overdue): refuse (`SALES_TAX_BOX_MISMATCH`, nothing changes) when it has a tax rate row
  and the box is off, or the box is on, it has none, and the M4 switch is on. No new table, lock or flag.
- **Why refuse, not recompute:** the kept drafts are the ones the save path can't re-save; recomputing them is what
  20270117120000 removed because it rolled back the whole switch.
- **Authority:** unchanged. Posting rights are the posting RPCs'. The trigger is `SECURITY DEFINER` to read the
  sale's box, the rate rows and the M4 switch whatever the caller can see; it takes nothing from the caller. Its
  preflight requires the stale-line guard (which checks the tax cents; this one checks only taxed vs untaxed).

## State and failure
- **Always holds:** a draft posts only if (rate row) = (box on), except while the M4 switch is off, when a draft
  with no rate row may post on a ticked sale (20270117140000: drafts made while off are untaxed by design).
- **Existing rows:** live has no rate rows and no ticked sale (M4 ships off), so nothing on live is refused. The
  postflight counts drafts that would now be refused (NOTICE only). Staging: a draft made while the switch was off,
  on a ticked sale, is refused once the switch is on until the box is switched over and back (proof case D). The postflight also
  counts those ("more once the M4 switch is on").
- **Unposted invoices** posted again keep what they were first posted with (trigger only fires from `draft`).
- **Recovery:** any setter call re-applies the box to every draft the save path can re-save, so the office switches
  the box over and back, ending at the setting they want (on screen the box only toggles). Locked drafts: void and
  redraft the group, or set the box back. With the M4 switch off ticking is refused, so a taxed locked draft on an
  unticked sale is voided and redrafted. The toast says kept drafts can't post *while they differ* from the box.
- **Rollback:** drop the trigger and function, BEFORE any rollback of 20270117140000 (this calls its helper).
  Rolling back reopens the original bug; nothing else to repair (it never writes).
- **Timing:** the tick holds the sale row and then each draft row `FOR UPDATE`; a post holds the invoice row. If
  the post wins, it posts under the old box (as if posted before the tick) and the tick then skips it (no longer a
  draft). If the tick wins, the post waits and its trigger reads the committed box. No retry or idempotency change. The app
  runs READ COMMITTED (PostgREST default); a REPEATABLE READ writer is out of scope, like for the stale-line guard.

## Proof cases (prover `prove-draft-tax-follows-box-real-schema.mjs`, chain `smoke-draft-tax-follows-box.sql`)
- A: Bill Split, untaxed, payer 2 locked, ticked: payer 2 kept untaxed; group post refused; unticked again, it posts.
- B: Bill Split, taxed, payer 2 locked, unticked: payer 2 kept taxed; group post refused.
- C: switch off, ticked sale drafts untaxed: posts.
- D: that draft after the switch is on: refused; box off and on: posts taxed.
- E: such a draft moved straight to `unposted` by a direct write: refused, stays draft.
- Every "posts" case checks the invoices' status; every refusal checks nothing left draft.
- Limit: the lock is simulated (the app can't create a real no-quantity payer line; its guards refuse it), so A/B
  prove the posting check against what `_invoice_resave_locked_20270109` reports, not how a row becomes locked.
- BEFORE the migration A, B, D and E get through (the bug); AFTER all pass; sales-tax and M4-switch chains still pass (the
  Bill Split chain fails on staging before and after for an unrelated stock-unit reason).

## Open business decisions
None: the box is Mason's existing rule (2026-11-09, every payer follows the one box).

## Cold challenge (Astra, gpt-6-astra high, 2026-11-17): 26 findings
Fixed: draft -> unposted bypass (trigger widened, case E); recovery wording ("over and back, ending where you want
it", not "untick and tick"); toast said every kept draft is blocked; preflight now requires the stale-line guard;
rollback order vs 20270117140000; postflight counts switch-off drafts that become blocked; smoke asserts statuses.
Refuted or out of scope: inserting an invoice already posted (pre-existing, same for the stale-line guard; posting
RPCs and split-creation claims guard inserts); REPEATABLE READ and lock-order deadlock (app is READ COMMITTED; the
tick locks sale then drafts, a post locks only the invoice before the trigger reads the sale); tax cents, rounding,
posting versions, idempotency and the void/redraft path (unchanged code, covered by their own chains); toast lists
invoice numbers, not UUIDs; M4 toast text when the switch is off (pre-existing, not this finding).
Reviewers (opus): rls-security 0 BLOCKER/HIGH/MED, 4 LOW (rollback order: noted; 0% rate counts as taxed: by design;
soft-deleted/insert-posted routes: unreachable today). migration-drift 0 BLOCKER/HIGH, M1 ledger order (apply script
re-checks), L1 fixed: trigger renamed zz_ so closed-sale, discount and unit refusals report first.
