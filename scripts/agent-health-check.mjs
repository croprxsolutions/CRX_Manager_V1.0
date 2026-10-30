#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeEol } from "./normalize-eol.mjs";
// Named for its original test use, but the hazard is not test-specific: git exports
// repository-local GIT_* variables to hook children, and GIT_DIR outranks BOTH `cwd`
// and `-C <dir>`. Any check below that names a directory would otherwise silently
// report on whichever repository invoked the hook instead. Reusing the one scrub
// helper rather than hand-rolling a second variable list is deliberate — it asks git
// itself via `rev-parse --local-env-vars` and also strips the indexed GIT_CONFIG_KEY_n
// / GIT_CONFIG_VALUE_n payload, which an obvious hand-written denylist misses.
import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function check(status, name, note = "") {
  return { status, name, note };
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function checkFilesPresent(root, files) {
  return files.map((file) => (
    existsSync(path.join(root, file))
      ? check("PASS", file, "present")
      : check("FAIL", file, "missing")
  ));
}

export function compareSyncedFiles(root, pairs) {
  return pairs.map(([left, right]) => {
    const leftPath = path.join(root, left);
    const rightPath = path.join(root, right);
    if (!existsSync(leftPath) || !existsSync(rightPath)) {
      return check("FAIL", `${right} synced from ${left}`, "missing source or copy");
    }
    // Compare EOL-normalized, exactly as scripts/sync-agent-workflows.mjs does.
    // A raw byte compare here disagreed with the generator on CRLF-smudged
    // checkouts; see scripts/normalize-eol.mjs for why that is a false FAIL.
    const matches = normalizeEol(readFileSync(leftPath, "utf8")) === normalizeEol(readFileSync(rightPath, "utf8"));
    return matches
      ? check("PASS", `${right} synced from ${left}`)
      : check("FAIL", `${right} synced from ${left}`, "run node scripts/sync-agent-workflows.mjs --write");
  });
}

export function checkCodexHookPortability(hooksJson) {
  const commands = Object.values(hooksJson?.hooks || {})
    .flatMap((entries) => entries || [])
    .flatMap((entry) => entry.hooks || [])
    .filter((hook) => hook.type === "command");
  if (commands.length === 0) return check("FAIL", ".codex/hooks.json portability", "no command hooks registered");
  const serialized = JSON.stringify(hooksJson);
  if (serialized.includes("C:\\CRX_Manager")) return check("FAIL", ".codex/hooks.json portability", "hard-coded C:\\CRX_Manager path found");
  if (commands.some((hook) => !hook.command || !hook.commandWindows)) return check("FAIL", ".codex/hooks.json portability", "each command hook needs command and commandWindows");
  if (serialized.includes("sync-from-claude.ps1")) return check("FAIL", ".codex/hooks.json portability", "SessionStart must not rewrite tracked hooks");
  if (!serialized.includes(".claude/hooks/sql-safety.mjs") ||
      !serialized.includes("production-action-guard.mjs") ||
      !serialized.includes("review-proof-guard.mjs")) {
    return check("FAIL", ".codex/hooks.json portability", "shared hook source or production guard missing");
  }
  return check("PASS", ".codex/hooks.json portability", `${commands.length} worktree-aware command hooks`);
}

export function checkBranchStaleness(runner) {
  try {
    const output = runner
      ? runner()
      : execFileSync("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          // Same class as checkGitHooksInstalled: an inherited GIT_DIR outranks cwd, so
          // from a hook this would report the calling worktree's staleness as ROOT's.
          // Benign (it only downgrades to WARN) but wrong, and fixing one instance of a
          // defect class while leaving its sibling is how the class survives.
          env: scratchHookEnvironment(ROOT),
        });
    const [behind, ahead] = String(output).trim().split(/\s+/).map(Number);
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) throw new Error("unexpected rev-list output");
    if (behind > 0) return check("WARN", "Branch freshness", `${behind} commit(s) behind origin/main; ${ahead} ahead`);
    return check("PASS", "Branch freshness", `current with origin/main; ${ahead} ahead`);
  } catch (error) {
    return check("WARN", "Branch freshness", `could not compare origin/main: ${error.message}`);
  }
}

