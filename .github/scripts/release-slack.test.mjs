// Run: node --test .github/scripts/release-slack.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, link, readMarker, writeMarker, cardMessage, threadUpdates, liveMessage, hotfixMessage, parseReleaseNotes, trySlack, slackConfigured, backMergeText } from './release-slack.mjs';
import { releaseNotesModule } from './release-flow.mjs';

const texts = (msg) => JSON.stringify(msg);
const on = { SLACK_RELEASE_TOKEN: 'xoxb-test', SLACK_RELEASE_CHANNEL: 'C123' };

test('PR text cannot ping the channel, mention people or forge links', () => {
  assert.equal(esc('<!channel> & <@U1> <https://x|y>'), '&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;https://x|y&gt;');
  assert.equal(link('https://a.example/p?q=1', '#5'), '<https://a.example/p?q=1|#5>');
  for (const bad of ['http://a.example', 'https://a.example/x|evil', 'https://a.example/<b>', 'javascript:x', '', undefined]) {
    assert.equal(link(bad, '<b>'), '&lt;b&gt;', String(bad));
  }
});

test('the hidden marker round-trips, is replaced in place and ignores junk', () => {
  const body = writeMarker('Release body', { ts: '1.2', ch: 'C1', states: { 5: 'verified' } });
  assert.match(body, /^Release body\n\n<!-- crx-slack \{.*\} -->\n$/);
  assert.deepEqual(readMarker(body), { ts: '1.2', ch: 'C1', states: { 5: 'verified' } });
  const again = writeMarker(body, { ts: '9.9', ch: 'C1' });
  assert.equal(again.match(/crx-slack/g).length, 1);
  assert.equal(readMarker(again).ts, '9.9');
  for (const junk of [null, '', 'no marker', '<!-- crx-slack {bad json} -->', '<!-- crx-slack [1] -->']) assert.equal(readMarker(junk), null, String(junk));
  // A value can never close the comment early, and a malformed one is dropped on read.
  const odd = writeMarker('', { ts: '-->x<!--', ch: 'C1' });
  assert.equal(odd.match(/-->/g).length, 1);
  assert.deepEqual(readMarker(odd), { ch: 'C1' });
});

test('an edited marker cannot put text into Slack: only fields of the expected shape survive', () => {
  const body = '<!-- crx-slack {"ts":"1.2","ch":"C1","v":"v0.2.0","date":"2026-11-19","mig":"\\u003c!channel\\u003e","orph":-1,"at":5,"gate":"yes","done":true,"states":{"1":"verified","2":"\\u003c!here\\u003e","x":"held"},"extra":"y"} -->';
  assert.deepEqual(readMarker(body), { ts: '1.2', ch: 'C1', v: 'v0.2.0', date: '2026-11-19', states: { 1: 'verified' }, done: true, at: 5 });
  for (const bad of [{ ts: '1.2; x' }, { ch: 'c1' }, { v: '0.2.0' }, { date: '19 Nov' }]) {
    assert.deepEqual(readMarker(`<!-- crx-slack ${JSON.stringify(bad)} -->`), {}, JSON.stringify(bad));
  }
});

const state = { v: 'v0.2.0', date: '2026-11-19', states: { 1: 'verified', 2: 'unverified', 3: 'held', 4: 'missing' }, gate: false, mig: 3, orph: 0 };
const prs = [
  { number: 1, title: 'feat: a', url: 'https://github.com/o/r/pull/1', state: 'verified' },
  { number: 2, title: 'fix: <!here> b', url: 'https://github.com/o/r/pull/2', state: 'unverified' },
  { number: 3, title: 'c', url: 'https://github.com/o/r/pull/3', state: 'held' },
  { number: 4, title: 'd', url: 'https://github.com/o/r/pull/4', state: 'missing' },
];

