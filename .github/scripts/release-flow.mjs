// Staging-first release flow: every decision the workflows make lives here as a plain function,
// tested in release-flow.test.mjs. The workflows only call the CLI at the bottom.
import { pathToFileURL } from 'node:url';

// Only the bot's release branch and hotfix branches may open a PR into main.
export function isReleaseOrHotfixHead(ref) {
  return typeof ref === 'string' && /^(release\/next|hotfix\/[^/]+)$/.test(ref);
}

// release/next may carry only staging's commits and the bot's own "chore(release): vX.Y.Z" commits.
// lines = `git log --no-merges --format=%an%x09%s origin/main..HEAD --not origin/staging`.
export function foreignReleaseCommits(lines) {
  return lines.filter((l) => !/^crx-release-bot\[bot\]\tchore\(release\): v\d+\.\d+\.\d+\S*$/.test(l));
}

// Every enforcing check stays inert until the repository variable RELEASE_FLOW is "on".
export function flowEnabled(env) {
  return env.RELEASE_FLOW === 'on';
}

const commands = {
  // usage (stdin = the git log lines above): release-flow.mjs check-release-commits
  async 'check-release-commits'() {
    const { readFileSync } = await import('node:fs');
    const bad = foreignReleaseCommits(readFileSync(0, 'utf8').split('\n').filter(Boolean));
    if (!bad.length) return 0;
    console.log(`::error::release/next carries commits that are neither on staging nor the release bot's version commit: ${bad.join(' | ').slice(0, 900)}`);
    return 1;
  },
  // usage: release-flow.mjs check-head <head ref>
  'check-head'([ref]) {
    if (isReleaseOrHotfixHead(ref)) return 0;
    console.log(`::error::Only release/next (the weekly release) and hotfix/<name> branches may open a PR into main; '${ref}' should target staging.`);
    return 1;
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [name, ...args] = process.argv.slice(2);
  const run = commands[name];
  if (!run) {
    console.error(`unknown command '${name}'; known: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
  }
  process.exit(await run(args));
}
