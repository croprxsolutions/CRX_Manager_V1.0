#!/usr/bin/env node

import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEol } from "./normalize-eol.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TARGET_ROOT = path.join(ROOT, ".agents");

function unix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

// A command file may open with a YAML frontmatter block (`model:` / `effort:`
// routing, per docs/reference/claude-model-tuning.md). Only a block at the very
// START of the file counts; a `---` rule further down is ordinary markdown.
const LEADING_FRONTMATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;

export function stripFrontmatter(markdown) {
  return markdown.replace(LEADING_FRONTMATTER_RE, "");
}

export function commandTitle(markdown, fallback) {
  // Frontmatter is metadata, not content: a YAML comment (`# ...`) inside the
  // block would otherwise match the H1 pattern and become the adapter's title.
  const withoutFrontmatter = stripFrontmatter(markdown);
  // A "# ..." line inside a ``` fence (e.g. a bash comment in an example) is not
  // a heading — strip fenced blocks before looking for the H1.
  const withoutFences = withoutFrontmatter.replace(/```[\s\S]*?```/g, "");
  const heading = withoutFences.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function buildExpected() {
  const expected = new Map();
  const skillsRoot = path.join(ROOT, ".claude", "skills");
  const skillNames = new Set();

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    skillNames.add(entry.name);
    const sourceRoot = path.join(skillsRoot, entry.name);
    for (const source of walkFiles(sourceRoot)) {
      const relativeWithinSkill = path.relative(sourceRoot, source);
      expected.set(unix(path.join("skills", entry.name, relativeWithinSkill)), readFileSync(source, "utf8"));
    }
  }

  const commandsRoot = path.join(ROOT, ".claude", "commands");
  for (const commandFile of readdirSync(commandsRoot).filter((name) => name.endsWith(".md")).sort()) {
    const name = commandFile.replace(/\.md$/, "");
    if (skillNames.has(name)) continue;
    const source = readFileSync(path.join(commandsRoot, commandFile), "utf8");
    const title = commandTitle(source, name);
    const description = `Use when the user asks for the CRX ${title} workflow; loads the canonical command from .claude/commands/${commandFile}.`;
    const adapter = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\nRead \`.claude/commands/${commandFile}\` from the active repository root completely and follow it as the source of truth.\n\nShared safety and approval rules remain in \`AGENTS.md\`.\n`;
    expected.set(`skills/${name}/SKILL.md`, adapter);
  }

  expected.set("README.md", `# Codex Agent Workflows\n\nThis directory is generated from \`.claude/skills/\` and \`.claude/commands/\`.\n\n- Edit the Claude source files.\n- Run \`node scripts/sync-agent-workflows.mjs --write\`.\n- Verify with \`node scripts/sync-agent-workflows.mjs --check\`.\n- Shared hook implementations stay in \`.claude/hooks/\`; Codex invokes them through \`.codex/hooks.json\`.\n`);

  const managed = [...expected.keys()].sort();
  expected.set(
    "generated-manifest.json",
    `${JSON.stringify({ version: MANIFEST_VERSION, managed }, null, 2)}\n`,
  );
  return expected;
}

// Bumped only when the manifest's shape changes. previousManifest() requires an
// EXACT match, so a manifest written by a newer or older generator reads as
// unavailable rather than being parsed on a guess.
const MANIFEST_VERSION = 1;

