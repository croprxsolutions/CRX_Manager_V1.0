// Slack posts for the release flow (Taha, 2026-11-12): one card per release PR, edited in place,
// with a thread of what happened to it; "vX.Y.Z is live" and hotfix posts; back-merge follow-ups.
// Message builders are pure and tested in release-slack.test.mjs; slack() is the only network call.
// Nothing here may fail a release: release-flow.mjs calls it through trySlack(), which only warns.

export const slackConfigured = (env = process.env) => Boolean(env.SLACK_RELEASE_TOKEN && env.SLACK_RELEASE_CHANNEL);

// In Slack text, &, < and > are control characters (<!channel>, <@U123>, <url|text>): PR text gets them escaped.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A link only for a plain https URL Slack can't misread; otherwise the text alone.
export const link = (url, text) => (/^https:\/\/[^\s<>|]+$/.test(url ?? '') ? `<${url}|${esc(text)}>` : esc(text));
const short = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
// PR text for Slack: escaped first, then cut, so escaping can't push a block past Slack's size limits.
const clip = (s, max) => short(esc(s), max);

// Where the card lives and what it last showed, kept as a hidden comment in the PR body. Only the bot
// writes it, and it holds no PR text: ts/channel ids, PR numbers, states, counts.
const MARK = /<!-- crx-slack (\{[^<>]*\}) -->/;
const STATES = new Set(['verified', 'held', 'missing', 'unverified']);
// Only fields of the expected shape survive, so an edited marker can't put text into Slack.
export function readMarker(body) {
  const m = MARK.exec(body ?? '');
  if (!m) return null;
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (/^\d+\.\d+$/.test(v.ts)) out.ts = v.ts;
  if (/^[CG][A-Z0-9]+$/.test(v.ch)) out.ch = v.ch;
  if (/^v\d+\.\d+\.\d+$/.test(v.v)) out.v = v.v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.date)) out.date = v.date;
  if (v.states && typeof v.states === 'object' && !Array.isArray(v.states)) {
    out.states = Object.fromEntries(Object.entries(v.states).filter(([n, st]) => /^\d+$/.test(n) && STATES.has(st)));
  }
  for (const k of ['gate', 'done', 'warned']) if (typeof v[k] === 'boolean') out[k] = v[k];
  for (const k of ['mig', 'orph', 'at']) if (Number.isSafeInteger(v[k]) && v[k] >= 0) out[k] = v[k];
  return out;
}
export function writeMarker(body, marker) {
  const tag = `<!-- crx-slack ${JSON.stringify(marker).replace(/[<>]/g, '')} -->`;
  const b = body ?? '';
  return MARK.test(b) ? b.replace(MARK, () => tag) : `${b.trimEnd()}\n\n${tag}\n`;
}

const COLORS = { open: '#BA7517', ready: '#185FA5', merged: '#3B6D11', squashed: '#A32D2D', hotfix: '#993C1D' };
const WAITING = new Set(['unverified', 'missing']);
const button = (text, url) => ({ type: 'button', text: { type: 'plain_text', text }, url });

// The release card. m: { v, date, states: {number: state}, gate, mig, orph }; prs (optional) adds
// titles and links; phase: open | merged | squashed.
export function cardMessage(m, { prs, phase = 'open', prUrl, compareUrl, tagUrl, mergedBy } = {}) {
  const list = prs ?? Object.entries(m.states ?? {}).map(([n, state]) => ({ number: Number(n), state }));
  const count = (f) => list.filter(f).length;
  const waiting = list.filter((p) => WAITING.has(p.state));
  const shown = phase === 'open' && m.gate ? 'ready' : phase;
  const word = { open: 'candidate', ready: 'ready to merge', merged: 'shipped', squashed: 'merged without a merge commit' }[shown];
  const gate = {
    open: waiting.length + (m.orph ?? 0) ? `:hourglass_flowing_sand: Waiting on ${waiting.length + (m.orph ?? 0)}` : ':red_circle: Red',
    ready: ':large_green_circle: Green',
    merged: `:white_check_mark: Merged by ${esc(mergedBy)}`,
    squashed: ':warning: No tag',
  }[shown];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: short(`Release ${m.v} · ${word}`, 150) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(m.date)} · ${list.length} PR(s) from staging · ${m.mig ?? 0} migration(s) for live` }] },
    {
      type: 'section',
      fields: [
        `*Verified on staging*\n${count((p) => p.state === 'verified')}`,
        `*Needs proof*\n${waiting.length}`,
        `*Held off*\n${count((p) => p.state === 'held')}`,
        `*Release gate*\n${gate}`,
      ].map((text) => ({ type: 'mrkdwn', text })),
    },
  ];
  if (phase === 'open' && waiting.length) {
    const lines = waiting.slice(0, 8).map((p) => `${link(p.url, `#${p.number}`)} ${clip(p.title ?? '', 80)}`);
    if (waiting.length > 8) lines.push(`…and ${waiting.length - 8} more`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Needs proof on staging*\n${lines.join('\n')}` } });
  }
  const held = list.filter((p) => p.state === 'held');
  if (phase === 'open' && held.length) {
    const lines = held.slice(0, 8).map((p) => `${link(p.url, `#${p.number}`)} ${clip(p.held ?? p.title ?? '', 120)}`);
    if (held.length > 8) lines.push(`…and ${held.length - 8} more`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Held off (not shipping)*\n${lines.join('\n')}` } });
  }
  if (m.orph) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:x: ${m.orph} commit(s) on staging without a PR` }] });
  const buttons = [prUrl && button('Open release PR', prUrl), phase === 'open' && compareUrl && button('Compare main…release', compareUrl), phase === 'merged' && tagUrl && button('Release notes', tagUrl)].filter(Boolean);
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  return { text: `Release ${m.v}: ${word}`, attachments: [{ color: COLORS[shown], blocks }] };
}

