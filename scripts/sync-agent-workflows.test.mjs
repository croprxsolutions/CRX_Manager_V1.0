#!/usr/bin/env node
// Regression test for the --write repair path of scripts/sync-agent-workflows.mjs.
//
// Why this file exists: on 2026-08-19 the write path was "fixed" to normalize the
// target before comparing it, which is a no-op on the only case that matters. A
// CRLF mirror normalizes to the canonical LF form, so the write was skipped, the
// file stayed CRLF, and --write still printed "Synced". Two independent reviewers
// and a live proof against a CRLF *source* all missed it, because the source case
// and the mirror case fail differently. CodeRabbit caught it on PR #425.
//
// writeExpected() takes an explicit targetRoot so this runs against a temp
// directory and never touches the real .agents/** tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import {
  archiveImportedSkills,
  classifyExtras,
  commandTitle,
  gitEnvironment,
  isEntryPoint,
  previousManifest,
  stripFrontmatter,
  writeExpected,
} from "./sync-agent-workflows.mjs";

const targetRoot = mkdtempSync(path.join(os.tmpdir(), "crx-sync-write-"));

// Release instructions must use the executable parameter/contract matcher,
// not bless actor-forgery exemptions by their violation keys alone.
//
// These assert SEMANTICS, not token presence. A bare `includes("--adjudicate")`
// passes on "do NOT run --adjudicate" and on "--adjudicate is optional", so it
// would not catch the reversal it exists to prevent. Each rule therefore pairs a
// `require` pattern (the instruction must actually be given) with `forbid`
// patterns (it must not be negated or downgraded to optional). The patterns are
// deliberately focused rather than exact-prose, so ordinary rewording survives.
const ADJUDICATION_CONTRACT = [
  {
    rule: "must invoke the adjudicating sweep command",
    require: /run-sweeps\.mjs\s+--adjudicate\b/,
    forbid: [
      /(?:do not|do NOT|don't|never|skip|without)\b[^.\n]{0,80}run-sweeps\.mjs\s+--adjudicate/i,
      /--adjudicate\b[^.\n]{0,40}\b(?:is\s+)?(?:optional|not required)\b/i,
    ],
  },
  {
    rule: "must capture the function/authorization dependency contracts",
    require: /\bfunction_contracts\b|\bauthorization-dependency\b/,
    forbid: [
      /(?:function_contracts|authorization-dependency)[^.\n]{0,60}\b(?:optional|not required|best[- ]effort|if present|if available)\b/i,
      // An ADDED contradiction leaves the required token in place, so `require` still matches:
      // "Do not capture function_contracts" has to be forbidden in its own right. The window is
      // tight and needs a capture verb, so the real prose's "Do not compare violation keys alone:
      // … authorization-dependency contracts" does not trip it (CodeRabbit on #774).
      /\b(?:do not|do NOT|don't|never|skip|omit|stop)\b[^.\n]{0,30}\b(?:captur\w*|collect\w*|includ\w*|read\w*|record\w*|emit\w*|request\w*)\b[^.\n]{0,30}\b(?:function_contracts|authorization-dependency)\b/i,
    ],
  },
  {
    rule: "must refuse key-only allowlisting",
    // A positive prohibition, not merely the absence of a bad phrasing: flipping
    // "Do not compare violation keys alone" into "Compare violation keys alone"
    // deletes the negation and so fails `require`.
    require: /\b(?:do not|do NOT|don't|never)\b[^.\n]{0,60}?\b(?:compare|subtract|allowlist|match)\b[^.\n]{0,60}?violation[ _]`?keys?`?[^.\n]{0,20}?\balone\b/i,
    forbid: [
      /compare (?:returned )?`violation_key`s (?:against|to)/,
      // Same additive hole on the other rule: "You may allowlist by violation key alone" keeps the
      // prohibition above intact, so permissive phrasing must be forbidden explicitly.
      /\b(?:may|can|it is fine|is fine|is ok|is okay|acceptable|allowed|suffices|sufficient|enough)\b[^.\n]{0,60}?\b(?:allowlist\w*|subtract\w*|match\w*|compar\w*|exempt\w*)\b[^.\n]{0,60}?violation[ _]`?keys?`?[^.\n]{0,20}?\balone\b/i,
    ],
  },
];

function assertAdjudicationContract(source, label) {
  for (const { rule, require: required, forbid } of ADJUDICATION_CONTRACT) {
    assert.match(source, required, `${label} ${rule}`);
    for (const pattern of forbid) {
      assert.doesNotMatch(source, pattern, `${label} ${rule} (reversed by ${pattern})`);
    }
  }
}

const RELEASE_COMMANDS = ["ship", "codex-gauntlet", "preflight"];
for (const command of RELEASE_COMMANDS) {
  const source = readFileSync(new URL(`../.claude/commands/${command}.md`, import.meta.url), "utf8");
  assertAdjudicationContract(source, command);
}


// Prove the helper actually rejects the reversals, rather than passing whatever
// the current prose happens to say. Each mutation is applied to every real
// command source; if a mutation is a no-op on some source the guard would look
// green for the wrong reason, so an unchanged source is itself a failure.
const SEMANTIC_REVERSALS = [
  ["drops adjudication", (s) => s.replace(/run-sweeps\.mjs\s+--adjudicate/g, "run-sweeps.mjs")],
  ["negates adjudication", (s) => s.replace(/(node scripts\/db-invariant-sweeps\/)run-sweeps\.mjs\s+--adjudicate/g, "do not run $1run-sweeps.mjs --adjudicate")],
  ["makes adjudication optional", (s) => s.replace(/(run-sweeps\.mjs\s+--adjudicate)/g, "$1 is optional")],
  ["drops dependency contracts", (s) => s.replace(/function_contracts/g, "rows").replace(/authorization-dependency/g, "reviewed")],
  ["makes dependency contracts optional", (s) => s.replace(/(function_contracts|authorization-dependency)/g, "$1 optional")],
  ["permits key-only allowlisting", (s) => s.replace(/\b(?:Do not|Do NOT)\b(\s+(?:compare|subtract))/g, "Always$1")],
  // The six above all REMOVE or REVERSE the instruction. These two ADD a contradicting sentence and
  // leave the original wording in place, so every `require` still matches — the case the forbid
  // patterns had to grow for (CodeRabbit on #774).
  ["adds a contradicting dependency-contract instruction", (s) => `${s}\n\nDo not capture function_contracts for this gate.\n`],
  ["adds a contradicting key-only permission", (s) => `${s}\n\nYou may allowlist by violation key alone.\n`],
];

for (const command of RELEASE_COMMANDS) {
  const source = readFileSync(new URL(`../.claude/commands/${command}.md`, import.meta.url), "utf8");
  for (const [name, mutate] of SEMANTIC_REVERSALS) {
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `mutation "${name}" did not change ${command}.md — the guard would pass vacuously`);
    assert.throws(() => assertAdjudicationContract(mutated, command),
      assert.AssertionError, `${command}.md mutated to "${name}" must be rejected`);
  }
}

// The review skills launch the same live sweeps, so they must route through the same adjudicator:
// a skill that still says "classify the MCP rows against the allowlist" bypasses the contract
// checks entirely. (Codex on #838.)
const REVIEW_SKILLS = ["codex-review", "codex-cross-review"];
for (const skill of REVIEW_SKILLS) {
  const source = readFileSync(new URL(`../.claude/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  assertAdjudicationContract(source, `skill ${skill}`);
  for (const [name, mutate] of SEMANTIC_REVERSALS) {
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `mutation "${name}" did not change skill ${skill} — the guard would pass vacuously`);
    assert.throws(() => assertAdjudicationContract(mutated, `skill ${skill}`),
      assert.AssertionError, `skill ${skill} mutated to "${name}" must be rejected`);
  }
}

try {
  // The two entries writeExpected() subtracts from its count (README + manifest)
  // are irrelevant here; any Map of relative-path -> content exercises the loop.
  const expected = new Map([
    ["skills/demo/SKILL.md", "line one\nline two\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);

  // A mirror smudged to CRLF must be repaired to LF. This is the assertion the
  // normalize-before-compare version silently failed.
  mkdirSync(path.join(targetRoot, "skills", "demo"), { recursive: true });
  const smudged = path.join(targetRoot, "skills", "demo", "SKILL.md");
  writeFileSync(smudged, "line one\r\nline two\r\n");
  assert.ok(readFileSync(smudged, "utf8").includes("\r\n"), "fixture must start out CRLF");

  writeExpected(expected, targetRoot);

  assert.equal(
    readFileSync(smudged, "utf8"),
    "line one\nline two\n",
    "--write must rewrite a CRLF mirror to LF, not skip it as already in sync",
  );

  // ...and it must be idempotent: a second run over an already-LF tree leaves the
  // bytes untouched. (Raw comparison is what keeps this true — the canonical form
  // equals the file byte for byte, so nothing is rewritten.)
  //
  // Assert on mtime, not content. Content alone also passes when writeExpected
  // rewrites every file with identical bytes on every run, which is exactly the
  // claim this block is here to disprove — the same "proof weaker than the claim"
  // trap that let the CRLF-mirror bug ship.
  const untouched = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(smudged, untouched, untouched);
  writeExpected(expected, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "line one\nline two\n");
  assert.equal(
    statSync(smudged).mtime.getTime(),
    untouched.getTime(),
    "an in-sync mirror must not be rewritten at all, not merely rewritten identically",
  );

  // A source carrying CRLF must still land as LF in the mirror. This is the case
  // the original fix DID cover; keep it pinned so a future edit cannot trade one
  // half of the repair for the other.
  const crlfSource = new Map([
    ["skills/demo/SKILL.md", "alpha\r\nbeta\r\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(crlfSource, targetRoot);
  assert.equal(
    readFileSync(smudged, "utf8"),
    "alpha\nbeta\n",
    "a CRLF source must be normalized to LF on the way into the mirror",
  );

  // Real content drift is still written through, EOL handling notwithstanding.
  const changed = new Map([
    ["skills/demo/SKILL.md", "alpha\nCHANGED\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(changed, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "alpha\nCHANGED\n");
  // ── entry-point detection ────────────────────────────────────────────────
  // The CLI is guarded by isEntryPoint() so importing this module (which the
  // assertions above do) cannot regenerate the real .agents/** tree. A false
  // negative here is the dangerous direction: the CLI would silently not run,
  // `--check` would exit 0 with no output, and check-agent-workflows.mjs would
  // report "synced" having checked nothing.
  const selfUrl = new URL("./sync-agent-workflows.mjs", import.meta.url).href;
  const selfPath = fileURLToPath(selfUrl);

  assert.equal(isEntryPoint(selfPath, selfUrl), true, "absolute path must be recognized (CI spawn)");
  assert.equal(
    isEntryPoint(path.relative(process.cwd(), selfPath), selfUrl),
    true,
    "relative path must be recognized (husky / npm script invocation)",
  );
  assert.equal(isEntryPoint(undefined, selfUrl), false, "no argv[1] is not an entry point");
  assert.equal(
    isEntryPoint(path.join(path.dirname(selfPath), "normalize-eol.mjs"), selfUrl),
    false,
    "a different file must not be treated as the entry point",
  );

  // Windows drive-letter casing: process.cwd() carries whatever casing launched
  // the shell, import.meta.url carries the module URL's. A plain === would skip
  // the CLI on a `c:` vs `C:` mismatch.
  if (process.platform === "win32" && /^[A-Za-z]:/.test(selfPath)) {
    const flipped = selfPath[0] === selfPath[0].toUpperCase()
      ? selfPath[0].toLowerCase() + selfPath.slice(1)
      : selfPath[0].toUpperCase() + selfPath.slice(1);
    assert.equal(
      isEntryPoint(flipped, pathToFileURL(selfPath).href),
      true,
      "drive-letter casing must not decide whether the CLI runs",
    );
  }
  // ── foreign Codex-import directories ─────────────────────────────────────
  // The Codex CLI's /import feature writes source-command-<name>/SKILL.md into
  // .agents/skills/. Those are not generated here and blocked every commit in
  // the checkout they landed in. classifyExtras() splits them out of the verdict
  // WITHOUT widening the check for anything else.
  //
  // Every assertion below was mutation-proved load-bearing: dropping the `[^/]+`
  // to `[^/]*` reddens the bare-prefix case; dropping the trailing `/` from the
  // pattern reddens the sibling-file case; removing the classification entirely
  // reddens the first case.
  {
    const foreign = classifyExtras([
      "skills/source-command-ship/SKILL.md",
      "skills/source-command-ship/extra.md",
      "skills/source-command-parked/SKILL.md",
    ]);
    assert.deepEqual(foreign.extras, [], "importer directories must not count as drift");
    assert.deepEqual(
      foreign.foreignDirs,
      ["source-command-parked", "source-command-ship"],
      "each importer directory is reported ONCE, sorted, however many files it holds",
    );

    // The exemption must stay narrow. An ordinary stray file is still drift —
    // this is the check that would have caught a blanket "ignore extras" fix.
    const mixed = classifyExtras([
      "skills/source-command-ship/SKILL.md",
      "skills/NOT-OURS.md",
      "README.stray",
    ]);
    assert.deepEqual(
      mixed.extras,
      ["skills/NOT-OURS.md", "README.stray"],
      "a stray file outside an importer directory must still be reported as drift",
    );
    assert.deepEqual(mixed.foreignDirs, ["source-command-ship"]);

    // Near-misses that must NOT be exempted: the prefix as a bare directory name
    // with nothing after it, the prefix as a FILE rather than a directory, and
    // the prefix appearing anywhere other than the first path segment under
    // skills/. Each of these is a path the generator could legitimately own.
    const nearMisses = classifyExtras([
      "skills/source-command-/SKILL.md",
      "skills/source-command-ship.md",
      "skills/real/source-command-ship/SKILL.md",
      "source-command-ship/SKILL.md",
    ]);
    assert.deepEqual(
      nearMisses.foreignDirs,
      [],
      "only skills/source-command-<name>/... is foreign; near-miss shapes stay checked",
    );
    assert.equal(nearMisses.extras.length, 4, "every near-miss is still reported as drift");

    // ── the three narrowing conditions (Codex, PR #565) ────────────────────
    // Each closes a way the exemption could have let non-generated instructions
    // live in .agents/ unchallenged. Drop the corresponding option from
    // classifyExtras and exactly one of these goes red.

    // (a) A directory the generator PREVIOUSLY owned stays ours. Otherwise
    //     deleting a canonical `.claude` command named source-command-* drops
    //     its mirror out of `expected`, and the orphan would be waved through as
    //     importer litter while its stale instructions remain on disk.
    const orphaned = classifyExtras(["skills/source-command-demo/SKILL.md"], {
      previouslyManaged: ["skills/source-command-demo/SKILL.md"],
    });
    assert.deepEqual(orphaned.foreignDirs, [], "a formerly generated directory is not importer litter");
    assert.deepEqual(
      orphaned.extras,
      ["skills/source-command-demo/SKILL.md"],
      "an orphaned mirror of a deleted canonical command is still drift",
    );

    // (b) Ownership is per DIRECTORY, not per file. When the generator emits
    //     skills/source-command-demo/SKILL.md, a hand-added sibling in that same
    //     directory is drift — not litter — even though the sibling itself is
    //     never in `expected`.
    const sibling = classifyExtras(["skills/source-command-demo/manual.md"], {
      expectedKeys: ["skills/source-command-demo/SKILL.md"],
    });
    assert.deepEqual(sibling.foreignDirs, [], "a canonical directory is never reclassified as foreign");
    assert.deepEqual(
      sibling.extras,
      ["skills/source-command-demo/manual.md"],
      "an extra file beside a generated adapter stays drift",
    );

    // (c) The exemption is for UNTRACKED working-tree litter only. Once the
    //     importer output is staged or tracked it is becoming part of the repo,
    //     and mangled instructions must fail the parity check rather than ride
    //     in silently. Proven live as well: staging the fixture turned --check
    //     from PASS to `FAIL ... is not generated from .claude`.
    const staged = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackedPaths: ["skills/source-command-ship/SKILL.md"],
    });
    assert.deepEqual(staged.foreignDirs, [], "tracked importer output is not exempt");
    assert.deepEqual(
      staged.extras,
      ["skills/source-command-ship/SKILL.md"],
      "staged or tracked importer files must fail the check",
    );

    // (d) DELIBERATELY NOT COVERED, and pinned here so the gap is visible.
    //     Sequence Codex found: a generated source-command-demo/ also holds an
    //     extra manual.md; the canonical command is deleted; --write prunes
    //     SKILL.md and rewrites `managed` without the directory. On the next
    //     --check, `previouslyManaged` no longer mentions it, so (a) cannot fire
    //     and the surviving manual.md IS waved through as litter.
    //
    //     A durable `ownedImporterDirs` field used to cover this, reconstructed
    //     from the git index, HEAD and every merge parent. That layer drew a
    //     review finding every round without converging - eight across eight
    //     rounds, one of them introduced by the fix for the round before it - so
    //     Mason cut it on 2026-09-03. Nothing in .claude/ is named
    //     `source-command-*`, so this sequence cannot occur today; the cost if it
    //     ever did is an unreferenced instruction file under .agents/.
    const afterRewrite = classifyExtras(["skills/source-command-demo/manual.md"], {
      expectedKeys: ["README.md"],
      previouslyManaged: [],
    });
    assert.deepEqual(
      afterRewrite.foreignDirs,
      ["source-command-demo"],
      "ACCEPTED GAP: once --write rewrites `managed`, a formerly generated directory is treated as litter",
    );
    assert.deepEqual(afterRewrite.extras, []);
    // Case (b) above already pins the half that still holds: while the canonical
    // command exists, a hand-added sibling beside its adapter is still drift.

    // (e) UNKNOWN tracking state must not buy an exemption. gitKnownTargetPaths
    //     used to answer a git failure with an empty list, which reads as
    //     "nothing is tracked" - the most permissive answer available, handed
    //     out at exactly the moment the check can no longer tell whether the
    //     importer output had been staged. It now reports `known: false` and the
    //     exemption is withheld (CodeRabbit, PR #565).
    const trackingUnknown = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackedPaths: [],
      trackingKnown: false,
    });
    assert.deepEqual(trackingUnknown.foreignDirs, [], "unknown tracking state grants no exemption");
    assert.deepEqual(
      trackingUnknown.extras,
      ["skills/source-command-ship/SKILL.md"],
      "when git cannot be consulted, importer paths are reported as drift",
    );

    // (f) The SAME shape, from the other provenance source. A manifest that
    //     exists but cannot be parsed means the record of what the last sync
    //     generated is UNAVAILABLE, not empty; conflating the two would hand a
    //     corrupt manifest the exemption for every importer directory.
    //     checkExpected() ands both signals together, so this is the identical
    //     withholding.
    const manifestUnavailable = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackingKnown: false, // gitKnown.known && prior.known, with prior unusable
    });
    assert.deepEqual(manifestUnavailable.foreignDirs, [], "an unreadable manifest grants no exemption");
    assert.deepEqual(
      manifestUnavailable.extras,
      ["skills/source-command-ship/SKILL.md"],
      "a corrupt manifest reports importer paths as drift instead of exempting them",
    );

    // ...and the untracked twin of (c) still passes, so the fix did not simply
    // delete the exemption. An empty tracked list with `known: true` is a real
    // answer - nothing staged yet - and must still exempt.
    const untracked = classifyExtras(["skills/source-command-ship/SKILL.md"]);
    assert.deepEqual(untracked.foreignDirs, ["source-command-ship"]);
    assert.deepEqual(untracked.extras, [], "untracked importer litter is still exempt");
  }

  // (g) The staged-path guard has to read the index git is actually committing.
  //     `git commit <paths>` hands its hooks a TEMPORARY index holding exactly
  //     the candidate tree via GIT_INDEX_FILE; this helper used to delete that
  //     variable along with the repository redirects, so the guard inspected the
  //     default index and a partial commit could carry an imported adapter in
  //     unseen (Codex P2, PR #565). The redirects still have to go - they are
  //     absolute and outrank `-C ROOT`.
  {
    const commonDir = path.join(targetRoot, ".git");
    const candidateIndex = path.join(commonDir, "index.tmp-abc123");
    const kept = gitEnvironment(
      {
        GIT_DIR: "/elsewhere/.git",
        GIT_WORK_TREE: "/elsewhere",
        GIT_INDEX_FILE: candidateIndex,
      },
      { commonDir },
    );
    assert.equal(kept.GIT_DIR, undefined, "GIT_DIR outranks -C ROOT and must be stripped");
    assert.equal(kept.GIT_WORK_TREE, undefined, "GIT_WORK_TREE must be stripped");
    assert.equal(
      kept.GIT_INDEX_FILE,
      candidateIndex,
      "the candidate index for THIS repository must survive, or a partial commit is inspected against the wrong index",
    );

    // A relative value is resolved against the cwd git invoked the hook from,
    // not against ROOT, which is where `-C ROOT` would otherwise re-root it.
    const relative = gitEnvironment(
      { GIT_INDEX_FILE: "index.tmp-rel" },
      { commonDir, cwd: commonDir },
    );
    assert.equal(relative.GIT_INDEX_FILE, path.join(commonDir, "index.tmp-rel"));

    // ...but only for THIS repository. core.hooksPath has pointed at a foreign
    // checkout on this machine, and honoring its index would have us report on
    // an unrelated repository's staged files.
    const foreign = gitEnvironment(
      { GIT_INDEX_FILE: path.join(targetRoot, "other-repo", ".git", "index") },
      { commonDir },
    );
    assert.equal(
      foreign.GIT_INDEX_FILE,
      undefined,
      "an index belonging to another repository is discarded, not trusted",
    );

    // With no git dir resolvable there is nothing to validate against, so the
    // stray value is dropped rather than honored.
    const unresolvable = gitEnvironment({ GIT_INDEX_FILE: candidateIndex }, { commonDir: null });
    assert.equal(unresolvable.GIT_INDEX_FILE, undefined);
  }

  // (h) The manifest records `managed` and nothing else. The durable
  //     `ownedImporterDirs` field - and with it the git index / HEAD /
  //     MERGE_HEAD reconstruction that kept it honest - was cut on 2026-09-03.
  //     Pinned here so a future change cannot quietly reintroduce the field
  //     without also reintroducing the eight findings' worth of provenance
  //     handling it needs to be safe.
  {
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, "generated-manifest.json"), "utf8"));
    assert.deepEqual(
      Object.keys(manifest).sort(),
      ["managed", "version"],
      "the manifest carries only `version` and `managed`",
    );
  }

  // (i) Valid JSON of the WRONG SHAPE is not an answer either. previousManifest()
  //     used to read `parsed.managed` off whatever parsed, fall back to `[]` when
  //     it was not an array, and still report `known: true` - so `[]`,
  //     `"text"` or `{"managed":"invalid"}` all read as a confident "nothing was
  //     managed". checkExpected() ands `prior.known` into `trackingKnown`, so
  //     that confident-but-wrong empty is what hands a corrupt manifest the
  //     importer exemption for every source-command-* directory. It must fail
  //     closed, exactly like the unparseable branch (CodeRabbit, PR #565).
  {
    const shapeRoot = path.join(targetRoot, "manifest-shapes");
    mkdirSync(shapeRoot, { recursive: true });
    const manifestPath = path.join(shapeRoot, "generated-manifest.json");
    const write = (text) => writeFileSync(manifestPath, text);

    // No manifest at all stays a real answer: nothing has been generated yet.
    assert.deepEqual(previousManifest(shapeRoot), { managed: [], known: true });

    for (const [label, text] of [
      ["unparseable", "{not json"],
      ["a top-level array", "[]"],
      ["a top-level string", '"text"'],
      ["a top-level null", "null"],
      ["a top-level number", "7"],
      ["managed as a string", '{"version":1,"managed":"invalid"}'],
      ["managed as an object", '{"version":1,"managed":{}}'],
      ["managed missing", '{"version":1}'],
      ["managed holding non-strings", '{"version":1,"managed":["ok.md",42]}'],
      // The version must be present and EXACT, or a manifest written by some other
      // generator is parsed on a guess and treated as authoritative (Codex, PR #565).
      ["version missing", '{"managed":[]}'],
      ["version null", '{"version":null,"managed":[]}'],
      ["version from a future writer", '{"version":2,"managed":[]}'],
      ["version as a string", '{"version":"1","managed":[]}'],
      // Every entry is joined onto the target root and passed to rmSync() by --write,
      // so an entry that can ESCAPE that root is not merely odd, it is a delete outside
      // .agents/. `managed: ["../package.json"]` used to prune a repository file.
      ["a parent-escaping entry", '{"version":1,"managed":["../package.json"]}'],
      ["a deep parent-escaping entry", '{"version":1,"managed":["skills/../../package.json"]}'],
      ["a windows-separator entry", '{"version":1,"managed":["..\\\\.git\\\\index"]}'],
      ["a posix-absolute entry", '{"version":1,"managed":["/etc/passwd"]}'],
      ["a drive-absolute entry", '{"version":1,"managed":["C:/Windows/system32/drivers/etc/hosts"]}'],
      ["an empty entry", '{"version":1,"managed":[""]}'],
      ["a dot segment", '{"version":1,"managed":["./README.md"]}'],
      ["a doubled separator", '{"version":1,"managed":["skills//SKILL.md"]}'],
      ["a NUL in an entry", '{"version":1,"managed":["README.md\\u0000.evil"]}'],
    ]) {
      write(text);
      assert.deepEqual(
        previousManifest(shapeRoot),
        { managed: [], known: false },
        `${label} must report the record as UNAVAILABLE, not as an empty managed list`,
      );
    }

    // ...and the real shape still answers, so this did not simply disable the
    // provenance source it is guarding.
    write('{"version":1,"managed":["skills/demo/SKILL.md"]}\n');
    assert.deepEqual(previousManifest(shapeRoot), {
      managed: ["skills/demo/SKILL.md"],
      known: true,
    });
    write('{"version":1,"managed":[]}\n');
    assert.deepEqual(
      previousManifest(shapeRoot),
      { managed: [], known: true },
      "a well-formed manifest with an empty managed list is a real answer",
    );

    // An INHERITED `managed` must not satisfy the check. With Object.prototype
    // polluted anywhere in the process, a bare property read on `{"version":1}`
    // returns the inherited array and the record reads as authoritative-and-empty
    // (Codex, PR #565). `Object.hasOwn` is what closes it.
    write('{"version":1}');
    Object.defineProperty(Object.prototype, "managed", {
      value: [],
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      assert.deepEqual(
        previousManifest(shapeRoot),
        { managed: [], known: false },
        "an inherited `managed` must not make a schema-invalid manifest authoritative",
      );
    } finally {
      delete Object.prototype.managed;
    }
    assert.equal(({}).managed, undefined, "the prototype fixture must be torn down");

    rmSync(shapeRoot, { recursive: true, force: true });
  }

  // (j) --write PRUNES by deleting `path.join(targetRoot, entry)` for every manifest
  //     entry no longer generated. An entry that escapes the target root therefore
  //     deletes a file outside .agents/ - `managed: ["../package.json"]` removed a
  //     repository file (Codex, PR #565). Two layers now stop it: previousManifest()
  //     refuses the manifest outright, and the prune loop independently re-checks
  //     containment because a delete does not get to assume its caller validated.
  //     Asserted end to end on a real file outside the target root.
  {
    const escapeRoot = mkdtempSync(path.join(os.tmpdir(), "crx-sync-escape-"));
    const targetInside = path.join(escapeRoot, "agents");
    mkdirSync(targetInside, { recursive: true });
    const outsider = path.join(escapeRoot, "package.json");
    writeFileSync(outsider, '{"name":"must-survive"}\n');
    writeFileSync(
      path.join(targetInside, "generated-manifest.json"),
      '{"version":1,"managed":["../package.json","skills/../../package.json"]}\n',
    );

    writeExpected(
      new Map([
        ["README.md", "readme\n"],
        ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
      ]),
      targetInside,
    );

    assert.equal(
      readFileSync(outsider, "utf8"),
      '{"name":"must-survive"}\n',
      "a manifest entry that escapes the target root must never delete a file outside it",
    );
    rmSync(escapeRoot, { recursive: true, force: true });
  }

  // (k) A command file may open with YAML frontmatter (`model:` / `effort:`
  //     routing, 2026-09-05). commandTitle() derives the Codex adapter's title,
  //     and through it the adapter description, from the first `# ` heading. A
  //     YAML comment inside the block has exactly that shape, so before the
  //     frontmatter was stripped the comment became the title. The first case
  //     below is RED on the old implementation.
  {
    const withComment = [
      "---",
      "# Read-only report: faster model at low effort.",
      "model: sonnet",
      "effort: low",
      "---",
      "",
      "Show a quick dashboard.",
      "",
      "# Real Heading",
      "",
    ].join("\n");
    assert.equal(
      commandTitle(withComment, "demo-command"),
      "Real Heading",
      "a YAML comment inside frontmatter must not be read as the H1",
    );

    // No heading in the body: the fallback title-cases the file name, and the
    // frontmatter comment still does not stand in for the missing H1.
    const noHeading = "---\n# a comment\nmodel: sonnet\n---\n\nPlain prose only.\n";
    assert.equal(commandTitle(noHeading, "demo-command"), "Demo Command");

    // CRLF frontmatter (a checkout with autocrlf) is still recognized.
    assert.equal(
      commandTitle("---\r\n# c\r\nmodel: sonnet\r\n---\r\n\r\n# Windows Heading\r\n", "x"),
      "Windows Heading",
    );

    // Only a block at the very START is frontmatter. A `---` rule later in the
    // body is ordinary markdown and the text around it must survive.
    const ruleInBody = "Intro paragraph.\n\n---\n\n# After Rule\n";
    assert.equal(stripFrontmatter(ruleInBody), ruleInBody, "a body rule is not frontmatter");
    assert.equal(commandTitle(ruleInBody, "x"), "After Rule");

    // A file with no frontmatter at all is untouched, so every command that has
    // none keeps the exact title it had before this change.
    const plain = "First line.\n\n# Plain Heading\n";
    assert.equal(stripFrontmatter(plain), plain);
    assert.equal(commandTitle(plain, "x"), "Plain Heading");

    // The two routed command files must keep resolving to the titles their
    // generated .agents/ adapters already carry; otherwise --check goes red the
    // moment frontmatter lands. Read from the real repo, not a fixture.
    const commandsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "commands");
    for (const [name, expectedTitle] of [["status", "Status"], ["fleet", "Fleet"]]) {
      const source = readFileSync(path.join(commandsRoot, `${name}.md`), "utf8");
      assert.match(source, /^---\r?\n/, `${name}.md is expected to open with frontmatter`);
      assert.equal(commandTitle(source, name), expectedTitle, `${name}.md adapter title must be unchanged by its frontmatter`);
    }

    // /parked is NOT routed. On an apply request it continues into the
    // migration flow (risk assessment, /explain-migration, /migration-review,
    // the apply itself), and docs/reference/claude-model-tuning.md forbids
    // lowering effort on a migration path (Codex App P1 on PR #621). Pin that
    // it carries no frontmatter so a later "tidy-up" cannot quietly re-route it.
    const parked = readFileSync(path.join(commandsRoot, "parked.md"), "utf8");
    assert.doesNotMatch(parked, /^---\r?\n/, "parked.md must not carry model/effort frontmatter");
    assert.equal(commandTitle(parked, "parked"), "Parked");
  }

  // --archive-imported moves Codex importer output out of the active skills directory
  // into a verified, restorable archive, and refuses anything it cannot prove is
  // importer litter. Junctions stand in for symlinks: they need no Windows privilege.
  {
    const sandbox = path.join(targetRoot, "archive");
    let run = 0;
    const freshCheckout = () => {
      const checkoutRoot = path.join(sandbox, `checkout-${run += 1}`);
      mkdirSync(path.join(checkoutRoot, ".agents", "skills"), { recursive: true });
      writeFileSync(path.join(checkoutRoot, ".agents", "generated-manifest.json"), JSON.stringify({ version: 1, managed: [] }));
      return checkoutRoot;
    };
    const addSkill = (checkoutRoot, name, body = `# ${name}\n`) => {
      const dir = path.join(checkoutRoot, ".agents", "skills", name);
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), body);
      writeFileSync(path.join(dir, "agents", "openai.yaml"), `name: ${name}\n`);
      return dir;
    };
    const fingerprint = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return `${path.relative(root, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      })
      .sort();
    const fullTree = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${path.relative(root, path.join(entry.parentPath, entry.name))}${path.sep}`)
      .concat(fingerprint(root))
      .sort();
    const refusedNames = (result) => result.refused.map(({ name }) => name).sort();

    // Preview: names the work, and writes nothing anywhere.
    {
      const checkoutRoot = freshCheckout();
      addSkill(checkoutRoot, "source-command-ship");
      addSkill(checkoutRoot, "ship");
      const archiveRoot = path.join(sandbox, "preview-archive");
      const before = fingerprint(checkoutRoot);
      const result = archiveImportedSkills({ checkoutRoot, archiveRoot });
      assert.deepEqual(result.planned, [{ name: "source-command-ship", fileCount: 2 }]);
      assert.deepEqual(result.moved, []);
      assert.deepEqual(fingerprint(checkoutRoot), before, "a preview must not change the checkout");
      assert.equal(existsSync(archiveRoot), false, "a preview must not create the archive");
    }

    // A real move: importer folders leave, everything else stays, and the restore map
    // holds a hash taken independently here for every byte that moved.
    {
      const checkoutRoot = freshCheckout();
      const source = addSkill(checkoutRoot, "source-command-ship", "old ship\r\nsecond line\n");
      const originalHashes = fingerprint(source);
      const canonical = addSkill(checkoutRoot, "ship");
      const archiveRoot = path.join(sandbox, "real-archive");
      const result = archiveImportedSkills({ checkoutRoot, archiveRoot, confirm: true, stamp: "first" });
      assert.deepEqual(result.moved, [".agents/skills/source-command-ship"]);
      assert.equal(existsSync(source), false, "the importer folder must leave the active directory");
      assert.equal(existsSync(path.join(canonical, "SKILL.md")), true, "a canonical skill must stay");
      const archived = path.join(archiveRoot, "first", "skills", "source-command-ship");
      assert.deepEqual(fingerprint(archived), originalHashes, "the archive must hold the exact bytes");
      assert.equal(readFileSync(path.join(archived, "SKILL.md"), "utf8"), "old ship\r\nsecond line\n");
      const map = JSON.parse(readFileSync(path.join(archiveRoot, "first", "restore-map.json"), "utf8"));
      assert.equal(map.entries[0].originalPath, ".agents/skills/source-command-ship");
      assert.equal(map.entries[0].archivedPath, "skills/source-command-ship");
      assert.deepEqual(
        map.entries[0].files.map((file) => `${path.normalize(file.path)}:${file.sha256}`).sort(),
        originalHashes,
        "the restore map must record every file and its hash",
      );
      assert.match(map.restore, /archivedPath back to originalPath/);
    }

    // Empty folders are part of the tree: archived, listed in the restore map, and
    // back in place after following the map's restore instruction.
    {
      const checkoutRoot = freshCheckout();
      const source = addSkill(checkoutRoot, "source-command-ship");
      mkdirSync(path.join(source, "assets", "empty", "deeper"), { recursive: true });
      mkdirSync(path.join(source, "notes"));
      const before = fullTree(source);
      const archiveRoot = path.join(sandbox, "empty-dirs-archive");
      archiveImportedSkills({ checkoutRoot, archiveRoot, confirm: true, stamp: "dirs" });
      assert.equal(existsSync(source), false);
      const map = JSON.parse(readFileSync(path.join(archiveRoot, "dirs", "restore-map.json"), "utf8"));
      assert.deepEqual(map.entries[0].directories, ["agents", "assets", "assets/empty", "assets/empty/deeper", "notes"]);
      const archived = path.join(archiveRoot, "dirs", map.entries[0].archivedPath);
      assert.deepEqual(fullTree(archived), before, "the archive must hold the exact tree");
      cpSync(archived, path.join(checkoutRoot, map.entries[0].originalPath), { recursive: true });
      assert.deepEqual(fullTree(source), before, "a restore must give the exact tree back");

      // A folder that appears while files are being copied keeps the source in place.
      const late = freshCheckout();
      const lateSource = addSkill(late, "source-command-ship");
      const realCopy = fs.copyFileSync;
      fs.copyFileSync = (...args) => {
        mkdirSync(path.join(lateSource, "late", "empty"), { recursive: true });
        return realCopy(...args);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => archiveImportedSkills({ checkoutRoot: late, archiveRoot: path.join(sandbox, "late-archive"), confirm: true }), /changed while it was being archived/);
      } finally {
        fs.copyFileSync = realCopy;
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(path.join(lateSource, "late", "empty")), true, "a late empty folder must not be lost");

      // A file written after the last check, right before the rename, is not in the
      // verified snapshot, and it survives with the original folder in the archive.
      const lastMoment = freshCheckout();
      const lastSource = addSkill(lastMoment, "source-command-ship");
      const lastBefore = fullTree(lastSource);
      const lastArchive = path.join(sandbox, "last-moment-archive");
      const realRename = fs.renameSync;
      fs.renameSync = (...args) => {
        writeFileSync(path.join(lastSource, "late.md"), "written at the last moment\n");
        return realRename(...args);
      };
      syncBuiltinESMExports();
      let lastResult;
      try {
        lastResult = archiveImportedSkills({ checkoutRoot: lastMoment, archiveRoot: lastArchive, confirm: true, stamp: "last" });
      } finally {
        fs.renameSync = realRename;
        syncBuiltinESMExports();
      }
      assert.deepEqual(lastResult.moved, [".agents/skills/source-command-ship"]);
      assert.equal(existsSync(lastSource), false, "the active skill path must be gone");
      const lastMap = JSON.parse(readFileSync(path.join(lastArchive, "last", "restore-map.json"), "utf8"));
      assert.equal(lastMap.entries[0].originalBackupPath, "originals/source-command-ship");
      assert.match(lastMap.originals, /present only after that folder's move succeeded/);
      const retained = path.join(lastArchive, "last", lastMap.entries[0].originalBackupPath);
      assert.equal(readFileSync(path.join(retained, "late.md"), "utf8"), "written at the last moment\n");
      assert.deepEqual(fullTree(retained).filter((entry) => !entry.startsWith("late.md:")), lastBefore, "the original tree must stay recoverable");
      assert.deepEqual(fullTree(path.join(lastArchive, "last", lastMap.entries[0].archivedPath)), lastBefore, "the snapshot holds what was verified");

      // A rename that cannot be atomic stops the run: no copy-and-delete fallback, the
      // moved folder is retained, and the map's backup path exists only for that one.
      const acrossVolumes = freshCheckout();
      const pair = ["source-command-a", "source-command-b"].map((name) => addSkill(acrossVolumes, name));
      const pairTrees = pair.map(fullTree);
      const volumeArchive = path.join(sandbox, "volume-archive");
      let renames = 0;
      fs.renameSync = (...args) => {
        renames += 1;
        if (renames === 2) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        return realRename(...args);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => archiveImportedSkills({ checkoutRoot: acrossVolumes, archiveRoot: volumeArchive, confirm: true, stamp: "volume" }), /could not be moved in one step \(EXDEV\)/);
      } finally {
        fs.renameSync = realRename;
        syncBuiltinESMExports();
      }
      const volumeMap = JSON.parse(readFileSync(path.join(volumeArchive, "volume", "restore-map.json"), "utf8"));
      const states = volumeMap.entries.map((entry, index) => ({
        active: existsSync(pair[index]),
        retained: existsSync(path.join(volumeArchive, "volume", entry.originalBackupPath)),
      }));
      assert.deepEqual(states.map(({ active }) => active).sort(), [false, true], "exactly one folder moved");
      assert.ok(states.every(({ active, retained }) => active !== retained), "a folder is in one place, and the map's backup path exists only after its move");
      volumeMap.entries.forEach((entry, index) => {
        assert.deepEqual(fullTree(path.join(volumeArchive, "volume", entry.archivedPath)), pairTrees[index], "the verified copy must be kept");
        const place = states[index].active ? pair[index] : path.join(volumeArchive, "volume", entry.originalBackupPath);
        assert.deepEqual(fullTree(place), pairTrees[index], "the original must be untouched wherever it is");
      });
    }

    // Ownership: tracked, staged-then-deleted, generated now, generated at the last
    // sync, and unknown tracking each keep the folder in place.
    {
      const checkoutRoot = freshCheckout();
      addSkill(checkoutRoot, "source-command-tracked");
      addSkill(checkoutRoot, "source-command-deleted");
      addSkill(checkoutRoot, "source-command-generated");
      addSkill(checkoutRoot, "source-command-prior");
      addSkill(checkoutRoot, "source-command-loose");
      writeFileSync(path.join(checkoutRoot, ".agents", "generated-manifest.json"), JSON.stringify({
        version: 1,
        managed: ["skills/source-command-prior/SKILL.md"],
      }));
      const result = archiveImportedSkills({
        checkoutRoot,
        archiveRoot: path.join(sandbox, "ownership-archive"),
        expectedKeys: ["skills/source-command-generated/SKILL.md"],
        trackedPaths: ["skills/source-command-tracked/agents/openai.yaml", "skills/source-command-deleted/gone.md"],
        confirm: true,
      });
      assert.deepEqual(result.moved, [".agents/skills/source-command-loose"]);
      assert.deepEqual(refusedNames(result), [
        "source-command-deleted",
        "source-command-generated",
        "source-command-prior",
        "source-command-tracked",
      ]);
      assert.equal(existsSync(path.join(checkoutRoot, ".agents", "skills", "source-command-tracked", "SKILL.md")), true,
        "one tracked file must hold back its whole folder");

      const unknown = freshCheckout();
      addSkill(unknown, "source-command-ship");
      const blind = archiveImportedSkills({
        checkoutRoot: unknown,
        archiveRoot: path.join(sandbox, "unknown-archive"),
        trackingKnown: false,
        confirm: true,
      });
      assert.deepEqual(blind.moved, [], "unknown tracking must move nothing");
      assert.deepEqual(refusedNames(blind), ["source-command-ship"]);
      assert.match(blind.refused[0].reason, /could not say who owns it/);

      const corrupt = freshCheckout();
      addSkill(corrupt, "source-command-ship");
      writeFileSync(path.join(corrupt, ".agents", "generated-manifest.json"), "{ not json");
      const unreadable = archiveImportedSkills({ checkoutRoot: corrupt, archiveRoot: path.join(sandbox, "corrupt-archive"), confirm: true });
      assert.deepEqual(unreadable.moved, [], "an unreadable manifest must move nothing");
    }

    // Links: a link inside a folder, and a folder that IS a link, are reported and
    // kept, and the target behind the link stays whole.
    {
      const checkoutRoot = freshCheckout();
      const outside = path.join(sandbox, "outside-target");
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "precious.md"), "do not move\n");
      symlinkSync(outside, path.join(addSkill(checkoutRoot, "source-command-nested"), "linked"), "junction");
      symlinkSync(outside, path.join(checkoutRoot, ".agents", "skills", "source-command-whole"), "junction");
      const result = archiveImportedSkills({ checkoutRoot, archiveRoot: path.join(sandbox, "link-archive"), confirm: true });
      assert.deepEqual(result.moved, []);
      assert.deepEqual(refusedNames(result), ["source-command-nested", "source-command-whole"]);
      assert.equal(readFileSync(path.join(outside, "precious.md"), "utf8"), "do not move\n");
      assert.equal(existsSync(path.join(checkoutRoot, ".agents", "skills", "source-command-nested", "SKILL.md")), true);
    }

    // Containment: an archive Codex or Claude would still scan is refused, as is a
    // linked skills directory, which would aim the move at another checkout.
    {
      const checkoutRoot = freshCheckout();
      const source = addSkill(checkoutRoot, "source-command-ship");
      for (const archiveRoot of [
        path.join(checkoutRoot, ".agents", "skills", "archive"),
        path.join(checkoutRoot, ".agents", "archive"),
        path.join(checkoutRoot, ".claude", "skills", "archive"),
        // A leading ".." in a folder's name is not a step up out of the tree.
        path.join(checkoutRoot, ".claude", "skills", "..archive"),
      ]) {
        assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot, confirm: true }), /inside an active skills tree/);
        assert.equal(existsSync(archiveRoot), false, `${archiveRoot} must not be created`);
      }
      assert.equal(existsSync(path.join(source, "SKILL.md")), true);

      // A true sibling with the same kind of name is outside, so a preview accepts it.
      const sibling = path.join(checkoutRoot, ".claude", "..skills-archive");
      assert.deepEqual(archiveImportedSkills({ checkoutRoot, archiveRoot: sibling }).refused, []);
      assert.equal(existsSync(sibling), false, "a preview must not create the archive");

      // An archive root that only reaches the active tree through a link.
      const viaLink = path.join(sandbox, "link-into-agents");
      symlinkSync(path.join(checkoutRoot, ".agents"), viaLink, "junction");
      assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot: viaLink, confirm: true }), /inside an active skills tree/);
      assert.equal(existsSync(path.join(source, "SKILL.md")), true);

      // A new path that crosses an existing link into the active tree is refused before
      // any folder is made there, in a preview as well as a real run.
      for (const [active, into] of [[path.join(checkoutRoot, ".agents", "skills"), "link-into-skills"], [path.join(checkoutRoot, ".claude", "skills"), "link-into-claude-skills"]]) {
        mkdirSync(active, { recursive: true });
        const link = path.join(sandbox, into);
        symlinkSync(active, link, "junction");
        const before = readdirSync(active);
        for (const confirm of [false, true]) {
          assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot: path.join(link, "new", "deep"), confirm }), /inside an active skills tree/);
        }
        assert.deepEqual(readdirSync(active), before, "no folder may be created through the link");
      }

      // A link with nothing behind it cannot be followed by mkdir into the active tree.
      const dangling = path.join(sandbox, "dangling-archive");
      symlinkSync(path.join(checkoutRoot, ".claude", "skills", "not-yet"), dangling, "junction");
      assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot: path.join(dangling, "new"), confirm: true }), /ENOENT/);
      assert.equal(existsSync(path.join(checkoutRoot, ".claude", "skills", "not-yet")), false);
      assert.equal(existsSync(path.join(source, "SKILL.md")), true);

      // A link that appears after the first check is caught by the check after mkdir.
      const raced = path.join(sandbox, "raced-link");
      const racedArchive = path.join(raced, "new");
      const realMkdir = fs.mkdirSync;
      fs.mkdirSync = (target, ...rest) => {
        if (target === racedArchive) symlinkSync(path.join(checkoutRoot, ".claude", "skills"), raced, "junction");
        return realMkdir(target, ...rest);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot: racedArchive, confirm: true }), /inside an active skills tree/);
      } finally {
        fs.mkdirSync = realMkdir;
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(path.join(source, "SKILL.md")), true);

      const linkedCheckout = path.join(sandbox, "linked-checkout");
      mkdirSync(linkedCheckout);
      symlinkSync(path.join(checkoutRoot, ".agents"), path.join(linkedCheckout, ".agents"), "junction");
      assert.throws(() => archiveImportedSkills({ checkoutRoot: linkedCheckout, archiveRoot: path.join(sandbox, "linked-archive"), confirm: true }), /through a link/);
      assert.equal(existsSync(path.join(source, "SKILL.md")), true);

      const notSynced = path.join(sandbox, "not-synced");
      mkdirSync(path.join(notSynced, ".agents", "skills", "source-command-mine"), { recursive: true });
      assert.throws(() => archiveImportedSkills({ checkoutRoot: notSynced, archiveRoot: path.join(sandbox, "foreign-archive"), confirm: true }), /not a synced CRX checkout/);
    }

    // Collision: reusing an archive folder fails before anything is copied or removed.
    {
      const checkoutRoot = freshCheckout();
      const source = addSkill(checkoutRoot, "source-command-ship");
      const archiveRoot = path.join(sandbox, "collision-archive");
      mkdirSync(path.join(archiveRoot, "taken"), { recursive: true });
      assert.throws(() => archiveImportedSkills({ checkoutRoot, archiveRoot, confirm: true, stamp: "taken" }), /EEXIST/);
      assert.equal(existsSync(path.join(source, "SKILL.md")), true, "a collision must leave the source in place");
      assert.deepEqual(readdirSync(path.join(archiveRoot, "taken")), [], "a collision must not write into the earlier archive");
    }

    // The CLI acts on the checkout it is run from, not the one holding this script, and
    // resolves a linked worktree's archive to the shared git directory.
    {
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-agent-workflows.mjs");
      const repo = path.join(sandbox, "cli-repo");
      const worktree = path.join(sandbox, "cli-worktree");
      mkdirSync(path.join(repo, ".agents", "skills"), { recursive: true });
      const inRepo = (...args) => {
        const result = spawnSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      writeFileSync(path.join(repo, ".agents", "generated-manifest.json"), JSON.stringify({ version: 1, managed: [] }));
      addSkill(repo, "source-command-tracked");
      inRepo("init", "-q");
      inRepo("add", "--", ".agents");
      inRepo("commit", "-q", "-m", "seed");
      inRepo("worktree", "add", "-q", worktree);
      addSkill(worktree, "source-command-ship");
      const cli = (...args) => spawnSync(process.execPath, [scriptPath, "--archive-imported", ...args], { cwd: worktree, encoding: "utf8" });

      const preview = cli();
      assert.equal(preview.status, 1, preview.stdout + preview.stderr);
      assert.match(preview.stdout, /KEPT source-command-tracked: it is tracked, staged, or owned/);
      assert.match(preview.stdout, /WOULD ARCHIVE source-command-ship \(2 file\(s\)\)/);
      assert.match(preview.stdout, /DRY RUN: nothing changed/);
      assert.equal(existsSync(path.join(worktree, ".agents", "skills", "source-command-ship", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, ".git", "crx-archive")), false);

      const confirmed = cli("--confirm");
      assert.match(confirmed.stdout, /Archived 1 imported skill folder/);
      assert.equal(existsSync(path.join(worktree, ".agents", "skills", "source-command-ship")), false);
      assert.equal(existsSync(path.join(worktree, ".agents", "skills", "source-command-tracked", "SKILL.md")), true);
      const stamps = readdirSync(path.join(repo, ".git", "crx-archive", "imported-skills"));
      assert.equal(stamps.length, 1, "the archive must land in the shared git directory");
      assert.equal(existsSync(path.join(repo, ".git", "crx-archive", "imported-skills", stamps[0], "restore-map.json")), true);
    }
  }
} finally {
  rmSync(targetRoot, { recursive: true, force: true });
}

console.log("OK - sync-agent-workflows --write repairs CRLF mirrors; Codex-import dirs are quarantined, not ignored.");
