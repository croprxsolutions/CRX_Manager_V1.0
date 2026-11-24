// Taha ready bot (Mason and Taha, 2026-11-24; ship.md › Taha's PRs). No AI model.
//   label: on each open, non-draft PR that is not Taha's, add `ready-for-taha` and request Taha's
//          review once (a) it touches his lane (taha-lane-lib.mjs, the merge block's own test),
//          (b) it needs no Sol (sol-risk-lib.mjs, the merge gate's own classifier) and
//          (c) every required check is green. It never removes the label.
//   ping:  post once per PR head to #crx-work for each labelled PR Taha has not reviewed at that head.
//          The first post needs only the label; a later head needs his review request again.
//          A hidden PR comment per head is the dedupe record, written before Slack is called.
// Sol proofs are files on the builder's computer, never on GitHub, so this bot cannot see a clean Sol:
// a PR on the Sol list is left for the agent, which labels it after Sol (the ping still covers it).
// Usage: node .github/scripts/taha-ready.mjs <label|ping> [--dry-run]
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prFilesOnGitHub, tahaLaneProblem } from '../../.claude/hooks/taha-lane-lib.mjs';
import { solRiskOnGitHub } from '../../.claude/hooks/sol-risk-lib.mjs';
import { TAHA_LOGIN } from '../../.claude/hooks/migration-landing-gate-lib.mjs';
import { esc, link, slack } from './release-slack.mjs';

export const REPO = 'croprxsolutions/CRX_Manager_V1.0';
export const LABEL = 'ready-for-taha';
export const CHANNEL = 'C0CD7G2EQNA'; // #crx-work
const TAHA_SLACK = 'U0CCWU300RG';
const BOT_LOGINS = new Set(['github-actions', 'github-actions[bot]', 'app/github-actions']);

const isTaha = (login) => String(login ?? '').trim().toLowerCase() === TAHA_LOGIN;
const sameSha = (a, b) => Boolean(a) && String(a).toLowerCase() === String(b ?? '').toLowerCase();
export const isTahasPr = (pr) => isTaha(pr.author?.login) || /^taha\//i.test(pr.headRefName ?? '');
export const hasLabel = (pr) => (pr.labels ?? []).some((l) => l.name === LABEL);
export const tahaRequested = (pr) => (pr.reviewRequests ?? []).some((r) => isTaha(r.login));
// Any live review of his on this head (approve, changes requested or comment) means he has seen it:
// the next move is his Approve or our fix, not another nudge.
export const tahaReviewedHead = (pr) => (pr.reviews ?? []).some((r) => isTaha(r.author?.login) && !['PENDING', 'DISMISSED'].includes(r.state) && sameSha(r.commit?.oid, pr.headRefOid));

// Required checks from `gh pr check --required`: green only if there is at least one and all passed (or were skipped).
export function requiredChecksProblem(checks) {
  if (!Array.isArray(checks)) return 'required checks could not be read';
  if (!checks.length) return 'no required checks reported yet';
  const notGreen = checks.filter((c) => !['pass', 'skipping'].includes(c.bucket));
  return notGreen.length ? `required checks not green (${notGreen.map((c) => `${c.name}: ${c.bucket}`).join('; ')})` : null;
}

// What to do with one PR. checks/lane/sol are called only when needed (each costs GitHub calls):
// checks() -> [{name,bucket}] | null; lane() -> tahaLaneProblem result; sol() -> solRiskOnGitHub result.
export function decide(pr, { checks, lane, sol }) {
  const skip = (why) => ({ act: false, why });
  if (pr.isDraft) return skip('draft');
  if (isTahasPr(pr)) return skip("Taha's own PR");
  if (hasLabel(pr) && tahaRequested(pr)) return skip('already labelled and waiting on Taha');
  if (tahaReviewedHead(pr)) return skip('Taha already reviewed this head');
  const checkProblem = requiredChecksProblem(checks());
  if (checkProblem) return skip(checkProblem);
  const inLane = lane();
  if (!inLane) return skip("not in Taha's lane");
  // Unreadable or cut-short file lists block a merge, but never label: no named lane file, no label.
  if (!inLane.files?.length) return skip(`lane unclear: ${inLane.reason}`);
  const risk = sol();
  if (risk?.risky !== false) return skip(`Sol needed (${risk?.reason ?? 'unknown'}): the bot cannot see Sol proofs; the agent labels it after Sol`);
  return { act: true, why: `${hasLabel(pr) ? 're-request Taha' : 'label + request Taha'}: ${inLane.reason}; ${risk.reason}; required checks green` };
}

export const pingMarker = (sha) => `<!-- taha-ready-ping ${String(sha).toLowerCase()} -->`;
const pinged = (comments, sha) => (comments ?? []).filter((c) => BOT_LOGINS.has(c.author?.login) && /<!-- taha-ready-ping [0-9a-f]{40} -->/.test(c.body ?? ''))
  .map((c) => /<!-- taha-ready-ping ([0-9a-f]{40}) -->/.exec(c.body)[1]).filter((s) => sha === undefined || s === String(sha).toLowerCase());