const ref = (p) => link(p.url, `#${p.number}`);

// Thread replies for what changed since the card last posted (none on the first post).
// now: { prs: [{ number, url, state, proof, held }], gateOk }.
export function threadUpdates(prev, now) {
  if (!prev?.states) return [];
  const out = [];
  const added = now.prs.filter((p) => !(String(p.number) in prev.states));
  if (added.length) out.push(`:heavy_plus_sign: Added to this release: ${added.map(ref).join(', ')}`);
  for (const p of now.prs) {
    const was = prev.states[p.number];
    if (p.state === was) continue;
    if (p.state === 'verified') out.push(`:white_check_mark: ${ref(p)} verified on staging${p.proof ? ` · ${link(p.proof, 'proof')}` : ''}`);
    else if (p.state === 'held') out.push(`:double_vertical_bar: ${ref(p)} held off: ${clip(p.held ?? '', 200)}`);
    else if (was === 'verified' || was === 'held') out.push(`:x: ${ref(p)} lost its proof or reason, so it needs checking again`);
  }
  if (typeof prev.gate === 'boolean' && prev.gate !== now.gateOk) {
    out.push(now.gateOk ? ':large_green_circle: Release gate is green. Ready to merge.' : ':red_circle: Release gate is red again.');
  }
  return out;
}

// The announcement once a release is on main. r: { version, items, prCount, migrations, mergedBy, tagUrl, changelogUrl, prUrl }.
export function liveMessage(r) {
  const items = r.items.slice(0, 12).map((i) => `• ${clip(String(i), 200)}`);
  if (r.items.length > 12) items.push(`…and ${r.items.length - 12} more in the release notes`);
  const facts = [`Merged by ${esc(r.mergedBy)}`, r.prCount != null && `${r.prCount} PR(s)`, r.migrations != null && `${r.migrations} migration(s)`].filter(Boolean);
  return {
    text: `${r.version} is live`,
    attachments: [{
      color: COLORS.merged,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${r.version} is live` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: facts.join(' · ') }] },
        { type: 'section', text: { type: 'mrkdwn', text: `*What's new for users*\n${items.join('\n') || '_Nothing user-facing this time._'}` } },
        { type: 'actions', elements: [button('Release notes', r.tagUrl), button('Changelog', r.changelogUrl), button('Release PR', r.prUrl)] },
      ],
    }],
  };
}

// A hotfix on main. h: { number, title, url, mergedBy, releasesUrl }.
export function hotfixMessage(h) {
  return {
    text: `Hotfix #${h.number} is on main`,
    attachments: [{
      color: COLORS.hotfix,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Hotfix on main' } },
        { type: 'section', text: { type: 'mrkdwn', text: `${link(h.url, `#${h.number}`)} ${clip(h.title, 200)}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Merged by ${esc(h.mergedBy)} · its tag and GitHub Release follow in a minute` }] },
        { type: 'actions', elements: [button('Hotfix PR', h.url), button('Releases', h.releasesUrl)] },
      ],
    }],
  };
}

export const SQUASHED = ':warning: This release was merged with squash or rebase, so main does not contain release/next and no tag was made. Fix it with a history-only merge of the branch into main (like #1786), then tag it by hand.';
export const backMergeText = (kind, n, url) => ({
  opened: `:leftwards_arrow_with_hook: Back-merge ${link(url, `#${n}`)} opened. Merge it today with "Create a merge commit".`,
  carried: `:leftwards_arrow_with_hook: Back-merge ${link(url, `#${n}`)} is still open and now carries this too. Merge it today with "Create a merge commit".`,
  merged: `:white_check_mark: Back-merge ${link(url, `#${n}`)} merged. Staging contains main again.`,
  squashed: `:warning: Back-merge ${link(url, `#${n}`)} was merged by squash or rebase, so staging still lacks main's history. Merge main into staging again with "Create a merge commit".`,
  overdue: `:warning: Back-merge ${link(url, `#${n}`)} is still open, so staging is missing what just shipped. Merge it with "Create a merge commit".`,
})[kind];

// The version, date and items from src/releaseNotes.ts as the bot writes it, or null.
export function parseReleaseNotes(source) {
  const m = /=\s*(\{[\s\S]*\});\s*$/.exec(source ?? '');
  if (!m) return null;
  try {
    const n = JSON.parse(m[1]);
    return Array.isArray(n.items) ? n : null;
  } catch {
    return null;
  }
}

export async function slack(method, body, env = process.env) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SLACK_RELEASE_TOKEN}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: env.SLACK_RELEASE_CHANNEL, ...(method === 'chat.postMessage' ? { unfurl_links: false, unfurl_media: false } : {}), ...body }),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

// Runs a Slack step; any failure (Slack down, token revoked, bot not in the channel) is a warning only.
export async function trySlack(fn, env = process.env) {
  if (!slackConfigured(env)) return null;
  try {
    return await fn();
  } catch (e) {
    console.log(`::warning::Slack: ${e.message}`);
    return null;
  }
}