function runCommand(name, command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: options.timeout || 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && options.shell !== false,
    }).trim();
    return check("PASS", name, output.split(/\r?\n/)[0] || "ok");
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message || "").trim().split(/\r?\n/)[0];
    return check(options.warn ? "WARN" : "FAIL", name, message || "not available");
  }
}

export function resolveNewestCodexBinary() {
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "OpenAI",
    "Codex",
    "bin",
  );
  try {
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate));
    dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function checkCodexCli() {
  const codex = resolveNewestCodexBinary();
  if (!codex) {
    return check("FAIL", "Codex CLI", "newest OpenAI Codex binary not found");
  }
  return runCommand("Codex CLI", codex, ["--version"], { shell: false, warn: false });
}

// Run a CLI status command and capture its outcome. Returns {ok, stdout, stderr};
// `ok` reflects exit 0. Uses spawnSync (not execFileSync) so BOTH streams are captured
// regardless of exit — `codex login status` prints "Logged in" to stderr while signalling
// success via exit code 0, so a stdout-only capture would miss it.
function runStatus(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: options.timeout || 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && options.shell !== false,
  });
  return {
    ok: res.status === 0 && !res.error,
    stdout: String(res.stdout || ""),
    stderr: String(res.stderr || res.error?.message || ""),
  };
}

// `--version` passes even when the CLI is logged out — but the whole headless
// review toolkit (codex-review / codex-gauntlet) silently fails without auth.
// Delegate to `codex login status` (the authoritative check the review command itself
// relies on): it honors CODEX_HOME, rejects malformed/expired tokens, and is exit-coded —
// far more robust than inspecting auth.json's shape ourselves. `runner` is injectable for tests.
export function checkCodexAuth(runner) {
  const run = runner || (() => {
    const codex = resolveNewestCodexBinary();
    if (!codex) return { ok: false, stdout: "", stderr: "newest OpenAI Codex binary not found" };
    return runStatus(codex, ["login", "status"], { shell: false });
  });
  const r = run();
  // Exit 0 is the authoritative "logged in" signal (codex prints "Logged in…" to stderr).
  if (r.ok) {
    return check("PASS", "Codex CLI auth", ((r.stdout || r.stderr).split(/\r?\n/).find(Boolean) || "logged in").trim());
  }
  const note = (r.stderr || r.stdout || "not logged in").split(/\r?\n/).find(Boolean) || "not logged in";
  return check("FAIL", "Codex CLI auth", `${note.trim()} — run \`codex login\``);
}

const APP_SERVER_TIMEOUT_MS = 15_000;
const APP_SERVER_OUTPUT_LIMIT = 4 * 1024 * 1024;