test('the open card counts states, lists what needs proof and links the PR', () => {
  const msg = cardMessage(state, { prs, prUrl: 'https://github.com/o/r/pull/9', compareUrl: 'https://github.com/o/r/compare/main...release/next' });
  assert.equal(msg.text, 'Release v0.2.0: candidate');
  const [{ color, blocks }] = msg.attachments;
  assert.equal(color, '#BA7517');
  assert.equal(blocks[0].text.text, 'Release v0.2.0 · candidate');
  assert.match(blocks[1].elements[0].text, /4 PR\(s\) from staging · 3 migration\(s\) for live/);
  assert.deepEqual(blocks[2].fields.map((f) => f.text.split('\n')[1]), ['1', '2', '1', ':hourglass_flowing_sand: Waiting on 2']);
  assert.match(blocks[3].text.text, /<https:\/\/github.com\/o\/r\/pull\/2\|#2> fix: &lt;!here&gt; b/);
  assert.doesNotMatch(texts(msg), /<!here>/);
  assert.deepEqual(blocks.at(-1).elements.map((e) => e.text.text), ['Open release PR', 'Compare main…release']);
});

test('the card turns blue when the gate is green, green when merged, red when squashed', () => {
  const ready = cardMessage({ ...state, gate: true, states: { 1: 'verified' } }, { prUrl: 'https://x.example/p' });
  assert.equal(ready.attachments[0].color, '#185FA5');
  assert.equal(ready.text, 'Release v0.2.0: ready to merge');
  const merged = cardMessage(state, { phase: 'merged', mergedBy: 'taha<x>', tagUrl: 'https://x.example/t', prUrl: 'https://x.example/p' });
  assert.equal(merged.attachments[0].color, '#3B6D11');
  assert.match(texts(merged), /Merged by taha&lt;x&gt;/);
  assert.ok(!texts(merged).includes('Needs proof on staging'), 'no waiting list once merged');
  assert.deepEqual(merged.attachments[0].blocks.at(-1).elements.map((e) => e.text.text), ['Open release PR', 'Release notes']);
  assert.equal(cardMessage(state, { phase: 'squashed' }).attachments[0].color, '#A32D2D');
});

test('a long waiting list is cut at 8, and orphan commits show', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ number: i + 1, title: 't', url: 'https://x.example/p', state: 'unverified' }));
  const msg = cardMessage({ ...state, orph: 2 }, { prs: many });
  assert.match(texts(msg), /…and 3 more/);
  assert.match(texts(msg), /2 commit\(s\) on staging without a PR/);
  assert.match(texts(msg), /Waiting on 13/);
});

test('thread replies say what changed, and nothing on the first post', () => {
  assert.deepEqual(threadUpdates(null, { prs, gateOk: false }), []);
  const prev = { states: { 1: 'unverified', 2: 'unverified', 3: 'unverified', 4: 'verified' }, gate: false };
  const now = {
    prs: [
      { ...prs[0], proof: 'https://proof.example/1' },
      prs[1],
      { ...prs[2], held: 'flag <x>' },
      prs[3],
      { number: 5, url: 'https://github.com/o/r/pull/5', state: 'unverified' },
    ],
    gateOk: true,
  };
  assert.deepEqual(threadUpdates(prev, now), [
    ':heavy_plus_sign: Added to this release: <https://github.com/o/r/pull/5|#5>',
    ':white_check_mark: <https://github.com/o/r/pull/1|#1> verified on staging · <https://proof.example/1|proof>',
    ':double_vertical_bar: <https://github.com/o/r/pull/3|#3> held off: flag &lt;x&gt;',
    ':x: <https://github.com/o/r/pull/4|#4> lost its proof or reason, so it needs checking again',
    ':large_green_circle: Release gate is green. Ready to merge.',
  ]);
  assert.deepEqual(threadUpdates({ states: { 1: 'verified' }, gate: true }, { prs: [prs[0]], gateOk: false }), [':red_circle: Release gate is red again.']);
});

test('the live post lists what users see, escaped and capped', () => {
  const r = { version: 'v0.2.0', items: ['Tax <!channel>', ...Array.from({ length: 16 }, (_, i) => `item ${i}`)], prCount: 14, migrations: 3, mergedBy: 'taha', tagUrl: 'https://x.example/t', changelogUrl: 'https://x.example/c', prUrl: 'https://x.example/p' };
  const msg = liveMessage(r);
  assert.equal(msg.text, 'v0.2.0 is live');
  assert.match(texts(msg), /Merged by taha · 14 PR\(s\) · 3 migration\(s\)/);
  assert.match(texts(msg), /• Tax &lt;!channel&gt;/);
  assert.match(texts(msg), /…and 5 more in the release notes/);
  assert.match(texts(liveMessage({ ...r, items: [], prCount: null, migrations: null })), /Nothing user-facing this time/);
  assert.doesNotMatch(texts(liveMessage({ ...r, prCount: null, migrations: null })), /PR\(s\)/);
});