// Ping once per head, only with required checks green. The first ping trusts whoever added the label
// (an agent adds it only after a clean Sol). A review request can outlive a push, so a later head is
// pinged only when Taha is requested AND the bot itself can see it needs no Sol; a new head on the Sol
// list is the agent's to announce. Returns { ping, why }; checks/sol are thunks as in decide().
export function needsPing(pr, comments, { checks, sol }) {
  const no = (why) => ({ ping: false, why });
  if (!hasLabel(pr) || pr.isDraft || isTahasPr(pr)) return no('not a labelled, ready PR of ours');
  if (tahaReviewedHead(pr)) return no('Taha already reviewed this head');
  if (pinged(comments, pr.headRefOid).length) return no('already pinged for this head');
  const checkProblem = requiredChecksProblem(checks());
  if (checkProblem) return no(checkProblem);
  if (!pinged(comments).length) return { ping: true, why: 'first ping' };
  if (!tahaRequested(pr)) return no('new head, Taha not re-requested');
  const risk = sol();
  if (risk?.risky !== false) return no('new head on the Sol list: the agent tells Taha after Sol');
  return { ping: true, why: 'new head, Taha re-requested' };
}

export const pingText = (pr) => `<@${TAHA_SLACK}> ${link(pr.url, `#${pr.number}`)} ${esc(pr.title)} is waiting on your Approve (head ${String(pr.headRefOid).slice(0, 7)})`;

function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'gh failed').trim());
  return run.stdout;
}
const tryGh = (args) => { try { return gh(args); } catch { return null; } };

const LIST_FIELDS = 'number,title,url,author,isDraft,headRefName,headRefOid,baseRefOid,labels,reviewRequests';
// shortcut: reads at most 500 open PRs; raise the limit if the repository ever holds more.
const listOpen = () => JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '500', '--json', LIST_FIELDS]));
const viewMore = (n) => JSON.parse(gh(['pr', 'view', String(n), '--repo', REPO, '--json', 'reviews,comments']));
const currentHead = (n) => tryGh(['pr', 'view', String(n), '--repo', REPO, '--json', 'headRefOid,state', '--jq', 'select(.state=="OPEN") | .headRefOid'])?.trim();
function requiredChecks(n) {
  // gh exits non-zero while checks are pending or failing, but still prints the JSON.
  const run = spawnSync('gh', ['pr', 'checks', String(n), '--repo', REPO, '--required', '--json', 'name,bucket'], { encoding: 'utf8' });
  try { return JSON.parse(run.stdout); } catch { return /no required checks/i.test(run.stderr ?? '') ? [] : null; }
}

async function handle(pr, mode, dry) {
  Object.assign(pr, viewMore(pr.number));
  const facts = {
    checks: () => requiredChecks(pr.number),
    lane: () => tahaLaneProblem({ files: prFilesOnGitHub({ repo: REPO, gh, number: pr.number, headSha: pr.headRefOid }) }),
    sol: () => solRiskOnGitHub({ baseSha: pr.baseRefOid, headSha: pr.headRefOid, repo: REPO, gh }),
  };
  // Everything above was read for one head; a push since then means this run judged the wrong commit.
  const moved = () => currentHead(pr.number) !== pr.headRefOid;
  if (mode === 'label') {
    const d = decide(pr, facts);
    console.log(`#${pr.number} ${d.act ? 'LABEL' : 'skip'}: ${d.why}`);
    if (d.act && !dry) {
      if (moved()) return console.log(`#${pr.number} head moved; next run decides`), 0;
      gh(['api', `repos/${REPO}/issues/${pr.number}/labels`, '-f', `labels[]=${LABEL}`]);
      gh(['api', `repos/${REPO}/pulls/${pr.number}/requested_reviewers`, '-f', 'reviewers[]=TahaKhanAbdalli']);
    }
    if (d.act) { pr.labels = [...(pr.labels ?? []), { name: LABEL }]; pr.reviewRequests = [{ login: 'TahaKhanAbdalli' }]; }
  }
  const p = needsPing(pr, pr.comments, facts);
  if (!p.ping) return 0;
  if (mode === 'label' || dry) return console.log(`#${pr.number} PING due (${p.why}): ${pingText(pr)}`), 1;
  if (moved()) return console.log(`#${pr.number} head moved; next run decides`), 0;
  // Dedupe record first, so a re-run never double-posts. A failed Slack post deletes it so the next run
  // retries; a crash between the two loses that one ping (accepted: never double-post).
  const id = gh(['api', `repos/${REPO}/issues/${pr.number}/comments`, '-f',
    `body=Pinged Taha in Slack (#crx-work) for head ${pr.headRefOid.slice(0, 7)}.\n\n${pingMarker(pr.headRefOid)}`, '--jq', '.id']).trim();
  try {
    await slack('chat.postMessage', { channel: CHANNEL, text: pingText(pr) });
    console.log(`#${pr.number} pinged (${p.why})`);
  } catch (e) {
    const deleted = tryGh(['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${id}`]) !== null;
    console.log(`::warning::#${pr.number} Slack ping failed: ${e.message}${deleted ? '' : `; its dedupe comment ${id} could not be deleted, so delete it by hand to retry`}`);
  }
  return 1;
}

async function main() {
  const [mode, ...flags] = process.argv.slice(2);
  const dry = flags.includes('--dry-run');
  if (!['label', 'ping'].includes(mode)) { console.error('usage: taha-ready.mjs <label|ping> [--dry-run]'); process.exit(2); }
  if (mode === 'ping' && !dry && !process.env.SLACK_RELEASE_TOKEN) { console.log('::warning::SLACK_RELEASE_TOKEN missing; no pings sent.'); return; }
  let pingsDue = 0;
  let failed = 0;
  for (const pr of listOpen()) {
    try {
      pingsDue += await handle(pr, mode, dry);
    } catch (e) {
      failed++;
      console.log(`::warning::#${pr.number} skipped: ${String(e.message).split(/\r?\n/)[0]}`);
    }
  }
  if (mode === 'label' && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pings=${pingsDue}\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
