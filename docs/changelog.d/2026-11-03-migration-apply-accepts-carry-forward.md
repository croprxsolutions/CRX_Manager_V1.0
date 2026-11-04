## 2026-11-03 — A migration's apply accepts a carried-forward Sol proof

`AGENTS.md`, `.claude/commands/ship.md` (Migrations bullet, Step 5 item 2, Step 8 item 4) and `docs/reference/sol-required-paths.md` now say a migration's live apply needs a Sol proof bound to its exact head: a full review or a `--carry-forward` of one after a clean merge of main (Mason, 2026-11-03; `docs/manual/DECISION_LOG.md`). The apply gate already accepted carried proofs through `proofValid`, so no guard code changes. Motivation: PR #1389 paid a full Sol round, about 20 minutes, for each of five main moves.
