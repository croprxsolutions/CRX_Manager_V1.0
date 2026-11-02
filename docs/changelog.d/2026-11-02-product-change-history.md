## 2026-11-02 — Product setup change history

Added a local candidate migration that records each changed setup field with the signed-in actor, name snapshot, time, old value and new value. Product creation gets a single created row. Active staff can read the append-only history; cost and price fields remain in the admin-only cost history.

Added the Change History card to existing product pages, a focused component test, a local browser scenario, and a real-schema Docker proof. The candidate has not been applied to production.

Live read on 2026-11-02 at 7:50 AM Central (read-only `list_migrations`): 1,089 ledger rows, effective high-water `20261101120000`, highest version `20261101181836`, and no row at or after this candidate. CURRENT_STATE.md and KNOWN_ISSUES.md were re-stamped for the ledger read only.
