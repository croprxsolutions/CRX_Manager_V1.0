## 2026-11-23 — Sol skip carries forward when Sol repeats the same finding

**Decision (Mason, 2026-11-23):** when Sol flags again, on a later head of the same PR, a finding Mason already skipped through the hook flow, and Sol itself labels every finding `SAME_AS_ACCEPTED`, the skip carries forward automatically instead of asking him again.
**Why:** PR #2267 asked Mason three times to skip the same issue. "this doesnt need to be loctite."
**What this forbids/implies:**
- The carry needs: same PR, same file, the PR's own change in that file unchanged, severity not raised, a root skip at most 7 days old given by Mason through `owner-accept-sol-finding.mjs`, and a `staging` base. Any `NEW` finding, a missing label or summary, or a release/hotfix PR with gate files refuses the carry and asks Mason as before.
- A run Sol marks all-repeat is never put to Mason; the skip request refuses it ("Yes, never ask").
- Codex's merge guard never lands a carried skip; it hands the merge to Claude ("Yes, hand to Claude"). A live migration apply never accepts a carried skip.
- Accepted risk ("Yes, accept and open"): the saved root proof file is trusted without re-reading Mason's chat reply, the same trust as today's skip. Sol may also mislabel a new issue as "same"; the file/diff/severity checks limit that, they do not remove it.
- This partly reverses the 2026-11-22 PR #2226 rule that skipped findings never carry: they still never carry onto a newer base, but now carry across heads of the same PR on staging.
- This PR opens as a draft without a clean Sol round 4; Mason or Taha merges it by hand.
