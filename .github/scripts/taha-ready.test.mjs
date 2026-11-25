// Run: node --test .github/scripts/taha-ready.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedAfterPush, decide, needsPing, pingMarker, pingText, requiredChecksProblem } from './taha-ready.mjs';

const HEAD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const pr = (o = {}) => ({ number: 7, title: 'fix: <!channel> quotes', url: 'https://github.com/x/y/pull/7', isDraft: false, author: { login: 'masonwells1' },
  headRefName: 'fix/q', headRefOid: HEAD, labels: [], reviewRequests: [], reviews: [], ...o });
const green = () => [{ name: 'CI', bucket: 'pass' }, { name: 'Vercel', bucket: 'skipping' }];
const inLane = () => ({ files: ['src/components/quotes/Q.tsx'], reason: "it changes Taha's areas (src/components/quotes/Q.tsx)" });
const noSol = () => ({ risky: false, reason: '1 file(s), none on the Sol list' });
const ok = { checks: green, lane: inLane, sol: noSol };
const never = () => { throw new Error('should not be called'); };

test('labels only when lane + no Sol + required checks green', () => {
  assert.equal(decide(pr(), ok).act, true);
  assert.match(decide(pr(), ok).why, /^label \+ request Taha/);
  assert.equal(decide(pr(), { ...ok, lane: () => null }).act, false);
  assert.equal(decide(pr(), { ...ok, sol: () => ({ risky: true, reason: 'supabase/ needs Sol' }) }).act, false);
  assert.equal(decide(pr(), { ...ok, sol: () => undefined }).act, false);
  assert.equal(decide(pr(), { ...ok, checks: () => [{ name: 'CI', bucket: 'pending' }] }).act, false);
  assert.equal(decide(pr(), { ...ok, checks: () => [{ name: 'CI', bucket: 'fail' }] }).act, false);
  assert.equal(decide(pr(), { ...ok, checks: () => [] }).act, false);
  assert.equal(decide(pr(), { ...ok, checks: () => null }).act, false);
});

test('an unreadable or cut-short file list never labels', () => {
  assert.equal(decide(pr(), { ...ok, lane: () => ({ files: [], reason: 'could not be read' }) }).act, false);
});

test("drafts, Taha's own PRs and already-waiting PRs are left alone without GitHub calls", () => {
  const lazy = { checks: never, lane: never, sol: never };
  assert.equal(decide(pr({ isDraft: true }), lazy).why, 'draft');
  assert.equal(decide(pr({ author: { login: 'TahaKhanAbdalli' } }), lazy).act, false);
  assert.equal(decide(pr({ headRefName: 'taha/x' }), lazy).act, false);
  assert.equal(decide(pr({ labels: [{ name: 'ready-for-taha' }], reviewRequests: [{ login: 'TahaKhanAbdalli' }] }), lazy).act, false);
  assert.equal(decide(pr({ reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'APPROVED', commit: { oid: HEAD } }] }), lazy).act, false);
});

test('a labelled PR at a new head is re-requested once ready again', () => {
  const p = pr({ labels: [{ name: 'ready-for-taha' }], reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'APPROVED', commit: { oid: NEW } }] });
  assert.match(decide(p, ok).why, /^re-request Taha/);
});

test('requiredChecksProblem names what is not green', () => {
  assert.equal(requiredChecksProblem(green()), null);
  assert.match(requiredChecksProblem([{ name: 'CI', bucket: 'fail' }]), /CI: fail/);
});

const bot = (sha) => ({ author: { login: 'github-actions' }, body: `Pinged.\n\n${pingMarker(sha)}` });
const labelled = (o) => pr({ labels: [{ name: 'ready-for-taha' }], ...o });

const T = { reviewRequests: [{ login: 'TahaKhanAbdalli' }] };
const solList = { ...ok, sol: () => ({ risky: true, reason: 'supabase/' }) };
const P = (p, c, f = ok) => needsPing(p, c, { asked: () => false, ...f }).ping;

test('ping dedupe: once per head, never twice; a new head pings again', () => {
  assert.equal(P(labelled(T), []), true);
  assert.equal(P(labelled(T), [bot(HEAD)]), false);
  assert.equal(P(labelled({ ...T, headRefOid: NEW }), [bot(HEAD)]), true);
});

test('no ping unless Taha is requested and required checks are green', () => {
  assert.equal(P(labelled(), []), false);
  assert.equal(P(labelled(T), [], { ...ok, checks: () => [{ name: 'CI', bucket: 'pending' }] }), false);
});

