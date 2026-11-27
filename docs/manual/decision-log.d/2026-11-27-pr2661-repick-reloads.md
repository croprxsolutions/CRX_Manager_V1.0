## 2026-11-27 — Record Payments: re-picking the same farm reloads its invoices (#2661)

**Decision (Mason, 2026-11-27, in chat: "fix it", on Sol's round-4 HIGH for #2661):** re-picking the farm already chosen on Record Payments reloads its open invoices and keeps the typed check and the amounts typed on invoices that are still open. It no longer keeps the old list unchanged.
**Why:** an invoice posted for that farm while the page was open must show up, so Auto-Allocate and the clerk see every open invoice.
**What this forbids/implies:** this allows one Sol round on #2661's head after this fix. A kept amount above an invoice's refreshed balance is flagged on screen and blocks Apply, as a typed one does. A further Sol round on #2661 needs a new decision from Mason.
