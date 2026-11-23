# Quote-to-cash remediation tracker (staging audit 2026-11-21)

Source: signed-in staging run on 2026-11-21 against `staging.croprxsolutions.app` (Supabase `fsnjredpmakbmhwowjjt`), synthetic "QA Q2C 1121" fixtures only. Staging ref at triage: `9a1c5b2d9`. All proof for these items runs on staging or a disposable database, never production.

Ownership rule: Taha owns quotes, bookings, invoices and billing until 2026-12-15 (Mason, 2026-11-19). Items in that area go to Taha as an issue or PR comment; agents do not build them.

| # | Item | Severity | Area | Owner | Disposition |
|---|---|---|---|---|---|
| F05 | Delivery can schedule/complete beyond the ordered quantity (ORD-2026-0017: 2 ordered, 3 delivered; DEL-00009 kept 10 after line dropped to 6) | HIGH | deliveries / stock | Claude | **In progress** — contract `2026-11-22-f05-delivery-remaining-qty-CONTRACT.md` |
| F06 | Job completion and its linked blend ticket both deduct stock (JOB-2026-0010 / BT-2026-0002) | HIGH | jobs / stock | Claude | Next after F05. Not covered by #2170 (that PR fixes missing stock rows, not double deduction) |
| F10 | Delivery edit drops tote, keeps cleared driver/address | HIGH (dispatch) | deliveries | Claude | Queued after F06 |
| F15 | Damaged return defaults to restock; message always says "restocked" | MED | returns / stock | Claude | Needs Mason: default for damaged goods |
| D11 | Short-close refused after a credited return (ORDER_HAS_RECEIVED_RETURN) | policy | orders | Claude | Needs Mason: allow closing only the unshipped quantity? |
| F11 | Stale tab completing rush pricing overwrites a finalized line price | HIGH | order pricing (feeds drafts) | Claude, check with Taha | Confirm with Taha it is outside his invoice work before building |
| F09 | Payer-switch repair on staging held | HIGH on main | invoices | Taha | Verified on staging; ships with the next release |
| F01 | Return credit uses order price, not billed price | HIGH | credit memos | Taha | Route to Taha |
| F02 | No way to record an outside cash refund against credit | HIGH | credit / payments | Taha | Route to Taha (needs Mason's rule) |
| F03 | Credit for externally billed shipments | HIGH | credit memos | Taha | Route to Taha; needs isolated fixture |
| F04 | Month-end summary misses allocation-ledger receipts | HIGH | payments / close | Taha | Route to Taha |
| F07 | Stale draft save erases freight | HIGH | invoice drafts | Taha | Route to Taha |
| F08 | Price change timing changes later drafts | HIGH | invoice drafts | Taha | Route to Taha (needs Mason's rule) |
| F12 | Fractional rush drafts lose a cent | MED | invoice drafts | Taha | Route to Taha |
| F13 | Commission payout preview counts uncollected orders | HIGH | commission | Taha | Route to Taha (billing-adjacent) |
| F14 | Payment-reversal guidance wording | HIGH (recovery) | payments | Taha | Route to Taha |
| F16 | Invoice number formatter past 9,999 | MED | invoices | Taha | Route to Taha; disposable-database proof only |
| F17 | Reprinted invoice shows renamed product | MED | invoice PDF | Taha | Route to Taha |
| F18 | Group invoice permission review | defensive | invoices / permissions | Taha | Private review; details kept out of this public file |
