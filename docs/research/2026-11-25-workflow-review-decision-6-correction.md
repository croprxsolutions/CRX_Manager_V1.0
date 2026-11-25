# Correction to workflow-review decision 6 (2026-11-25)

Addendum to the 2026-11-22 workflow review (PR #2304, still a draft, so this correction sits in its own file). Source: Taha's chemical-side review of 2026-11-25, finding A1.

## What decision 6 says

Decision 6 ("Cost on an edited order"): existing lines keep their booked cost; only a newly added line takes today's cost. The review material says this is **already how the app works** for edits to an existing line.

## What is actually true today

It is not. When anyone saves an order edit, the app re-reads today's catalog cost for **every** line on the order, not just the line that changed. Taha proved this with a test (finding A1). Example from his review: a rep changes only one product's quantity; another, untouched line's cost jumps to today's catalog cost, so the order's profit and the rep's pending commission move even though that line was never edited.

## What this changes

- Decision 6 itself stands as the business rule: an unchanged line keeps its booked cost.
- The "already how the app works" note in the #2304 material is wrong; read decision 6 as **not built** for unchanged lines.
- The fix is Taha's A1 (orders are Taha's lane until Dec 15), one of his four proven fixes planned before Dec 15.

Other answers from the same review are recorded in `docs/manual/decision-log.d/2026-11-25-taha-review-*.md`. Questions from that review still open (early-pay discount commission, order of work, v0.2.1 timing, the Ship / Spray mark) are not decided here.
