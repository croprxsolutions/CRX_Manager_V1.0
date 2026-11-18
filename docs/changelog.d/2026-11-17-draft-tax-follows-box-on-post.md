## 2026-11-17 — A draft can't post with sales tax that contradicts its sale's box

Migration `20270124140000_draft_tax_follows_box_on_post` (not applied; staging candidate). Fixes a Sol HIGH in the
unreleased billing work: a Bill Split payer's draft that the tax box couldn't update (it can't be re-saved) kept its
old tax and could still be posted. Posting such a draft is now refused with `SALES_TAX_BOX_MISMATCH`; the office
switches the box over and back (ending where they want it), which fixes the drafts it can re-save; a locked split
draft keeps its tax through that, so the office sets the box back to match it, or voids and redrafts the group. The order page's toast and the plain error message say so.
Luna rounds 1-2 fixes: soft-deleted drafts are checked too; the preflight requires the stale-line guard to call its own function; the error offers setting the box back as well as void and redraft.
