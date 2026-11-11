# plan-contract pilot log

One row per logical change that used `.claude/commands/plan-contract.md`. That means one row across all of the change's PRs, and stopped attempts count. Add the row when the change closes. After five rows, the agent closing the fifth compares them with the baseline and tells Mason whether to keep, simplify or delete the step.

**Baseline** (PRs #1652–#1696, rough estimates; see `README.md`): money and database PRs needed a median of about 5 fix rounds (range 3–8). Late design findings caused the longest ones, for example Sol rounds 4–8 on #1678 and #1653.

**Late design finding:** a review finding after code existed that exposed one of the following:

- a missing business rule;
- a wrong factual assumption, such as a column that does not exist;
- a screen, server or RLS mismatch;
- a legacy-row, timing, undo or rollout gap.

A simple implementation mistake against a settled rule is not a late design finding.

| Date | PRs | Contract | Mason questions | Challenge findings settled / declined | Extra planning effort (approx.) | Luna rounds | Sol rounds | Late design findings | Escaped defects | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-10 | #1746 (replaced parked #1688) | `docs/plans/2026-11-10-reg1-step2-record-line-link-CONTRACT.md` | 5 (4 in the contract; "Yes at post wins" after Sol r1) | 40 settled / 0 declined (Astra, high) | one contract and one Astra run (not timed) | 4 | 3 (r1 HIGH, r2 clean, r3 clean after a main merge) | 1 (Sol r1: a Yes known at posting must create the record; a missing business rule) | 0 so far (applied live 2026-11-10; seed not yet run) | Linking each record to its invoice line removed every "which record covers this sale" rule that kept #1688 failing over 13 Sol rounds. Leftovers: #1754, KI-117, KI-118. |
