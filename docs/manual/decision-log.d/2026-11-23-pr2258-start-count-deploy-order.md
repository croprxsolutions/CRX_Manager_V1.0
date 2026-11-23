## 2026-11-23 — #2258: Start Count deploy-order risk accepted; Sol round 7 allowed

**Decision (Mason, 2026-11-23, in chat: "Yes, accept it").** The Start Count screen calls `create_cycle_count`, which is on staging and reaches production through the release flow, whose migrations are applied live before the release merges into `main`. Mason accepts the risk that if that apply were ever skipped, Start Count shows an error and saves nothing (no wrong data or money). After the staging catch-up at `9094fbf01`, Mason allowed a further Sol review of #2258.
