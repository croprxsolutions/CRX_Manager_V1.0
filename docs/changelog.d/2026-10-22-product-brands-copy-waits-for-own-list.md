## 2026-10-22 — Product brands: Copy waits for the product's own brand list (step 1, PR A)

**What changed.** A Codex App review of PR #1050 (head `19d19d5ba`) found that "Copy from another product" worked while the page's own brand list was still loading or had failed to load. The screen then couldn't tell which brands the product already had. A duplicate was refused part-way through, and the remaining picks went uncopied.
- Copy is switched off until the product's own list has loaded, and paused, with a message, if a reload fails.
- The brands offered for copying are checked against the product's current list on every redraw. A brand that appears on a reload, such as one another admin just added, drops out of the copy list.

**Proof.** Three new screen tests in `ProductBrandsSection.test.tsx`: Copy is off while loading, a retry is paused after a failed reload, and a brand that shows up on a reload is no longer offered. All three fail on the old code and pass on the fixed code. No database change.
