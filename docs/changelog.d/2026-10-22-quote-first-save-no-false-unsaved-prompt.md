## 2026-10-22 — Quotes: the first Save Draft no longer shows a false "Unsaved Changes" prompt

- Seen live during PR #1038's click-through: saving a NEW quote as a draft showed "Quote saved as draft" and then the
  "Unsaved Changes — Leave / Stay" dialog as the page moved to the saved quote. A rep who chose Stay was left on
  `/quotes/new` holding a quote that was already saved.
- Cause: `handleSaveDraft` cleared the dirty flag and navigated in the same tick, so the router's blocker still held the
  old "dirty" value. Same bug class as the field-application invoice screen (2026-10-09), fixed the same way:
  `QuoteBuilder` now passes a one-shot skip ref to `useUnsavedChanges` and sets it right before each navigation that
  follows a committed write — first Save Draft, booking draw-down to an order, Convert to an order, and Convert's
  "order already created" recovery. A real unsaved edit still prompts.
- Edits typed while Save Draft is still running (the save itself, and a planned program's hold creation) are not in
  what was saved (Codex review on this PR). A new quote still opens its saved page, because staying on `/quotes/new`
  would make the next save create a second quote, and a warning says the late changes were not included. On an
  existing quote such an edit now keeps the screen marked unsaved instead of being cleared. Draw-down, Convert and
  Convert's recovery give the same warning when the rep typed while the order was being created (Luna round 2).
- New `src/pages/QuoteBuilder.saveNavigation.test.tsx` uses the real router, hook and dialog to cover both cases.
- Frontend only; the save payload, line ids and every RPC are unchanged.