// The manifest records `managed`: the file list from the last --write. It is
// rewritten wholesale each time, so it describes the last sync and nothing older.
//
// It used to carry a second, DURABLE `ownedImporterDirs` field so that deleting a
// canonical `.claude` command named `source-command-*` could not make --check
// forget the directory had ever been ours. That field is gone (Mason's decision,
// 2026-09-03). Recovering it reliably meant reading the git index, HEAD, and every
// merge parent, and each provenance source added its own way of answering
// "I don't know" with the most permissive value - eight review findings across
// eight rounds, all in that layer, one of them introduced by the fix for the round
// before it. The exemption's real job is to stop imported adapters from blocking
// commits, and `managed` plus the staged-path check does that without a git
// archaeology layer.
//
// KNOWINGLY GIVEN UP: delete a canonical command whose name starts with
// `source-command-` while some other file remains in its mirror directory, and the
// survivor is classified as importer litter instead of drift. Nothing in .claude/
// is named that way today, and the cost is a stale instruction file sitting
// unreferenced under .agents/ - not wrong behavior in the app.
//
// `known` stays, because it costs nothing and guards the same trap in the one
// source that remains:
//
//   - NO manifest at all: a real answer. Nothing generated yet. `known: true`.
//   - a manifest that EXISTS but cannot be parsed: NOT an answer. `known: false`.
//   - a manifest that PARSES but is not the shape this writer emits (`[]`,
//     `"text"`, `{"managed":"invalid"}`, a `managed` holding non-strings): also
//     NOT an answer. Reading `parsed.managed` off those yields `undefined` or a
//     non-array, and answering that with an empty list is the fail-open shape
//     again - a corrupt manifest would read as a confident "nothing was managed"
//     and buy the importer exemption at exactly the moment the record is
//     unusable (CodeRabbit, PR #565). `known: false`, same as unparseable.
//
// Callers must fail closed on `known: false`.
export function previousManifest(targetRoot = TARGET_ROOT) {
  const file = path.join(targetRoot, "generated-manifest.json");
  if (!existsSync(file)) return { managed: [], known: true };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { managed: [], known: false };
  }
  // `hasOwn` on both keys, not a bare property read: with `Object.prototype.managed`
  // set anywhere in the process, `{"version":1}` would otherwise inherit an array and
  // read as an authoritative empty record (Codex, PR #565).
  const isPlainObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (
    !isPlainObject
    || !Object.hasOwn(parsed, "version") || parsed.version !== MANIFEST_VERSION
    || !Object.hasOwn(parsed, "managed") || !Array.isArray(parsed.managed)
    || !parsed.managed.every(isSafeManagedEntry)
  ) {
    return { managed: [], known: false };
  }
  return { managed: parsed.managed, known: true };
}

// Every `managed` entry is joined onto the target root and handed to rmSync() by
// --write, so "is it a string" is not a sufficient check: `../package.json` resolves
// out of .agents/ and deletes a repository file, and on Windows `..\.git\index` reaches
// the git index (Codex, PR #565). Entries are WRITTEN as unix relative paths, so demand
// exactly that shape - anything else means the record is not one this generator wrote.
function isSafeManagedEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (entry.includes("\\") || entry.includes("\0")) return false;
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) return false;
  return entry.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// KNOWINGLY GIVEN UP (Mason's call, 2026-09-03, round 12): this drops `known`, so
// --write cannot tell "the last sync generated nothing" from "the record is unusable".
// Both prune nothing, and --write then overwrites the manifest anyway. If the unusable
// manifest owned an adapter that is no longer generated, that file survives on disk while
// the only record naming it is erased, and every later --check reports it as drift with a
// `--write` remedy that cannot remove it (Codex, PR #565).
//
// Not fixed, deliberately. The stale-mirror behavior is PRE-EXISTING - the old reader
// answered a corrupt manifest with an empty list too, so it also pruned nothing. What the
// round-10 version check changed is only the SIZE of that set: a manifest from a different
// generator version, e.g. {"version":2,...}, used to be read and pruned and now reads as
// unavailable. Aborting the write instead is the wrong shape, because --write is the
// remedy an operator reaches for when the manifest is broken; refusing to run it there
// reads as a dead end unless the error also says "delete the file and re-run", which is a
// new failure mode in the function that had already produced eleven rounds of findings.
// Recovery today is the same one sentence: delete generated-manifest.json and re-run
// --write. See docs/manual/KNOWN_ISSUES.md.
function previousManagedFiles(targetRoot = TARGET_ROOT) {
  return previousManifest(targetRoot).managed;
}

