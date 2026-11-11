// Staging-first release flow: every decision the workflows make lives here as a plain function,
// tested in release-flow.test.mjs. The workflows only call the CLI at the bottom.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only the bot's release branch and hotfix branches may open a PR into main.
export function isReleaseOrHotfixHead(ref) {
  return typeof ref === 'string' && /^(release\/next|hotfix\/[^/]+)$/.test(ref);
}

// release/next may differ from "staging merged with main" only in the files the bot writes.
// Comparing trees (not commits or authors) also catches a change hidden in a merge commit.
export const BOT_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'src/releaseNotes.ts'];
export function releaseExtraFiles(files) {
  return files.filter((f) => !BOT_FILES.includes(f));
}

// X.Y.Z compared as numbers.
export function versionIsNewer(now, was) {
  const [a, b] = [now, was].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The version the bot sets must be one plain X.Y.Z, the same in package.json, its lock and the notes,
// with its own section in CHANGELOG.md.
export function versionProblems(pkg, lock, notes, changelog = null) {
  try {
    const versions = [JSON.parse(pkg).version, JSON.parse(lock).version, JSON.parse(lock).packages?.['']?.version,
      JSON.parse(/export const releaseNotes: ReleaseNotes = ([\s\S]*);\n$/.exec(notes)[1]).version];
    if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versions[0]) && versions.every((v) => v === versions[0])) {
      return changelog === null || changelog.includes(`\n## v${versions[0]} (`) ? [] : [`CHANGELOG.md has no section for v${versions[0]}`];
    }
    return [`the version isn't one X.Y.Z across package.json, package-lock.json and src/releaseNotes.ts (${versions.join(', ')})`];
  } catch {
    return ['package.json, package-lock.json or src/releaseNotes.ts is missing or unreadable'];
  }
}