test('a Sol-list head pings only when labelled or re-requested after its push', () => {
  assert.equal(P(labelled(T), [], solList), false);
  assert.equal(P(labelled({ ...T, headRefOid: NEW }), [bot(HEAD)], solList), false);
  assert.equal(P(labelled({ ...T, headRefOid: NEW }), [bot(HEAD)], { ...solList, asked: () => true }), true);
  assert.equal(P(labelled(T), [], { ...ok, sol: () => undefined, asked: () => false }), false);
});

test('askedAfterPush compares the newest ask with the push', () => {
  const push = '2026-11-24T10:00:00Z\n2026-11-24T10:05:00Z';
  assert.equal(askedAfterPush(push, '2026-11-24T09:00:00Z\n2026-11-24T10:01:00Z'), true);
  assert.equal(askedAfterPush(push, '2026-11-24T09:59:00Z'), false);
  assert.equal(askedAfterPush(null, '2026-11-24T11:00:00Z'), false);
  assert.equal(askedAfterPush(push, null), false);
  assert.equal(askedAfterPush('garbage', 'garbage'), false);
});

test('only the bot can write a dedupe record', () => {
  assert.equal(P(labelled(T), [{ author: { login: 'masonwells1' }, body: pingMarker(HEAD) }]), true);
});

test('no ping without the label, on drafts, on Taha PRs, or once he reviewed the head', () => {
  const lazy = { checks: never, sol: never, asked: never };
  assert.equal(P(pr(T), [], lazy), false);
  assert.equal(P(labelled({ ...T, isDraft: true }), [], lazy), false);
  assert.equal(P(labelled({ ...T, author: { login: 'TahaKhanAbdalli' } }), [], lazy), false);
  assert.equal(P(labelled({ ...T, reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'CHANGES_REQUESTED', commit: { oid: HEAD } }] }), [], lazy), false);
  // A dismissed review no longer counts as having seen the head.
  assert.equal(P(labelled({ ...T, reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'DISMISSED', commit: { oid: HEAD } }] }), []), true);
});

test('ping text escapes PR titles and names the short head', () => {
  const t = pingText(pr());
  assert.match(t, /&lt;!channel&gt;/);
  assert.match(t, /head aaaaaaa\)/);
  assert.match(t, /<https:\/\/github.com\/x\/y\/pull\/7\|#7>/);
});

// ── Hotfixes into main (Mason, 2026-11-25) ─────────────────────────────────────────────────────
import { githubOwned, isMainHotfix } from './taha-ready.mjs';

const hotfix = (o) => pr({ baseRefName: 'main', headRefName: 'hotfix/q', ...o });
const gateWaiting = () => [...green(), { name: 'Release flow guard (main)', bucket: 'fail' }, { name: 'release-gate', bucket: 'pending' }];

test('a hotfix into main is asked for even while the guard and release-gate wait on Taha; other checks still count', () => {
  assert.equal(isMainHotfix(hotfix()), true);
  assert.equal(isMainHotfix(pr({ baseRefName: 'staging', headRefName: 'hotfix/q' })), false);
  assert.equal(isMainHotfix(pr({ baseRefName: 'main', headRefName: 'release/next' })), false);
  assert.equal(decide(hotfix(), { ...ok, checks: gateWaiting }).act, true);
  assert.equal(decide(hotfix(), { ...ok, checks: () => [...gateWaiting(), { name: 'CI', bucket: 'fail' }] }).act, false);
  // Not a hotfix: the guard still blocks.
  assert.equal(decide(pr({ baseRefName: 'main', headRefName: 'release/next' }), { ...ok, checks: gateWaiting }).act, false);
  assert.equal(P(labelled({ ...T, baseRefName: 'main', headRefName: 'hotfix/q' }), [], { ...ok, checks: gateWaiting }), true);
});

test('.github/ files count as Taha\'s on a hotfix (he is a code owner)', () => {
  assert.deepEqual(githubOwned([{ filename: '.github/workflows/release-pr.yml' }, { filename: 'README.md' }]).files, ['.github/workflows/release-pr.yml']);
  assert.equal(githubOwned([{ filename: 'docs/x.md' }]), null);
  assert.equal(githubOwned(null), null);
});

test('the ping asks for the hotfix-backport label only on a hotfix whose guard wants it', () => {
  const h = labelled({ ...T, baseRefName: 'main', headRefName: 'hotfix/q' });
  const p = needsPing(h, [], { ...ok, asked: () => false, backport: () => true });
  assert.equal(p.backport, true);
  assert.match(pingText(h, null, p), /Approve \+ `hotfix-backport` label \(add it after the latest push\) \(head aaaaaaa\)/);
  assert.equal(needsPing(h, [], { ...ok, asked: () => false, backport: () => false }).backport, false);
  assert.equal(needsPing(labelled(T), [], { ...ok, asked: () => false, backport: never }).backport, false);
  assert.doesNotMatch(pingText(pr()), /hotfix-backport/);
});

