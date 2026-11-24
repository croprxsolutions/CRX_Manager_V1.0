## 2026-11-22 — #2248 (KI-144): keep the PO vendor-link design

**Decision (Mason, 2026-11-22, "Yes, keep design"):** PR #2248 keeps its design: a purchase order keeps the vendor name it was written with, one vendor name belongs to one vendor, and the backfill links a PO that already has bills to the vendor that billed it.
**Why:** Live has no bills tied to purchase orders (checked read-only 2026-11-22), so the bill-history part of the backfill links no live PO; every live PO is linked by its printed name. The alternative (ignore bill history and always link by printed name) would need new code and another review cycle for no live effect.
**What this forbids/implies:** Do not redesign the bill-history backfill or the one-name rule in #2248. A further Sol BLOCKER/HIGH on this PR still goes to Mason to fix or skip.