// Inside those files, only what the bot writes may differ: the version in package.json and its lock,
// and a releaseNotes.ts that is exactly the bot's module (no code). CHANGELOG.md is text only.
export function botFileProblems(file, expected, actual) {
  if (actual === null) return [`${file} is missing (the bot always writes it)`];
  if (file === 'src/releaseNotes.ts') {
    // Always the bot's exact module, even when unchanged: this file is app code.
    try {
      const notes = JSON.parse(/export const releaseNotes: ReleaseNotes = ([\s\S]*);\n$/.exec(actual)[1]);
      const shape = Object.keys(notes).join() === 'version,date,items' && typeof notes.version === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(notes.date) && Array.isArray(notes.items) && notes.items.every((i) => typeof i === 'string');
      if (shape && actual === releaseNotesModule(notes)) return [];
    } catch { /* not the bot's module */ }
    return [`${file} isn't exactly the module the bot writes (a version, a date and a list of strings)`];
  }
  if (expected === actual) return [];
  if (file === 'package.json' || file === 'package-lock.json') {
    const strip = (t) => {
      const j = JSON.parse(t);
      delete j.version;
      if (file === 'package-lock.json' && j.packages?.['']) delete j.packages[''].version;
      return JSON.stringify(j);
    };
    try { if (strip(expected) === strip(actual)) return []; } catch { /* unreadable counts as a difference */ }
    return [`${file} differs from staging + main outside its version field`];
  }
  if (file === 'CHANGELOG.md') {
    // Text only, but every earlier release's section stays word for word.
    const sections = `\n${expected ?? ''}`.split(/\n(?=## v\d)/).filter((sec) => sec.startsWith('## v')).map((sec) => sec.trimEnd());
    // Each one whole: from its heading line to the next release heading (or the end), nothing added.
    const padded = `\n${actual.trimEnd()}\n\n## v`;
    const lost = sections.filter((sec) => !padded.includes(`\n${sec}\n\n## v`)).map((sec) => sec.split('\n')[0]);
    return lost.length ? [`CHANGELOG.md changed or lost earlier release sections (${lost.slice(0, 5).join('; ')})`] : [];
  }
  return [];
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
// how: a PR or commit (#123 or a GitHub link) or a flag ("flag <name>").
export function heldOffNote(texts) {
  for (const t of texts) {
    for (const m of (t ?? '').matchAll(/^[ \t]*held off:[ \t]*(\S.*?)[ \t]*$/gim)) {
      if (/#\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(pull|commit)\/\w+|\bflag\s+\S+/i.test(m[1])) return m[1];
    }
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

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
  const m = /^release:\s*v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\s*$/i.exec(title ?? '');
  return m ? `v${m[1]}` : null;
}

// The releaser's version wins only if it is newer than everything shipped (tags + main's package.json).
export function releaseVersion(title, shipped) {
  const auto = nextVersion(shipped, 'release');
  const typed = versionFromTitle(title);
  if (!typed) return auto;
  const floor = nextVersion(shipped, 'hotfix'); // one patch past the newest shipped version
  const n = (v) => SEMVER.exec(v).slice(1).map(Number);
  const [a, b] = [n(typed), n(floor)];
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return cmp >= 0 ? typed : auto;
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
// "None" means nothing; the template's "<…>" placeholder counts as not filled in.
export function usersSee(body) {
  const text = body ?? '';
  const line = /^[ \t]*what users see:[ \t]*(.*)$/im.exec(text);
  const said = line?.[1].trim() ?? '';
  if (NOTHING.test(said)) return [];
  if (said && !said.startsWith('<')) return [said];
  const section = /^[ ]{0,3}#+\s*what users see\s*$/im.exec(text);
  if (!section) return [];
  const out = [];
  for (const l of text.slice(section.index + section[0].length).split('\n')) {
    if (/^[ ]{0,3}#/.test(l)) break;
    const item = l.replace(/^\s*[-*]\s*/, '').trim();
    if (item && !NOTHING.test(item) && !item.startsWith('<') && !/^what users see:/i.test(item)) out.push(item);
  }
  return out;
}

// A PR's release state, read fresh each run: held-off needs its reason (and wins over verified),
// verified needs its proof link still present.
export function prState(p) {
  const texts = [p.body, ...(p.comments ?? [])];
  if (p.labels.includes('held-off')) return heldOffNote(texts) ? 'held' : 'missing';
  if (p.labels.includes('verified-on-staging')) return proofLink(texts) ? 'verified' : 'missing';
  return 'unverified';
}

// The release can merge only when every included PR is verified (with proof) or held off (with a
// reason). Deleting the evidence after labelling turns the gate red again at the next refresh.
export function gateState(prs, orphans) {
  const blocking = [];
  for (const p of prs) {
    const state = prState(p);
    if (state === 'missing') blocking.push(`#${p.number} (label without its proof or reason)`);
    else if (state === 'unverified') blocking.push(`#${p.number}`);
  }
  blocking.push(...orphans.map((x) => `commit without a PR: ${x}`));
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

// One version's section of CHANGELOG.md (without its heading), or null.
export function changelogSection(markdown, version) {
  const head = new RegExp(`^## ${escapeRegExp(version)} \\(`, 'm').exec(markdown);
  if (!head) return null;
  const rest = markdown.slice(head.index).split('\n').slice(1).join('\n');
  const end = rest.search(/^## v/m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

const INLINE_BLOCKS = new Set(['version', 'date']);

// Turns comment markers into visible text (one pass, nothing removed, so nothing can be rebuilt):
// PR text can't open or close a comment or a bot block, and "A --> B" still reads as an arrow.
export function neutralizeCommentMarkers(text) {
  return String(text).replace(/<!--/g, '&lt;!--').replace(/--(!?)>/g, '--$1&gt;');
}
// A markdown table cell: one line, no HTML tags, backslashes escaped first, then pipes.
export const cell = (text) => String(text).replace(/\s*[\r\n]+\s*/g, ' ').replace(/</g, '&lt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

// Drops closed <!-- … --> (or --!>) comments in one left-to-right scan; an unclosed one stays as text.
// ponytail: not Markdown-aware, so a "<!--" inside inline code still pairs with a later "-->".
export function dropComments(text) {
  const close = /--!?>/g;
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('<!--', i);
    if (open < 0) return out + text.slice(i);
    close.lastIndex = open + 4;
    const end = close.exec(text); // the first closer after the opener; each scan starts past the last
    if (!end) return out + text.slice(i);
    out += text.slice(i, open);
    i = end.index + end[0].length;
  }
}

// Fill the <!-- bot:NAME --> … <!-- /bot:NAME --> blocks; everything else (ticked boxes,
// deployment notes) is kept from the current PR body.
export function renderReleaseBody(template, data, previousBody) {
  return (previousBody || template).replace(/<!-- bot:(\w+) -->[\s\S]*?<!-- \/bot:\1 -->/g, (block, key) => {
    if (!(key in data)) return block;
    // PR text can't close or open a bot block.
    const clean = neutralizeCommentMarkers(data[key]);
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
    ...(await allPages(`/pulls/${number}/reviews`)).filter((r) => r.state !== 'DISMISSED'),
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

function isAncestor(a, b) {
  try {
    git('merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
}

// Today's date where Taha works (the release opens Thursday 08:00 Dubai).
function dubaiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
}

// The first real paragraph of a PR description: no headings, comments or badges, one line.
export function firstParagraph(body, max = 200) {
  // Closed comments go whole; a stray marker (an unclosed comment, "<!--" in code) stays as text.
  for (const para of neutralizeCommentMarkers(dropComments(body ?? '')).split(/\n\s*\n/)) {
    const text = para.split('\n').filter((l) => !/^\s*(#|>|\||!\[)/.test(l) && !/^\s*(what users see|staging proof|held off):/i.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  }
  return '';
}

function summaryMarkdown(prs, gate) {
  const verified = prs.filter((p) => prState(p) === 'verified').length;
  const held = prs.filter((p) => prState(p) === 'held').length;
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
    const state = { verified: '✅ verified', held: '⏸️ held off', missing: '❌ label without proof or reason', unverified: '❌ not verified' }[prState(p)];
    const proof = proofLink([p.body, ...(p.comments ?? [])]);
    return `| #${p.number} | ${cell(p.title)} | ${state} | ${proof ? `[proof](${proof})` : ''} |`;
  };
  return ['| PR | Title | Staging | Proof |', '|---|---|---|---|', ...prs.map(row), ...orphans.map((s) => `| — | ${cell(s)} | ❌ commit without a PR | |`)].join('\n');
}

// Loaded only by the commands that post to Slack, so the guard and label jobs need just this file.
const slackKit = () => import('./release-slack.mjs');

const REPO_URL = () => `https://github.com/${process.env.GITHUB_REPOSITORY}`;

// What the Slack card shows for a release plan (also what its hidden marker remembers).
function cardState(plan) {
  return { v: plan.version, date: plan.date, states: Object.fromEntries(plan.prs.map((p) => [p.number, prState(p)])), gate: plan.gate.ok, mig: plan.migrations.length, orph: plan.orphans.length };
}
function slackPrs(plan) {
  return plan.prs.map((p) => {
    const texts = [p.body, ...(p.comments ?? [])];
    return { number: p.number, title: p.title, url: `${REPO_URL()}/pull/${p.number}`, state: prState(p), proof: proofLink(texts), held: heldOffNote(texts) };
  });
}

// Posts the release card, or edits it in place. Returns the marker to save and the thread replies
// for what changed, which are posted only once that marker is saved (a failed save can't repeat them).
async function syncCard({ cardMessage, slack, threadUpdates }, plan, prUrl, prev) {
  const now = cardState(plan);
  const prs = slackPrs(plan);
  const msg = cardMessage(now, { prs, prUrl, compareUrl: `${REPO_URL()}/compare/main...release/next` });
  const ch = process.env.SLACK_RELEASE_CHANNEL;
  if (!prev?.ts || prev.ch !== ch) return { marker: { ts: (await slack('chat.postMessage', msg)).ts, ch, ...now }, replies: [] };
  await slack('chat.update', { ts: prev.ts, ...msg });
  return { marker: { ...prev, ...now }, replies: threadUpdates(prev, { prs, gateOk: plan.gate.ok }) };
}

const commands = {
  // usage (stdin = changed file names): release-flow.mjs check-release-files
  // usage: release-flow.mjs check-release-content <expected tree> <release/next sha>
  async 'check-release-content'([expected, head]) {
    // null when `git cat-file -e` can't find the path (missing, or the ref itself is unreadable: the head
    // side then reports "missing"); reading a file that exists has no size cap and throws on any error.
    const show = (ref, f) => {
      try { execFileSync('git', ['cat-file', '-e', `${ref}:${f}`], { stdio: 'ignore' }); } catch { return null; }
      return execFileSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    };
    const problems = BOT_FILES.flatMap((f) => botFileProblems(f, show(expected, f), show(head, f)));
    problems.push(...versionProblems(show(head, 'package.json'), show(head, 'package-lock.json'), show(head, 'src/releaseNotes.ts'), show(head, 'CHANGELOG.md') ?? ''));
    // A release is a newer version than staging + main's (an equal or older one re-publishes history).
    try {
      const [now, was] = [head, expected].map((ref) => JSON.parse(show(ref, 'package.json')).version);
      if (!versionIsNewer(now, was)) problems.push(`the version ${now} isn't newer than staging + main's ${was}`);
    } catch { /* unreadable: versionProblems already reports it */ }
    for (const p of problems) console.log(`::error::release/next: ${p}. Only the release bot writes these files.`);
    return problems.length ? 1 : 0;
  },
  async 'check-release-files'() {
    const extra = releaseExtraFiles(readFileSync(0, 'utf8').split('\n').filter(Boolean));
    if (!extra.length) return 0;
    console.log(`::error::release/next differs from staging + main outside the bot's files (${extra.slice(0, 20).join(', ')}). If staging just moved, the bot refreshes release/next on that push.`);
    return 1;
  },
  // Collects what staging has that main lacks; writes $RUNNER_TEMP/release.json for the next steps.
  async 'release-plan'() {
    // Merge commits count too (a PR merged with a merge commit); only back-merges and catch-ups,
    // whose second parent is already on main, are skipped.
    const lines = git('log', '--first-parent', '--format=%H%x09%P%x09%s', 'origin/main..origin/staging').split('\n').filter(Boolean);
    const prs = [];
    const orphans = [];
    for (const line of lines) {
      const [sha, parents, subject] = line.split('\t');
      const second = parents.split(' ')[1];
      if (second && isAncestor(second, 'origin/main')) continue;
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
    const version = releaseVersion(existing?.title, tags);
    // Until this run posts the new result, the open release PR's gate is "pending", so a run that
    // fails half-way can't leave an old green gate behind.
    if (existing && prs.length + orphans.length > 0) {
      await gh(`/statuses/${existing.head.sha}`, { method: 'POST', body: { state: 'pending', context: 'release-gate', description: 'Release PR is being refreshed' } });
    }
    const migrations = git('diff', '--name-only', '--diff-filter=AM', 'origin/main...origin/staging', '--', 'supabase/migrations')
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
    const without = old.replace(new RegExp(`## ${escapeRegExp(plan.version)} \\([^)]*\\)\\n[\\s\\S]*?(?=\\n## v|$)`), '').trimEnd();
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
    const S = await slackKit();
    if (process.env.DRY_RUN) {
      console.log(`DRY RUN: would ${plan.existing ? `update #${plan.existing.number}` : 'open'} "${title}", release-gate ${plan.gate.ok ? 'success' : 'failure'}\n\n${body}`);
      console.log(`Slack card: ${JSON.stringify(S.cardMessage(cardState(plan), { prs: slackPrs(plan), prUrl: 'https://github.com/x/y/pull/0' }))}`);
      return 0;
    }
    // The Slack card goes up before the PR is written, so its place is saved in the same edit.
    let pr;
    let card;
    if (plan.existing) {
      card = await S.trySlack(() => syncCard(S, plan, `${REPO_URL()}/pull/${plan.existing.number}`, S.readMarker(plan.existing.body)));
      pr = await gh(`/pulls/${plan.existing.number}`, { method: 'PATCH', body: { title, body: card ? S.writeMarker(body, card.marker) : body } });
    } else {
      pr = await gh('/pulls', { method: 'POST', body: { title, body, head: 'release/next', base: 'main' } });
      card = await S.trySlack(() => syncCard(S, plan, pr.html_url, null));
      if (card) await gh(`/pulls/${pr.number}`, { method: 'PATCH', body: { body: S.writeMarker(pr.body, card.marker) } });
    }
    if (card?.replies.length) await S.trySlack(async () => { for (const text of card.replies) await S.slack('chat.postMessage', { thread_ts: card.marker.ts, text }); });
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
  // push to main (back-merge job): tell Slack what landed. BACK_MERGE_PR is set when this push opened one.
  async 'main-pushed'() {
    const sha = process.env.SHA;
    const hit = (await gh(`/commits/${sha}/pulls`)).find((p) => p.merge_commit_sha === sha && p.base?.ref === 'main' && p.merged_at);
    if (!hit) return 0;
    const { backMergeText, cardMessage, esc, hotfixMessage, liveMessage, parseReleaseNotes, readMarker, slack, SQUASHED, trySlack, writeMarker } = await slackKit();
    await trySlack(async () => {
      const pr = await gh(`/pulls/${hit.number}`);
      const by = pr.merged_by?.login ?? 'someone';
      const ch = process.env.SLACK_RELEASE_CHANNEL;
      let thread;
      if (pr.head.ref === 'release/next') {
        const m = readMarker(pr.body);
        const card = m?.ts && m.ch === ch ? m : null;
        const v = `v${JSON.parse(git('show', `${sha}:package.json`)).version}`;
        const tagUrl = `${REPO_URL()}/releases/tag/${v}`;
        const merged = git('rev-list', '--parents', '-n', '1', sha).split(' ').length === 3;
        if (card) await slack('chat.update', { ts: card.ts, ...cardMessage({ ...card, v }, { phase: merged ? 'merged' : 'squashed', prUrl: pr.html_url, tagUrl, mergedBy: by }) });
        thread = card?.ts;
        if (!merged) {
          await slack('chat.postMessage', { thread_ts: thread, reply_broadcast: Boolean(thread), text: SQUASHED });
        } else {
          if (thread) await slack('chat.postMessage', { thread_ts: thread, text: `:twisted_rightwards_arrows: Merged into main by ${esc(by)}. Tag ${v} and its GitHub Release follow.` });
          const notes = parseReleaseNotes(git('show', `${sha}:src/releaseNotes.ts`));
          const live = await slack('chat.postMessage', liveMessage({
            version: v, items: notes?.items ?? [], prCount: card ? Object.keys(card.states ?? {}).length : null, migrations: card?.mig ?? null,
            mergedBy: by, tagUrl, changelogUrl: `${REPO_URL()}/blob/main/CHANGELOG.md`, prUrl: pr.html_url,
          }));
          thread ??= live.ts;
        }
      } else if (isReleaseOrHotfixHead(pr.head.ref)) {
        thread = (await slack('chat.postMessage', hotfixMessage({ number: pr.number, title: pr.title, url: pr.html_url, mergedBy: by, releasesUrl: `${REPO_URL()}/releases` }))).ts;
      } else return;
      const bm = Number(process.env.BACK_MERGE_PR);
      if (bm && thread) {
        const b = await gh(`/pulls/${bm}`);
        await slack('chat.postMessage', { thread_ts: thread, text: backMergeText('opened', bm, b.html_url) });
        await gh(`/pulls/${bm}`, { method: 'PATCH', body: { body: writeMarker(b.body, { ts: thread, ch, at: Date.now() }) } });
      }
    });
    return 0;
  },
  // Every release-pr run (pushes, labels, nightly): reply when a back-merge lands, warn once if one
  // has waited over 12 hours. State lives in the back-merge PR's hidden marker.
  async 'back-merge-slack'() {
    const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
    const { backMergeText, readMarker, slack, trySlack, writeMarker } = await slackKit();
    await trySlack(async () => {
      const ch = process.env.SLACK_RELEASE_CHANNEL;
      for (const p of await gh(`/pulls?state=all&base=staging&head=${owner}:main&sort=updated&direction=desc&per_page=10`)) {
        const m = readMarker(p.body);
        if (!m?.ts || m.ch !== ch || m.done) continue;
        // The marker is saved before posting, so a failed save never repeats a post.
        let next = null;
        let post = null;
        if (p.merged_at) [next, post] = [{ ...m, done: true }, { thread_ts: m.ts, text: backMergeText('merged', p.number, p.html_url) }];
        else if (p.state === 'closed') next = { ...m, done: true };
        else if (!m.warned && Date.now() - Number(m.at) > 12 * 3600 * 1000) {
          [next, post] = [{ ...m, warned: true }, { thread_ts: m.ts, reply_broadcast: true, text: backMergeText('overdue', p.number, p.html_url) }];
        }
        if (next) await gh(`/pulls/${p.number}`, { method: 'PATCH', body: { body: writeMarker(p.body, next) } });
        if (post) await slack('chat.postMessage', post);
      }
    });
    return 0;
  },
  // pull_request closed into main: tag the merge commit and publish the GitHub Release.
  async 'tag-release'() {
    const { pull_request: pr } = await readEvent();
    const sha = pr.merge_commit_sha;
    // The commit a tag points at (an annotated tag's ref points at a tag object first).
    const tagSha = async (v) => {
      const ref = await gh(`/git/ref/tags/${v}`, { allow404: true });
      if (!ref) return null;
      return ref.object.type === 'tag' ? (await gh(`/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha;
    };
    // Creating the tag ref is atomic: if it already exists (422), it's ours only if it points here.
    const claim = async (v) => (await gh('/git/refs', { method: 'POST', body: { ref: `refs/tags/${v}`, sha }, allow422: true })) !== null || (await tagSha(v)) === sha;
    // Publish (or finish publishing) the release for a tag that points at this merge commit.
    const publish = async (version, notes) => {
      const existing = await gh(`/releases/tags/${version}`, { allow404: true });
      const rel = existing ?? (await gh('/releases', { method: 'POST', body: { tag_name: version, target_commitish: sha, name: version, body: notes } }));
      console.log(`${version} at ${sha}: ${rel.html_url}`);
      return 0;
    };
    if (pr.head.ref === 'release/next') {
      const version = `v${JSON.parse(git('show', `${sha}:package.json`)).version}`;
      const notes = changelogSection(git('show', `${sha}:CHANGELOG.md`), version);
      if (!notes) throw new Error(`CHANGELOG.md at ${sha} has no ${version} section`);
      if (!(await claim(version))) {
        console.log(`::error::Tag ${version} already exists on another commit; tag ${sha} by hand with a new version.`);
        return 1;
      }
      return publish(version, notes);
    }
    if (!isReleaseOrHotfixHead(pr.head.ref)) return 0;
    // A hotfix takes the next free patch above every tag and the version in its own package.json.
    // Two hotfixes merged together each move on to the next number instead of colliding.
    // ponytail: the commit's package.json keeps the release version; only the tag says vX.Y.(Z+1).
    const notes = `#### 🚑 Hotfix\n* ${pr.title} (#${pr.number})\n\n${firstParagraph(pr.body, 600)}`;
    git('fetch', '--tags', '--force', 'origin');
    // A re-run (or a run whose publish failed) finishes the version this commit already has.
    const mine = git('tag', '--points-at', sha, '--list', 'v*').split('\n').filter(Boolean)[0];
    if (mine) return publish(mine, notes);
    const known = [...git('tag', '--list', 'v*').split('\n').filter(Boolean), `v${JSON.parse(git('show', `${sha}:package.json`)).version}`];
    for (let i = 0; i < 10; i++) {
      const version = nextVersion(known, 'hotfix');
      if (await claim(version)) return publish(version, notes);
      known.push(version);
    }
    throw new Error('no free hotfix version after 10 tries');
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
