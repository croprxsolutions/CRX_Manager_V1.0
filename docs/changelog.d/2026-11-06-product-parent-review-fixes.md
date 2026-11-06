## 2026-11-06 — Product parents: fixes from Taha's review of the grouping proposal (PAR-2)

Migration `20261126100000_product_parent_review_fixes.sql`; it must be live before the PAR-2 screens PR turns grouping on. Four fixes, from Taha's review of PR #1555:

- **Strengths are never treated as sizes.** A proposal no longer suggests putting "UAN 28/0/0" and "UAN 32/0/0", "Imidacloprid 2 lb/gal" and "4 lb/gal", "Talstar 2 G" and "0.2 G", or "Starter 6/24/6" and "3/24/6" under one product. A group whose sizes have the same recorded container but different numbers in their names is held for review by hand.
- **No second parent for one product.** A suggested group whose EPA number and name match an existing product parent is held, and an approval is refused if such a parent was made after the proposal was built. Same EPA number under a different name is still only flagged.
- **Rejections stick.** Rebuilding a proposal keeps an earlier rejection (with its reason, who and when) while none of that group's sizes changed; if one changed, the group is suggested again with the earlier rejection named.
- **Moving a size keeps its brands honest.** Moving a size to another parent is refused while the two parents list different brands, so a size's brands never change silently; a parent left with no sizes now has its brands retired, each logged.

Proof: `scripts/smoke/prove-product-parent-review-fixes-real-schema.mjs`.
