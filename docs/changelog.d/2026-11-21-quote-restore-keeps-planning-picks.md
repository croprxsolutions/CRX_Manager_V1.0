## 2026-11-21 — Rewinding a booking keeps each section's Timing and Confidence

- New migration `20270204140000_quote_restore_keeps_planning_picks.sql` (not applied live; record in `docs/reference/migrations.d/`). Needs `20270127110000` (the Timing and Confidence columns) first.
- Before: rewinding a booking to an earlier sent version blanked Timing and Confidence on every section, because versions never saved them. The buy plan then treated firm demand as "could add" and quietly left it out.
- Now a rewind keeps the booking's current Timing and Confidence: each restored section takes the picks of the current section with the same position and name. A section that only the old version has comes back unset. Timing and Confidence are planning picks, not part of what a version records, so a rewind does not roll them back.
- Nothing else about the rewind changes: who may do it, the refusal for a booking already drawn into an order, prices, and the version snapshot itself.
- A section renamed since the send, or moved to another position (removing a section renumbers the ones after it), comes back unset, so picks never land on the wrong section; the rep sets it again.
- Proof: `npm run proof:quote-restore-keeps-planning-picks` (container prover: before, a rewind blanks every pick; after, the picks are kept, the extra section comes back unset, a section renumbered by a removal or renamed comes back unset, a drawn booking is still refused with nothing changed, a second apply is refused, and owner, security mode, search path and grants are unchanged). Not yet verified on staging.
