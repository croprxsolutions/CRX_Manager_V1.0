## 2026-10-18 — New Order keeps an edited form when a retry opens the earlier order (replay-binding batch 2)

Sol final review of PR #951 (HIGH, fixed before landing):

- **Edits are no longer lost.** When a New Order retry is refused because the form changed since an
  earlier attempt that already created an order, the screen still opens that earlier order, but it
  now keeps the current form as a draft instead of deleting it. The edits are in no order, so they
  must stay recoverable. The warning says the form was kept.
- **Two different forms no longer share a retry key.** The form's change check joined free-text
  fields with `|`, so an order name `A|B` with notes `C` looked the same as name `A` with notes
  `B|C`. It is now JSON-encoded.
- **A true retry keeps its key (CodeRabbit).** Each order type's change check is now exactly the
  arguments that order sends, built once and sent as built. Before, a field the order never sends
  (a rush order's date or name, or a space after the PO number) gave a retry a fresh key, so a
  retry after a lost response could create a second order.
- **The kept draft is current (CodeRabbit).** The draft saves half a second after typing; the
  recovery now writes it immediately before opening the earlier order.
- **Proof:** `src/__tests__/replayBindingBatch2CallSites.test.ts` fails if either recovery block
  clears the draft or skips the immediate save, or if either order call stops sending exactly
  the arguments its key's change check covers; `src/hooks/useFormDraft.test.ts` proves the
  immediate save cancels a pending one.
