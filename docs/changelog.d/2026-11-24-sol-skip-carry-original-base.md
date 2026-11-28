## 2026-11-24 — A carried Sol skip records the base Mason first skipped it against

Follow-up to #2336 (Taha's review, Mason's answer 2026-11-23: "have each carried skip record the
original base").

- Each carried entry's `carried_from` now holds `original_base_sha`: the base the root skip was
  reviewed against. The carried decision-log entry names it ("first skipped against base ...").
  A record only: no gate reads it, so older carried proofs keep their meaning.
- `docs/manual/decision-log.d/2026-11-23-sol-skip-carry-forward.md` no longer says a skip "never
  carries onto a newer base": it does, after a catch-up merge, when Sol's fresh full review marks
  every finding the same. A saved Sol proof itself still never carries onto a newer base.
- Mason's rule is unchanged: once he skips a finding it stays skipped; he is never asked again.
- Test: `.claude/hooks/sol-skip-carry.test.mjs` checks the original base in the carry, the proof
  and the log entry.