test('an approved hotfix whose guard still wants the label gets one label-only ping (as on #2573)', () => {
  const approved = hotfix({ reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'APPROVED', commit: { oid: HEAD } }] });
  const lazy = { checks: never, sol: never, asked: never };
  const p = needsPing(approved, [], { ...lazy, backport: () => true });
  assert.equal(p.ping, true);
  assert.match(pingText(approved, null, p), /waiting on your `hotfix-backport` label \(add it after the latest push\) \(head/);
  assert.doesNotMatch(pingText(approved, null, p), /Approve/);
  assert.equal(needsPing(approved, [bot(HEAD)], { ...lazy, backport: () => true }).ping, false);
  assert.equal(needsPing(approved, [], { ...lazy, backport: () => false }).ping, false);
  // Approved on an older head, or not a hotfix: the normal rules apply.
  assert.equal(needsPing(hotfix({ reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'APPROVED', commit: { oid: NEW } }] }), [], { ...lazy, backport: () => true }).ping, false);
  assert.equal(needsPing(pr({ reviews: approved.reviews }), [], { ...lazy, backport: never }).ping, false);
});

// ── Taha's verdict labels, reminder, Haiku (Mason, 2026-11-24) ─────────────────────────────────
import { needsReminder, parseTopics, remindMarker, reviewLabelChanges, summarize, tahaVerdict } from './taha-ready.mjs';

const rv = (state, oid = HEAD, login = 'TahaKhanAbdalli') => ({ author: { login }, state, commit: { oid } });
const L = (...names) => names.map((name) => ({ name }));

test("Taha's verdict on the current head: latest decisive review wins, comments and old heads don't count", () => {
  assert.equal(tahaVerdict(pr({ reviews: [rv('APPROVED')] })), 'taha-approved');
  assert.equal(tahaVerdict(pr({ reviews: [rv('APPROVED'), rv('CHANGES_REQUESTED')] })), 'taha-changes');
  assert.equal(tahaVerdict(pr({ reviews: [rv('CHANGES_REQUESTED'), rv('APPROVED')] })), 'taha-approved');
  assert.equal(tahaVerdict(pr({ reviews: [rv('APPROVED'), rv('COMMENTED')] })), 'taha-approved');
  assert.equal(tahaVerdict(pr({ reviews: [rv('DISMISSED')] })), null);
  assert.equal(tahaVerdict(pr({ reviews: [rv('APPROVED', NEW)] })), null, 'approval of another head');
  assert.equal(tahaVerdict(pr({ reviews: [rv('APPROVED', HEAD, 'masonwells1')] })), null, 'not Taha');
});

test('review labels: exactly one of approved / changes, or neither after a push', () => {
  assert.deepEqual(reviewLabelChanges(pr({ reviews: [rv('APPROVED')] })), { add: ['taha-approved'], remove: [] });
  assert.deepEqual(reviewLabelChanges(pr({ reviews: [rv('APPROVED')], labels: L('taha-approved') })), { add: [], remove: [] });
  assert.deepEqual(reviewLabelChanges(pr({ reviews: [rv('CHANGES_REQUESTED')], labels: L('taha-approved') })), { add: ['taha-changes'], remove: ['taha-approved'] });
  assert.deepEqual(reviewLabelChanges(pr({ reviews: [rv('APPROVED', NEW)], labels: L('taha-approved', 'taha-changes') })), { add: [], remove: ['taha-approved', 'taha-changes'] });
  assert.deepEqual(reviewLabelChanges(pr({ author: { login: 'TahaKhanAbdalli' }, reviews: [rv('APPROVED')] })), { add: [], remove: [] }, "Taha's own PR untouched");
});

