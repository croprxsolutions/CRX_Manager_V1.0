## 2026-10-16 — replay-binding batch 2: `create_planned_holds` requires a retry key from the browser

CodeRabbit's pre-merge check on PR #951 ("Mutating RPC without idempotency key") was right:
migration `20261016140000` still let any signed-in caller run `create_planned_holds` with no key,
because `revert_quote_status` calls it that way. The migration now closes it the way batch 1
handled its one internal keyless call:

- `revert_quote_status` gets a same-signature pass-through wrapper. Its body is renamed unchanged
  (`_revert_quote_status_impl_20261016`, callable only by the database owner) and keeps every
  check and receipt it has today. The wrapper sets the transaction-local marker
  `crx.revert_quote_status_internal` around the call.
- `create_planned_holds` accepts a keyless call only while that marker is set; any other keyless
  call is refused with `IDEMPOTENCY_KEY_REQUIRED`. The app's own call already sends a key.
- Proof: the rollback-only chain now reopens a declined planned quote through
  `revert_quote_status` (its keyless rebuild runs, writes no receipt, and the marker does not
  outlive the call) and shows a keyless call from outside is refused; the container prover
  mutates the marker gate, the keyless path and the marker itself, and each turns the chain red.
- The order screens also stop showing "Order created successfully" on top of the warning when
  they open an order an earlier attempt already created (Codex P2 on PR #951).
