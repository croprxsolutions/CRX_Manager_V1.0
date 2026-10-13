# GitHub branch cleanup audit and restore ledger (2026-10-13)

**Status: REPORT. Nothing has been deleted.** Mason asked on 2026-10-13 to "analyze all our branches
we have in github … remove what is useless and cleanup". Every measurement behind this document was
read-only. Branch deletion is a hard-gated action (`AGENTS.md`), so the deletions below wait for
Mason's explicit yes in the conversation. When they run, this file is the restore ledger.

## The answer

- **GitHub held 189 branches besides `main`.** 4 belong to open PRs (#897, #898, #899 and #900) and
  stay. Of the other 185: **178 can be deleted, 5 stay for now, and 2 need Mason's call.**
- **Nothing is lost by deleting the 178.** Each one's work either merged under a later PR (most are
  "delivery laps": a PR closed and reopened as a fresh branch until one merged), was deliberately
  dropped by a Mason decision, or was made obsolete by `main`. Each verdict was challenged by two
  independent skeptics. 166 can go straight away; 12 wait for this PR, because they hold a record being
  rescued here or are named by a doc this PR repoints.
- **Every deleted branch stays restorable.** 165 of the 178 tips are kept permanently by GitHub as the
  final commit of their PR; restore them with the PR page's *Restore branch* button. 12 have no PR copy
  and get an `archive/2026-10-13/<branch>` tag on GitHub before deletion. One already has a tag.
- **No live database change is at risk.** Every migration applied to the live database is on `main` by
  name. The 10 migration files that exist only on branches were never applied, and each was replaced,
  decided against, or is parked on a kept branch.
