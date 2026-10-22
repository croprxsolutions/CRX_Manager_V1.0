## 2026-10-22 — Bulk PO import refuses a unit cost past two decimals instead of rounding it

**What changed.** When OCR reads a unit cost like `$10.006` off a vendor document, the admin's
review table in **Import POs from Documents** (`src/components/purchase-orders/BulkPOImport.tsx`)
now marks that cost box red with "Enter an amount with no more than two decimal places.", leaves the
PO out of the **Import N POs** count, and refuses to import it until the admin types an exact cost.
Before, the browser silently rounded it to whole cents (`$10.01`) and saved that. This follows Mason's
money rule: more than two decimals is refused, never rounded. It closes the deferred Luna finding
from PR #980; the rounding behavior itself predates #980.

**Unchanged.** A sales rep's import still sends no cost at all (purchase cost is admin-only since
#980), so a rep can import the same document and the line arrives flagged for an admin to confirm.
The PO detail cost editor already refused sub-cent input; no database change.

**Proof.** `src/components/purchase-orders/BulkPOImport.test.tsx` now proves an OCR cost of `3.334`
blocks the import (button reads **Import 0 POs**, input `aria-invalid`, no `save_purchase_order`
call), then saves `3.33` / `333` cents after the admin corrects it; a second test proves a rep's
import of the same document still goes through. The old test that asserted rounding was replaced.