test('hotfix and back-merge texts link the PR', () => {
  assert.match(texts(hotfixMessage({ number: 7, title: 'fix: <b>', url: 'https://x.example/7', mergedBy: 'm', releasesUrl: 'https://x.example/r' })), /<https:\/\/x.example\/7\|#7> fix: &lt;b&gt;/);
  assert.match(backMergeText('overdue', 8, 'https://x.example/8'), /<https:\/\/x.example\/8\|#8> is still open/);
  assert.match(backMergeText('carried', 8, 'https://x.example/8'), /is still open and now carries this too/);
  assert.match(backMergeText('squashed', 8, 'https://x.example/8'), /merged by squash or rebase, so staging still lacks main's history/);
});

test('release notes are read back from the module the bot writes', () => {
  const notes = { version: '0.2.0', date: '2026-11-19', items: ['a', 'b "q"'] };
  assert.deepEqual(parseReleaseNotes(releaseNotesModule(notes)), notes);
  for (const bad of ['', 'export const x = 1;', 'x = {"items": 1};']) assert.equal(parseReleaseNotes(bad), null, bad);
});

test('Slack is optional and its failures only warn', async () => {
  assert.equal(slackConfigured({}), false);
  assert.equal(slackConfigured({ SLACK_RELEASE_TOKEN: 'x' }), false);
  assert.equal(slackConfigured(on), true);
  let called = false;
  assert.equal(await trySlack(() => { called = true; }, {}), null);
  assert.equal(called, false, 'not called when Slack is not set up');
  const logs = [];
  const log = console.log;
  console.log = (s) => logs.push(s);
  try {
    assert.equal(await trySlack(async () => { throw new Error('channel_not_found'); }, on), null);
  } finally {
    console.log = log;
  }
  assert.deepEqual(logs, ['::warning::Slack: channel_not_found']);
  assert.equal(await trySlack(async () => 5, on), 5);
});

test('the biggest posts stay inside Slack\'s block limits', () => {
  const long = '&<>'.repeat(2000); // escaping makes each of these 4-5 characters
  const live = liveMessage({ version: 'v1.0.0', items: Array(40).fill(long), prCount: 1, migrations: 0, mergedBy: long, tagUrl: 'https://x.example/t', changelogUrl: 'https://x.example/c', prUrl: 'https://x.example/p' });
  const many = Array.from({ length: 60 }, (_, i) => ({ number: 100000 + i, title: long, url: `https://github.com/o/r/pull/${100000 + i}`, state: 'unverified' }));
  const card = cardMessage({ ...state, v: `v${'9'.repeat(200)}` }, { prs: many, prUrl: 'https://x.example/p', compareUrl: 'https://x.example/c' });
  for (const msg of [live, card]) {
    for (const b of msg.attachments[0].blocks) {
      if (b.type === 'header') assert.ok(b.text.text.length <= 150, 'header');
      if (b.text?.type === 'mrkdwn') assert.ok(b.text.text.length <= 3000, `section ${b.text.text.length}`);
      for (const f of b.fields ?? []) assert.ok(f.text.length <= 2000, 'field');
    }
  }
});

test('held-off PRs are named with their reason, and a red gate with nothing listed says red', () => {
  const held = [{ number: 7, title: 'feat: x', url: 'https://x.example/7', state: 'held', held: 'flag <tax_v2>' }];
  const msg = cardMessage({ ...state, states: { 7: 'held' } }, { prs: held });
  assert.match(texts(msg), /Held off \(not shipping\)\*\\n<https:\/\/x.example\/7\|#7> flag &lt;tax_v2&gt;/);
  assert.match(texts(cardMessage({ ...state, states: {}, gate: false }, { prs: [] })), /:red_circle: Red/);
});
