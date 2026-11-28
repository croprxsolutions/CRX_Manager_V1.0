## 2026-11-25 — Field Setup (#2558): deferred follow-ups

**Severity:** LOW–MED. **Area:** Field Setup (who-pays split, payer notes). **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2558 (merged into staging), "Follow-ups" section.

- **MED: the stale-split warning is best-effort.** The check and the save are two separate requests. A split someone else saves in the moment between them is not warned about. Closing it needs a database check in `set_field_billing_split`, and the field rule says flag, never block.
- **LOW: a rare note replay.** If a payer note is edited back and forth (A→B→A→B) and two saves in a row lose their reply on the same day, an old saved result can replay.
- **LOW: a failed pre-save read skips the warning.** If reading payer notes fails during the pre-save check, the save goes ahead without the warning; the check never blocks.
- **Still open from #2498:** one call for `save_field` and `set_field_billing_split` together; check the applicator-directions link in the printed PDF.
- **LOW: full browser storage.** When session storage is full, a retry can get a new retry key.
