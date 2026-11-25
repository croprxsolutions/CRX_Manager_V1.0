## 2026-11-24 — Supplier quote with a near-zero package size and conversion factor

**Severity:** LOW. **Area:** Supplier Pricing, quote review. **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2486 (Sol round 1 MED, deferred).

If a supplier link's conversion factor and a quote's package quantity are both set to the
smallest value the columns allow (0.00000001), the converted cost per inventory unit is larger
than a whole-cent bigint can hold. The quote review screen then shows an enormous converted cost,
and after approval the supplier workspace read fails on that row when the database converts the
value. No real product is set up this way (live comparable links all use 1 or more). Fix: refuse
a conversion factor or package quantity that small when the link or quote is saved, or cap the
converted cost on screen and in the read.
