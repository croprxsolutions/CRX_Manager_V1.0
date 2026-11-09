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

// The first line "Staging proof: https://…" in the PR body or any comment (key case-insensitive).
// The link must be on the same line and be a real https URL with a host.
export function proofLink(texts) {
  for (const t of texts) {
    for (const m of (t ?? '').matchAll(/^[ \t]*staging proof:[ \t]*(\S+)/gim)) {
      try {
        const url = new URL(m[1]);
        if (url.protocol === 'https:' && url.hostname.includes('.')) return m[1];
      } catch {
        // not a URL; keep looking
      }
    }
  }
  return null;
}

// "Held off: <revert PR or flag name>": why a PR on staging isn't shipping this week.
export function heldOffNote(texts) {
  for (const t of texts) {
    const m = /^[ \t]*held off:[ \t]*(\S.*?)[ \t]*$/im.exec(t ?? '');
    if (m) return m[1];
  }
  return null;
}

// The back-merge PR (main -> staging) is plumbing, not work: no labels, not in release lists.
export function isBackMerge(headRef) {
  return headRef === 'main';
}

export const LABELS = {
  'on-staging': { color: '0ea5a4', description: 'Merged into staging (added by the release flow)' },
  'verified-on-staging': { color: '16a34a', description: 'Tried on staging; needs a "Staging proof: <link>" line' },
  'held-off': { color: 'f59e0b', description: 'On staging but not shipping: "Held off: <revert PR or flag>"' },
};

// Why a label can't stay, or null when it can. on-staging is the bot's; added by hand to an
// unmerged PR or a back-merge, it goes.
export function labelProblem({ label, merged, baseRef, headRef, texts }) {
  if (!(label in LABELS)) return null;
  if (isBackMerge(headRef)) return `The back-merge PR (main into staging) isn't release work, so I removed \`${label}\`.`;
  if (!merged || baseRef !== 'staging') {
    return `\`${label}\` goes on after the PR is merged into staging and tried there, so I removed it.`;
  }
  if (label === 'verified-on-staging' && !proofLink(texts)) {
    return 'I removed `verified-on-staging`: add a line `Staging proof: <link>` (an https link to a screenshot, recording or comment showing it working on staging) to the PR description or a comment, then add the label again.';
  }
  if (label === 'held-off' && !heldOffNote(texts)) {
    return 'I removed `held-off`: add a line `Held off: <revert PR or flag name>` saying how it is kept out of this release, then add the label again.';
  }
  return null;
}

// Minimal GitHub REST helper (GITHUB_TOKEN, GITHUB_REPOSITORY from the Actions environment).
async function gh(path, { method = 'GET', body, allow404 = method === 'DELETE' } = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || method === 'DELETE' ? null : res.json();
}

async function ensureLabels() {
  for (const [name, spec] of Object.entries(LABELS)) {
    if (!(await gh(`/labels/${encodeURIComponent(name)}`, { allow404: true }))) {
      await gh('/labels', { method: 'POST', body: { name, ...spec } });
    }
  }
}

async function allPages(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

// Conversation comments, review summaries and inline review comments written by people.
async function humanComments(number) {
  const all = [
    ...(await allPages(`/issues/${number}/comments`)),
    ...(await allPages(`/pulls/${number}/reviews`)),
    ...(await allPages(`/pulls/${number}/comments`)),
  ];
  return all.filter((c) => c.user?.type !== 'Bot' && c.body).map((c) => c.body);
}

async function readEvent() {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
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
  // pull_request closed into staging: label the merged work on-staging (not the back-merge PR).
  async 'mark-on-staging'() {
    const { pull_request: pr } = await readEvent();
    if (!pr.merged || pr.base.ref !== 'staging' || isBackMerge(pr.head.ref)) return 0;
    await ensureLabels();
    await gh(`/issues/${pr.number}/labels`, { method: 'POST', body: { labels: ['on-staging'] } });
    console.log(`#${pr.number} labelled on-staging`);
    return 0;
  },
  // pull_request labeled: verified-on-staging needs a proof link, held-off needs a reason.
  async 'check-label'() {
    const { pull_request: pr, label } = await readEvent();
    const texts = [pr.body, ...(await humanComments(pr.number))];
    const problem = labelProblem({ label: label?.name, merged: pr.merged, baseRef: pr.base.ref, headRef: pr.head.ref, texts });
    if (!problem) return 0;
    await gh(`/issues/${pr.number}/labels/${encodeURIComponent(label.name)}`, { method: 'DELETE' });
    await gh(`/issues/${pr.number}/comments`, { method: 'POST', body: { body: problem } });
    console.log(`#${pr.number}: removed ${label.name}`);
    return 0;
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
