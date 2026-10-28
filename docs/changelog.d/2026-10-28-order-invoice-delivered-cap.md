## 2026-10-28 - Parked order-wide delivered quantity cap (to-do 3.2)

Local implementation; not merged, applied or deployed. Mason requested separate
implementations without merging. Shared to-do/current-state/decision files are
intentionally untouched during parallel work.

- New migration `20261028175633_cap_order_invoices_at_delivered` adds an immediate
  order-wide product quantity check alongside the existing per-delivery checks.
  It counts active split siblings and added product lines together, rechecks
  posting and restoration, and serializes new billing with the existing order lock.
- Return credits remain supported and do not authorize a second sale of the same
  delivered units. A new physical delivery supplies any replacement sale allowance.
- Quick-delivery drafts retain their approved planned-quantity exception; posting
  still requires completion. Delivery cancellation/void automation (3.5), partial
  split billing (4.1-4.3), and application-only caps (5.3) are separate work.
- The Order page no longer offers an invoice action before fulfillment. It explains
  delivery-first billing and prepay; delivered field-split billing stays available.
- A disposable real-schema prover covers the database behavior and concurrent
  writes; focused page/error tests cover the screen changes.

Observed local proof (2026-10-28):

- `ORDER_INVOICE_DELIVERED_CAP_PROOF_PASS`: production schema baseline plus 155
  post-baseline schema migrations, followed by the candidate. Before/after
  reproduction; admin/rep saves; added lines; cumulative siblings; posting and
  restoration; genuine split completion, landlord returns/credits and partial
  quick-delivery completion; two concurrent direct writers and two real editor
  saves. A refused busy writer is also refused by the cap on retry after commit.
- The latest candidate also passed explicit malformed-line refusals, both admin
  and rep `save_invoice` calls with an untyped order-backed line, clearing a charge
  type, and the allowed typed freight control. Private helpers expose no API grants.
- Full Vitest run: 480 files passed, 6,634 tests passed, 123 skipped. Focused billing
  run: 173 tests passed. Typecheck, lint, build, code-health and diff whitespace
  checks passed. The build reports its existing large-bundle warnings.
- Independent security and schema-drift reviews found no SQL defects. Iterating
  review identified malformed-line cases; their fixes and regression cases are
  included. Luna's final read-only review returned CLEAN with no remaining findings.
  The exact-commit Sol gate is reported separately with the parked commit.

This is parked implementation proof, not production proof. No live writes ran.
Before any eventual application, refresh main/overlap, live migration ordering,
current-data preflight, reviews and delivery proofs. The live ledger read in this
session ended at `20261027080300_notification_sender_recorded` (apply version
`20261028121259`), below this migration's authored timestamp. Nothing is reserved
or cleared for a later apply by that observation.

Rollback path: a separately reviewed migration removes only the new order cap's
two triggers and two private helpers. Existing delivery caps remain installed.
No existing rows, permissions on existing objects, or money values are rewritten.

Navigation evidence: Graphify built at `a3423a81`; query
`what connects save_invoice to create_split_invoices_from_order and delivery quantity caps?`
returned the invoice RPCs and OrderDetail. Current source and live read-only function
definitions confirmed the relevant paths. The existing delivery cap migration is
present in the live ledger; zero active whole-order invoices were observed.
