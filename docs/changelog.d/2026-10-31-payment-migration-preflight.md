## 2026-10-31 - Refuse unexpected payment function drift

- The unapplied payment-date migration checks the existing function's signature, overload count and body before replacement, refusing a mismatch observed by that check.
- The disposable proof exercises refusal for an extra overload and a changed prior body. Production stays unchanged until the release gates and guarded apply complete.
- The check does not lock out another migration changing this same function between the check and replacement; coordinate and recheck overlapping applies before release.
