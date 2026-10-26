## 2026-10-26 — A purchase order can be downloaded as a PDF and emailed to its vendor (To-Do 0.15)

**What changed.** On a purchase order, admins now see two buttons:

- **Download PDF** — a branded purchase order: vendor (with contact, address, phone and email when the
  vendor record has them), buyer, order and requested-delivery dates, each product with its EPA number,
  quantity, unit cost and line total, the order total, notes, and "Page N of M" on every page. A draft is
  marked "DRAFT - NOT YET SUBMITTED" and a cancelled PO "CANCELLED - DO NOT FILL". Line and order totals
  are whole cents from the same helpers as the purchase order page (`src/lib/purchaseOrderPdf.ts`). A line
  with no cost yet prints "TBD" and is left out of the total; an unconfirmed cost is starred; both get a
  red footnote, so a printed or forwarded PDF never shows them as firm prices. Vendor details wrap rather
  than being cut, long notes continue onto new pages, and the PDF is built from a fresh read of the lines.
  The PO notes box now says its notes print on the PDF.
- **Email Vendor** (submitted or partly received POs) — asks to confirm, then emails that PDF to the
  email saved on the vendor. It says plainly, and sends nothing, when the vendor has no email (true of every
  vendor today), a line has a $0 or unconfirmed cost, or the PO has no lines.

Both are admin-only because a PO shows purchase cost, which is admin-only (Mason, 2026-10-18).

**Server side.** `send-email` gains the `purchase_order` type, allowed for admins only (sales reps keep the
10 customer types). It needs no `customer_id`; instead it needs `resource_type='purchase_order'`, and the
recipient must equal the email of the one active vendor named on the PO. The PO must be submitted or partly
received with every line cost confirmed, and the lines the app says the attached PDF prints (id, quantity,
unit cost) must be exactly the PO's lines, so an out-of-date PDF is refused. These checks run before the
write-ahead log and again just before the provider call (`supabase/functions/_shared/purchaseOrderEmailGate.ts`). Migration
`20261026090000_email_type_purchase_order.sql` adds the `purchase_order` value to `email_type` so the send
is logged in `email_log`.

**Not live until:** Mason approves deploying the `send-email` edge function (until then an Email Vendor
attempt gets "Unknown email_type: purchase_order"), and vendor emails are entered on the Vendors page.

**Proof.**
- PDF generated from the real lines of PO-2026-0024 and opened page by page: 12 lines, total $143,134.69
  (equal to the sum of its line totals and to the PO page); a 48-line test PO with a long vendor name,
  address and email, one unpriced and one unconfirmed line and very long notes runs to 4 pages: nothing
  cut, no row split across pages, TBD and star footnotes shown, total $559,204.01 (the 4x total less
  the TBD line), and a footer on each page.
- In the running app (admin): both buttons show on PO-2026-0024; Email Vendor shows "This vendor has no
  email address on file…" and makes no request; Download PDF produces the same PDF.
- Tests: `purchaseOrderPdf.test.ts`, `purchaseOrderEmail.test.ts`, `purchaseOrderEmailGate.test.ts`
  (server gate decisions and wiring order) and `PurchaseOrderDetail.vendorEmail.test.tsx` (no-email
  message, confirm-then-send payload, key kept on failure, draft and sales-rep visibility).
