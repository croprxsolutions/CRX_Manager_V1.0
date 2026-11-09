// Staging-first release flow: every decision the workflows make lives here as a plain function,
// tested in release-flow.test.mjs. The workflows only call the CLI at the bottom.
import { pathToFileURL } from 'node:url';

// Only the bot's release branch and hotfix branches may open a PR into main.
export function isReleaseOrHotfixHead(ref) {
  return typeof ref === 'string' && /^(release\/next|hotfix\/[^/].*)$/.test(ref);
}

// Every enforcing check stays inert until the repository variable RELEASE_FLOW is "on".
export function flowEnabled(env) {
  return env.RELEASE_FLOW === 'on';
}

const commands = {
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
