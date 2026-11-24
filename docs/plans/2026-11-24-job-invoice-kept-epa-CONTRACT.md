# #2341 — job invoices and restricted-use captures use the job's kept EPA number: behavior contract

Read at `origin/staging` `41d701225` (2026-11-24). GitHub #2341 (Sol round 10 on #2247; Mason chose to track it, 2026-11-23).
Follows KI-195 (#2330, `docs/plans/2026-11-23-ki195-printouts-kept-epa-CONTRACT.md`), which moved the printouts only.

## Facts (with sources)

- `job_product_epa(job_id, product_id, epa_registration, not_recorded)` is live (ledger `20261107131813`, migration
  `20261204120000`): one insert-only row per product of a sprayed or finished job, the first recorded number wins, stored through
  `_epa_norm`. Three kept states: a number; NULL with `not_recorded = false` (no number when locked); NULL with
  `not_recorded = true` ("Not recorded"). Settled read rule (Mason, 2026-11-06, "lock per product"; header item 4): the
  kept row's number when one exists, else the catalog number.
- Create Invoice on a job (`transfer_job_to_invoice` → `_transfer_job_to_invoice_intent_impl_20260908`) refuses a job
  that is not `completed` (20270226150000 L324-325). Finishing a job writes its kept rows
  (`trg_job_epa_freeze_on_finish`), so every product on a job being invoiced already has a kept row.
- Newest transfer body: `20270226150000_job_transfer_below_cost_whole_line.sql` (LOCAL CANDIDATE, staging only; postflight
  pins md5 `aa385acd9adb57eadb0a52ac37b833d8`). Live runs the older `20261120100000` body (md5 `a54e3e6a…`, read
  2026-11-24). Both chemical-line loops (L489 owner group, L775 single invoice) read `p.epa_registration` (the catalog) into
  `invoice_items.epa_registration`, for priced and customer-supplied lines.
- `trg_fill_invoice_line_epa` (20261207113000) fills only a blank line number, from the catalog; it keeps a number the
  writer sent. `trg_fill_invoice_line_zbrands` (20270106110000) replaces the number only on lines with delivery brands
  (`order_item_id` set); job lines have none. So a number the transfer writes stays on the line.
- The invoice PDF prints the line's own number (`invoicePdf.ts` L317 `invoiceLineEpaText(item.brand_lines,
  item.epa_registration)`); the field-invoice editor sends each line's stored number back on save
  (`FieldApplicationInvoice.tsx` L1425, L1944).
- Restricted-use capture: `_capture_invoice_line_rup` (AFTER INSERT OR UPDATE on `invoice_items`, newest body
  20270106110000, live md5 `5fb2eb8c484b08242a46f647f9d09ec4`, read 2026-11-24) stores per line
  `_invoice_line_rup_facts(product, line number).epa_registration`, which is the **catalog** number (`n.pn`); the line's
  number only feeds the Yes/Unknown status. `generate_rup_sales_records` writes each record's number from that capture
  (`c.epa_registration`). Mason, 2026-11-09/10 (#1746 header): "the number is the product's own".
- Every invoice a job makes carries `invoices.job_id` (both transfer branches).
- Live, read-only 2026-11-24: 0 `job_product_epa` rows, 0 invoices with a `job_id`, 0 completed-unbilled jobs. Nothing
  existing needs correcting.

## Outcome and authority

When a sprayed job is invoiced, each chemical line and its restricted-use capture/record carry the EPA number the job
kept for that product; only when the job kept no number for it (none kept, kept with no number, or "Not recorded") do
they use the catalog number, as today. Who may invoice, price, cost, quantity and RUP status rules are unchanged.

Smallest change, one migration `20270303100000_job_invoice_kept_epa.sql`, no screen change:

1. New private `_job_kept_epa(job_id, product_id) RETURNS text`: the kept number when the job kept one, else NULL. SQL,
   STABLE, owner postgres, no API grant (only the two definer functions below call it).
2. `_transfer_job_to_invoice_intent_impl_20260908` re-emitted from 20270226150000 with one change in each of its two
   chemical reads: `COALESCE(_job_kept_epa(p_job_id, jc.product_id), p.epa_registration)` instead of
   `p.epa_registration`. Owner, SECURITY DEFINER, search_path, grants, idempotency and the wrapper unchanged.
3. `_capture_invoice_line_rup` re-emitted from 20270106110000 with one change in the per-line insert: the stored number
   is `COALESCE(_normalize_epa_registration(_job_kept_epa(<line's invoice job_id>, product)), <catalog, as today>)`.
   When a kept number is used, its signal word is that registration's (else the product's), and the status is Yes when
   that registration says Yes (otherwise the status as today, so any Yes still wins). Brand captures and the re-capture
   rule are unchanged. "The product's own number" for a job's line is the number the product had when sprayed.
   Customer-supplied lines get no capture or record, as today (`_capture_invoice_line_rup` skips them).

Files: the migration, its ledger record `docs/reference/migrations.d/20270303100000_job_invoice_kept_epa.md`, a
changelog entry, a real-schema prover `scripts/smoke/prove-job-invoice-kept-epa-real-schema.mjs`, this contract, and
the pilot log row. On the Sol path (migration).

Not changed: `generate_rup_sales_records` (its own capture insert runs only for a line with no capture, which after the
REG-1 seed never happens: the capture trigger fires on every line insert); brand captures (job lines have no brands);
invoices not made from a job; existing rows; printouts (KI-195); REI/PHI (#2329, a different path: printouts and new
stored values, left as its own issue).

## State and failure

- Server enforcement: both functions are SECURITY DEFINER owned by postgres and read `job_product_epa` directly (RLS
  does not apply). No caller sends an EPA number to the transfer; `p_job_id` is the only locator and is already checked.
- A kept row can only be inserted, never changed (`20261204120000`), and the job is held FOR UPDATE through the
  transfer, so the number read cannot change mid-transfer. A job's products are locked to the invoice once invoiced
  (`JOB_INVOICED_LOCKED`).
- Rollout: the migration applies after 20270226150000 (it pins that body). The deployed app is unaffected: it never
  sends or reads anything new. Invoice editor re-saves keep the line's number (sent back as stored); a delete-and-
  re-insert save re-captures with the kept number again.
- Existing rows: none change. Live has no job invoices (read above).
- Timing: double click / retry of Create Invoice is the existing idempotent wrapper (unchanged). The capture runs inside
  the same transaction as the line write.
- Undo: voiding a job invoice is unchanged; a later transfer of the same job reads the same kept numbers.
- Rollback: a reviewed migration re-emitting the two pinned bodies (20270226150000 transfer, 20270106110000 capture) and
  dropping `_job_kept_epa`. Lines written meanwhile keep their kept numbers (correct values).

## Proof cases (real-schema prover, disposable Docker Postgres with every migration replayed; never production)

1. When a job is completed while its product's catalog number is A, the catalog is then corrected to B, and the job is
   invoiced as the signed-in admin through `transfer_job_to_invoice`, then the invoice line shows A (BEFORE the
   candidate: B, the bug).
2. Same job, restricted-use product: the line's capture and, after posting, the restricted-use sales record show A.
3. Two-owner job (group branch): every owner's line shows A.
4. Customer-supplied line on the same job shows A (no capture, as today).
4b. Two products on one job each show their own kept number.
5. When the kept row has no number (NULL, either kept state), then the line and capture show the catalog number B.
6. When the invoice is not from a job, nothing changes: a line and its capture take the catalog number.
7. The transfer body equals the pinned body with only the two EPA reads changed (billing logic untouched).
8. Fidelity: the replayed transfer and capture bodies have the md5s the preflight pins; a second apply stops at the
   preflight; owners, SECURITY DEFINER, search_path and grants unchanged; `_job_kept_epa` executable by no API role.

## Open business decisions

D1. When the job kept **no number** for a product (it had none when sprayed, or the job is "Not recorded" because it
was sprayed before 2026-11-07 or had a spray record moved onto it), the invoice line and restricted-use record:
- (a) **Recommended:** use today's catalog number, as now. Smallest; invoice lines cannot hold "Not recorded" text, and a
  blank line is refilled from the catalog by an existing trigger. Live has 0 such rows.
- (b) Leave the number blank on the invoice and record. Needs a change to the line-fill trigger; a restricted-use record
  with no number shows on Sales to check for a person.

D2. A number corrected in the catalog after the spray: the invoice line and restricted-use record show the number the job
was sprayed with (**recommended**; what #2341 asks, and what the printouts already do since KI-195). The alternative is
today's behavior (the corrected number).

Out of scope: invoices made from blend tickets (a different path), REI/PHI (#2329).

## Cold challenge (gpt-6.2-astra high, 2026-11-24): 48 findings, settled

- Alias missing (BLOCKER): refuted, the migration writes `AS epa_registration`.
- Loop line numbers swapped; "first number" wording: fixed above.
- Signal word from the catalog while the number is the kept one: fixed (the kept registration's signal word).
- Kept registration says Yes but the catalog's says No: intended, the record follows the sprayed registration.
- Customer-supplied lines have no capture: stated above; the prover's supplied case covers the line.
- Missing captures / seed not run: live has the REG-1 seed and 0 product lines without a capture.
- Non-job invoices: prover control (blank and typed line numbers) shows identical results before and after.
- Billing regression risk: the prover proves the new body is the old one with only the EPA read changed.
- Existing rows, authority, idempotency, wrapper: unchanged; live has no kept rows and no job invoices.
- Ordering: the preflight pins 20270226150000's body, so the migration cannot apply before it.
- The rest restate pre-existing behavior outside this change.
