## 2026-11-03 — Any rep can change the booked prices on another rep's booking

- Mason, 2026-10-30: "any rep may change booked prices on any booking".
- New migration `20261104130000_any_rep_changes_booked_prices.sql` (NOT APPLIED; record in
  `docs/reference/migrations.d/`). On a sent or revised booking, an active sales rep who is not the
  booking's rep may click Revise Quote and change the price of existing lines. The rules are the same
  as for the booking's rep: a higher price needs "Grower agreed" on that line, each change is recorded
  in `quote_price_changes` under the rep who saved, it applies with no re-send, and below-cost
  approval is unchanged. Anything else that rep's save would change (quantities, rates, acres, notes,
  lines, sections, products, customer, tier, planned flag, commission split, expiry, or a status other
  than sent to revised) is refused with `QUOTE_PRICE_ONLY_FOR_OTHER_REPS` and nothing is saved.
  Admins and the booking's own rep are unchanged; drafts and closed quotes stay owner-only
  (`NOT_QUOTE_OWNER`); drivers, deactivated users and signed-out callers are refused as before.
- Quote screen: that refusal shows a plain message instead of the raw code.
- New smoke chain `smoke-any-rep-booked-prices.sql` (spec `any_rep_changes_booked_prices`).
  `smoke-save-quote-customer-row-version.sql` now expects the price-only refusal for another rep's
  note change on a sent quote. `prove-quote-price-trail-real-schema.mjs` reads its chains, sweep and
  allowlist as of its own candidate, since this migration re-emits what it covered.
- `allowlist.json`: the `save_quote` actor-forgery exception's wrapper and implementation pins move
  with the re-emit (post-apply values, read from a local replay that reproduces the current live
  digests).
- Proof: local Supabase rebuilt from this branch with synthetic data. Booking scenarios: 36 pass,
  the 5 known failures unchanged (S02 S09 S12b S14 S16b). S24, S24b and S24c failed on main before
  the change; S24d (the refusals) passes on both; S24e (retry binding) was added afterwards. A save
  shaped like the quote screen's Revise Quote, then a price cut, passes as another rep. Permission
  matrix 232 pass / 2 fail, unchanged.
- Not verified: live; the Docker real-schema provers (image not on this machine); the
  `cost-exposure-review` key for `save_quote` after apply (needs a read-only live query).
