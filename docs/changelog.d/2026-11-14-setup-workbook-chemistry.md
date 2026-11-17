## 2026-11-14 — Setup workbook weight drafts and ingredient proposals

The setup workbook adds Weights and Ingredients sheets with separate previews and confirmations. Weight changes save drafts. Ingredient changes create proposals, with a separate Apply decision and explicit confirmation for removals. A new ingredient may omit CAS; preview and proposal review warn that applying it creates a provisional shared ingredient even when a similar name exists.

The workbook keeps unanswered chemistry requests for an explicit retry with the same key and arguments. A workbook upload that finishes checking product membership after the signed-in profile changes is discarded. Existing ingredient CAS is read-only in the workbook; correct it through the shared ingredient review screen after downloading a fresh workbook. Older v2 uploads remain compatible. The screen uses the existing database APIs and does not require a new migration.

Late Parent Rates preview replies from an old workbook or profile can no longer clear the current retry state. Chemistry save/Finish success toasts are also suppressed when their proposal refresh completes after the actor or workbook has changed.

An unanswered Product Rates save now keeps its accepted preview and retry key across a Setup save. New uploads clear old retry-pending UI state without losing per-payload keys. A known business refusal on a replay shows the server's reason; an own-Setup rebase is used if a later stale refusal requires a fresh preview. Parent Rates auth and PostgREST errors retain an unanswered request, with sign-in/admin guidance for auth failures. Known stale or lock refusals still require a fresh preview or show the locked state.