test('reminder: once per head, 24 h after the first ping, while Taha has not decided', () => {
  const T0 = Date.UTC(2026, 10, 24, 12);
  const bot = (body, createdAt = new Date(T0).toISOString()) => ({ author: { login: 'github-actions' }, body, createdAt });
  const waiting = pr({ labels: L('ready-for-taha'), reviewRequests: [{ login: 'TahaKhanAbdalli' }] });
  const pingedAt = [bot(`x ${pingMarker(HEAD)}`)];
  const day = T0 + 24 * 3600e3;
  assert.equal(needsReminder(waiting, pingedAt, day, { checks: green }).remind, true);
  assert.equal(needsReminder(waiting, pingedAt, day - 1, { checks: green }).remind, false, 'under 24 h');
  assert.equal(needsReminder(waiting, [], day, { checks: green }).remind, false, 'never pinged');
  assert.equal(needsReminder(waiting, [bot(`x ${pingMarker(NEW)}`)], day, { checks: green }).remind, false, 'pinged for another head only');
  assert.equal(needsReminder(waiting, [...pingedAt, bot(`y ${remindMarker(HEAD)}`)], day, { checks: green }).remind, false, 'already reminded');
  assert.equal(needsReminder({ ...waiting, reviews: [rv('APPROVED')] }, pingedAt, day, { checks: green }).remind, false, 'Taha approved');
  assert.equal(needsReminder({ ...waiting, reviews: [rv('COMMENTED')] }, pingedAt, day, { checks: green }).remind, true, 'a comment still waits on his decision');
  assert.equal(needsReminder(waiting, pingedAt, day, { checks: () => [{ name: 'CI', bucket: 'fail' }] }).remind, false, 'checks red');
  assert.equal(needsReminder(waiting, [{ ...pingedAt[0], author: { login: 'someone' } }], day, { checks: green }).remind, false, "a person's copy of the marker doesn't count");
});

test('topics: only from the fixed list, at most 3, model noise ignored', () => {
  assert.deepEqual(parseTopics('Billing, quotes'), ['topic:billing', 'topic:quotes']);
  assert.deepEqual(parseTopics('ready-for-taha, hotfix, billing, billing'), ['topic:billing']);
  assert.deepEqual(parseTopics('maps, driver, deliveries, reports'), ['topic:maps', 'topic:driver', 'topic:deliveries']);
  assert.deepEqual(parseTopics(null), []);
});

test('summary: only title, description and file names go out; the answer is escaped and cut; failures mean no summary', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body), key: init.headers['x-api-key'] };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hi <!channel> <@U1>\n'.repeat(60) }] }) }; };
  const s = await summarize(pr({ body: 'desc' }), ['src/a.ts'], { key: 'k', fetchImpl });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.match(sent.body.messages[0].content, /Title: fix: <!channel> quotes\nDescription:\ndesc\nChanged files:\nsrc\/a\.ts$/);
  assert.ok(!s.includes('<') && s.length <= 400 && !s.includes('\n'), 'no Slack control text, no newlines, capped');
  assert.equal(await summarize(pr(), [], { key: '', fetchImpl: never }), null, 'no key, no call');
  assert.equal(await summarize(pr(), [], { key: 'k', fetchImpl: async () => ({ ok: false }) }), null, 'API error');
  assert.equal(await summarize(pr(), [], { key: 'k', fetchImpl: async () => { throw new Error('timeout'); } }), null, 'network error');
  assert.match(pingText(pr(), s), /\n> AI summary of the author's description, not checked: Hi &lt;!channel&gt;/);
  assert.doesNotMatch(pingText(pr(), null), /\n/);
  const reply = (text) => async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) });
  assert.equal(await summarize(pr(), [], { key: 'k', fetchImpl: reply('Safe, *approve* now: https://evil.example/x ok') }), 'Safe, approve now: ok',
    'links and Slack formatting are stripped');
  assert.equal(await summarize(pr(), [], { key: 'k', fetchImpl: reply('https://only.a/link') }), null, 'nothing left means no summary');
});

test('topics: an outage is retried (null), only a real but unusable answer becomes topic:none ([])', async () => {
  const { pickTopics } = await import('./taha-ready.mjs');
  const reply = (text) => async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) });
  assert.equal(await pickTopics(pr(), [], { key: 'k', fetchImpl: async () => ({ ok: false }) }), null, 'API error');
  assert.equal(await pickTopics(pr(), [], { key: 'k', fetchImpl: async () => { throw new Error('timeout'); } }), null, 'timeout');
  assert.deepEqual(await pickTopics(pr(), [], { key: 'k', fetchImpl: reply('nothing fits') }), [], 'answered, nothing usable');
  assert.deepEqual(await pickTopics(pr(), [], { key: 'k', fetchImpl: reply('billing') }), ['topic:billing']);
});

test("strangers' fork PRs are never labelled or pinged", () => {
  const fork = pr({ isCrossRepository: true });
  assert.equal(decide(fork, { checks: green, lane: inLane, sol: noSol }).act, false);
  assert.equal(needsPing({ ...fork, labels: [{ name: 'ready-for-taha' }] }, [], { checks: green, sol: noSol, asked: () => [] }).ping, false);
});