// Ask the Codex app server which hooks it would really run for `cwd`. Only two requests
// are sent, `initialize` and `hooks/list`: neither changes config or trust, and neither
// calls a model. The initialize result carries account paths, so nothing from it is
// kept, and server error text is reduced to its numeric code before it can be printed.
//
// stdin stays open until the answer arrives: the server drops a pending request at EOF.
// Every way out goes through finish(), which ends only the child started here.
export function probeCodexHooks(cwd, {
  codex = resolveNewestCodexBinary(),
  spawnChild = spawn,
  timeoutMs = APP_SERVER_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    if (!codex) {
      resolve({ error: "newest OpenAI Codex binary not found" });
      return;
    }
    let child;
    let timer;
    let settled = false;
    let pending = "";
    let received = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin?.end();
      child?.kill();
      resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const handle = (message) => {
      if (message?.id !== 1 && message?.id !== 2) return;
      if (message.error) {
        const code = Number.isInteger(message.error.code) ? message.error.code : "unknown";
        finish({ error: `${message.id === 1 ? "initialize" : "hooks/list"} returned error code ${code}` });
      } else if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
      } else {
        const entry = message.result?.data?.find((item) => typeof item?.cwd === "string"
          && path.resolve(item.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
        finish(Array.isArray(entry?.hooks) ? { entry } : { error: "hooks/list answer had no hook list" });
      }
    };
    timer = setTimeout(() => finish({ error: `no answer from codex app-server within ${timeoutMs / 1000}s` }), timeoutMs);
    try {
      child = spawnChild(codex, ["app-server"], {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: scratchHookEnvironment(cwd),
      });
    } catch {
      finish({ error: "codex app-server could not start" });
      return;
    }
    child.on("error", () => finish({ error: "codex app-server could not start" }));
    child.on("exit", () => finish({ error: "codex app-server exited before answering" }));
    child.stdin.on("error", () => finish({ error: "codex app-server closed its input before answering" }));
    child.stdout.on("data", (chunk) => {
      received += chunk.length;
      if (received > APP_SERVER_OUTPUT_LIMIT) {
        finish({ error: "codex app-server sent more output than a hook list needs" });
        return;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // The server also logs here; only a matching response id is an answer.
        }
        handle(message);
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "crx-agent-health", version: "1" }, capabilities: { experimentalApi: true } },
    });
  });
}

// One line per hook .codex/hooks.json registers, as the live list names it.
function requiredCodexHooks(hooksJson) {
  return Object.entries(hooksJson?.hooks || {}).flatMap(([event, groups]) =>
    (groups || []).flatMap((group) => (group.hooks || [])
      .filter((hook) => hook.type === "command")
      .map((hook) => ({
        eventName: `${event[0].toLowerCase()}${event.slice(1)}`,
        commands: [hook.command, hook.commandWindows],
        matcher: group.matcher,
        label: `${event} ${String(hook.command).match(/[\w.-]+\.mjs/g)?.pop() ?? "command"}`,
      }))));
}

const normalizedMatcher = (matcher) => matcher === undefined || matcher === null || matcher === "" ? "*" : matcher;

// A hook only protects anything if Codex would run it, and Codex silently skips a hook
// that is new, changed since it was trusted, or switched off. Comparing the manifest to
// the live list catches that; the manifest parity check above cannot.
//
// Codex CLI 0.165 answers for a linked worktree from the main checkout's hooks file, so
// a hook new on a branch reads as missing until it lands there and is trusted. That is
// the truth about what Codex would run in that worktree.
export function compareCodexHooks(hooksJson, entry) {
  if (!Array.isArray(entry?.hooks)) return check("FAIL", "Codex runtime hooks", "hooks/list answer had no hook list");
  const required = requiredCodexHooks(hooksJson);
  const project = entry.hooks.filter((hook) => hook.source === "project");
  const problems = { missing: [], disabled: [], untrusted: [] };
  for (const { eventName, commands, matcher, label } of required) {
    const live = project.filter((hook) => hook.eventName === eventName && commands.includes(hook.command)
      && normalizedMatcher(hook.matcher) === normalizedMatcher(matcher));
    if (live.length === 0) problems.missing.push(label);
    else if (!live.some((hook) => hook.enabled === true)) problems.disabled.push(label);
    else if (!live.some((hook) => hook.enabled === true && hook.trustStatus === "trusted")) problems.untrusted.push(label);
  }
  const globalStop = entry.hooks.filter((hook) => hook.source === "user" && hook.eventName === "stop"
    && String(hook.command).includes("global-verify-before-stop"));
  const globalStopRuns = globalStop.some((hook) => hook.enabled === true && hook.trustStatus === "trusted");
  const globalNote = globalStop.length === 0 ? "no global Stop verify hook"
    : globalStopRuns ? "global Stop verify hook active"
    : "global Stop verify hook installed but will not run";
  const reported = (entry.errors?.length ?? 0) + (entry.warnings?.length ?? 0);
  const found = Object.entries(problems)
    .filter(([, labels]) => labels.length > 0)
    .map(([problem, labels]) => `${problem}: ${labels.join(", ")}`);
  if (entry.errors?.length > 0) found.push(`${entry.errors.length} hook load error(s) reported by Codex`);
  const name = "Codex runtime hooks";
  if (required.length === 0) return check("FAIL", name, ".codex/hooks.json registers no command hooks to compare");
  if (found.length > 0) {
    return check("FAIL", name, `${required.length - problems.missing.length - problems.disabled.length - problems.untrusted.length}/${required.length} required hooks would run; ${found.join("; ")}; ${globalNote}. Open Codex in this project and trust the hooks; a worktree of an unmerged branch stays short until its hooks land.`);
  }
  // The generic global reminder and the project proof check have different guarantees.
  const status = reported > 0 || (globalStop.length > 0 && !globalStopRuns) ? "WARN" : "PASS";
  return check(status, name, `${required.length}/${required.length} required hooks enabled and trusted; ${globalNote}${reported > 0 ? `; ${reported} warning(s) from Codex` : ""}`);
}

