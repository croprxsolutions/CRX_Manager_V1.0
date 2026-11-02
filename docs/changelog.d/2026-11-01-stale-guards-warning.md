## 2026-11-01 - Warn when a session's guards load from a stale folder

- `session-context-reminder.mjs` now adds one line at session start when its own checkout is not the session's folder and that checkout's `.claude/hooks` or `.claude/skills` differ from `origin/main`. It warns and never blocks.
- Why: a side session's hooks can load from the folder its parent started in. On 2026-11-01 a session's merge guard ran from `C:\CRX_harness_parity`, which was behind `main`, and enforced a Sol rule replaced days earlier. Nothing showed the session where its guards came from.
- It compares file contents rather than counting commits behind, so a folder that is behind only on app code stays quiet. It does not fetch, so it uses that folder's last known `origin/main`, and each git call has a one-second limit so all three fit Codex's five-second hook limit. If git fails, the warning is skipped and the normal reminder still appears.
- Proof: the hook's test builds two throwaway repositories and covers all four cases: another folder with old guards warns; the session's own folder, a bad folder and another folder with current guards stay quiet. With the warning switched off the test fails, and with it on the test passes.
- Not covered: the check lives in the folder it inspects, so a folder older than this change cannot warn until it is moved onto `main` once.
