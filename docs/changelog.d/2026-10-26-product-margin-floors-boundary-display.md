## 2026-10-26 — Margin floor: a margin just under its floor never reads as the floor (To-Do 0.2)

CodeRabbit round 4 on PR #1102: on the Products list, a tier at 14.996% net under a 15% floor showed
"15.00% net · under 15% floor", because two-decimal rounding reached the floor. A flagged margin now
never rounds up to its floor ("14.99% net · under 15% floor"). The rule lives in
`formatNetMarginPercent` (`src/lib/marginFloors.ts`), with unit and page tests for the boundary.
Sol's final review found the same rounding on the product page's Margin Floor card warning ("Tier 2
is at 15.00% — under the 15% floor"); the card now uses the same helper and has its own test.
