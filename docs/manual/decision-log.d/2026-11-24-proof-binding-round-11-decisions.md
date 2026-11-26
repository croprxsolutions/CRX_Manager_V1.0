## 2026-11-24 — Proof binding: leftover signature images and when the binding becomes required

**Decision (Mason, 2026-11-24, relayed word for word from his session: "i approve both recommended"):**
1. **Leftover signature images (Sol r11 MED 5 on #2324).** The screens catch the usual refusals before the signature image is uploaded (every amount under 0.01; products or delivered amounts changed since signing). The rare race that still leaves an unlinked image in private storage is listed as a known issue; no deletion job.
2. **Binding required in the same release.** A third small PR, merged right after the proof-binding screen PR and shipped in the same release, refuses a fresh signature or paper-ticket completion that carries no binding (including ticket photos saved before the release). This replaces the 2026-11-23 "one week after the screen PR" answer (contract decision 2).
**Why:** the live app is not in real use yet, so no old app copies or queued offline completions need a grace period; requiring the binding from day one closes Sol r11 HIGHs 1 and 2 for every caller.
**What this forbids/implies:** no automatic deletion of signature images without a new decision; the release that carries the screen PR must also carry the "required" migration. Contract: `docs/plans/2026-11-23-proof-bound-to-load-CONTRACT.md` (Round 3).
