## 2026-10-18 — New Order keeps an edited form when a retry opens the earlier order (replay-binding batch 2)

Sol final review of PR #951 (HIGH, fixed before landing):

- **Edits are no longer lost.** When a New Order retry is refused because the form changed since an
  earlier attempt that already created an order, the screen still opens that earlier order, but it
  now keeps the current form as a draft instead of deleting it. The edits are in no order, so they
  must stay recoverable. The warning says the form was kept.
- **Two different forms no longer share a retry key.** The form's change check joined free-text
  fields with `|`, so an order name `A|B` with notes `C` looked the same as name `A` with notes
  `B|C`. It is now JSON-encoded, so any change to any field starts a fresh key.
- **Proof:** `src/__tests__/replayBindingBatch2CallSites.test.ts` fails if either recovery block
  clears the draft or the hash goes back to a delimiter join.
