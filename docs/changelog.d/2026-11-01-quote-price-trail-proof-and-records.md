## 2026-11-01 — Records and proof for the price trail and expiry grant

- `20261101100000_quote_price_trail_and_expiry_grant` applied live 2026-11-01 17:13:55 UTC (11:13 AM
  Central) on Mason's approval of that file, and #1237 merged as `408fc9d7d`.
- Adds `scripts/smoke/smoke-quote-price-trail-and-expiry.sql` and
  `scripts/smoke/prove-quote-price-trail-real-schema.mjs` (`QUOTE_PRICE_TRAIL_PROOF_PASS`), held out of
  the public repo until every part of the fix was live. The chain reached live before the fix
  (cases A and G failed), and passes after it.
- Proof after apply: the chain passed on live, and a full live sweep adjudicated all 30 predicates
  `ok: true`, `complete: true`. Mason approved running `quote-versions-rpc-owned` once from a script
  with his token, because a query that size was cut off when a model retyped it; the script sent
  only the query the live-data guard recognises as the exact fingerprinted text.
- One narrow case stays accepted: a ticked row since the last send still vouches for its price after
  rewinds, so the trail and the grower's tick remain. Closing it means restore writing a marker.
