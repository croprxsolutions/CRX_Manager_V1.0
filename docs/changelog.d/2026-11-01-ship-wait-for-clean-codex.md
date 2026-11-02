## 2026-11-01 - An approved merge no longer sits idle after a clean Codex review

- `ship.md` Step 8 now has one background wait of up to 2 hours for the Codex App's result, used only when Mason has said to merge when ready. It reads Codex's summary comment and changes nothing.
- Why: Auto-fix wakes a session for failures, conflicts and comments, not for a clean result. On croprxsolutions/CRX_Manager_V1.0#1249 Mason said to merge when ready, Codex finished clean, and nothing moved for about 3 hours until he came back.
- No gate changes. When the wait ends, every merge check runs again, and merging is still pinned to the head. If it times out or the head changed, the session tells Mason to say "continue".
- Proof: the check matched Codex's real completed comment on #1249 and did not match the same comment with a wrong commit.
- Not covered: the full wait has not run on a live PR yet, so its first real use is its first full test.
