// Owner hold: a PR whose title carries [HOLD FOR MASON] must not land until Mason's approval is verified.
// Pure (no gh, no I/O) so the merge gate and later readiness checks share one rule.

const HOLD_MARKER = /\[HOLD FOR MASON\]/i;

// Returns a plain-English refusal reason, or null when the owner hold does not block.
// GitHub always returns a title, so an absent one is unreadable state: fail closed on every base.
export function ownerHoldProblem({ title } = {}) {
  if (typeof title !== "string") {
    return "GitHub did not return this pull request's title, so the owner-hold marker could not be checked (fail closed).";
  }
  if (HOLD_MARKER.test(title)) {
    return "this PR's title carries [HOLD FOR MASON], so it is held for Mason. Verify his approval in this conversation " +
      "covers the CURRENT exact head commit, then clear the title marker through the existing policy and retry. " +
      "Approval for an earlier commit does not carry over.";
  }
  return null;
}
