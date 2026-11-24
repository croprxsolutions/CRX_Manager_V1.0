// Run: node --test .github/scripts/taha-ready.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, needsPing, pingMarker, pingText, requiredChecksProblem } from './taha-ready.mjs';

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

const P = (p, c, f = ok) => needsPing(p, c, f).ping;

test('ping dedupe: once per head, never twice', () => {
  assert.equal(P(labelled(), []), true);
  assert.equal(P(labelled(), [bot(HEAD)]), false);
  assert.equal(P(labelled({ reviewRequests: [{ login: 'TahaKhanAbdalli' }] }), [bot(HEAD)]), false);
});

test('no ping while required checks are not green', () => {
  assert.equal(P(labelled(), [], { ...ok, checks: () => [{ name: 'CI', bucket: 'pending' }] }), false);
});

test('a new head pings again only when Taha is re-requested and it needs no Sol', () => {
  const req = { headRefOid: NEW, reviewRequests: [{ login: 'TahaKhanAbdalli' }] };
  assert.equal(P(labelled({ headRefOid: NEW }), [bot(HEAD)]), false);
  assert.equal(P(labelled(req), [bot(HEAD)]), true);
  // A request that outlived a push to a Sol-list head is not proof Sol ran again.
  assert.equal(P(labelled(req), [bot(HEAD)], { ...ok, sol: () => ({ risky: true, reason: 'supabase/' }) }), false);
});

test('only the bot can write a dedupe record', () => {
  assert.equal(P(labelled({ headRefOid: NEW, reviewRequests: [{ login: 'TahaKhanAbdalli' }] }), [{ author: { login: 'masonwells1' }, body: pingMarker(NEW) }]), true);
  assert.equal(P(labelled(), [{ author: { login: 'masonwells1' }, body: pingMarker(HEAD) }]), true);
});

test('no ping without the label, on drafts, on Taha PRs, or once he reviewed the head', () => {
  const lazy = { checks: never, sol: never };
  assert.equal(P(pr(), [], lazy), false);
  assert.equal(P(labelled({ isDraft: true }), [], lazy), false);
  assert.equal(P(labelled({ author: { login: 'TahaKhanAbdalli' } }), [], lazy), false);
  assert.equal(P(labelled({ reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'CHANGES_REQUESTED', commit: { oid: HEAD } }] }), [], lazy), false);
  // A dismissed review no longer counts as having seen the head.
  assert.equal(P(labelled({ reviews: [{ author: { login: 'TahaKhanAbdalli' }, state: 'DISMISSED', commit: { oid: HEAD } }] }), []), true);
});

test('ping text escapes PR titles and names the short head', () => {
  const t = pingText(pr());
  assert.match(t, /&lt;!channel&gt;/);
  assert.match(t, /head aaaaaaa\)/);
  assert.match(t, /<https:\/\/github.com\/x\/y\/pull\/7\|#7>/);
});
