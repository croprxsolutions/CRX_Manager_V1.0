## 2026-11-23 — RT-4a rate switch ships its own refusals; the general invoice-unit guard is a follow-up (#2372)

**Decision (Mason, 2026-11-23, "A: follow-up issue"):** #2372 keeps the two refusals on the rate switch itself (old values that could not be switched back; an approved unit field-app invoices cannot convert). The general database guard on Add a size, Move a size and rate corrections moves to follow-up #2367.
**Why:** the general guard drew a new Sol HIGH in rounds 3 and 4 on this branch. Products whose rate unit field-app invoices cannot convert can already be created on every group today, with or without the switch; #2367 covers every write path under its own plan and review.
**What this implies:** #2372 may run Sol round 5. Its migration no longer adds a trigger on products; the invoice-unit gap on size and unit edits is tracked in #2367.
