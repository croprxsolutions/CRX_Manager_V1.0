#!/usr/bin/env node
// PostToolUse migration reminder.
// Reads the actual file path from the tool payload — no hallucinated filenames.
//
// The full checklist is shown once per migration file per session; later edits
// of the same file get a one-line pointer back to it (Mason, 2026-10-29: the
// eight steps were repeated on every edit). Any doubt about the record — no
// session id, an unreadable or unwritable state file — shows the full list.
// The record is written only AFTER the reminder is emitted, so a crash in
// between repeats the checklist rather than losing it (Luna, PR #1193).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let payload;
try {
  payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const fp = (payload?.tool_input?.file_path || payload?.tool_response?.filePath || "").replace(/\\/g, "/");
if (!/supabase\/migrations\/.+\.sql$/.test(fp)) {
  process.exit(0);
}

const filename = path.posix.basename(fp);
// The record keys on the file's full path as given, so two files with one
// basename in different folders are not confused (Luna, PR #1193).
const fileKey = fp;

// Where this session's record lives, or null when it cannot be named safely.
// Only a plain session id names a state file.
function recordPath() {
  try {
    const sessionId = payload?.session_id;
    if (typeof sessionId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(sessionId)) return null;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
    if (typeof projectDir !== "string" || !projectDir) return null;
    return path.join(projectDir, ".claude", "session-state", `migration-reminder-${sessionId.toLowerCase()}.json`);
  } catch {
    return null;
  }
}

function readSeen(file) {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.files) ? parsed.files.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

const record = recordPath();
const seen = readSeen(record);
const alreadyReminded = seen.includes(fileKey);

const reason = alreadyReminded
  ? `MIGRATION SAFETY CHECK — ${filename} edited again. The full checklist shown on its first edit this session still applies: types, typecheck, the parallel reviewers before any apply, and the DB invariant sweeps after it.`
  : `MIGRATION SAFETY CHECK — You just created/edited ${filename}.

Before continuing, you MUST:
1. Update src/types/index.ts to match any schema changes
2. Check whether existing components need updates for the new/changed columns
3. Run \`npm run typecheck\` to verify everything compiles
4. BEFORE suggesting \`apply_migration\` to Mason, dispatch in PARALLEL (single message, multiple Agent calls):
   - Agent: rls-security-reviewer  (scope: this migration)
   - Agent: migration-drift-reviewer (scope: this migration)
   - Agent: typescript-types-drift-reviewer (if types were updated)
5. If any subagent returns BLOCKER findings, fix them before suggesting apply_migration.
6. If Mason is non-technical (which he is), also offer to run /explain-migration so he understands what's about to change live.
7. If this migration changes an RPC signature, a status/CHECK enum, or a table, offer to run /map-drift-audit AFTER it's applied — it reconciles the app-workflow-map against the live DB and catches app-wide drift (missing/renamed RPCs, UI statuses the new CHECK would now reject) that the per-migration reviewers don't look for.
8. AFTER the migration is applied to live, run the DB invariant sweeps:
   Run this in Bash: node scripts/db-invariant-sweeps/run-sweeps.mjs
   It prints SQL queries — execute each one via Supabase MCP execute_sql on project rhyzpcqhnizqbxphqdkr.
   Each query should return ZERO rows. Any rows = a security or schema problem to fix before the next session.
   (Sweeps check: ungated SECDEF mutators, actor-forgery, missing search_path, overloads, anon-exec SECDEF.)

Do NOT proceed to other tasks until these steps are complete.`;

// Context, not `decision: "block"`: a PostToolUse block cannot undo the edit, it
// only rendered as a "blocking error" (109 times in 14 days before 2026-10-02).
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason },
}));

if (record && !alreadyReminded) {
  try {
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ files: [...seen, fileKey] }));
  } catch { /* cannot record: the full list shows again next time */ }
}
