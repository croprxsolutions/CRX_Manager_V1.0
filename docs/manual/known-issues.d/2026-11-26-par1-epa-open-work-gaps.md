## 2026-11-26 — Parent EPA correction: open-work check has named gaps

**Severity:** LOW (no amount or stock changes; an older record can show the corrected EPA number). **Area:** Product
corrections (parent EPA correction refuses open work, #2579). **Status:** ACCEPTED.
**Owner:** Mason (accepted). **Tracked:** #2613 (merged to staging 2026-11-26), contract
`docs/plans/2026-11-25-par1-epa-refuse-open-work-CONTRACT.md` › Residual.

The correction refuses while a size has open jobs, unbilled or unrecorded blend tickets, or draft/unposted invoices.
These cases are not caught, and each can leave an earlier spray showing the corrected number:

- A blend ticket whose scanned (OCR) line is not yet matched to a product does not block.
- A completed job counts as billed once any live invoice is linked to it or its blend ticket, even if that invoice
  has no line for the size; a line added afterwards takes the corrected number (Mason, 2026-11-25, "Ship, name the gap").
- An application record made from a ticket after its job was invoiced, and a service-only split draft that later gets
  a chemical line, can take the corrected number (Sol r2–r4, skipped by Mason 2026-11-25 and 2026-11-26).
- Reopening finished work after a correction, and status changes racing the check, are the accepted race from 2026-11-07.
- The refusal shows in the standard short toast, so a long list of records can be hard to read before it closes.

Related but separate: job completion and a linked ticket's Create App Record can each deduct the same spray's stock;
being fixed in its own branch (Mason chose "count once, flag", 2026-11-26).
