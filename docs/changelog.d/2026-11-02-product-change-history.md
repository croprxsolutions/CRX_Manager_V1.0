## 2026-11-02 — Product setup change history

Added a local candidate migration that records each changed setup field with the signed-in actor, name snapshot, time, old value and new value. Product creation gets a single created row. Active staff can read the append-only history; cost and price fields remain in the admin-only cost history.

Added the Change History card to existing product pages, a focused component test, a local browser scenario, and a real-schema Docker proof. The candidate has not been applied to production.
