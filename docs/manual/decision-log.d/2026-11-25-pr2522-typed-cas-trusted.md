## 2026-11-25 — A typed CAS is trusted when EPA gives none (#2522)

**Decision (Mason, 2026-11-25):** "Yes, trust it." When EPA gives no CAS for an ingredient, an admin's typed CAS is trusted on their reason and evidence, even on an EPA-numbered product. The check digit and the "CAS already used by another ingredient" check still apply.
**Why:** an ingredient the EPA lookup added without a CAS could never get one (the EPA gate refused every ingredient edit), so ten live ingredients stay unlinked. Trying to check a typed CAS against EPA lookup history kept leaving new gaps (Sol rounds 1–3 on #2522).
**What this forbids/implies:**
- #2522 lets a CAS-only edit pass the EPA gate only when it fills an EMPTY CAS.
- **Follow-up decision (Mason, 2026-11-25, "Fix it" on Sol round 5):** once set, a CAS is locked on an EPA-numbered product; an admin cannot change or clear it from the screen. A wrong CAS there needs a reviewed fix.
- Accepted risk: a mistyped but valid, unused CAS could make a later EPA import link to the wrong ingredient until it is fixed by a reviewed change.
- This approves the code path only. A CAS on a live ingredient is confirmed from a published source and needs Mason's separate yes.
