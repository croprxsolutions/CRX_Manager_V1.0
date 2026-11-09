---
name: plan-contract
description: Use before writing code for any CRX Manager change that can affect money, stock, stored data, who may do what, or a record's lifecycle (or the enforcement protecting them), including when Mason asks to plan such a change first, deliberate with Codex, or attack its plan. Writes a short behavior contract, asks Mason only business decisions, gets one cold challenge from the other model, then builds.
---

# Plan Contract

Read `.claude/commands/plan-contract.md` from the active repository root completely and use it as the source of truth.

Natural-language triggers, when the change can affect money, stock, stored data, permissions or a lifecycle, or their enforcement: "plan it first", "think it through before coding", "have Claude and Codex agree on the plan", "attack the plan". For other work these phrases mean `ship.md`'s short plan.

It never replaces a gate: Luna, Sol, CI, migration proofs and hooks still run. Delivery (push, PR, live apply, merge) follows `.claude/commands/ship.md` and its gates, including splitting database-first PRs.
