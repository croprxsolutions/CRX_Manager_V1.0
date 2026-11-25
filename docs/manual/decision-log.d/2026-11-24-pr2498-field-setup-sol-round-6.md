## 2026-11-24 — Sol round 6 allowed on Field Setup (#2498)

**Decision (Mason, 2026-11-24):** A sixth Sol round on #2498 is allowed ("Yes, round 6"), run after the branch is restacked on the FP-1 (#2487) head that fixes Sol round 5's backfill-rounding finding.
**Why:** Round 5's only HIGH was in the FP-1 migration this branch is stacked on, not in the Field Setup screen; the fix lands on FP-1 and this branch must be re-reviewed on top of it.
**What this forbids/implies:** Round 6 runs only on a head that contains the fixed FP-1 commit; the screen keeps the lock-and-reload save recorded in 2026-11-24-pr2498-field-setup-lock-and-reload.md.
