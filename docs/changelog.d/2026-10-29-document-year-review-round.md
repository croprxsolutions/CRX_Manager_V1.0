## 2026-10-29 - Document-number year candidate: review round 1 (PR #1181)

- The migration no longer carries its own `BEGIN;`/`COMMIT;`: the guarded apply script
  supplies the transaction and refuses a file with top-level transaction control. The
  function bodies and every preflight/postflight check are unchanged. The disposable
  proof now wraps the file the same way and passed again.
- Quote screen: a new quote allocation clears any previous number first (so a failed
  allocation can never save under a stale number), an existing quote no longer shows
  "still loading", and a failed allocation reports a real `Error` to Sentry.
- Corrected stale stamp and draft-only wording in the proof record, review record,
  RPC reference and the first changelog entry; pinned the migration file as LF.
- Deferred at this round: four-digit numbers stop at 9,999 (pre-existing capacity limit,
  owner: Codex), since removed from the candidate by
  [2026-10-31-document-number-capacity.md](2026-10-31-document-number-capacity.md);
  `generate_ticket_number` stays on its own year logic.
