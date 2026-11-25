## 2026-11-25 — Field Setup: an old tab can overwrite a newer payer note; nested Split Evenly button

**Severity:** MED (note overwrite), LOW (nested button). **Area:** Field Setup (who-pays split and payer notes, FP-1). **Status:** FIXED (2026-11-25, on staging once merged).
**Owner:** none. **Tracked:** found in the sales-rep role check on #2498 (results comment 7167925342).

Both found on a local test copy built from staging at 8e1828690, signed in as a sales rep, with invented data.

- **A stale tab silently replaces a newer payer note (MED).** Open the same field in two tabs. Tab 1 changes a
  payer's note and saves. Tab 2, opened earlier, types a different note for the same payer and saves. Tab 2's note
  replaces tab 1's, and both saves show "Field updated" with no warning. A name-only save from the old tab does NOT
  wipe the newer note; only an edit to the same note does. This is the same "later save wins" pattern as the
  two-reps-same-split item in #2498's follow-ups. Per the field rule (flag and note, never add steps), the likely
  fix is a warning that the note changed since the page opened, not a block.
- **The Split Evenly button sits inside another button (LOW).** On Field Setup, "Split Evenly" is placed inside
  the Default Billing header's open/close button. The browser logs "button cannot contain a nested button".
  Clicking works today; it is invalid page structure and can confuse screen readers and keyboard focus.

**Fixed:** before a save that changes a payer note, Field Setup re-reads the stored notes. If someone else changed
that payer's note after the page opened, it shows "Note changed since you opened this field" with the newer text;
"Save mine anyway" saves, Cancel keeps the newer note (reload to see it). A failed re-read never stops the save.
"Split Evenly" now sits in the open Default Billing panel, not inside its open/close button. Proved on a local test
copy as a sales rep: the two-tab repro warns, Split Evenly gives 33.33/33.33/33.33 = 100.00%, and no nested-button
warning. Still open (LOW): the open/close button wraps the section heading, as the FSA section does.
