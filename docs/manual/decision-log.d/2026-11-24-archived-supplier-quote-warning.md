## 2026-11-24 — An archived supplier's pending quote stays approvable, with a warning

**Decision (Mason, 2026-11-24):** asked "Should a pending quote from an archived supplier still be approvable?", Mason answered "Yes, with a warning".
**Why:** approving saves the price correctly; it only stays out of supplier evidence and cost basis (both skip archived suppliers) until the supplier is restored. Nothing wrong is saved, so a block would only add friction.
**What this forbids/implies:**
- The quote review screen shows "This supplier is archived. Approving saves the price, but it won't show in supplier evidence or cost basis unless the supplier is restored." for a pending quote whose supplier is archived.
- No block and no database rule: approval of an archived supplier's quote is allowed.
- Closes known issue `2026-11-24-supplier-quote-archived-vendor`.