// This check runs inside the pre-commit hook, where git exports its own
// repository redirects. They are NOT interchangeable, and the difference is a
// bug this file already shipped:
//
//   GIT_DIR / GIT_WORK_TREE are absolute and OUTRANK `-C ROOT`, so inheriting
//   them makes this helper inspect the hook's view instead of ROOT. Strip them.
//
//   GIT_INDEX_FILE is the opposite. It names the index git wants this hook to
//   inspect, and `git commit <paths>` / `git commit --only <paths>` build a
//   TEMPORARY index holding exactly the candidate tree and point it there.
//   Deleting it sent gitKnownTargetPaths() to the default index, so an importer
//   adapter staged by a partial commit was invisible to the staged-path guard
//   and rode into the candidate tree - reproduced by Codex on PR #565 with an
//   alternate index holding `skills/source-command-alt/SKILL.md`.
//
// Keep the candidate index, but only when it belongs to THIS repository. A
// foreign checkout's hooks can run against our worktree (core.hooksPath has
// pointed at another checkout on this machine), and honoring a stray
// GIT_INDEX_FILE would then have us read an unrelated repository's index.
// Anything outside our own git dir is discarded rather than trusted.
export function gitEnvironment(baseEnv = process.env, options = {}) {
  const { commonDir = null, cwd = process.cwd() } = options;
  const env = { ...baseEnv };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.MSYS_NO_PATHCONV = "1";
  if (!env.GIT_INDEX_FILE) return env;
  // `-C ROOT` would re-root a relative value against ROOT; git set it relative
  // to the cwd it invoked the hook from, so resolve it there first.
  const resolved = path.resolve(cwd, env.GIT_INDEX_FILE);
  const within =
    commonDir && !unix(path.relative(commonDir, resolved)).startsWith("..");
  if (within) env.GIT_INDEX_FILE = resolved;
  else delete env.GIT_INDEX_FILE;
  return env;
}

let cachedGitDir;
function ownGitDir() {
  if (cachedGitDir !== undefined) return cachedGitDir;
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.MSYS_NO_PATHCONV = "1";
  const result = spawnSync("git", ["-C", ROOT, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    env,
  });
  cachedGitDir =
    result.status === 0 && result.stdout ? path.resolve(result.stdout.trim()) : null;
  return cachedGitDir;
}

function git(args, checkout = ROOT) {
  const env = gitEnvironment(process.env, { commonDir: ownGitDir() });
  return spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", env });
}

