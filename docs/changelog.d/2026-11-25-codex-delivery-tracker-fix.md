## 2026-11-25 - Correct the Codex delivery tracker and isolate the reminder test

The Codex delivery known issue now lists what is actually still open: Codex merge refusal, pre-push review checks, and the owner-hold check outside Claude's merge guard. The Opus wrapper's staging scope already shipped in #2508. The startup reminder test no longer fails when the calling shell sets `CRX_AGENT_SURFACE`.
