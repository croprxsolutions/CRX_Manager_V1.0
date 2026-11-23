## 2026-11-23 — Sol round 5 allowed on PR #2323 (drop the inert short-stock trigger)

**Decision (Mason, 2026-11-23):** allow a fifth Sol review round on PR #2323 (#2225).
**Why:** Sol round 4 found one HIGH, now fixed: the drops run inside the guarded preflight block, so a client that continues after errors cannot commit them, and the prover covers that case. The change removes a trigger that no longer does anything and changes no row. Taha reviewed it with no findings.
**What this forbids/implies:** one more full Sol round on #2323's current head. If round 5 raises a new BLOCKER or HIGH, stop and ask Mason again rather than patching further.
