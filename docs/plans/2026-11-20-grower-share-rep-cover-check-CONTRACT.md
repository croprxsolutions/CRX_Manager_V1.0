# Behavior contract: a rep's grower-share invoice must cover its chemicals' cost

Read on `origin/staging` at the branch point of `claude/release-fix-rep-below-cost-approval` (2026-11-20). Closes Sol HIGH 1 on release #1990 head `ff46f6ca5` (`20270120150000:1000`).

## Facts
- `_enforce_below_cost_line` (final body: `20270120150000`, md5 `1069cd1451454030627b250db7b729d1`; no later file redefines it) lets the $0 "included in grower share" invoice line through for an active admin OR sales rep, and writes a `below_cost_approvals` row under that user (`operation = 'field_app_grower_share'`).
- Only `_save_field_app_invoice_impl_20260714` (final body `20270129171000`) sets that context, around that one INSERT. The split save refuses grower-share fields (`MODE_A_UNSUPPORTED`); the preview inserts nothing.
- In that save, an invoice's lines are deleted first, then its grower-share per-acre lines are inserted (product NULL, `acres` set, not a fee), then each chemical's $0 grower-share line, then billed lines, then fees. Billed and $0 lines never set `acres`; fees are `is_application_fee`.
- The per-acre rate comes from `field_billing_defaults.price_override_cents`, which reps can edit. So a rep can set $0.01/acre and save $500 of chemicals for $1.
- Browser roles have no INSERT/UPDATE/DELETE on `invoice_items` and only SELECT on `below_cost_approvals` (live read 2026-11-20). `save_invoice` rebuilding such a draft re-judges the $0 line under the normal wall (admin with reason only).
- Live 2026-11-20: 0 fields with a grower-share rate, 0 grower-share invoice lines, 3 active reps, 5 active admins.

## Decisions
- Mason, 2026-11-15 ("Admins and reps"): both may save grower-share invoices. Mason, 2026-11-16 ("Yes, record it"): each $0 line logs an approval row.
- **Mason, 2026-11-20 (chose "Reps if price covers cost"):** a rep may save only when the per-acre price covers the chemicals' cost; otherwise an admin must.

- **Mason, 2026-11-20 (after the Astra challenge):** coverage is judged on the **whole invoice** (fields pooled), not per field. A hand-typed chemical with no catalog product (cost 0 for a rep, as on every other hand-typed line) is **left as is for now**: follow-up.

## Outcome and authority
- Admin: the coverage comparison never applies (approval row under the admin). Every other refusal (sold unit, cost basis, rounding, posted group) still applies to admins.
- Rep: each $0 grower-share line is allowed only if, on that invoice, (sum of the grower-share per-acre lines' amounts) >= (cost of every $0 grower-share line already saved in this save + this line's cost). Because all per-acre lines are inserted before any $0 line, the last line's check is the whole-invoice check. Otherwise the save is refused `FIELD_APP_GROWER_SHARE_BELOW_COST` and nothing saves. The message never states a cost (cost is admin-only, 2026-10-15).
- Earlier $0 lines are counted from `below_cost_approvals` rows of this invoice whose line still exists (rows from earlier saves point at deleted lines). Browsers cannot write either table.
- Files: a new migration re-creating `_enforce_below_cost_line` only (the save body is untouched); the screen's error text (`src/lib/errorSanitizer.ts` + test); a reverse script and a prover; a changelog record.
- Revenue lines are picked as: this invoice, no product, `acres` set, not a fee, not from an order. Billed and $0 chemical lines never set `acres`, so the billed lines interleaved between $0 lines are never counted. Both sums are booked whole cents (`total_shortfall_cents` is a line total for both product lines and costed hand-typed admin lines).
- After the save: lines change only through this save (re-checked) or `save_invoice`, which re-judges every $0 line under the admin-with-reason wall (a rep is refused). Posting does not change lines. Changing a field default later does not change a saved invoice.

## State, timing, rollout
- No existing rows change; live has none of these invoices (re-count at apply time with the reviewers' read-only check).
- One save is one transaction with no exception handler around the insert, so a refusal rolls the whole save back.
- An idempotent replay returns the earlier result without re-running the save (unchanged behavior).
- Accepted consequence of Mason's decision: by trying rates, a rep can find the per-acre price at which an invoice's chemicals are covered, which reveals their total cost (exactly, on a simple one-chemical invoice). The message itself never states a cost.

## Astra challenge (2026-11-20, 29 findings) — settled
- DECISIONs 4 (pooling) and 3 (hand-typed cost): Mason, above. 16 (admin handoff) and 19 (preview vs save): the save's values are authoritative; a refused rep re-enters or asks an admin, as on every other admin-only refusal.
- Out of scope, pre-existing in the save and unchanged here (follow-ups): 9 incomplete input, 10 `save_invoice` on a field-app draft, 13 scope checks, 17 invoice lock order, 18 idempotency key binding, 21 single-to-group edit, 24 soft-deleted group members.
- Answered in the build: 6/8 line selection and arithmetic (above); 7 wording (above); 11 later edits (above); 12 approvals are admin-read only (`below_cost_approvals_admin_read`); 15 sanitizer test; 20/23/25 prover cases incl. a re-save; 26 file list; 27 reverse pins the exact candidate body; 28 one indexed-by-invoice sum per $0 line, a few rows each.
- 29 (compute totals in the save body) declined: it would re-emit the 700-line save body; the trigger keeps the change to one function.
- Rollback: `scripts/smoke/grower-share-rep-cover-reverse.sql` restores body `1069cd14…`.

## Proof cases (real-schema prover, `scripts/smoke/prove-grower-share-rep-cover-real-schema.mjs`)
1. Before: a rep at $0.01/acre saves a $500-cost grower-share chemical (the hole).
2. After: the same save as a rep is refused `FIELD_APP_GROWER_SHARE_BELOW_COST`; nothing is saved.
3. After: a rep at a rate whose amount covers the cost saves; one approval row under the rep.
4. After: two chemicals, each covered alone but not together: rep refused.
5. After: an admin at $0.01/acre saves; approval row under the admin.
6. Re-save of a covered invoice by a rep (earlier approval rows point at deleted lines) still saves.
7. Reverse restores the old body; candidate re-applies; second apply stops at the preflight.
