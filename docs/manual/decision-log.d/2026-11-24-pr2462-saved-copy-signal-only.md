## 2026-11-24 — #2462 driver saved copies show only when signal is lost

**Decision (Mason, 2026-11-24, after Sol round 4 on #2462 found a second HIGH about saved copies outliving access):** "Fix it, run round 5".
**What this implies:** My Route, a delivery stop and My Day show today's saved copy only when the read failed for lost connection. Any answer from the server (no row because the stop was reassigned or removed, or access denied) deletes that saved copy and shows the normal "could not load" path. A route refresh also deletes the saved copy of any stop that left the route. Sol round 5 on #2462 reviews this rule; other saved-copy notes (partial loads, cold offline restart, expiry on disk) stay follow-ups in the PR.