export function writeExpected(expected, targetRoot = TARGET_ROOT) {
  const expectedNames = new Set(expected.keys());
  for (const stale of previousManagedFiles(targetRoot)) {
    if (expectedNames.has(stale)) continue;
    const target = path.join(targetRoot, stale);
    // A SECOND, independent containment check. previousManifest() already rejects a
    // manifest holding an escaping entry, but this line DELETES, and a delete does not
    // get to assume its caller validated.
    //
    // It is a LEXICAL check, and the earlier wording here ("does not resolve to a path
    // strictly inside targetRoot") over-claimed by implying realpath resolution. It does
    // not follow links: a junction or symlink AT `.agents/skills/demo` pointing outside
    // the tree passes this test and the delete goes through it (gpt-5.6-sol, pre-merge
    // review of PR #565 — recorded, not fixed; see docs/manual/KNOWN_ISSUES.md). What it
    // does catch is an entry whose PATH TEXT escapes, which is the manifest-supplied
    // case this pairs with.
    const within = path.relative(targetRoot, target);
    if (!within || within.startsWith("..") || path.isAbsolute(within)) continue;
    rmSync(target, { force: true });
  }
  for (const [relative, content] of expected) {
    const target = path.join(targetRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    // Write the LF form, then compare the target's RAW bytes against it. Skill and
    // command mirrors are byte copies of their .claude sources, so a CRLF-smudged
    // source used to make --write copy CRLF straight into .agents/**.
    //
    // Do NOT normalize the target before comparing. That was the first attempt at
    // this fix and it is a no-op on the case that matters: a CRLF mirror
    // normalizes to `canonical`, the write is skipped, and the file stays CRLF
    // while --write prints "Synced". Comparing raw is what makes the "run
    // --write" remedy the health check prints actually repair a smudged mirror.
    // It is still idempotent - an already-LF mirror equals `canonical` byte for
    // byte, so the common case writes nothing.
    // Compare BYTES, not decoded strings. Decoding maps any invalid UTF-8 byte to
    // U+FFFD, so a corrupt target could decode equal to canonical text containing
    // that character and be skipped - the same shape of bug as the CRLF one above,
    // where the comparison was looser than the write.
    const canonical = Buffer.from(normalizeEol(content), "utf8");
    if (!existsSync(target) || !readFileSync(target).equals(canonical)) {
      writeFileSync(target, canonical);
    }
  }
  console.log(`Synced ${expected.size - 2} Codex workflow file(s) from .claude.`);
}

// Compare adapter content IGNORING line endings. The generator emits LF and
// .gitattributes pins .agents/** to LF, but a checkout where core.autocrlf still
// rewrote a file to CRLF would otherwise report identical text as "stale" — a
// false failure that bricked commits in fresh worktrees (2026-07-16 scaffolding
// review). Line endings are not content drift; the committed form is LF-pinned
// regardless, so normalizing here tests what the check is FOR (real drift).
// `normalizeEol` is shared with scripts/agent-health-check.mjs: the two used to
// define "in sync" differently, so the same commit could FAIL one and PASS the
// other. Keep the single definition in scripts/normalize-eol.mjs.

// The Codex CLI's "Import from other apps" (`/import`) writes its own adapters
// into .agents/skills/ as `source-command-<name>/SKILL.md`. They are NOT ours and
// never can be: the importer rewrites the instruction text with a case-insensitive
// claude -> Codex substitution, so the copies point at a `.Codex/hooks/` path that
// does not exist. Nothing in this repo invokes them. There is no off-switch in the
// binary, and .gitignore cannot help because the sweep below reads the directory
// directly. Left unclassified they are 24 "not generated from .claude" failures
// that block EVERY commit in the checkout they land in (C:\CRX_Manager, 2026-08-31
// through 2026-09-02).
//
// Mason's 2026-09-02 decision: keep them VISIBLE, do not delete them. So they are
// reported on every run and excluded from the pass/fail verdict — foreign litter,
// not drift in a file we generate.
//
// Mason's 2026-10-30 approval changes what happens next: Codex discovers these
// beside the real skills, so the stale copies can be picked up. --archive-imported
// moves them out of the active directories into a verified archive; nothing here
// deletes them outright, and the same exemption below decides what may be moved.
//
// Classify by REGION, not by an enumeration of the 24 names: any path under a
// `skills/<importer-prefixed-dir>/` that this generator does not itself produce.
//
// Three narrowing conditions, each closing a hole Codex found on PR #565. The
// exemption applies ONLY to a directory that is
//
//   1. not currently generated  — a path in `expected` is filtered out upstream,
//      but that is not enough on its own: see (2);
//   2. not PREVIOUSLY generated — if `generated-manifest.json` ever owned a file
//      in that directory, the directory is ours. Without this, deleting a
//      canonical `.claude` command named `source-command-*` would drop its
//      mirror out of `expected`, this filter would then call the orphan
//      "importer litter", and stale instructions would survive `--check`. It
//      also fixes the sibling case: when `skills/source-command-demo/SKILL.md`
//      IS generated, a hand-added `manual.md` beside it stays drift, because
//      ownership is decided per DIRECTORY, not per file. "Previously" means the
//      manifest's `managed` list, which `--write` rewrites wholesale — so this
//      memory lasts until the next sync, not forever. Making it durable required
//      reconstructing ownership from the git index, HEAD and every merge parent,
//      and that layer produced a review finding every round without converging;
//      it was cut on 2026-09-03 (Mason's call). See previousManifest() for what
//      is knowingly given up;
//   3. not tracked or staged in git — the exemption is for untracked
//      working-tree litter. Once someone `git add -A`s the importer output it is
//      becoming part of the repo, and mangled instructions must fail the parity
//      check rather than ride in silently. This condition FAILS CLOSED: if git
//      cannot be consulted the tracking state is unknown, so no directory is
//      exempted at all and the litter is reported as ordinary drift. It used to
//      fail open — a git failure read as "nothing is tracked", which is the most
//      permissive possible answer and would have exempted staged adapters at
//      exactly the moment the check could no longer tell (CodeRabbit, PR #565).
//
// Together these keep the invariant the exemption could otherwise break:
// `.agents/` is generated solely from `.claude/`.
const FOREIGN_SKILL_DIR_RE = /^skills\/(source-command-[^/]+)\//;

function importerDirOf(relativePath) {
  return FOREIGN_SKILL_DIR_RE.exec(relativePath)?.[1] ?? null;
}

export function classifyExtras(extraRelativePaths, options = {}) {
  const {
    expectedKeys = [],
    previouslyManaged = [],
    trackedPaths = [],
    // Whether git could actually be consulted. False means "unknown", and an
    // unknown tracking state must never buy an exemption - see condition (3).
    trackingKnown = true,
  } = options;

  // Any directory this generator owns now, or owned at the last sync, is OURS.
  const ownedDirs = new Set();
  for (const key of [...expectedKeys, ...previouslyManaged]) {
    const dir = importerDirOf(key);
    if (dir) ownedDirs.add(dir);
  }
  const tracked = new Set(trackedPaths);

  const extras = [];
  const foreignDirs = new Set();
  for (const relative of extraRelativePaths) {
    const dir = importerDirOf(relative);
    if (dir && trackingKnown && !ownedDirs.has(dir) && !tracked.has(relative)) foreignDirs.add(dir);
    else extras.push(relative);
  }
  return { extras, foreignDirs: [...foreignDirs].sort() };
}

// Paths under .agents/ that git already knows about (tracked or staged), as
// TARGET_ROOT-relative unix paths, plus whether git could be consulted at all.
//
// `known: false` means the answer is UNKNOWN, not "nothing is tracked". Those
// are opposite defaults: the latter is the most permissive reading possible and
// would hand the exemption to every importer path precisely when the check can
// no longer tell whether they had been staged. Callers must fail closed on it.
//
// An empty result with `known: true` is a real answer - nothing is tracked yet -
// and still allows the exemption.
function gitKnownTargetPaths(targetRoot = TARGET_ROOT, checkout = ROOT) {
  const rel = unix(path.relative(checkout, targetRoot)) || ".agents";
  const out = new Set();
  let known = true;
  for (const args of [["ls-files", "-z", "--", rel], ["diff", "--cached", "--name-only", "-z", "--", rel]]) {
    const r = git(args, checkout);
    if (r.status !== 0) { known = false; continue; }
    if (!r.stdout) continue;
    for (const line of r.stdout.split("\0")) {
      if (!line) continue;
      const withinTarget = unix(path.relative(rel, line));
      if (withinTarget && !withinTarget.startsWith("..")) out.add(withinTarget);
    }
  }
  return { paths: [...out], known };
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Where `candidate` would really land: its nearest existing ancestor with links resolved,
// plus the part that does not exist yet.
function resolvedDestination(candidate) {
  let existing = candidate;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(realpathSync(existing), path.relative(existing, candidate));
}

// The plain files and folders under `dir`, and anything that is neither. A link is
// listed rather than followed: copying through one would archive a file from
// somewhere else, and the delete that follows must only ever see real folders.
function plainTree(dir) {
  const files = [];
  const dirs = [];
  const links = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = plainTree(full);
      files.push(...nested.files);
      dirs.push(full, ...nested.dirs);
      links.push(...nested.links);
    } else if (entry.isFile()) files.push(full);
    else links.push(full);
  }
  return { files, dirs, links };
}

