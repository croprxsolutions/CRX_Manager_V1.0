## 2026-11-23 — #2248 (KI-144): ship the name-matched vendor link as is

**Decision (Mason, 2026-11-23, "Ship as is"):** PR #2248 ships with the purchase-order vendor link set from the vendor name typed on the PO, as it is now. Rare name-matching cases are accepted until #2279 has the PO screen pick the vendor from the vendor list and save its id: two saves at the same moment on the same name, spacing-only differences in a name, and a vendor taking another vendor's old name.
**Why:** Live has no vendor bills tied to purchase orders, so these cases have close to no real exposure today, while each fix to the name matching added new rare cases. Picking the vendor on the screen (#2279) removes name matching altogether.
**What this forbids/implies:** No more changes to the name-matching rules in #2248. The lasting fix is #2279; until then an affected PO is corrected by editing its vendor text.
