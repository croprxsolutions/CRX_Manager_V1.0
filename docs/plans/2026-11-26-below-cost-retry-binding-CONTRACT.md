# Behavior contract: below-cost retry is bound to the lines the prompt showed (#2617)

Read at origin/staging 7ef954700 (2026-11-26). Decision: Mason, 2026-11-26, in chat: "Yes, refuse if changed".

## 1. Outcome and authority

**Business result.** When an admin types a below-cost reason and clicks "Approve and Retry", the save goes through only if
the below-cost lines it writes are the same lines, at the same price, cost and quantity, that the prompt showed. If anything
changed in between (a cost update, another user's edit, the server re-pricing a line), the save is refused and the prompt
shows the new list, so the reason is never recorded against amounts the admin did not see.

**Facts (source).**
- Every below-cost line is judged by one row trigger, `_enforce_below_cost_line` (newest body: `20270310210000`). Without a
  reason it notes the line in the transaction setting `app.crx_below_cost_pending`; the deferred trigger
  `_raise_below_cost_reason_list` refuses once at commit with the full list (`lines`, `line_count`, `more_count`,
  `total_shortfall_cents`). With a reason it writes one `below_cost_approvals` row per line and notes nothing.
- Every save path delivers the reason as one string in `app.crx_below_cost_reason`: the wrappers via
  `_begin_below_cost_money_write` (`20260812115237`), the blend-ticket RPC by `set_config` around its own inserts
  (`20270129190000`, it clears it to '' after). The screen sends it per path (`withBelowCostReason`, `src/lib/belowCostApproval.ts`):
  inside order notes, item JSON, quote sections, or `p_below_cost_reason`.
- Only an active admin reaches the reason branch; a rep gets `BELOW_COST_ADMIN_REQUIRED` at once (unchanged).
- Precedent: the blend-ticket $0-line approval already binds the approval to what the window showed
  (`p_approved_zero_lines`, `BELOW_COST_APPROVAL_STALE`, `20270129190000`).

**Smallest change.** No new table, column, parameter or RPC signature.
1. The refusal JSON gains `shown`: a 32-hex fingerprint of the whole below-cost list (all lines, not only the 200 listed).
2. The screen appends ` [shown:<fingerprint>]` to the reason it sends. Every transport already carries the reason string to
   `app.crx_below_cost_reason`, so no wrapper changes.
3. In the reason branch, when the reason ends with a `[shown:<32 hex>]` marker, the trigger strips the marker and notes the
   line exactly as the no-reason branch does, plus the marker, the typed reason and the approver; it writes NO approval row
   yet (Astra 1-4: a row-time approval could outlive a line deleted or repriced later in the save). At commit the deferred
   trigger builds the list as today and its fingerprint; if every listed line was approved under that same fingerprint, it
   writes one approval row per surviving noted line (the rows an unmarked reason writes today, with the noted amounts, so the
   approval log keeps today's shape, including both rows of a delivered rush order) and the save commits; otherwise it raises
   `BELOW_COST_REASON_REQUIRED` with the new list and new `shown`, and the whole save rolls back.
4. A reason with no marker (the app deployed today, cached tabs) keeps today's behavior exactly: no note, approvals written,
   no comparison.

**Fingerprint.** md5 (32 hex) of the sorted JSON arrays, one per listed line: operation, document type, product id (or, for
a no-product invoice line, its name), `per`, `unit_price_cents`, `locked_unit_cost_cents`, `quantity` (trailing zeros
trimmed), `line_shortfall_cents`. JSON encoding makes it unambiguous; the operation makes a quote's fingerprint useless for an
order with the same lines (Astra 11, 20). Line ids are left out (a quote save rewrites its lines, so ids differ between the prompt and the retry). Lines the list
already drops (deleted later in the save; an invoice line billed from an order line listed in the same save) are dropped from
the fingerprint the same way.

**Who may act.** Unchanged: only an active admin can approve; the marker is not an authority, it only narrows what a reason
covers. An admin who forges a marker gains nothing they could not get by approving the shown list.

**Files.** One migration (re-creates `_enforce_below_cost_line` and `_raise_below_cost_reason_list`), its reverse script
and real-schema prover under `scripts/smoke/`, then (PR 2) `src/contexts/BelowCostApprovalContext.tsx`,
`src/lib/belowCostApproval.ts`, `src/types` and their tests.

## 2. State and failure

- **Automatic record changes.** None. A refused retry writes nothing.
- **Rules that always hold.** A committed save with a marked reason has an approval row for every below-cost line it wrote,
  and those lines match the prompt's fingerprint. Approval rows and line writes are one transaction; no email, receipt or
  file is produced before commit.
- **Existing rows.** No row changes; `below_cost_approvals.reason` never stores the marker (stripped first). Order notes
  that carry the reason (`create_direct_order`, `bulk_import_order`) keep the marker in the internal "Below-cost approved:"
  line, which customer documents already strip (`stripBelowCostApprovalNote`).
- **Timing.**
  - Cost, price or quantity changes between prompt and retry (same or other user): retry refused, new list shown.
  - Double click on Approve: the screen sends one retry per prompt (unchanged); a second identical retry, if it arrives,
    either commits under the same idempotency key replay or is checked the same way.
  - Retry after a network timeout under the same idempotency key: the committed result is replayed (unchanged behavior).
  - Lines that are now at or above cost: they drop out; if none remain below cost, nothing is noted and the save commits
    (the reason is unused). If some remain but differ, refused.
- **Undo and history.** None added.

## 3. Delivery

- PR 1 (database): the migration alone. Compatible with the deployed app: it only adds `shown` to the refusal JSON and
  checks a marker that the deployed app never sends.
- PR 2 (screen): after PR 1 is applied on staging. Appends the marker and, when an approved retry comes back refused with a
  new list, shows the prompt again with that list (today it would surface the raw error).
- The issue stays open until both are verified on staging.

## 4. Proof cases (real migrated database, local prover, test data)

1. When an admin saves a quote with 2 below-cost lines and no reason, then the refusal lists both and carries `shown`.
2. When the admin retries with reason + that `shown`, nothing changed, then the save commits with 2 approval rows whose
   reason has no marker.
3. When the product cost changes between the prompt and the retry, then the retry is refused with the new list and a
   different `shown`, and no approval row exists.
4. When a third line goes below cost before the retry, then refused, list of 3.
5. When a quantity changes before the retry, then refused.
6. When one of the two lines is now at or above cost, then refused (list of 1, different `shown`).
7. When both lines are now at or above cost, then the save commits with no approval rows.
8. When the retry sends a reason with no marker (deployed app), then it commits exactly as today.
9. When a delivered rush order is priced below cost (order line + invoice line), then `shown` counts the loss once and the
   marked retry commits.
10. When a rep saves below cost, then `BELOW_COST_ADMIN_REQUIRED` at once, no cost in the message (unchanged).
11. The 20270310210000 prover still passes against the new bodies.

## Challenge (Astra gpt-6.2-astra, high, 2026-11-26: FINDINGS 51) and how each was settled

Corrected in this contract: 1-4 and 7 (approvals written once, at commit, for surviving lines, in today's shape); 11 and 20
(operation and JSON encoding in a 32-hex fingerprint); 23 (a reason that is only a marker counts as no reason; proof N7);
41 (the internal note fields are stripped from the refusal; proof N1).

Disproved or not a regression of this change (evidence):
- 5, 6, 8, 9, 10, 17, 28: behavior of the #2610 list (dedupe rule, 200-line cap that Mason accepted on 2026-11-25, no-product
  lines priced as a line total, identical lines). The fingerprint covers exactly what the prompt shows, so the retry is bound
  to what was shown; changing what the list shows is out of scope.
- 12 (A to B to A), 15 (product rename), 37 (who saw it): the rule Mason chose is "refuse if the lines changed"; equal values
  at retry are the lines he saw. Not a new decision.
- 13, 14: lines that are no longer below cost need no approval; the save is safe (no loss). The order-note copy of the reason
  is today's behavior for any approved save.
- 18, 19: a save cannot mix marked and unmarked reasons (one reason setting per save; blend clears it to '' and a below-cost
  line written then is noted unapproved, so the save is refused). The success path clears the note; later queued events
  return at once (same as today's empty path). A marked retry with no below-cost line queues nothing and needs nothing.
- 21, 22, 33-36, 39, 40, 46: existing reason transport and screen behavior, unchanged by the database PR. 21 (an old
  "Below-cost approved:" line already in an order's notes wins) is fixed in PR 2 by removing old marker lines before the
  fresh one is appended.
- 24, 42, 43: rollout. PR 1 is a no-op for the deployed app (proof N8 and case 11). PR 2 appends the marker only when the
  refusal carries `shown`, so a new screen on an old database sends today's reason. Requiring the marker (refusing
  unmarked admin reasons) is a follow-up once PR 2 is in production; filed as an issue.
- 25: the reason is cut to 1,000 characters after the marker is removed; the marker survives note flattening (single line).
- 27, 32: blend's own $0-line prompt carries no `shown`, so PR 2 sends no marker for it (unchanged, already bound by
  `p_approved_zero_lines`).
- 38: no grant, policy or wrapper changes; the same functions, owner and grants (postflight checks the ACL is unchanged).
- 44: reverse restores both 20270310210000 bodies; proven forward, reverse, re-apply (case 9). 45, 49: prevention is the
  goal; no history change. 47: a marked retry costs what the no-reason first attempt already costs.

Declined suggestions: 50 (one decision per save) is what this contract now does for marked reasons; 51 (a new parameter on
every RPC) is a much larger change for the same outcome.

## Open business decisions

None open. Mason, 2026-11-26: refuse the retry if the lines changed.
