// Temp folders for tests that clean themselves up, even when the test fails.
// Removal never follows a link or junction: a fixture that junctions to a real
// folder (node_modules, a live checkout) must lose only the link, never the target.
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const made = [];
process.on("exit", () => {
  for (const dir of made.splice(0)) {
    try { removeTree(dir); } catch { /* best effort at exit; the leftover check reports it */ }
  }
});

// mkdtempSync in the OS temp folder, removed when the process exits for any reason.
export function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Windows briefly locks a path an indexer or antivirus has open; these clear in milliseconds.
const sleep = new Int32Array(new SharedArrayBuffer(4));
function retryBusy(fn, codes) {
  for (let attempt = 1; ; attempt++) {
    try { return fn(); } catch (e) {
      if (attempt >= 5 || !codes.includes(e.code)) throw e;
      Atomics.wait(sleep, 0, 0, 100 * attempt);
    }
  }
}

// Remove a folder tree. Links and junctions are unlinked, never descended into.
export function removeTree(target) {
  let st;
  try { st = lstatSync(target); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    // EPERM on a file means read-only (handled below), so only EBUSY is retried here.
    try { retryBusy(() => unlinkSync(target), ["EBUSY"]); } catch (e) {
      // Git writes its objects read-only; Windows refuses to delete those until writable.
      // chmod follows links, so never retry a link this way.
      if (st.isSymbolicLink() || (e.code !== "EPERM" && e.code !== "EACCES")) throw e;
      chmodSync(target, 0o666);
      retryBusy(() => unlinkSync(target), ["EBUSY"]);
    }
    return;
  }
  for (const name of readdirSync(target)) removeTree(path.join(target, name));
  retryBusy(() => rmdirSync(target), ["EBUSY", "ENOTEMPTY", "EPERM"]);
}
