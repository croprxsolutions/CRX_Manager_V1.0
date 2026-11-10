// Staging-first release flow: every decision the workflows make lives here as a plain function,
// tested in release-flow.test.mjs. The workflows only call the CLI at the bottom.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// "Held off: <revert PR or flag name>": why a PR on staging isn't shipping this week. It must name
// how: a PR (#123 or a link) or a flag ("flag <name>").
export function heldOffNote(texts) {
  for (const t of texts) {
    const m = /^[ \t]*held off:[ \t]*(\S.*?)[ \t]*$/im.exec(t ?? '');
    if (m && /#\d+|https:\/\/\S+|\bflag\s+\S+/i.test(m[1])) return m[1];
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

// The PR a staging commit came from: GitHub's own commit-to-PR link, accepted only when that PR
// was merged into staging as exactly this commit. A title ending "(#N)" proves nothing.
export function pickPr(sha, pulls) {
  return pulls.find((p) => p.merge_commit_sha === sha && p.base?.ref === 'staging' && p.merged_at) ?? null;
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

// Next tag: a release bumps MINOR, a hotfix bumps PATCH. v1.0.0 (go-live) is typed by hand.
export function nextVersion(tags, kind) {
  const latest = tags
    .map((t) => SEMVER.exec(t))
    .filter(Boolean)
    .map((m) => m.slice(1).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .at(-1) ?? [0, 0, 0];
  const [maj, min, pat] = latest;
  return kind === 'hotfix' ? `v${maj}.${min}.${pat + 1}` : `v${maj}.${min + 1}.0`;
}

// The releaser can change the version by editing the PR title to "release: vX.Y.Z".
export function versionFromTitle(title) {
  const m = /^release:\s*(v\d+\.\d+\.\d+)\s*$/i.exec(title ?? '');
  return m ? m[1] : null;
}

const CHORE_TYPES = new Set(['refactor', 'chore', 'docs', 'ci', 'build', 'test', 'perf', 'style']);

export function groupChangelog(prs) {
  const g = { features: [], fixes: [], chores: [], other: [] };
  for (const pr of prs) {
    const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(pr.title);
    const type = m?.[1].toLowerCase();
    const entry = { number: pr.number, text: m ? m[2] : pr.title };
    if (type === 'feat') g.features.push(entry);
    else if (type === 'fix') g.fixes.push(entry);
    else if (CHORE_TYPES.has(type)) g.chores.push(entry);
    else g.other.push(entry);
  }
  return g;
}

export function changelogMarkdown(g) {
  const sections = [
    ['✨ New Features', g.features],
    ['🐛 Bug Fixes', g.fixes],
    ['🧹 Refactors & Chore', g.chores],
    ['🧩 Other', g.other],
  ].filter(([, items]) => items.length);
  if (!sections.length) return '_Nothing yet._';
  return sections.map(([h, items]) => `#### ${h}\n${items.map((e) => `* ${e.text} (#${e.number})`).join('\n')}`).join('\n\n');
}

const NOTHING = /^(none|nothing|n\/a|-)\.?$/i;

// What a PR says users will notice: a "What users see: …" line, or a "## What users see" list.
export function usersSee(body) {
  const text = body ?? '';
  const line = /^\s*what users see:[ \t]*(.*)$/im.exec(text);
  if (line) return line[1].trim() && !NOTHING.test(line[1].trim()) ? [line[1].trim()] : [];
  const section = /^#+\s*what users see\s*$/im.exec(text);
  if (!section) return [];
  const out = [];
  for (const l of text.slice(section.index + section[0].length).split('\n')) {
    if (/^#/.test(l)) break;
    const item = l.replace(/^\s*[-*]\s*/, '').trim();
    if (item && !NOTHING.test(item)) out.push(item);
  }
  return out;
}

// The release can merge only when every included PR is verified on staging (with its proof link
// still there) or held off (with its reason still there). Read fresh each run, so deleting the
// evidence after labelling turns the gate red again.
export function gateState(prs, orphans) {
  const blocking = [];
  for (const p of prs) {
    const texts = [p.body, ...(p.comments ?? [])];
    if (p.labels.includes('held-off') && heldOffNote(texts)) continue;
    if (p.labels.includes('verified-on-staging') && proofLink(texts)) continue;
    blocking.push(p.labels.includes('verified-on-staging') || p.labels.includes('held-off') ? `#${p.number} (label without its proof or reason)` : `#${p.number}`);
  }
  blocking.push(...orphans.map((s) => `commit without a PR: ${s}`));
  return { ok: blocking.length === 0 && prs.length + orphans.length > 0, blocking };
}

// The app's "What's new" source. JSON.stringify makes every PR-supplied string a safe literal.
export function releaseNotesModule(notes) {
  return `// Written by the release bot (.github/scripts/release-flow.mjs) for each release. Don't edit by hand.
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const releaseNotes: ReleaseNotes = ${JSON.stringify(notes, null, 2)};
`;
}

const INLINE_BLOCKS = new Set(['version', 'date']);

// Fill the <!-- bot:NAME --> … <!-- /bot:NAME --> blocks; everything else (ticked boxes,
// deployment notes) is kept from the current PR body.
export function renderReleaseBody(template, data, previousBody) {
  return (previousBody || template).replace(/<!-- bot:(\w+) -->[\s\S]*?<!-- \/bot:\1 -->/g, (block, key) => {
    if (!(key in data)) return block;
    // PR text can't close or open a bot block.
    const clean = String(data[key]).replace(/<!--|-->/g, '');
    const value = INLINE_BLOCKS.has(key) ? clean : `\n${clean}\n`;
    return `<!-- bot:${key} -->${value}<!-- /bot:${key} -->`;
  });
}

// Minimal GitHub REST helper (GITHUB_TOKEN, GITHUB_REPOSITORY from the Actions environment).
async function gh(path, { method = 'GET', body, allow404 = method === 'DELETE', allow422 = false } = {}) {
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
  if ((res.status === 404 && allow404) || (res.status === 422 && allow422)) return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || method === 'DELETE' ? null : res.json();
}

async function ensureLabels() {
  for (const [name, spec] of Object.entries(LABELS)) {
    if (!(await gh(`/labels/${encodeURIComponent(name)}`, { allow404: true }))) {
      // 422 = another run created it a moment ago, which is fine.
      await gh('/labels', { method: 'POST', body: { name, ...spec }, allow422: true });
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

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Conversation comments, review summaries and inline review comments written by people.
async function humanComments(number) {
  const all = [
    ...(await allPages(`/issues/${number}/comments`)),
    ...(await allPages(`/pulls/${number}/reviews`)),
    ...(await allPages(`/pulls/${number}/comments`)),
  ];
  // On a public repo anyone can comment: only people with access to the repository count.
  return all.filter((c) => TRUSTED.has(c.author_association) && c.user?.type !== 'Bot' && c.body).map((c) => c.body);
}

async function readEvent() {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}

// Today's date where Taha works (the release opens Thursday 08:00 Dubai).
function dubaiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
}

// The first real paragraph of a PR description: no headings, comments or badges, one line.
export function firstParagraph(body, max = 200) {
  for (const para of (body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\n\s*\n/)) {
    const text = para.split('\n').filter((l) => !/^\s*(#|>|\||!\[)/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  }
  return '';
}

function summaryMarkdown(prs, gate) {
  const verified = prs.filter((p) => p.labels.includes('verified-on-staging')).length;
  const held = prs.filter((p) => p.labels.includes('held-off')).length;
  const lines = [`${prs.length} PR(s) since the last release: ${verified} verified on staging, ${held} held off.`];
  lines.push(gate.ok ? 'Release gate: ✅ ready.' : `Release gate: ❌ waiting on ${gate.blocking.join(', ')}.`);
  for (const p of prs) {
    const first = firstParagraph(p.body);
    if (first) lines.push(`* #${p.number}: ${first}`);
  }
  return lines.join('\n');
}

function statusMarkdown(prs, orphans) {
  const row = (p) => {
    const state = p.labels.includes('verified-on-staging') ? '✅ verified' : p.labels.includes('held-off') ? '⏸️ held off' : '❌ not verified';
    const proof = proofLink([p.body, ...(p.comments ?? [])]);
    return `| #${p.number} | ${p.title.replace(/\|/g, '\\|')} | ${state} | ${proof ? `[proof](${proof})` : ''} |`;
  };
  return ['| PR | Title | Staging | Proof |', '|---|---|---|---|', ...prs.map(row), ...orphans.map((s) => `| — | ${s.replace(/\|/g, '\\|')} | ❌ commit without a PR | |`)].join('\n');
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
  // Collects what staging has that main lacks; writes $RUNNER_TEMP/release.json for the next steps.
  async 'release-plan'() {
    const lines = git('log', '--first-parent', '--no-merges', '--format=%H%x09%s', 'origin/main..origin/staging').split('\n').filter(Boolean);
    const prs = [];
    const orphans = [];
    for (const line of lines) {
      const [sha, subject] = line.split('\t');
      const p = pickPr(sha, await gh(`/commits/${sha}/pulls`));
      if (!p) orphans.push(subject);
      else if (!prs.some((x) => x.number === p.number)) {
        prs.push({ number: p.number, title: p.title, body: p.body ?? '', labels: p.labels.map((l) => l.name), comments: await humanComments(p.number) });
      }
    }
    const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
    const [existing] = await gh(`/pulls?state=open&base=main&head=${owner}:release/next`);
    // Tags plus main's package.json, so a forgotten tag never reuses a shipped version.
    const tags = [...git('tag', '--list', 'v*').split('\n').filter(Boolean), `v${JSON.parse(git('show', 'origin/main:package.json')).version}`];
    const version = versionFromTitle(existing?.title) ?? nextVersion(tags, 'release');
    const migrations = git('diff', '--name-only', '--diff-filter=A', 'origin/main...origin/staging', '--', 'supabase/migrations')
      .split('\n').filter(Boolean).map((f) => f.split('/').pop());
    const gate = gateState(prs, orphans);
    const plan = { version, date: dubaiDate(), prs, orphans, gate, migrations, existing: existing ? { number: existing.number, body: existing.body } : null };
    writeFileSync(`${process.env.RUNNER_TEMP}/release.json`, JSON.stringify(plan));
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nhas_work=${prs.length + orphans.length > 0 ? 1 : ''}\npr_exists=${existing ? 1 : ''}\n`);
    console.log(`${version}: ${prs.length} PRs, ${orphans.length} orphan commits, gate ${gate.ok ? 'green' : 'red'}`);
    return 0;
  },
  // On the release/next checkout: version in package.json (+ lock), CHANGELOG.md, src/releaseNotes.ts.
  async 'release-files'() {
    const plan = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/release.json`, 'utf8'));
    const bare = plan.version.slice(1);
    for (const f of ['package.json', 'package-lock.json']) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      j.version = bare;
      if (j.packages?.['']) j.packages[''].version = bare;
      writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
    }
    const shipping = plan.prs.filter((p) => !p.labels.includes('held-off'));
    const section = `## ${plan.version} (${plan.date})\n\n${changelogMarkdown(groupChangelog(shipping))}\n`;
    const old = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '# Changelog\n\nReleases of CRX Manager, newest first.\n';
    const without = old.replace(new RegExp(`## ${plan.version.replace(/\./g, '\\.')} \\([^)]*\\)\\n[\\s\\S]*?(?=\\n## v|$)`), '').trimEnd();
    const [head, ...rest] = without.split(/\n(?=## v)/);
    writeFileSync('CHANGELOG.md', `${[head.trimEnd(), section.trimEnd(), ...rest.map((r) => r.trimEnd())].join('\n\n')}\n`);
    writeFileSync('src/releaseNotes.ts', releaseNotesModule({ version: bare, date: plan.date, items: shipping.flatMap((p) => usersSee(p.body)) }));
    return 0;
  },
  // Opens or updates the release PR and posts the release-gate status on its head.
  async 'release-pr'() {
    const plan = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/release.json`, 'utf8'));
    const template = readFileSync(`${process.env.RUNNER_TEMP}/release-pr-template.md`, 'utf8');
    const shipping = plan.prs.filter((p) => !p.labels.includes('held-off'));
    const body = renderReleaseBody(template, {
      version: plan.version,
      date: plan.date,
      summary: summaryMarkdown(plan.prs, plan.gate),
      changelog: changelogMarkdown(groupChangelog(shipping)),
      status: statusMarkdown(plan.prs, plan.orphans),
      users: shipping.flatMap((p) => usersSee(p.body)).map((s) => `* ${s}`).join('\n') || '_Nothing user-facing._',
      migrations: plan.migrations.length ? plan.migrations.map((m) => `\`${m}\``).join(', ') : 'None',
    }, plan.existing?.body);
    const title = `release: ${plan.version}`;
    if (process.env.DRY_RUN) {
      console.log(`DRY RUN: would ${plan.existing ? `update #${plan.existing.number}` : 'open'} "${title}", release-gate ${plan.gate.ok ? 'success' : 'failure'}\n\n${body}`);
      return 0;
    }
    const pr = plan.existing
      ? await gh(`/pulls/${plan.existing.number}`, { method: 'PATCH', body: { title, body } })
      : await gh('/pulls', { method: 'POST', body: { title, body, head: 'release/next', base: 'main' } });
    // The commit this run built and pushed; anything pushed after it has no green status.
    const sha = process.env.RELEASE_SHA;
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('RELEASE_SHA is not set');
    await gh(`/statuses/${sha}`, {
      method: 'POST',
      body: {
        state: plan.gate.ok ? 'success' : 'failure',
        context: 'release-gate',
        description: (plan.gate.ok ? 'Every PR is verified on staging or held off' : `Waiting on ${plan.gate.blocking.join(', ')}`).slice(0, 140),
        target_url: pr.html_url,
      },
    });
    console.log(`${pr.html_url} (${plan.version}), release-gate ${plan.gate.ok ? 'success' : 'failure'}`);
    return 0;
  },
  // A hotfix PR into main gets release-gate from the release bot (dispatched by the guard), after
  // the same checks the guard makes: this repository, hotfix/<name>, contains main, no staging work.
  async 'hotfix-gate'() {
    const pr = await gh(`/pulls/${Number(process.env.HOTFIX_PR)}`);
    const sha = pr.head.sha;
    let problem = null;
    if (pr.state !== 'open' || pr.base.ref !== 'main') problem = 'not an open PR into main';
    else if (pr.head.repo?.full_name !== process.env.GITHUB_REPOSITORY || !/^hotfix\/[^/]+$/.test(pr.head.ref)) problem = 'not a hotfix/<name> branch of this repository';
    else {
      git('fetch', '--no-tags', 'origin', sha);
      const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
      if (!isAncestor('origin/main', sha)) problem = 'missing commits from main';
      else if (!isAncestor(git('merge-base', sha, 'origin/staging'), 'origin/main')) problem = 'carries staging work that has not been released';
    }
    await gh(`/statuses/${sha}`, {
      method: 'POST',
      body: { state: problem ? 'failure' : 'success', context: 'release-gate', description: problem ? `Hotfix refused: ${problem}` : 'Hotfix: no weekly release gate', target_url: pr.html_url },
    });
    console.log(`#${pr.number} hotfix gate: ${problem ?? 'ok'}`);
    return 0;
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
  // Reads the PR fresh, so an edit made while this queued is seen; removes only a label still there.
  async 'check-label'() {
    const { pull_request: event, label } = await readEvent();
    const pr = await gh(`/pulls/${event.number}`);
    if (!pr.labels.some((l) => l.name === label?.name)) return 0;
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
