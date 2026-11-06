// Whether Mason may be asked to approve a parked migration yet (scripts/owner-approve-migration.mjs).
import { pullRequestChecksGreen } from "../../.claude/hooks/codex-push-lib.mjs";

/**
 * Why Mason must not be asked yet, or null. The request is bound to an open PR into main at
 * this exact head, and the apply gate also refuses until every check is green; asking while
 * checks ran let a peer's newer stamp go live first and voided his approval (PR #1495,
 * 2026-11-05). `pr` is `gh pr view --json number,state,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup`.
 */
export function approvalPullRequestProblem(pr, head) {
  const number = `#${pr?.number ?? "?"}`;
  if (String(pr?.state).toUpperCase() !== "OPEN" || String(pr?.baseRefName) !== "main" || String(pr?.headRefOid).toLowerCase() !== String(head).toLowerCase()) {
    return `pull request ${number} must be open against main with head ${String(head).slice(0, 12)} ` +
      `(GitHub: state ${pr?.state}, base ${pr?.baseRefName}, head ${String(pr?.headRefOid || "?").slice(0, 12)}). Push first.`;
  }
  if (!pullRequestChecksGreen(pr)) {
    return `pull request ${number} is not merge-ready yet (mergeStateStatus ${pr?.mergeStateStatus ?? "?"}; every check must be green). ` +
      `The apply gate refuses until it is, so wait for the checks and ask Mason only then.`;
  }
  return null;
}
