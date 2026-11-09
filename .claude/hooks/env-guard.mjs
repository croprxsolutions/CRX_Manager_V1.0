#!/usr/bin/env node
// Env file & service_role key guard for CRX Manager.
// Blocks two classes of mistake:
//   1. Writing/editing any .env* file via Claude (forces Mason to do it manually
//      so secrets aren't echoed back through model context or transcripts).
//   2. Pasting a SUPABASE_SERVICE_ROLE_KEY value (or any "service_role" literal)
//      into ANY file under src/ — service_role must NEVER ship to the frontend.
//
// Rules match the existing hook style: fail-open if no content visible.
// For an Edit the content judged is the FULL post-edit file (spliced from disk).

import { readFileSync } from "node:fs";
import { judgedContent } from "./edit-splice-lib.mjs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    // No objection prints nothing ("allow" would pre-approve the call and skip the
    // normal permission prompt).
    : null;
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath) out("allow");

// RULE 1 — block any .env* file edit
// Allow .env.example (template, no secrets) and any *.md file mentioning .env in its name.
const basename = filePath.split("/").pop() || "";
const isEnvFile = /^\.env(\.|$)/.test(basename);
const isExample = /\.example$/.test(basename) || /\.template$/.test(basename) || /\.sample$/.test(basename);

if (isEnvFile && !isExample) {
  out("block",
    `ENV GUARD: Refusing to write/edit ${basename}. Env files contain secrets (Supabase service_role, ` +
    `Resend API key, etc.) that must never pass through model context. Mason: edit this file yourself ` +
    `in your editor. To bypass for a legitimate reason, rename target to .env.example first.`);
}

// RULE 2 — block service_role literals in frontend code
const content = judgedContent(filePath, payload?.tool_input);
if (!content) out("allow");

// Anchored at a path-segment boundary so a repo-relative `src/lib/x.ts` counts; case-insensitive
// because Windows paths are.
const inSrc = /(?:^|\/)src\//i.test(filePath);
const isFrontendFile = inSrc && /\.(ts|tsx|js|jsx)$/i.test(filePath);
// Test files never ship to the browser, and several assert database grants by quoting the role.
const isTestFile = /\.test\.(ts|tsx)$/i.test(filePath);

if (isFrontendFile) {
  // Every scan judges the raw text, comments included: a comment that names the key or quotes
  // the role is refused, and the author rewords it.
  const violations = [];

  if (/SUPABASE_SERVICE_ROLE_KEY/.test(content)) {
    violations.push("SUPABASE_SERVICE_ROLE_KEY referenced in a src/ file (comments count too; reword a comment that names it).");
  }
  // eyJ... is the JWT prefix all Supabase keys share; flag a long literal that looks like one.
  // Anon keys are also eyJ... but a long literal in source is suspicious regardless — use env vars.
  if (/['"`]eyJ[A-Za-z0-9_-]{40,}['"`]/.test(content)) {
    violations.push("Hard-coded JWT-shaped literal (eyJ...) in source — keys must come from import.meta.env.");
  }
  if (!isTestFile && /['"`]service_role['"`]/.test(content)) {
    violations.push("'service_role' string literal in src/ — this role belongs only in Edge Functions (a comment quoting it is refused too; reword it).");
  }

  if (violations.length > 0) {
    out("block",
      "ENV GUARD: " + violations.join(" | ") +
      " CRX Manager rule: service_role NEVER leaves Edge Functions. Frontend uses anon key only, " +
      "read from import.meta.env.VITE_SUPABASE_ANON_KEY.");
  }
}

out("allow");