const relativeDirs = (sourceRoot, dirs) => dirs.map((dir) => unix(path.relative(sourceRoot, dir))).sort();

// Choose which importer folders may move. The rule is the --check exemption
// (classifyExtras), so a folder this generator owns, a tracked or staged file, or an
// unknown tracking state keeps the folder in place. One tracked file holds back its
// whole folder: splitting a folder would leave half of it in the active directory.
function planImportedSkillArchive({ targetRoot, expectedKeys, trackedPaths, trackingKnown }) {
  const skillsRoot = path.join(targetRoot, "skills");
  const prior = previousManifest(targetRoot);
  const walked = new Map();
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!importerDirOf(`skills/${entry.name}/`)) continue;
    const dir = path.join(skillsRoot, entry.name);
    walked.set(entry.name, entry.isDirectory() ? plainTree(dir) : { files: [], dirs: [], links: [dir] });
  }
  const relativePaths = [...walked.values()].flatMap(({ files }) =>
    files.map((file) => unix(path.relative(targetRoot, file))));
  const { extras, foreignDirs } = classifyExtras(relativePaths, {
    expectedKeys,
    previouslyManaged: prior.managed,
    trackedPaths,
    trackingKnown: trackingKnown && prior.known,
  });
  // trackedPaths as well: a tracked file deleted from disk still marks its folder.
  const held = new Set([...extras, ...trackedPaths].map((relative) => relative.split("/")[1]));
  const move = [];
  const refused = [];
  for (const [name, { files, dirs, links }] of walked) {
    if (links.length > 0) refused.push({ name, reason: "it is, or contains, a link or special file" });
    else if (files.length === 0) refused.push({ name, reason: "it holds no files" });
    else if (!trackingKnown || !prior.known) refused.push({ name, reason: "git or generated-manifest.json could not say who owns it" });
    else if (held.has(name) || !foreignDirs.includes(name)) refused.push({ name, reason: "it is tracked, staged, or owned by this generator" });
    else move.push({ name, files, dirs });
  }
  return { skillsRoot, move, refused };
}