export async function checkCodexRuntimeHooks(root, hooksJson, probe = probeCodexHooks) {
  try {
    const { entry, error } = await probe(root);
    return error
      ? check("FAIL", "Codex runtime hooks", `could not read the live hook list: ${error}`)
      : compareCodexHooks(hooksJson, entry);
  } catch {
    return check("FAIL", "Codex runtime hooks", "could not read the live hook list: runtime probe failed");
  }
}

// Delegate to `claude auth status` (machine-readable JSON: {"loggedIn":true,...}). It reads
// the keychain/credentials/env the CLI actually uses, so it can't be fooled by a malformed
// credentials file. Logged-out is a WARN, not FAIL: non-interactive `claude -p` (used by
// run-claude-review) can still auth via ANTHROPIC_API_KEY / apiKeyHelper even when the OAuth
// session shows logged out. `runner` is injectable for tests.
//
// Known limitation (documented follow-up): `auth status` proves *auth*, not the end-to-end
// review path — a stale/invalid env key could let `auth status` report logged-in while
// `claude -p` still fails at review time. The authoritative check is a live `claude -p`
// smoke; it's intentionally kept OUT of the default so an on-demand health check doesn't
// incur a billed model call on every run. Add an opt-in deep mode if that proof is needed.
export function checkClaudeAuth(runner) {
  const run = runner || (() => runStatus("claude", ["auth", "status"]));
  const r = run();
  if (!r.ok) {
    return check("WARN", "Claude CLI auth", "`claude auth status` unavailable (older CLI / not installed) — run `claude login` if reviews fail to auth");
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed?.loggedIn === true) {
      return check("PASS", "Claude CLI auth", parsed.authMethod ? `logged in (${parsed.authMethod})` : "logged in");
    }
    return check("WARN", "Claude CLI auth", "claude auth status reports logged out (env/apiKeyHelper auth may still work) — run `claude login` if reviews fail");
  } catch {
    return check("WARN", "Claude CLI auth", "could not parse `claude auth status` — run `claude login` if reviews fail to auth");
  }
}

