## 2026-10-31 - Refuse unexpected payment function drift

- The unapplied payment-date migration checks the existing function's signature, overload count, body, owner, exact grants, `SECURITY DEFINER`, `search_path`, volatility, strictness, parallel mode and argument defaults before replacement, refusing a mismatch observed by that check.
- The disposable proof exercises refusal for an extra overload, a changed prior body and drift in each of those settings. Production stays unchanged until the release gates and guarded apply complete.
- The check does not lock out another migration changing this same function between the check and replacement; coordinate and recheck overlapping applies before release.
