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
