## 2026-10-30 - Align invoice-cap guidance and remove the retired invoice path

- Updated delivery cancellation requirements to the owner's invoice-first decision and removed the repeated PR-specific known-issues header.
- Removed the unreachable single-invoice branch and pre-delivery warning from Order Detail. The visible split-invoice action retains its allocation freshness checks, retry key, RPC result validation, and error handling.
- Regenerated the workflow map so it no longer draws the retired Order Detail invoice call.
- Updated the source guards to check the retained split action's verified-result-before-key-reset ordering and to reject reintroducing the retired single-invoice call.
- Kept pre-change verification local; the committed prover exercises the candidate safeguards after installation.
