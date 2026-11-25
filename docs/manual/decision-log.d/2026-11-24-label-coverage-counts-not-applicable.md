## 2026-11-24 — A product whose label gives no REI/PHI counts as covered on Label Data Quality

**Decision (Mason, in chat 2026-11-24: "yes, ticked products count as covered"; issue #2500):** on the Label Data Quality coverage report, a product ticked "Label gives no REI" (or PHI) counts as covered for that interval, the same as a product with a number.
**Why:** the product page already stops showing "Incomplete setup" for a ticked product; the report should agree, so its gap count shows only products that truly need work.
**What this implies:** the report never counts a blank, unticked interval as covered, and never treats a tick as 0.