// Move importer folders out of the active skills directory into `archiveRoot`, with
// a restore map. Nothing leaves the active directory until every copy has been hashed
// against its source and the map is on disk, and a source that changed meanwhile stops
// the run before its folder is moved. Without `confirm` this only reports.
export function archiveImportedSkills({
  checkoutRoot,
  archiveRoot,
  expectedKeys = [],
  trackedPaths = [],
  trackingKnown = true,
  confirm = false,
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
}) {
  const realCheckout = realpathSync(checkoutRoot);
  const targetRoot = path.join(realCheckout, ".agents");
  const skillsRoot = path.join(targetRoot, "skills");
  if (!existsSync(skillsRoot) || !existsSync(path.join(targetRoot, "generated-manifest.json"))) {
    throw new Error(`${realCheckout} has no generated .agents/ directory, so it is not a synced CRX checkout. Nothing was moved.`);
  }
  // A linked `.agents` or `skills` folder would aim the move at another checkout.
  if (path.relative(skillsRoot, realpathSync(skillsRoot)) !== "") {
    throw new Error(`${skillsRoot} is reached through a link, so it is not this checkout's own skills directory. Nothing was moved.`);
  }
  const activeDirs = [targetRoot, path.join(realCheckout, ".claude", "skills")];
  const assertOutsideActiveDirs = (candidate) => {
    if (activeDirs.some((active) => isInside(active, candidate))) {
      throw new Error(`The archive ${candidate} would sit inside an active skills tree, where Codex would still find it. Nothing was moved.`);
    }
  };
  assertOutsideActiveDirs(path.resolve(archiveRoot));
  assertOutsideActiveDirs(resolvedDestination(path.resolve(archiveRoot)));
  const { move, refused } = planImportedSkillArchive({ targetRoot, expectedKeys, trackedPaths, trackingKnown });
  const archiveDir = path.join(path.resolve(archiveRoot), stamp);
  const planned = move.map(({ name, files }) => ({ name, fileCount: files.length }));
  if (!confirm || move.length === 0) return { archiveDir, moved: [], planned, refused };

  mkdirSync(path.resolve(archiveRoot), { recursive: true });
  assertOutsideActiveDirs(realpathSync(archiveRoot));
  // Not recursive: an existing folder is a collision with an earlier archive.
  mkdirSync(archiveDir);
  mkdirSync(path.join(archiveDir, "originals"));
  const entries = [];
  for (const { name, files, dirs } of move) {
    const sourceRoot = path.join(skillsRoot, name);
    const directories = relativeDirs(sourceRoot, dirs);
    for (const directory of directories) mkdirSync(path.join(archiveDir, "skills", name, directory), { recursive: true });
    const manifestFiles = [];
    for (const source of files) {
      const relative = unix(path.relative(sourceRoot, source));
      const target = path.join(archiveDir, "skills", name, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
      const hash = sha256(source);
      if (sha256(target) !== hash) throw new Error(`The archived copy of ${source} does not match it. Nothing was removed; the partial archive is at ${archiveDir}.`);
      manifestFiles.push({ path: relative, sha256: hash });
    }
    entries.push({ originalPath: `.agents/skills/${name}`, archivedPath: `skills/${name}`, originalBackupPath: `originals/${name}`, directories, files: manifestFiles });
  }
  writeFileSync(path.join(archiveDir, "restore-map.json"), `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    checkout: unix(realCheckout),
    restore: "Copy each archivedPath back to originalPath under the checkout, including empty folders, then compare every file with its sha256 and confirm every listed directory exists.",
    originals: "archivedPath is the verified snapshot. originalBackupPath is the original folder itself, including any late writes or open-handle changes, and is present only after that folder's move succeeded; if it is absent, the folder is still at originalPath. Do not delete it.",
    entries,
  }, null, 2)}\n`, { flag: "wx" });

  const moved = [];
  for (const entry of entries) {
    const sourceRoot = path.join(realCheckout, ...entry.originalPath.split("/"));
    const { files, dirs, links } = plainTree(sourceRoot);
    const unchanged = links.length === 0
      && JSON.stringify(relativeDirs(sourceRoot, dirs)) === JSON.stringify(entry.directories)
      && files.length === entry.files.length
      && entry.files.every((file) => {
        const source = path.join(sourceRoot, ...file.path.split("/"));
        return existsSync(source) && sha256(source) === file.sha256;
      });
    if (!isInside(skillsRoot, sourceRoot) || !unchanged) {
      throw new Error(`${entry.originalPath} changed while it was being archived, so it was left in place. Already moved: ${moved.length}. Archive: ${archiveDir}.`);
    }
    // Renamed, never deleted: a write that lands after the check above stays with the
    // folder. No copy fallback, because a rename across volumes cannot be atomic.
    try {
      renameSync(sourceRoot, path.join(archiveDir, ...entry.originalBackupPath.split("/")));
    } catch (error) {
      throw new Error(`${entry.originalPath} could not be moved in one step (${error.code}), so it was left in place with its verified copy kept. Already moved: ${moved.length}. Archive: ${archiveDir}.`, { cause: error });
    }
    moved.push(entry.originalPath);
  }
  return { archiveDir, moved, planned, refused };
}

// The checkout the operator is standing in, not the one this script file lives in,
// so a reviewed copy of the script can act on another worktree of the same repository.
function activeCheckout(cwd = process.cwd()) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { encoding: "utf8", env: gitEnvironment() });
  const [checkoutRoot, commonDir] = String(result.stdout || "").split(/\r?\n/);
  if (result.status !== 0 || !checkoutRoot || !commonDir) {
    throw new Error(`${cwd} is not inside a git checkout, so there is no active .agents/ to archive from.`);
  }
  return { checkoutRoot, commonDir };
}

