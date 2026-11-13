## 2026-11-13 - Prepare confirmation of reviewed typed delivery brands

Follow-up #1846: saving brands with no edits includes lines containing a typed brand the office has linked or dismissed. The screen sends only the existing typed identity/amount payload and the event version; review authority stays on the server. Empty-pick lines remain unconfirmed. Existing reason, quantity, stale-save and retry checks remain.

Requires database candidate `20270109110000_priority_integrity_followups.sql` first. That change preserves the office review and original entry when identity is unchanged, even if only quantity changes, per Mason's 2026-11-13 choice. This app unit must remain unmerged until that behavior is available in its target environment. No migration, deployment or live-data action is included here.

Observed proof: 600 test files and 8,244 tests passed, 123 skipped; both linked and dismissed review cases passed focused coverage. The real dialog with synthetic services submitted identity, quantity, reason, event version and key, showed its success receipt and closed without sending review metadata. Independent compliance is clean. Luna correctly holds delivery until the database prerequisite is applied, so no preview/PR or push was created for this dependent screen. It remains a local prepared unit owned by Codex.
