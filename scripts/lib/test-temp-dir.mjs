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

// Remove a folder tree. Links and junctions are unlinked, never descended into.
export function removeTree(target) {
  let st;
  try { st = lstatSync(target); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    try { unlinkSync(target); } catch (e) {
      // Git writes its objects read-only; Windows refuses to delete those until writable.
      // chmod follows links, so never retry a link this way.
      if (st.isSymbolicLink() || (e.code !== "EPERM" && e.code !== "EACCES")) throw e;
      chmodSync(target, 0o666);
      unlinkSync(target);
    }
    return;
  }
  for (const name of readdirSync(target)) removeTree(path.join(target, name));
  rmdirSync(target);
}