// Archives live in the shared git directory: outside every worktree's active tree,
// never tracked or scanned, and kept when a worktree is removed.
function runImportedSkillArchive(expected, confirm) {
  const { checkoutRoot, commonDir } = activeCheckout();
  const targetRoot = path.join(checkoutRoot, ".agents");
  const gitKnown = gitKnownTargetPaths(targetRoot, checkoutRoot);
  const result = archiveImportedSkills({
    checkoutRoot,
    archiveRoot: path.join(commonDir, "crx-archive", "imported-skills"),
    expectedKeys: [...expected.keys()],
    trackedPaths: gitKnown.paths,
    trackingKnown: gitKnown.known,
    confirm,
  });
  for (const { name, reason } of result.refused) console.log(`KEPT ${name}: ${reason}.`);
  if (confirm) {
    console.log(result.moved.length > 0
      ? `Archived ${result.moved.length} imported skill folder(s) from ${checkoutRoot} to ${result.archiveDir}; restore-map.json lists every file and its hash.`
      : `Nothing to archive in ${checkoutRoot}.`);
  } else {
    for (const { name, fileCount } of result.planned) console.log(`WOULD ARCHIVE ${name} (${fileCount} file(s))`);
    console.log(`DRY RUN: nothing changed. ${result.planned.length} folder(s) in ${checkoutRoot} would move to ${result.archiveDir}. Add --confirm to move them.`);
  }
  if (result.refused.length > 0) process.exitCode = 1;
}

