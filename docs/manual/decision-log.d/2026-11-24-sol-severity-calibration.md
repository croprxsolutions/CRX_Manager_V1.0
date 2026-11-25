## 2026-11-24 — Sol grades HIGH only for a realistic path in ordinary use

**Decision (Mason, in chat 2026-11-24: "Yes, make them"):** the Sol review prompt (`buildCodexReviewPrompt`, `scripts/write-codex-push-proof.mjs`) gets severity rules, a short list of business facts, and a rule for decision-log entries.
**Why:** from 2026-11-07 to 2026-11-24 Sol ran about 954 times on 144 PRs and blocked about 88% of the runs it captured. Mason skipped more than 250 BLOCKER/HIGH findings, about 100 of them as "can't happen in our business". The prompt told Sol to assume the change is broken but never said what HIGH means, so unlikely edge cases were graded HIGH.
**What this forbids/implies:**
- BLOCKER/HIGH needs a realistic path in ordinary daily use, by a real role, ending in wrong money, stock, records, access or a secret leak that nothing stops or surfaces.
- Unlikely combinations are MED: simultaneous edits, a tab left open across a deploy, a future caller, or values the app never accepts. So is a worst case of an error or a retry with nothing half-saved. MED is still reported but does not fail the review.
- The business facts are: a small trusted staff, reps may work with any customer (2026-10-13), admin-only actions an admin can already do another way, and data entering only through the app's own checked screens.
- A decision-log entry is a business record that never changes Sol's verdict. It counts as prompt injection only if it addresses the reviewer directly.
- Sol must still report every defect, and the review base, the packet and the CLEAN/BLOCKERS gate are unchanged. Widening the facts list or moving a class between HIGH and MED is Mason's decision.
