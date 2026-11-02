## 2026-11-01 - fix(fields): a failed acreage step on a new field no longer leads to a duplicate

When a new field saved but its boundary or acres-to-bill step failed, the Unsaved Changes prompt stopped the move to the saved field. Stay left the user on the new-field form, where saving again created a second field. Forced in the private test copy: 2 fields before, 1 after. The move now goes through and the failure message stays. The page it lands on reloads from the database, so the acres message now names the number and asks for it to be entered again.