function checkExpected(expected) {
  const mismatches = [];
  for (const [relative, content] of expected) {
    const target = path.join(TARGET_ROOT, relative);
    if (!existsSync(target)) mismatches.push(`${relative} is missing`);
    else if (normalizeEol(readFileSync(target, "utf8")) !== normalizeEol(content)) mismatches.push(`${relative} is stale`);
  }
  // KNOWINGLY GIVEN UP (Mason's call, 2026-09-03, round 11): this sweep enumerates the
  // DISK, so a file that exists only in the index is never examined. Stage an imported
  // adapter, delete its working-tree copy WITHOUT staging that deletion, and commit: the
  // candidate tree carries the adapter, but it is absent from `actualFiles`, so --check
  // never classifies it and the parity gate passes (Codex, PR #565).
  //
  // Not fixed, deliberately. The cost is one stale mangled instruction file under
  // .agents/ - the same consequence class as the accepted gap pinned by test case (d),
  // not wrong behavior in the app. Unioning in the index would need to exclude staged
  // DELETIONS specifically, or a legitimate `git rm` of a non-generated file starts
  // reporting as drift and blocks the commit - trading a contrived hole for a false
  // positive on an ordinary action. Ten rounds of findings in this function preceded the
  // decision to stop; see docs/manual/KNOWN_ISSUES.md.
  const actualFiles = walkFiles(TARGET_ROOT)
    .map((file) => unix(path.relative(TARGET_ROOT, file)))
    .filter((relative) => !relative.startsWith("session-state/"));
  const prior = previousManifest();
  const gitKnown = gitKnownTargetPaths();
  const { extras, foreignDirs } = classifyExtras(
    actualFiles.filter((relative) => !expected.has(relative)),
    {
      expectedKeys: [...expected.keys()],
      previouslyManaged: prior.managed,
      trackedPaths: gitKnown.paths,
      // The exemption needs BOTH provenance sources to have actually answered.
      // Either one reporting "unknown" withholds it - see previousManifest()
      // and gitKnownTargetPaths().
      trackingKnown: gitKnown.known && prior.known,
    },
  );
  if (!gitKnown.known) {
    console.error("NOTE git could not report which .agents/ paths are tracked; the importer-directory exemption is withheld and any such files are reported as drift.");
  }
  if (!prior.known) {
    console.error(`NOTE generated-manifest.json exists but is unreadable, or is not the { version: ${MANIFEST_VERSION}, managed: <relative unix paths> } shape this generator writes, so the record of what the last sync generated is unavailable; the importer-directory exemption is withheld and any such files are reported as drift.`);
  }
  for (const extra of extras) {
    mismatches.push(`${extra} is not generated from .claude`);
  }
  // Report on stdout, ahead of the verdict. check-agent-workflows.mjs surfaces
  // only the FIRST stdout line as its note, so leading with this is what keeps
  // the litter visible through `npm run agent-health` too. Its PASS matcher is
  // `/^PASS - \d+ .../m`, which still finds the verdict line below.
  if (foreignDirs.length > 0) {
    console.log(`WARNING: ignoring ${foreignDirs.length} foreign .agents/skills/source-command-*/ director${foreignDirs.length === 1 ? "y" : "ies"} written by the Codex CLI /import feature - preview moving them to the recoverable archive with: node scripts/sync-agent-workflows.mjs --archive-imported`);
    console.log(`  Their text is mangled (claude -> Codex), so references like .Codex/hooks/ are broken, and Codex can still discover them. They are neither checked nor synced. Add --confirm to the command above to move them.`);
    for (const name of foreignDirs) console.log(`  - skills/${name}/`);
  }
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) console.error(`FAIL ${mismatch}`);
    console.error("Run: node scripts/sync-agent-workflows.mjs --write");
    process.exit(1);
  }
  console.log(`PASS - ${expected.size - 2} Codex workflow file(s) match .claude sources.`);
}

// Run the CLI only when this file IS the entry point. sync-agent-workflows.test.mjs
// imports writeExpected to prove the CRLF-mirror repair, and importing a module
// whose top level regenerates .agents/** would rewrite the real tree as a side
// effect of running the test suite. Compare resolved paths rather than basenames:
// .husky and CI invoke this as `node scripts/sync-agent-workflows.mjs --write`,
// check-agent-workflows.mjs spawns it by absolute path, and both must still run.
//
// Case-fold on Windows. `path.resolve` builds the entry path from process.cwd(),
// whose drive letter casing comes from whatever launched the shell, while
// fileURLToPath returns the casing in the module URL. A `C:` vs `c:` mismatch
// would silently skip the CLI, and the caller in check-agent-workflows.mjs keyed
// off the exit code alone - so a skipped --check would exit 0 and be reported as
// "synced" while checking nothing. That caller now also requires the PASS line;
// this comparison is the other half of closing that fail-silent path.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  const normalize = (value) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(argvPath) === normalize(fileURLToPath(moduleUrl));
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const mode = process.argv[2] || "--check";
  const expected = buildExpected();
  if (mode === "--write") writeExpected(expected);
  else if (mode === "--check") checkExpected(expected);
  else if (mode === "--archive-imported") {
    try {
      runImportedSkillArchive(expected, process.argv.includes("--confirm"));
    } catch (error) {
      console.error(`FAIL ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error("Usage: node scripts/sync-agent-workflows.mjs --write|--check|--archive-imported [--confirm]");
    process.exit(2);
  }
}
