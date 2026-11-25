## 2026-11-25 — Drop-location photo bound to the load

**Decision (Mason, 2026-11-25, in chat: "Yes, tie it"):** the Field Mode drop-location photo (no one present, left at site) is tied to the products and amounts it was taken for, like a signed-ticket photo. The screen saves that list with the photo; the "make it required" migration (`20270308010000_proof_binding_required.sql`) refuses a drop-location photo saved with no list, or for another load, with `LEFT_AT_SITE_LOAD_CHANGED`.
**Why:** Taha's review of #2557 (MED 1) and #2527 HIGH 4: a drop photo taken before the load changed could otherwise complete the changed delivery.
**What this forbids/implies:** a driver whose load changes after the drop photo must take a new one. No-proof (office) completions stay unchecked.
