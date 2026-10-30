// Teammate review comments (Mason, 2026-10-30).
//
// Both merge gates read CodeRabbit and the Codex App, but a person's comment was
// invisible to them. Taha's review bot posts under his own account, usually as a
// plain PR comment: #1174 carried a blocking case that way, and only luck got it
// answered. So a merge is refused while a teammate's comment has no answer.
//
// A teammate is any human except the PR's author and masonwells1, the account
// Mason and the agents share. Answered means a comment, by a different human, that
// contains that comment's link. The link is the point: on #1174 two unrelated
// comments followed Taha's, and a reply naming a teammate would also clear every
// other thing they said (Sol, 2026-10-30). The gate cannot judge an answer, only
// require one that says which comment it is answering.

export const SHARED_OWNER_LOGIN = "masonwells1";

const COMMENT_FIELDS = "author { __typename login } url body";

export const TEAMMATE_COMMENTS_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      author { login }
      comments(last:100) { pageInfo { hasPreviousPage } nodes { ${COMMENT_FIELDS} } }
      reviews(last:100) { pageInfo { hasPreviousPage } nodes { ${COMMENT_FIELDS} state } }
      reviewThreads(last:100) {
        pageInfo { hasPreviousPage }
        nodes { comments(last:100) { pageInfo { hasPreviousPage } nodes { ${COMMENT_FIELDS} } } }
      }
    }
  }
}`;

function humanComment(node) {
  if (node?.author?.__typename !== "User") return null;
  const login = String(node.author.login ?? "").trim().toLowerCase();
  const body = String(node.body ?? "");
  return login && body.trim() ? { login, body, url: String(node.url ?? "") } : null;
}

// ...#issuecomment-12 must not match inside ...#issuecomment-123.
function linksTo(body, url) {
  return url !== "" && body.split(url).slice(1).some((rest) => !/^\d/.test(rest));
}

// Returns { comments: [{ login, url }], truncated }, or null when the answer is not
// a usable read.
export function unansweredTeammateComments(pullRequest) {
  const author = String(pullRequest?.author?.login ?? "").trim().toLowerCase();
  const threads = pullRequest?.reviewThreads?.nodes;
  const lists = [pullRequest?.comments, pullRequest?.reviews, pullRequest?.reviewThreads, ...(threads ?? []).map((t) => t?.comments)];
  const readable = (list) => Array.isArray(list?.nodes) && typeof list.pageInfo?.hasPreviousPage === "boolean";
  if (!author || !lists.every(readable)) return null;

  const all = [
    ...pullRequest.comments.nodes.map(humanComment),
    // A pending review is visible only to its author, so it cannot be answered.
    ...pullRequest.reviews.nodes.filter((r) => r?.state !== "PENDING").map(humanComment),
    ...threads.flatMap((t) => t.comments.nodes.map(humanComment)),
  ].filter(Boolean);

  return {
    comments: all
      .filter((c) => c.login !== author && c.login !== SHARED_OWNER_LOGIN)
      .filter((c) => !all.some((r) => r.login !== c.login && linksTo(r.body, c.url)))
      .map(({ login, url }) => ({ login, url })),
    truncated: lists.some((list) => list.pageInfo?.hasPreviousPage === true),
  };
}

// `runQuery(args)` returns gh's raw stdout; each guard keeps its own gh runner.
export function readTeammateComments(runQuery, { owner, name, number, deadlineMs = null, now = Date.now }) {
  if (deadlineMs !== null && now() >= deadlineMs) {
    throw new Error("teammate comment lookup ran out of its time budget");
  }
  const raw = runQuery([
    "api", "graphql",
    "-f", `query=${TEAMMATE_COMMENTS_QUERY}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `number=${number}`,
  ]);
  const answer = JSON.parse(raw);
  // GraphQL can return errors beside partial data, which could hide a comment.
  if (answer?.errors?.length) return null;
  return unansweredTeammateComments(answer?.data?.repository?.pullRequest);
}

export function teammateCommentsDenial(prefix, selector, comments) {
  const which = selector ? String(selector) : "<number>";
  const list = comments.map(({ login, url }) => `  @${login}: ${url}`).join("\n");
  return (
    `${prefix}: these teammate comments on this pull request have no answer yet:\n${list}\n\n` +
    "  1. Read each one.\n" +
    "  2. Fix anything real and push, or decide it needs no change.\n" +
    `  3. Answer on the PR with each link:  gh pr comment ${which} --body "<link> <what you fixed, or why no change is needed>"\n\n` +
    "One comment may answer several links; their formal approval is not needed."
  );
}

export function teammateCommentsUnreadableDenial(prefix, selector) {
  return (
    `${prefix}: could not read this pull request's comments, so an unanswered teammate comment cannot be ` +
    `ruled out. Retry the merge in a minute; if it keeps failing, read them by hand ` +
    `(gh pr view ${selector || "<number>"} --comments) and tell Mason the comment lookup is failing.`
  );
}

// shortcut: a list over 100 refuses instead of paging, and no agent can clear it;
// add paging if a PR ever gets near that (the largest of the last 100 PRs had 30).
export function teammateCommentsTruncatedDenial(prefix, selector) {
  return (
    `${prefix}: this pull request has more comments than the gate reads at once, so an unanswered teammate ` +
    `comment cannot be ruled out. Read them by hand (gh pr view ${selector || "<number>"} --comments), then ` +
    "tell Mason this one needs his decision to merge."
  );
}
