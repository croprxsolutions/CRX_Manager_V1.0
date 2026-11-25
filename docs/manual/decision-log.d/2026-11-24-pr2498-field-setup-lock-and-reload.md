## 2026-11-24 — Field Setup save locks the page and reloads fresh (#2498)

**Decision (Mason, 2026-11-24):** On Field Setup (#2498), while a split or notes save runs the whole page is locked, and when it finishes the field reloads fresh from the database instead of merging the save's reply into the screen ("Yes, lock and reload"); a fifth Sol round on #2498 is allowed ("Yes, allow it").
**Why:** Merging a save's reply into a screen that stayed editable kept producing new ways to show or save stale data; locking and reloading removes that whole mechanism at the cost of about a second of waiting after Save.
**What this forbids/implies:** Field Setup never merges a split-save reply into an open form; a save always ends in a fresh load, and a failed reload shows the load-error state rather than a stale form.