- **Rescued in this PR** (records that lived only on branches about to go): two owner decisions that never
  reached `DECISION_LOG.md` (the 2026-08-09 pricing answers, including "commission is clawed back on
  returns", which is not built; and the 2026-08-27 ingredient identity model D-AA), and three
  `KNOWN_ISSUES.md` entries: a latent quote re-save refusal, an MCP permission gap, and a review-proof
  forgery route.

## Baseline and method

| | |
|---|---|
| `origin/main` | measured at `af0ce0c4c`; re-checked at `7abd52f6d` (#893 merged mid-run). No branch tip moved during the audit. |
| Branches | 190 heads on GitHub (`git ls-remote --heads origin`), 189 without `main` |
| PRs | `gh pr list --state all`: 886 PRs, matched to branches by head name |
| Repo setting | "Automatically delete head branches" is ON, so merged PRs clean up after themselves. The pile-up is closed-but-not-merged PRs, which GitHub never deletes. |
| Live database | `list_migrations` (1,024 rows) compared by name with `main`'s `supabase/migrations/` and each branch's migration files |

**How each branch was measured** (the method from `docs/audits/2026-09-02-github-branch-cleanup-audit.md`):
every file a branch changed since its merge base was classed against `main` by content hash as
IDENTICAL (landed), ABSENT (new file `main` lacks), BRANCH-ONLY (`main` never touched it), or MAIN-MOVED
(both changed it; scored by the share of the branch's added lines present verbatim on `main`). Commit
counts and three-dot diffs were not used as evidence, because this repository squash-merges.

**Who checked it.** A 56-agent read-only workflow:
- one investigator per topic group (18 groups), which read every PR and its closing comments, confirmed
  each successor PR's state, and checked unlanded content against `main`;
- two skeptics per group, one for code and migrations and one for records and evidence, each trying to
  prove a "delete" would lose something;
- one reader of every earlier branch report and decision;
- a completeness critic, which confirmed every branch got exactly one verdict, checked 61 cited
  successor PRs (all MERGED), and re-ran 8 delete verdicts end to end (all held).

The skeptics' four objections were accepted and are reflected below. Two of the rescued claims were
then re-checked on live, read-only: the quote re-save refusal (QuoteBuilder sends no line ids; live has
4 quotes, none affected) and the `quote_sections` grants (`authenticated` still holds TRUNCATE, TRIGGER
and REFERENCES).

## Earlier decisions: what still binds and what today's request supersedes

- **Superseded by Mason's 2026-10-13 request:** the 2026-08-24 "do not delete anything while work is in
  flight", the 2026-09-02 "leave the closed-PR branches / no further deletion pass", the 2026-09-11
  backlog plan's "cleanup after the queue drains" sequencing, and the "branch kept; reopen if needed"
  notes on PRs closed in the 2026-09-30 triage (each of those PRs stays restorable from its page).
- **Still binding, so these branches stay:** `KNOWN_ISSUES.md`'s "Do not delete that branch" for the
  pr364 protections, open issue #747's evidence branch, and the parked control-character fix that
  `KNOWN_ISSUES.md` points to.
- **Mason's own past choices that only he can reverse:** the `backup/` copy of PR #432's frozen work, and
  PR #449's branch, which he chose to keep when he retired it.

## What happens to each branch

**Delete now (166).** Superseded laps, duplicates and abandoned designs, grouped by topic. The
investigators' findings:

- **Job-to-invoice transfer retries (22)** were 19 delivery laps of PR #638 plus a 3-lap follow-up. They
  landed as #721 and #757; every lap tip is an ancestor of a merged head.
- **Field-application filed-season guard (26 across two groups)** landed as lap 20, PR #850 (`4e145adbc`),
  applied live 2026-10-02. The install docs landed as #871, and the two test-date fixes were overtaken by
  #857.
- **Inventory hold and adjustment retries (22)** were PR #624's laps. They landed as #682 and #691, live
  2026-09-15.
- **`adjust_inventory` receipt binding (10 laps)** landed as #739 (`17826e9c3`), live 2026-09-20.
- **Docs cleanup (19)** landed as #830, #839 and #866-#869.
- **Migration bookkeeping (12)**: restamps, applied-live records and registry refreshes, each merged under
  a later PR.
- **CodeRabbit and merge-gate attempts (10)** were overtaken by #456, #570, #571, #657, #706, #804 and #888.
- **Guard fixes (15 across two groups)** either landed under other PRs (#630, #648, #794, #855, #455, #564)
  or were dropped by Mason's 2026-08-25 freeze and 2026-10-02 guard policy.
- **Customer documents (6 of 9)** landed as #764, #800 and #875, verified live 2026-10-04.
- **Dependency advisories (5)** were duplicates of #645 and #844.
- **Permissions and approval (4 of 6)** landed as #841, #857 and #894.
- **Leftovers (15)**, each covered elsewhere:
  - **Return-credit COGS work** (#361, its review handoff branch, and #532's deferral) was rebuilt as
    #509 and live since 2026-09-01. #532's two test-script tweaks were judged moot and not rescued, and
    stay in PR #532.
  - **Invoice due dates from the posting date** (`codex/pr-comment-remediation-20260903`) was rejected by
    Mason on 2026-09-03.
  - **Merged elsewhere:** #892 landed as #895 and #893; #321 as #322; #491 as #500; #468 as #465; #363's
    follow-ups via #399; `claude/pr611-land-20260905` as #611.
  - **Inside retired #449:** #373.
  - **Integrity reports:** two integrity-report PRs, resolved by #889.
  - **Bulk-import retry key:** an abandoned design; the real fix is tracked in `TODO.md`.
  - **Uncommitted-files snapshot:** a 2026-09-08 snapshot, all of it superseded.

**Delete after this PR merges (12).** Five hold a record rescued here: PRs #397, #350, #507, #605 and
#612. Seven are named by a doc this PR repoints: F1's and F3's audit branches, the section1 branch, the
`adjust_inventory` lap cited in its entry, and the three PR-less customer-document page branches.

**Kept for now (5)**, each with the reason it stays, plus the 4 open-PR branches:

| Branch | Commit | Why it stays |
|---|---|---|
| `claude/pr364-guard-commits-local-20260831` | `57d27e79105b62ee9887d59bdd1f2f58ed3c0e2d` | KNOWN_ISSUES says "Do not delete that branch": only copy of three migration-apply protections main lacks (no PR copy). |
| `claude/adjust-inventory-control-char-keys-20260920` | `4bcb1d5e33e8436c97a28733db444713ebabe681` | KNOWN_ISSUES points here for the parked (accepted-residual) control-character fix; no PR copy. |
| `claude/autopilot-recursive-delete-alias-20260907` | `00cb318708b3048aa2a71fe7a58d97e8e02a3492` | Checked out at C:/CRX_rmguard with one unpushed commit and one uncommitted edit. |
| `claude/return-credit-chain-applied-2026-09-01` | `56812f3dd5e28c551a5e5dcb40898d88c2b6ead8` | Open issue #747 names this branch as its evidence. |
| `claude/rep-scope-order-invoices` | `322cbbd04d00ebbe0001e5b4c311b216bbd9b63b` | Its admin-only replacement is still unpushed; four of its findings are recorded nowhere else yet. |

**Ask Mason (2).** Both are retired work whose content is fully preserved either way. The
recommendation is to delete both: PR #449 is restorable from its page, and `backup/pr432` gets an
archive tag first.

| Branch | Commit | Restore from | Question |
|---|---|---|---|
| `backup/pr432-multitarget-20260825` | `5ffda1dd4c1e928f9b22d6ca7ffad16035dbe079` | tag archive/2026-10-13/backup/pr432-multitarget-20260825 (to create) | Offsite copy of PR #432 work you froze on 2026-08-25; the 09-02 audit said backup/* stays by default. No PR copy, so it gets an archive tag first. |
| `codex/actor-binding-mixed-notation-repair-20260810` | `b73dfc9ff7881814cf81f1d3c01d04fab212dc92` | PR #449 | PR #449, which you retired on 2026-09-12 and chose to keep the branch of. Fully restorable from the PR #449 page. |

## Other things this audit found (not deletion blockers)

1. **Latent quote bug.** Re-saving an existing quote that has two lines of the same product is refused,
   and reloading cannot clear it. Nobody is affected today: live has 4 quotes, none with a repeated
   product. Recorded in `KNOWN_ISSUES.md`; fix it before quoting is used for real.
2. **MCP permission gap.** A tool from a newly connected MCP connector runs with no prompt, because
   `migration-apply-guard.mjs` returns an explicit allow. Recorded in `KNOWN_ISSUES.md`.
3. **Stale tracking for PR #638's migration.** GitHub issue #669 ("Must fix before apply: … no enforced
   post-lock deadline") is still OPEN. Its migration (`20260914100800`) went live 2026-09-27 without that
   fix. `KNOWN_ISSUES.md` already labels its text as the pre-apply record, but nothing says whether the
   missing deadline still matters now that the migration is live. Left for a separate reconcile, because
   closing or commenting on an issue is outward-facing.
4. **Work sitting on this PC.** None of it is affected by deleting GitHub branches:
   - `C:/CRX_rmguard` holds one unpushed commit and one uncommitted edit (the kept recursive-delete
     branch).
   - The admin-only invoicing work (`claude/invoicing-admin-only-20261009` and its siblings) is not on
     GitHub yet.
   - Four local branches are 1 to 19 commits ahead of their GitHub copies, but each extra commit is a
     merge of `main` or already inside a merged PR.

## Deletion procedure (for the run after Mason's yes)

1. Re-read every tip from GitHub in the same turn and refuse any branch whose tip no longer matches this
   ledger.
2. Create and read back the `archive/2026-10-13/<branch>` tags for the branches whose restore source
   below says "to create".
3. Delete each branch through the GitHub ref API, one at a time. The repository's pre-push containment
   guard cannot parse a branch-deletion push (`KNOWN_ISSUES.md` / agent memory), so the API is the
   working route; a deletion transmits no content.
4. Confirm the count with `git ls-remote --heads origin`.

The check-then-delete is not atomic, as in the 2026-09-01 and 2026-09-03 runs. A push landing on one of
these branches in that window would be lost from the branch, though not from its PR copy. Accepted
because no target has an open PR and the newest commit on any of them is from 2026-10-09 (only two are
that recent: `claude/sol-skip-policy-proposal` and `claude/invoice-screen-safety-20261009`, both
superseded by merged PRs).

## Restoring a branch

Each row below gives the branch name, its exact commit, and where that commit lives. A PR number means
GitHub's *Restore branch* button on that PR page brings the branch back at that commit; a tag means
creating a branch at that tag. Like the earlier ledgers, this file deliberately carries no copy-paste
shell command.

## Restore ledger: branches to delete (178)

### Job-to-invoice transfer retries (PR #638 lineage) (22)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/pr638-delivery-20260913` | `392415f64953dfe8f197616acaad6bf001701ad8` | #663 closed | PR #663 | now |
| `claude/pr638-delivery10-20260915` | `db936cfddb4cddff32d1db429a646519411a84c5` | #707 closed | PR #707 | now |
| `claude/pr638-delivery11-20260915` | `742f70f5c8b4440bff04371169e3f05a940d8076` | #708 closed | PR #708 | now |
| `claude/pr638-delivery12-20260917` | `543b2dd089a596815aa89526688f4f30ee566589` | #709 closed | PR #709 | now |
| `claude/pr638-delivery13-20260917` | `543b2dd089a596815aa89526688f4f30ee566589` | #712 closed | PR #712 | now |
| `claude/pr638-delivery14-20260917` | `10e272513567b7b5441ef0631d729fbbec84e410` | #713 closed | PR #713 | now |
| `claude/pr638-delivery15-20260918` | `353b0ef8613abe0aac4928bc83a7fd28ce3dbb68` | #715 closed | PR #715 | now |
| `claude/pr638-delivery16-20260918` | `ef03cd5439db80ee15492b7927ca27ed041c5208` | #717 closed | PR #717 | now |
| `claude/pr638-delivery17-20260918` | `55e56bf7641dbf662d98e27e0c988657dd40c657` | #719 closed | PR #719 | now |
| `claude/pr638-delivery18-20260918` | `862d308b9fa617b6a8ec171c8710954567b37c0f` | #720 closed | PR #720 | now |
| `claude/pr638-delivery2-20260913` | `e00f5870f90542c0310dbeeb2be4001308326aef` | #668 closed | PR #668 | now |
| `claude/pr638-delivery3-20260914` | `9ea5e7b3e74ee60c0a53b1eb93a84500206899be` | #684 closed | PR #684 | now |
| `claude/pr638-delivery4-20260914` | `8b587e76ec3aaa0a0bd7c49b777aa075cdbc212b` | #687 closed | PR #687 | now |
| `claude/pr638-delivery5-20260914` | `1fcbaabf096d06df36effbd7e5c46b2bfb529fb1` | #690 closed | PR #690 | now |
| `claude/pr638-delivery6-20260914` | `b1f0055b2a39a9741db9df765a6e2e044bd821f5` | #696 closed | PR #696 | now |
| `claude/pr638-delivery7-20260914` | `e1cf6902d39cc2c7bffdc1e189b0d4bf12e359d9` | #697 closed | PR #697 | now |
| `claude/pr638-delivery8-20260914` | `39af0526b79f41740d20e90d6de2d8cc3ef8fda1` | #698 closed | PR #698 | now |
| `claude/pr638-delivery9-20260914` | `7f621efce63c8b43f782c09689ed3ad4fe797bbc` | #699 closed | PR #699 | now |
| `claude/transfer-intent-explicit-legacy-overload-drop` | `47a5aee224d9df5eaa7c3e991f5b28533f629032` | #753 closed | PR #753 | now |
| `claude/transfer-legacy-overload-refused-by-name` | `47a5aee224d9df5eaa7c3e991f5b28533f629032` | #755 closed | PR #755 | now |
| `claude/transfer-legacy-overload-refused-by-name-r2` | `16d5bb1f15a58a20162bcb4671dd8ea79cb0796a` | #756 closed | PR #756 | now |
| `codex/commission-transfer-idempotency-fix-20260908` | `45e3fc2bc5df01099111530f66a5f23325299a1e` | #638 closed | PR #638 | now |

### Field-application filed-season guard — Claude laps (17)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/field-invoice-filed-season-20260920` | `dbd3fb333eba20ab36d64f208c1b9daaaa336672` | #731 closed | PR #731 | now |
| `claude/field-season-delivery-final-20260920` | `4920df8e44a1da683a224b6827a594a9aba87425` | #748 closed | PR #748 | now |
| `claude/field-season-delivery-lap10-20260922` | `920b4eb8373fa5bec25ae072a68de2fdcfca73d6` | #774 closed | PR #774 | now |
| `claude/field-season-delivery-lap11-20260923` | `acc33bc04acbaa45733f158360414f7484041cba` | #781 closed | PR #781 | now |
| `claude/field-season-delivery-lap12-20260923` | `925d2929314679c59bd7020a9539e906e9f1fd65` | #793 closed | PR #793 | now |
| `claude/field-season-delivery-lap13-20260927` | `7cfa4b495974e0632c03cd5d4eccdf57f8f81e09` | #828 closed | PR #828 | now |
| `claude/field-season-delivery-lap14-20260927` | `1f96c388e4cb2313cb92ff49abb897e6d4d31472` | #829 closed | PR #829 | now |
| `claude/field-season-delivery-lap15-20260927` | `0b63d7f2d931254c588c8981fa06b7e45ff3641a` | #832 closed | PR #832 | now |
| `claude/field-season-delivery-lap16-20260928` | `669e4c9b93e731a0ed7409841beb7ee207b2f01d` | #837 closed | PR #837 | now |
| `claude/field-season-delivery-lap17-20260928` | `89a9898c7a2958321c9123c79716ce21e79afbe4` | #838 closed | PR #838 | now |
| `claude/field-season-delivery-lap18-20260928` | `188e09e14cd97f2e41ae897ab7c88402975bfbb8` | #842 closed | PR #842 | now |
| `claude/field-season-delivery-lap19-20260928` | `a3acffc80f5d0c8bb946b5e66e85bb059f7f00f8` | #843 closed | PR #843 | now |
| `claude/field-season-delivery-lap6-20260920` | `13e89a3b864e1dee4236e22cbcda30df21e58e64` | #751 closed | PR #751 | now |
| `claude/field-season-delivery-lap7-20260921` | `068be7bfafdd54a9fb4cf5cbeef7de4e0c15e235` | #754 closed | PR #754 | now |
| `claude/field-season-delivery-lap8-20260921` | `9eb9348472aee4fc1a1347a0558ce5695d1869b0` | #758 closed | PR #758 | now |
| `claude/field-season-delivery-lap9-20260921` | `50ba943d65b74cbe9a35fc056e4fa0f1ac26b46c` | #762 closed | PR #762 | now |
| `claude/pr700-field-season-delivery-20260920` | `fe13e961b6f570f05d4115224bdccdc655f78772` | #742 closed | PR #742 | now |

### Inventory retries — PR #624 Codex laps (15)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `codex/pr624-acknowledgment-read-cleanup-20260913` | `b5357ce6450175cffe684ee1aa64a8fbb98e285c` | #679 closed | PR #679 | now |
| `codex/pr624-acknowledgment-write-dedup-20260913` | `66a3907dedac8b79c9b489d7ff4ae010293d6a3d` | #678 closed | PR #678 | now |
| `codex/pr624-batch-retry-integration-20260913` | `033921841a3c80c86016e5c043209b82234f0dad` | #689 closed | PR #689 | now |
| `codex/pr624-confirmed-receiving-20260913` | `52556142da940b7c08aeb79ab7532a9b3b8a780d` | #674 closed | PR #674 | now |
| `codex/pr624-coverage-contracts-20260913` | `6e55c727bfbbfa6c246d5d4858a209d103971242` | #675 closed | PR #675 | now |
| `codex/pr624-current-main-delivery-20260913` | `043413b2edfb59998fffd1dbe724f96eeb756e20` | #683 closed | PR #683 | now |
| `codex/pr624-final-candidate-20260913` | `0b87a742ce2a2101fed55a890b6f49086b66f3d4` | #665 closed | PR #665 | now |
| `codex/pr624-final-review-corrections-20260913` | `0579a688153146bacf49810923d1c6613d6ff99d` | #680 closed | PR #680 | now |
| `codex/pr624-final-review-fixes-20260913` | `f7da37d579d1b48e43f3daf06a711b7022f1beae` | #676 closed | PR #676 | now |
| `codex/pr624-opus-reconciliation-20260913` | `e69874c466e2372769fa0180afd377f4b182f914` | #673 closed | PR #673 | now |
| `codex/pr624-peer-acknowledgment-retention-20260913` | `2ce8c1217015a8d177847c740e452f21c44b56c8` | #685 closed | PR #685 | now |
| `codex/pr624-peer-claim-override-reconciliation-20260913` | `934615fcee73c9d4d73f7770a3466ea4830b15e4` | #681 closed | PR #681 | now |
| `codex/pr624-receipt-proof-fix-20260913` | `908940b51d5ec572ee0f84e706a27d69434c8d4d` | #671 closed | PR #671 | now |
| `codex/pr624-retry-preparation-warnings-20260913` | `f83acc19b8fca5cfd253fc5c6d4882f55985b3bd` | #677 closed | PR #677 | now |
| `codex/pr624-staging-error-fix-20260913` | `dbd812a0ff6a829955fd2de8336a2f7bb1ab476b` | #667 closed | PR #667 | now |

### Docs cleanup part 1 laps (12)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/docs-cleanup-1-corrections` | `c86c7685fd3bcb1bb438fe9c2964aa980aa5f87f` | #809 closed | PR #809 | now |
| `claude/docs-cleanup-1-corrections-v10` | `ac3249ded5116fdb9945971c8c560b0974bc269f` | #818 closed | PR #818 | now |
| `claude/docs-cleanup-1-corrections-v11` | `86db976001f7637bdc2f7c3dec7dd237623611f9` | #819 closed | PR #819 | now |
| `claude/docs-cleanup-1-corrections-v12` | `697d73dd74773ffbf34899521864ed4d46f1a9c4` | #821 closed | PR #821 | now |
| `claude/docs-cleanup-1-corrections-v2` | `c86c7685fd3bcb1bb438fe9c2964aa980aa5f87f` | #810 closed | PR #810 | now |
| `claude/docs-cleanup-1-corrections-v3` | `cc763fb6873d26bd8cbc4a563afdb4b7caa304ab` | #811 closed | PR #811 | now |
| `claude/docs-cleanup-1-corrections-v4` | `aeeb630c4afa4a2a5f432aae2091e696952c260d` | #812 closed | PR #812 | now |
| `claude/docs-cleanup-1-corrections-v5` | `a1bc9881856698546ca2b442dc32774ea3c15e9b` | #813 closed | PR #813 | now |
| `claude/docs-cleanup-1-corrections-v6` | `24182a0c3b70f9425419fafe9d96691a512e16b8` | #814 closed | PR #814 | now |
| `claude/docs-cleanup-1-corrections-v7` | `8123df326665af50330264e4518cddfddff3a6a2` | #815 closed | PR #815 | now |
| `claude/docs-cleanup-1-corrections-v8` | `47632834aaf8d75c7d498cc9147a74f93f41cc9c` | #816 closed | PR #816 | now |
| `claude/docs-cleanup-1-corrections-v9` | `39c3bc6fb6bfa65ea4fa35eaea6c40f42eaaacbb` | #817 closed | PR #817 | now |

### Migration bookkeeping (12)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `chore/migration-ledger-reconcile-20260729` | `65716b1c2d910b4d1ebf995eba6302926e1f8efc` | #275 closed | PR #275 | now |
| `claude/617-applied-live-docs` | `c787dca8c58093e9d58609c69b6c0340a360a5aa` | #729 closed | PR #729 | now |
| `claude/617-applied-live-docs-v2` | `4d7540684450e828d1cff16b9d23aa58cd79d49b` | #733 closed | PR #733 | now |
| `claude/comment-fix-applied-closeout` | `01660702bca67d42908a98f968e80207fb6b025f` | #501 closed | PR #501 | now |
| `claude/recover-applied-migrations-20260812` | `27817c2a532993c92be36e0c9f63905f50aa3256` | #395 closed | PR #395 | now |
| `claude/refresh-schema-registry-after-restamp` | `3d199a5b668007c213279a09ad8e16d09a4859d2` | #710 closed | PR #710 | now |
| `claude/restamp-stranded-20260905-migrations` | `230f32baff6a3e75ee7654669b0f89ac26157bbe` | #688 closed | PR #688 | now |
| `claude/restamp-stranded-20260905-migrations-delivery-2` | `5826926fc90f898d9dd1ea5e588722f36751cc34` | #695 closed | PR #695 | now |
| `claude/restamp-stranded-20260905-migrations-delivery-3` | `aa4c4abf14d854cf300ef04707d5af563d8685c3` | #701 closed | PR #701 | now |
| `claude/restamp-stranded-20260905-migrations-delivery-4` | `aa4c4abf14d854cf300ef04707d5af563d8685c3` | #702 closed | PR #702 | now |
| `claude/restamp-stranded-20260905-migrations-delivery-5` | `ec0af0d84a1acd17ab2ede6cdcf67c304dec22f6` | #703 closed | PR #703 | now |
| `claude/schema-registry-refresh-20260905` | `dd212907206896976192919e46990528eb7ace2d` | #602 closed | PR #602 | now |

### CodeRabbit and merge-gate attempts (11)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/approval-head-binding-20260902` | `53e9c07142a4428848a3cebc0c31d2c1b83334c9` | #556 closed | PR #556 | now |
| `claude/close-superseded-delivery-prs-20260914` | `133d10f25c8cb2c20e5a8951e3e019feb0dd5c24` | #705 closed | PR #705 | now |
| `claude/coderabbit-request-path-guard-text` | `834fdf976d9f6faf1de31603c1dd3ab21182cbbd` | #634 closed | PR #634 | now |
| `claude/coderabbit-review-gate-b9f43a` | `a4483886fd8d958cc4afb36926c18c0fb66b107c` | #569 closed | PR #569 | now |
| `claude/coderabbit-setup-optimize-0f308d` | `5b58e3524aa4773c8f6d49cce73bfd57f1165789` | #441 closed | PR #441 | now |
| `claude/sol-skip-policy-proposal` | `c264695f0a8a50a369794cb0c65ac7feff1984b4` | #870 closed | PR #870 | now |
| `codex/coderabbit-execution-context-20260913` | `feb925977fb1ee7bb10da81739640496d7aa790d` | #656 closed | PR #656 | now |
| `codex/coderabbit-native-landing-20260913` | `e8527796971d13e1bc3e356349bda6ddf04820a1` | #654 closed | PR #654 | now |
| `codex/coderabbit-native-request-20260909` | `27531bf188fc6db3ab6726f0b28f362b4985e4d3` | #647 closed | PR #647 | now |
| `codex/coderabbit-snapshot-retry-20260913` | `e3f9d006fd64fe483909a39eb5b467d3a8cc7e86` | #655 closed | PR #655 | now |
| `codex/pr389-coderabbit-fixes` | `203a4742a9c2f072de63db52848035ebda510b98` | #397 closed | PR #397 | after this PR |

### adjust_inventory receipt binding (11)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bind-adjust-inventory-receipt` | `76e2ae4071fd17b01561ebdf69b21b5c7d629dbc` | #664 closed | PR #664 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917` | `96508921571f883ab2de6d53e1622ca12deb7755` | #711 closed | PR #711 | after this PR |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-10` | `e7adccc8b860d103f8fe89ee6b4f6d6061949cf4` | #738 closed | PR #738 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-2` | `96508921571f883ab2de6d53e1622ca12deb7755` | #714 closed | PR #714 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-3` | `ed017afc7263871ef6cb74a340d2b5e24c7471ff` | #716 closed | PR #716 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-4` | `5a837a1de13b3b792dce7651efc3f8cd6e9b004e` | #718 closed | PR #718 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-5` | `2939083b633ad8138104b800a79a9e048f0af422` | #723 closed | tag archive/2026-10-13/claude/bind-adjust-inventory-receipt-delivery-20260917-5 (to create) | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-6` | `b0d6236bb6208b65336bda945ee619d4e82b26b3` | #727 closed | PR #727 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-7` | `6eca0d786edd6c4155cc61f2ebe62d4fcad99c92` | #732 closed | PR #732 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-8` | `ca68bb3df9435a074e51c7706938ab1c9b593a20` | #735 closed | PR #735 | now |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-9` | `22ae064a11452b8e6345975e4604851eac6e2ad5` | #737 closed | PR #737 | now |

### Customer documents (9)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/crx-soft-delete-download-revoke-50befc` | `66fec5a379638ceffa170f1f5371f75858d71f5c` | #759 closed | PR #759 | now |
| `claude/crx-soft-delete-download-revoke-v2` | `ecb4055dbe200c050b5dd6f1a890fcb6b03dbd47` | #760 closed | PR #760 | now |
| `claude/crx-soft-delete-download-revoke-v3` | `d8c30f7394183d1a73614de7b0b0f7397fe4b989` | #761 closed | PR #761 | now |
| `claude/crx-soft-delete-download-revoke-v4` | `470a3f37508f3d31cc49c10f4a6734b76f95f927` | #763 closed | PR #763 | now |
| `claude/customer-document-rep-remove-page` | `fda25d4a691f0a2ce6259102834b68097291ebb9` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page (to create) | after this PR |
| `claude/customer-document-rep-remove-page-v2` | `aee5c0c1f4b8e301438cc852a5566519f977281f` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v2 (to create) | after this PR |
| `claude/customer-document-rep-remove-page-v3` | `812174bc0b02330c06b5727c1443f5a506d0ed25` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v3 (to create) | after this PR |
| `claude/customer-document-rep-soft-delete` | `bb3432e086a998c15d4033c02c3a436eb833b72e` | #769 closed | PR #769 | now |
| `codex/customer-document-soft-delete-20260908` | `a50130bfed7071307db8af2588592de00604afef` | #635 closed | PR #635 | now |

### Field-application filed-season guard — Codex laps, install docs, test fixes (9)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/field-season-install-20261001` | `14688aa8ffecd2646d36848696fc0dfd76e63263` | #862 closed | PR #862 | now |
| `claude/field-season-install-20261001b` | `edcf6d6e6b4f53702344880365377790b0b7404f` | #865 closed | PR #865 | now |
| `claude/fix-field-app-invoice-test-date` | `ab6eede1df10e37e5c9ac652086b36efaf9ab7a9` | #860 closed | PR #860 | now |
| `claude/fix-invoice-date-test-rollover` | `870d79ee0e3f31967cf6440a250b1ac67fecb64a` | #859 closed | PR #859 | now |
| `codex/field-app-current-main-20260914` | `dbd3fb333eba20ab36d64f208c1b9daaaa336672` | #700 closed | PR #700 | now |
| `codex/field-app-filed-season-guard-20260912` | `7a0ed406b1fec7459edea78243bbc0fddffde7a5` | #652 closed | PR #652 | now |
| `codex/field-app-season-final-20260913` | `e730b40b403044b1217870915a7e402e214e5c2d` | #660 closed | PR #660 | now |
| `codex/field-app-season-review-fixes-20260913` | `dd3ce212c884c20f575ed189225f0549e04a5894` | no PR | tag archive/2026-10-13/codex/field-app-season-review-fixes-20260913 (to create) | now |
| `codex/field-app-season-reviewed-20260913` | `5818d67aee18ae3a02d957a4359f859d4dedae0a` | #662 closed | PR #662 | now |

### Guard fixes (A) (8)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bash-safety-opacity-cleanup` | `bf54a52c9114e803ef95cc5c9a4eee93ea02c507` | #527 closed | PR #527 | now |
| `claude/codex-guard-single-ampersand` | `dddc6d74820a6f82e9a8cbdc54ede3838c4a3f76` | #464 closed | PR #464 | now |
| `claude/codex-recursion-hard-guard` | `47820dff7ed6f4fd85767f8a62d0e9f21880808e` | #452 closed | PR #452 | now |
| `claude/live-data-guard-comment-aware` | `b326461e0e9974bb185d6e1f578c592f6a6bcf1f` | #639 closed | PR #639 | now |
| `claude/nested-guards-delivery-20260930` | `9704220f3b166f7252ecdce8d5045b6c408cd505` | #851 closed | PR #851 | now |
| `claude/peer-envelope-fence-504b` | `890b41dcb233ad8c3f45c6dd9d3e14d38388135a` | #768 closed | PR #768 | now |
| `claude/pr-630-adversarial-review-vrpl9r` | `e9e212fa395633ba0ff78d027e24ad12b91da8b3` | #795 closed | PR #795 | now |
| `fix/push-guard-binary-shape` | `81c70d7c81c4ff2def5445b0d1765e14fde5c173` | #626 closed | PR #626 | now |

### Guard fixes (B) (8)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/actor-forgery-sweeps-20260902` | `c12c85ab8ec905ba8e6e162ffa61c7a312adfdd7` | #551 closed | PR #551 | now |
| `claude/push-guard-git-resolution` | `62d22b6e9de259f5c5653d7a0ebc5f911a779d10` | #445 closed | PR #445 | now |
| `claude/remove-guard-hooks-f23691` | `0ac235d0e50e106fb2c5e5df4dff46aad02144fa` | #503 closed | PR #503 | now |
| `claude/review-proof-guard-read-only-narrowing` | `e02709981a3ccabfd2991a41c32082fe5329525b` | #612 closed | PR #612 | after this PR |
| `claude/session-orchestration-setup-d73e6c` | `238d242ea87f789573e7642c9579c103909ac8a2` | #364 closed | PR #364 | now |
| `codex/pr402-review-gaps-20260819` | `8811927fff8d6a7d375a91b48be6be1ebb6d5781` | #432 closed | PR #432 | now |
| `codex/proof-wrapper-trusted-git-bootstrap` | `a2e1d0a183691964c2bdf9e2c5a38af33df24d69` | #454 closed | PR #454 | now |
| `codex/sol-gate-recovery-exception` | `9817fb9e058aef0732ef58fb033c5e9ca635bcc1` | #403 closed | PR #403 | now |

### Docs cleanup — other (7)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/changelog-docs-honesty` | `cc8eed92c50815802d604fe0725b5a617d44ed3e` | #505 closed | PR #505 | now |
| `claude/docs-cleanup-3-remove-finished` | `50f11d9ec92c36d298d1ea7e1c01e81c28268cd1` | #835 closed | PR #835 | now |
| `claude/docs-cleanup-3-remove-finished-v2` | `2f9bee7c13dc688b8967c90d452e8163acce5c69` | #854 closed | PR #854 | now |
| `claude/docs-cleanup-fix-stale-facts` | `98f60e6d0ff719223d3ed164bffe2c98a15b9f01` | #807 closed | PR #807 | now |
| `claude/docs-review-best-practices-trv6qq` | `fbbe6fd311d37d6f6285667cb0e404762eb48f77` | #836 closed | PR #836 | now |
| `claude/repo-docs-cleanup-101ef7` | `a3f58c5811c4b42095a2f35a7dc6721a6f5fe148` | #803 closed | PR #803 | now |
| `codex/lean-agent-docs-20260904` | `f1d2037df191d9a854b03257e07c0204d0126335` | #600 merged | tag archive/2026-10-13/codex/lean-agent-docs-20260904 (to create) | now |

### Inventory retries — other laps (7)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/inventory-hold-retry-delivery` | `492331008109dfb65af47fe95d669fb0ca465138` | #666 closed | PR #666 | now |
| `claude/inventory-hold-retry-delivery-2` | `80531fb644cbe305f8dec0703c781d29f1cda98d` | #670 closed | PR #670 | now |
| `claude/inventory-hold-retry-delivery-3` | `08cc28a4131e637ec89cf3cd6f072a0f8cc45ea4` | #672 closed | PR #672 | now |
| `claude/inventory-idempotency-key-reset-888161` | `b36de2ad887e66bc11c5fb8b78108dbce65d24d3` | #624 closed | PR #624 | now |
| `codex/inventory-ack-reload-delivery-20260913` | `66afc1cb043927e311e67c5a630d09508fb154db` | #661 closed | PR #661 | now |
| `codex/inventory-peer-ack-delivery-20260913` | `86b9ecb3a3f92831be9968e51d2c9a716fb45c93` | #659 closed | PR #659 | now |
| `codex/inventory-retry-native-delivery-20260913` | `f7b7bfc6b74d5af7b7ff16e9ddb11afa504e5b48` | #658 closed | PR #658 | now |

### Money and security one-offs (7)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/invoice-screen-safety-20261009` | `f6d996e56892d7118d9546dbdc41a20b1bbbc3d4` | #892 closed | PR #892 | now |
| `codex/harden-actor-binding-sql-reader` | `e652f7232da2b16b10d5e770b919d969337488d4` | #373 closed | PR #373 | now |
| `codex/idempotency-reset-order-hardening-20260802` | `9049efc80e3e9cf8956b32061fab0688487a8758` | no PR | tag archive/2026-10-13/codex/idempotency-reset-order-hardening-20260802 (to create) | after this PR |
| `codex/pr-comment-remediation-20260903` | `5dbad8a3fa76f2ae1a8a86a9bf9ab7108a260def` | #591 closed | PR #591 | now |
| `codex/section1-security-hardening-20260725` | `53f6177eb6afe628c5de437ac27f4a9cd8fbb7cf` | no PR | tag preserve/2026-07-29/codex-section1-security-hardening-20260725 (exists) | after this PR |
| `codex/section4-lifecycle-20260805` | `99cfcff5825ea9598eeb59d4f07a057e1e2e7379` | #321 closed | PR #321 | now |
| `codex/section9-ap-safety-remediation` | `0f8bf3aad7f0b6dea6632393402478cf85db6624` | #491 closed | PR #491 | now |

### Miscellaneous (6)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bulk-import-retry-scopes` | `ed62508e2937457a3ff58658b76d95525983320a` | no PR | tag archive/2026-10-13/claude/bulk-import-retry-scopes (to create) | now |
| `claude/pr611-land-20260905` | `231ad9cdde4b137aa36eedb88cd6c75f3e25fbd7` | no PR | tag archive/2026-10-13/claude/pr611-land-20260905 (to create) | now |
| `fix/quote-fixture-stale-date` | `be5df11c5dafce08f69bec0e9c4ad079122d24eb` | #468 closed | PR #468 | now |
| `ops/integrity-report-2026-09-01` | `a9dad49cb2a135cc7a3ac5c7fd6827d93922cc85` | #539 closed | PR #539 | now |
| `ops/integrity-report-2026-10-01` | `fa748a0fdc8a4d17e42e2ca0916fc3fec4d35f45` | #861 closed | PR #861 | now |
| `preserve/crx-manager-uncommitted-archive-20260908` | `5dcdb853e4bcf5101fa4966fface8ce64cf0dbc5` | no PR | tag archive/2026-10-13/preserve/crx-manager-uncommitted-archive-20260908 (to create) | now |

### Permissions and owner approval (6)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/control-file-coverage-a41c` | `b985e919bef5e3dea538f7c6b9b5fd5b9d76a908` | no PR | tag archive/2026-10-13/claude/control-file-coverage-a41c (to create) | after this PR |
| `claude/gallant-jackson-b07f96` | `d8a6fdbcdfbccae4753ef498755080f40e5399d1` | #822 closed | PR #822 | now |
| `claude/loosen-claude-permissions-20260905` | `d5cc21353ef0229fea6b57f8dd62b6175ab6c091` | #605 closed | PR #605 | after this PR |
| `claude/owner-approval-route-20260929` | `fd52fb46177061b1c4e64011c8d8f9b95be8c9d9` | #845 closed | PR #845 | now |
| `claude/owner-approval-route-20260930` | `c9849dacc314d2c70323bf9dbff91dd8b6cf9293` | #853 closed | PR #853 | now |
| `codex/autonomy-with-hard-boundaries-20260827` | `3accebbef6abfe2327188a6fb6ebabae2a5f518e` | #513 closed | PR #513 | now |

### Pricing and return-credit (August) (6)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/codex-claude-cogs-handoff-7bde15` | `e3c4a3fc47df9c8c9eabe3e35452482a5775ff64` | no PR | tag archive/2026-10-13/claude/codex-claude-cogs-handoff-7bde15 (to create) | now |
| `claude/ordering-cycle-review-t41vat` | `992ee08881768f008ef0e51dac22972ed531615f` | #363 closed | PR #363 | now |
| `claude/pricing-audit-strategy-jym8rr` | `f4eaa8259834405d26ae11b57ed454e881d94ec9` | #350 closed | PR #350 | after this PR |
| `claude/product-plan-rev12-followup` | `74ccba0f7888e69050d4951be9df02de2de25d68` | #507 closed | PR #507 | after this PR |
| `claude/return-credit-cogs-reversal` | `c4e83dea632b37b02e8b14e64c2859b7668f0e77` | #361 closed | PR #361 | now |
| `codex/defer-return-credit-rollout-20260831` | `ac695f4993effb3f2dafb2a77acf85e6670b2d74` | #532 closed | PR #532 | now |

### Dependency advisories (5)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/audit-brace-expansion-fast-uri` | `6ead36f7bf48f8b1eaef1bf1bd81ced1c21a377a` | #847 closed | PR #847 | now |
| `claude/brace-expansion-audit-fix` | `8cbe2478b03da53e977694a0ce99589c1b1e5de3` | #848 closed | PR #848 | now |
| `claude/deps-audit-fix-20260930` | `1f7449f79cca5f5492a8d64f5e0b1436eda79a92` | #846 closed | PR #846 | now |
| `claude/deps-audit-fix-20260930-v2` | `1f7449f79cca5f5492a8d64f5e0b1436eda79a92` | #849 closed | PR #849 | now |
| `claude/js-yaml-high-advisory-20260908` | `cf28a8601d5da6d4b6c434b7d2c4179298afe406` | #644 closed | PR #644 | now |
