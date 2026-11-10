// removeTree deletes a fixture but never what a junction or symlink inside it points at.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTree, tempDir } from "./test-temp-dir.mjs";

const outside = mkdtempSync(path.join(os.tmpdir(), "crx-tempdir-target-"));
try {
  writeFileSync(path.join(outside, "keep.txt"), "real data");
  const fixture = tempDir("crx-tempdir-fixture-");
  mkdirSync(path.join(fixture, "nested"));
  writeFileSync(path.join(fixture, "nested", "ro.txt"), "x", { mode: 0o444 });
  let linked = 0;
  try { symlinkSync(outside, path.join(fixture, "junction"), "junction"); linked++; } catch { /* platform cannot */ }
  try { symlinkSync(path.join(outside, "keep.txt"), path.join(fixture, "file-link")); linked++; } catch { /* needs privilege on Windows */ }
  assert.ok(linked > 0, "the fixture holds at least one link to the outside folder");

  removeTree(fixture);
  assert.equal(existsSync(fixture), false, "the fixture folder is gone, read-only files included");
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "real data", "the linked-to folder is untouched");
  removeTree(fixture); // already gone: no error

  // A test that crashes partway still leaves nothing behind.
  const crashTmp = mkdtempSync(path.join(outside, "crash-"));
  const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "test-temp-dir.mjs")).href;
  const crash = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { tempDir } from ${JSON.stringify(helper)}; tempDir("crx-crash-"); throw new Error("boom");`],
  { env: { ...process.env, TMP: crashTmp, TEMP: crashTmp, TMPDIR: crashTmp }, encoding: "utf8" });
  assert.notEqual(crash.status, 0, "the child really crashed");
  assert.deepEqual(readdirSync(crashTmp), [], "a crashed test's temp folder is still removed");

  // Windows briefly locks a folder (antivirus, indexer): removal retries that, and only that.
  const realRmdir = fs.rmdirSync;
  const failRmdirWith = (code, times) => {
    let left = times;
    fs.rmdirSync = (...args) => {
      if (left-- > 0) throw Object.assign(new Error(`${code}: stubbed`), { code });
      return realRmdir(...args);
    };
    syncBuiltinESMExports();
  };
  try {
    const busy = tempDir("crx-tempdir-busy-");
    failRmdirWith("EBUSY", 2);
    removeTree(busy);
    assert.equal(existsSync(busy), false, "a briefly busy folder is removed after a retry");

    const denied = tempDir("crx-tempdir-denied-");
    failRmdirWith("EACCES", 1);
    assert.throws(() => removeTree(denied), { code: "EACCES" }, "a non-transient error throws at once");
    assert.equal(existsSync(denied), true, "no retry happened after the non-transient error");

    const stuck = tempDir("crx-tempdir-stuck-");
    failRmdirWith("EBUSY", 1000);
    assert.throws(() => removeTree(stuck), { code: "EBUSY" }, "a lock that never clears still fails, boundedly");
  } finally {
    fs.rmdirSync = realRmdir;
    syncBuiltinESMExports();
  }
  console.log("test-temp-dir: all assertions passed");
} finally {
  rmSync(outside, { recursive: true, force: true });
}
