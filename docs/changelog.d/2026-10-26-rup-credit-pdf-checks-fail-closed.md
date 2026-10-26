## 2026-10-26 — the RUP-license, credit-limit and invoice-PDF checks stop when they cannot read their data (To-Do 10.5, sixth money PR)

- **Restricted-use (RUP) license check** (`src/lib/rupCompliance.ts`): a products or license read
  that failed, threw, came back empty or was not a list read as "no RUP products" (or a generic
  warning that nothing acted on), so an RUP sale could reach the post confirm looking clean. It now
  returns `checkFailed` with "The restricted-use (RUP) license check could not be run. Try again."
- **Post on Invoice Detail and on the Split Billing editor:** a check that could not run (the RUP
  read, the split group's sibling read, or a check that threw) used to fall through to the plain
  confirm. Post now stops with "… could not be run, so nothing was posted. Try again." and no
  confirm opens. A real RUP finding is still a warning on the confirm, not a gate.
- **Credit-limit check** (`src/lib/creditLimitGuard.ts`, used by `useCreditLimitCheck`): a failed
  or empty customer read read as "no credit limit set" and passed. It now goes to the existing
  "Could not verify credit limit" stop, and an invoices page with no list is no longer a $0
  balance. The Split Billing editor says "could not verify" instead of calling the invoice over
  the limit, and stops before the confirm.
- **Invoice PDF from a list or the field editor** (`buildInvoicePdfDataFromRow`): a failed customer,
  shares, billing or applied-acres read printed the PDF with the address, split shares, terms,
  notes or diluent total silently blank. It now stops with "Could not load the invoice details
  (customer, shares, billing or field acres), so no PDF was made. Please try again." A dropped
  request gives the same message instead of a raw network error.
- **Print on Invoice Detail** took the address from the customer picker list (500 active
  customers, its read error ignored), so a customer missing from it printed a blank address. It
  now reads the billed customer by id and refuses the PDF when that read fails.
- **Print Selected on the Invoices list** logged a failed customer read and printed a blank
  address, and ignored a failed shares read. Both now refuse the batch with the same message.
- The credit-limit check also treats an amount that is not a number as unverified, and the Split
  Billing post check stops when the group read answers no members.
- New Order, Quote Builder and New Delivery show the could-not-run message as their RUP warning and
  no longer log a failed check as an "RUP products … without valid license" activity.
- Proof: new checks in `rupCompliance.test.ts`, `useGuardrails.paging.test.ts`,
  `buildInvoicePdfDataFromRow.test.ts`, `splitGroupPostChecks.test.ts`, `InvoiceDetail.test.tsx`
  and `Invoices.batchPrint.test.tsx` fail when each fix is undone. Invoice Detail Post (RUP and credit limit), the Split Billing
  editor's Post and the Field Invoices Print were each checked in the dev app, working and failing
  (error, no data, not a list, dropped connection), against a local fake Supabase server.
- Not changed here: the after-save credit-limit toast on Quote Builder and Job Detail
  (`warnIfOverCreditLimit`) still says nothing when its own read fails (it is a notice after the
  save, not a check before it).
