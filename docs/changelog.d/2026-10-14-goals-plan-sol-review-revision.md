## 2026-10-14 - Goals plan revised after an independent Sol 6.1 review

Documentation only; no app or database change.

- **`docs/plans/2026-10-13-direction-and-goals.md` revised.** Mason asked Codex `gpt-6.1-sol` (high reasoning) to review the plan and help edit it. Its 43 findings were checked against the code at `395bdcd9a` and the live system before being applied. Main changes:
  - Goal 2's main change is marked shipped (PR #907), with its follow-ups listed: the own-name rule on every invoice path, reps reading every invoice, and commission splits.
  - React 19 is recorded as done.
  - Retiring Chem Man now depends on a 30-day reconciled pilot and signed opening balances, not just finished features.
  - Three launch-readiness checks are added to Phase A: compliance (L1), physical inventory (L2), and opening balances and cut-over rehearsal (L3).
  - Goal 6 (the test system and backups) and Goal 7's outside lead times (accountant, QuickBooks Desktop connection test, payment processor) start now, in parallel.
  - Proposed dated checkpoints and a more honest timeline (roughly 14–24 weeks for Phase A).
  - A proven connector or Intuit's Web Connector is preferred over IIF import files for QuickBooks Desktop.
  - The accounting map needs the accountant's approval before coding.
  - Much fuller "done when" tests for posting, voids, pricing, split billing, reports, offline delivery, recovery and payments.
  - Photo privacy must not rely on expiring links alone.
  - Goal 9 cleanup can never force-apply a migration or switch off a required gate.
  - Six new open questions for Mason (6f–6k).
