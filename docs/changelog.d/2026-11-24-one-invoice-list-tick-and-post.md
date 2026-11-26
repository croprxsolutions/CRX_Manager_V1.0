## 2026-11-24 — Chemical and field invoice lists share one design: tabs, tick-and-post, columns

Branch `ux/one-invoice-list`. Presentation only: no migration, no RPC or argument change, and the
rules for what can be posted are unchanged.

- **Chemical Invoices** gets the Field Invoices tabs: Drafts, Posted (posted, overdue, paid),
  By Customer (the same combined customer statement) and All Invoices (still the default). The
  tab is kept in the address (`?tab=`); links from before (`?status=ready_to_post`, `draft`,
  `overdue` …) open the matching tab. The Ready to post tile opens Drafts.
- **Field Invoices → Drafts** posts the way Chemical Invoices does: tick invoices (or Select All)
  and press "Post n invoices…". Only invoices the old Post All would post get a tick box (this
  season, not in a split group); split groups and older-season drafts still post from their own
  invoice page, and the confirm still names what is left out. Post All is gone: Select All + Post
  sends exactly the calls Post All sent. Print All / Old Print All / Print Invoice Report still
  print every invoice shown.
- Shared pieces: `src/components/invoices/InvoiceSelection.tsx` (bar with count and total of the
  ticked invoices, row tick box, Select All), `InvoiceListCells.tsx` (status badge, due date),
  `src/lib/invoiceListTabs.ts` (tab names, aliases, statuses).
- Every invoice list (chemical; field Drafts, Posted, All Invoices) now leads with Invoice #,
  Customer, Date, Due, Total, Status. Field status badges now use the app's one color set
  (overdue is amber on the field All Invoices tab, as on Chemical Invoices).

Proof: `src/components/invoices/InvoicePosting.parity.test.tsx` was committed first against the old
screens, pinning each RPC call (name, arguments, order, key scope) for chemical ticked posting and
field Post All; after the change only the clicks in it changed and the expected calls are
identical. New: `Invoices.tabs.test.tsx`, `FieldInvoiceColumns.test.tsx`. Billing area slice and
every invoice-list test pass. Not verified in a browser.