// A checkout whose core.hooksPath resolves to a missing or foreign directory runs
// NO pre-commit/pre-push guard, and git says nothing when it skips them — the
// guards are simply absent. husky's generated .husky/_ is gitignored, so before
// 2026-08-31 every worktree created without `npm install` landed in exactly that
// state, and hand-set absolute overrides pointed several at other checkouts.
// The tracked .husky/ hooks are plain shell and need no husky runtime.
export function checkGitHooksInstalled(root, platform = process.platform) {
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      // Without this, an inherited GIT_DIR beats `-C root` and this reads the calling
      // repository's core.hooksPath while the canonical comparison below still expects
      // root/.husky — so a correctly-installed fixture or worktree reports FAIL.
      env: scratchHookEnvironment(root),
    }).trim();
  } catch {
    hooksPath = "";
  }
  if (!hooksPath) {
    return check("FAIL", "Git hooks installed", "core.hooksPath is unset — commit/push guards do not run; set it to .husky");
  }
  // git runs hooks from the top of the working tree, so a relative hooksPath
  // resolves per-worktree. That is what makes one shared value correct everywhere.
  //
  // This is an ALLOWLIST of exactly one directory, not a containment test. A
  // containment test is not enough here for two independent reasons:
  //   * linked worktrees live UNDER the main checkout (.claude/worktrees/<name>),
  //     so an absolute path into another worktree's .husky is "contained" while
  //     still running that other branch's guards; and
  //   * any other in-worktree directory holding two executable files would pass
  //     while git bypassed the tracked .husky entirely.
  // Comparison is on CANONICAL paths because git executes the target of a symlink,
  // so a linked .husky would satisfy a purely textual test. Anything that is not
  // this worktree's own tracked .husky fails closed — an unanticipated spelling is
  // then a false alarm, never a hole.
  const canonical = (target) => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  // The expected path canonicalizes the ROOT but keeps `.husky` literal, while the
  // configured path is canonicalized whole. Canonicalizing both sides would defeat
  // the test: if `.husky` were itself a link into another checkout, both sides would
  // resolve to that same foreign directory and compare equal.
  const expected = path.join(canonical(root), ".husky");
  const resolved = canonical(path.resolve(root, hooksPath));
  // path.relative is case-insensitive on win32, which is what we want for a
  // same-directory test on this repository's primary platform.
  if (path.relative(expected, resolved) !== "") {
    return check("FAIL", "Git hooks installed", `core.hooksPath is ${hooksPath}, which resolves to ${resolved} rather than this worktree's tracked .husky (${expected}) — git would run another checkout's guards or none at all; set core.hooksPath to .husky`);
  }
  const required = ["pre-commit", "pre-push"];
  const missing = required.filter((hook) => !existsSync(path.join(resolved, hook)));
  if (missing.length > 0) {
    return check("FAIL", "Git hooks installed", `${hooksPath} is missing ${missing.join(", ")} — those guards silently do not run; set core.hooksPath to .husky`);
  }
  const escaping = required.filter((hook) => {
    const relative = path.relative(expected, canonical(path.join(resolved, hook)));
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  if (escaping.length > 0) {
    return check("FAIL", "Git hooks installed", `${hooksPath} links ${escaping.join(", ")} outside this worktree — git runs the symlink target, so another checkout's guard would run`);
  }
  // Same silent skip, different spelling: on POSIX git ignores a hook that is not
  // executable. Windows has no executable bit, and Git for Windows does not consult
  // one, so the question is only meaningful off win32 — CI is where it can bite.
  if (platform !== "win32") {
    const notExecutable = required.filter((hook) => {
      try {
        accessSync(path.join(resolved, hook), fsConstants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
    if (notExecutable.length > 0) {
      return check("FAIL", "Git hooks installed", `${hooksPath} has non-executable ${notExecutable.join(", ")} — git skips a non-executable hook in silence; restore the mode with git update-index --chmod=+x`);
    }
  }
  return check("PASS", "Git hooks installed", `${hooksPath} (pre-commit, pre-push)`);
}

function checkSessionStaleness() {
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT, ".claude", "hooks", "session-staleness.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    }).trim();
    if (!output) return check("PASS", "Session staleness", "no warnings");
    const parsed = JSON.parse(output);
    const extra = parsed?.hookSpecificOutput?.additionalContext || "";
    if (!extra) return check("PASS", "Session staleness", "no warnings");
    const first = extra.split(/\r?\n/).find((line) => line.includes("Schema registry") || line.includes("CLAUDE.md") || line.includes("uncommitted")) || "warnings present";
    return check("WARN", "Session staleness", first.replace(/^═══.*$/, "warnings present"));
  } catch (error) {
    return check("WARN", "Session staleness", String(error.message || "could not check"));
  }
}

export function summarizeChecks(checks) {
  const failed = checks.filter((item) => item.status === "FAIL");
  const warned = checks.filter((item) => item.status === "WARN");
  return {
    failed,
    warned,
    exitCode: failed.length > 0 ? 1 : 0,
  };
}

async function buildHealthChecks(root = ROOT) {
  const requiredFiles = [
    ".claude/commands/claude-review.md",
    ".claude/skills/claude-review/SKILL.md",
    ".agents/skills/claude-review/SKILL.md",
    ".claude/commands/agent-pair-review.md",
    ".claude/skills/agent-pair-review/SKILL.md",
    ".agents/skills/agent-pair-review/SKILL.md",
    ".claude/commands/agent-health.md",
    ".claude/skills/agent-health/SKILL.md",
    ".agents/skills/agent-health/SKILL.md",
    ".claude/commands/agent-pr-comment.md",
    ".claude/skills/agent-pr-comment/SKILL.md",
    ".agents/skills/agent-pr-comment/SKILL.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/hooks/codex-hook-adapter.mjs",
    ".codex/hooks/production-action-guard.mjs",
    ".claude/hooks/review-proof-guard.mjs",
    "scripts/run-claude-review.mjs",
    "scripts/agent-health-check.mjs",
    "scripts/post-agent-review-to-pr.mjs",
    "scripts/check-agent-workflows.mjs",
    "scripts/check-agent-guidance.mjs",
    "scripts/sync-agent-workflows.mjs",
    "scripts/normalize-eol.mjs",
  ];

  const checks = [
    ...checkFilesPresent(root, requiredFiles),
    ...compareSyncedFiles(root, [
      [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"],
      [".claude/skills/agent-pair-review/SKILL.md", ".agents/skills/agent-pair-review/SKILL.md"],
      [".claude/skills/agent-health/SKILL.md", ".agents/skills/agent-health/SKILL.md"],
      [".claude/skills/agent-pr-comment/SKILL.md", ".agents/skills/agent-pr-comment/SKILL.md"],
    ]),
  ];

  const codexHooks = readJsonIfPresent(path.join(root, ".codex", "hooks.json"));
  checks.push(checkCodexHookPortability(codexHooks));
  checks.push(checkGitHooksInstalled(root));
  checks.push(runCommand("Agent workflow sync", process.execPath, [path.join(ROOT, "scripts", "sync-agent-workflows.mjs"), "--check"], { shell: false }));
  checks.push(runCommand("Agent guidance", process.execPath, [path.join(ROOT, "scripts", "check-agent-guidance.mjs")], { shell: false }));
  checks.push(checkBranchStaleness());
  checks.push(runCommand("Claude CLI", "claude", ["--version"], { warn: false }));
  checks.push(checkClaudeAuth());
  checks.push(checkCodexCli());
  checks.push(checkCodexAuth());
  checks.push(await checkCodexRuntimeHooks(root, codexHooks));
  checks.push(runCommand("GitHub auth", "gh", ["auth", "status"], { warn: true }));
  checks.push(runCommand("Vercel CLI", "vercel", ["--version"], { warn: true }));
  checks.push(runCommand("Supabase CLI", "supabase", ["--version"], { warn: true }));
  checks.push(checkSessionStaleness());

  return checks;
}

async function main() {
  const checks = await buildHealthChecks(ROOT);
  const summary = summarizeChecks(checks);

  console.log("agent-health-check");
  for (const item of checks) {
    console.log(`${item.status.padEnd(4)} ${item.name}${item.note ? ` - ${item.note}` : ""}`);
  }
  if (summary.failed.length > 0) {
    console.log(`FAIL - ${summary.failed.length} required check(s) failed.`);
  } else if (summary.warned.length > 0) {
    console.log(`PASS with ${summary.warned.length} warning(s).`);
  } else {
    console.log("PASS - agent collaboration health is clean.");
  }
  process.exit(summary.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
