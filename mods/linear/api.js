// Linear GraphQL: the key, requests and queries (ported from herdr-linear's src/linear/queries.rs).

import { readTextFile, home, exec } from "herdr";

const ENDPOINT = "https://api.linear.app/graphql";
export const PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 50;
const RELATION_PAGE_SIZE = 50;
const DEEP_SEARCH_SIZE = 20;

// Shares the key herdr-linear saves. The first one found wins.
export function keyPaths() {
  const h = home();
  return [
    `${h}/.config/herdr/plugins/config/jh.linear/credentials`,
    `${h}/.config/herdr-linear/credentials`,
  ];
}

// LINEAR_API_KEY in the login environment comes first, then the credentials files.
export async function loadKey() {
  try {
    const r = await exec("sh", ["-lc", 'printf %s "$LINEAR_API_KEY"']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  for (const p of keyPaths()) {
    try {
      const text = await readTextFile(p);
      const key = text?.trim();
      if (key) return key;
    } catch {}
  }
  return null;
}

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // auth | ratelimit | network | graphql | notfound (i18n.js has the text)
  }
}

export async function gql(key, query, variables = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new ApiError("network", String(e?.message ?? e));
  }
  let body = null;
  try { body = JSON.parse(await res.text()); } catch {}
  const errors = body?.errors ?? [];
  const code = errors[0]?.extensions?.code;
  if (res.status === 401 || code === "AUTHENTICATION_ERROR") throw new ApiError("auth", "unauthorized");
  if (res.status === 429 || code === "RATELIMITED") throw new ApiError("ratelimit", "rate limited");
  if (errors.length) {
    const msg = errors.map((e) => e.message).join("; ");
    if (/not found|could not find|entity not found/i.test(msg)) throw new ApiError("notfound", msg);
    throw new ApiError("graphql", msg);
  }
  if (!res.ok) throw new ApiError("network", `HTTP ${res.status}`);
  return body?.data ?? {};
}

const RELATED = "id identifier title state { id name type color }";
const ISSUE = `id identifier number title description priority url branchName dueDate createdAt updatedAt archivedAt trashed
  team { id key name } state { id name type color } assignee { id name displayName } project { id name }
  cycle { id number name } parent { ${RELATED} } labels(first: 20) { nodes { id name color } }
  attachments(first: 10) { nodes { url sourceType createdAt metadata } }`;
const FRAGMENT = `fragment IssueFields on Issue { ${ISSUE} }`;

export async function viewer(key) {
  const d = await gql(key, "query Viewer { viewer { id name displayName email organization { id name urlKey } teams { nodes { id key name } } } }");
  return d.viewer;
}

async function issuesPage(key, filter, after = null) {
  const q = `query Issues($filter: IssueFilter, $after: String, $first: Int) {
    issues(filter: $filter, after: $after, first: $first, orderBy: updatedAt) { nodes { ...IssueFields } pageInfo { hasNextPage endCursor } } } ${FRAGMENT}`;
  const d = await gql(key, q, { filter, after, first: PAGE_SIZE });
  return d.issues;
}

// Open issues assigned to me (not completed, canceled or duplicate).
export async function myIssues(key) {
  const p = await issuesPage(key, {
    assignee: { isMe: { eq: true } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } },
  });
  return p.nodes;
}

// Issues of every team the key belongs to, most recently updated first.
export function teamIssues(key, teamIds, after) {
  return issuesPage(key, teamIds.length ? { team: { id: { in: teamIds } } } : {}, after);
}

export async function filterIssues(key, filter) {
  return (await issuesPage(key, filter)).nodes;
}

// Server search including comments. Its rate limit is low, so only on request.
export async function deepSearch(key, term, filter) {
  const q = `query Deep($term: String!, $filter: IssueFilter, $first: Int) {
    searchIssues(term: $term, filter: $filter, first: $first, includeComments: true) { nodes { ${ISSUE} } } }`;
  const d = await gql(key, q, { term, filter: filter ?? null, first: DEEP_SEARCH_SIZE });
  return d.searchIssues.nodes;
}

function detailQuery(withRelations) {
  const rel = withRelations
    ? ` children(first: ${RELATION_PAGE_SIZE}) { nodes { ${RELATED} subIssueSortOrder } pageInfo { hasNextPage } }
        relations(first: ${RELATION_PAGE_SIZE}) { nodes { type relatedIssue { ${RELATED} } } }
        inverseRelations(first: ${RELATION_PAGE_SIZE}) { nodes { type issue { ${RELATED} } } }`
    : "";
  return `query Detail($id: String!, $first: Int) { issue(id: $id) { ...IssueFields
    comments(first: $first) { nodes { id body createdAt editedAt user { id name displayName } } pageInfo { hasNextPage } }${rel} } } ${FRAGMENT}`;
}

// An issue with comments, sub-issues and relations. `id` is a UUID or an identifier (ENG-123).
// null when it doesn't exist. If the relation fields fail (a relation to a team you can't see),
// it asks again without them.
export async function issueDetail(key, id) {
  let d, withRel = true;
  try {
    d = await gql(key, detailQuery(true), { id, first: COMMENT_PAGE_SIZE });
  } catch (e) {
    if (e.kind === "notfound") return null;
    if (e.kind !== "graphql") throw e;
    withRel = false;
    try { d = await gql(key, detailQuery(false), { id, first: COMMENT_PAGE_SIZE }); }
    catch (e2) { if (e2.kind === "notfound") return null; throw e2; }
  }
  const i = d.issue;
  if (!i) return null;
  const comments = [...(i.comments?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let relations = null;
  if (withRel) {
    const kids = [...(i.children?.nodes ?? [])].sort((a, b) =>
      (a.subIssueSortOrder ?? Infinity) - (b.subIssueSortOrder ?? Infinity));
    relations = { children: kids, moreChildren: i.children?.pageInfo?.hasNextPage ?? false, blocking: [], blockedBy: [], related: [] };
    const push = (list, x) => { if (x && !list.some((y) => y.id === x.id)) list.push(x); };
    for (const n of i.relations?.nodes ?? []) {
      if (n.type === "blocks") push(relations.blocking, n.relatedIssue);
      else if (n.type === "related") push(relations.related, n.relatedIssue);
    }
    for (const n of i.inverseRelations?.nodes ?? []) {
      if (n.type === "blocks") push(relations.blockedBy, n.issue);
      else if (n.type === "related") push(relations.related, n.issue);
    }
  }
  const { comments: _c, children: _k, relations: _r, inverseRelations: _i, ...issue } = i;
  return { issue, comments, moreComments: i.comments?.pageInfo?.hasNextPage ?? false, relations, at: Date.now() };
}

function prNumber(url) {
  for (const m of ["/pull/", "/merge_requests/"]) {
    const rest = String(url ?? "").split(m)[1];
    if (rest) { const n = parseInt(rest.split(/[/?#]/)[0], 10); if (!isNaN(n)) return n; }
  }
  return null;
}

// The overall review: changes requested beats approved, using each reviewer's latest decision.
function reviewState(reviews) {
  const last = new Map();
  for (const r of [...(reviews ?? [])].sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")))) {
    const st = String(r.state ?? "").toLowerCase();
    const who = r.reviewerId ?? r.reviewerLogin ?? "?";
    if (st === "approved" || st === "changes_requested") last.set(who, st);
    else if (st === "dismissed") last.delete(who);
  }
  const all = [...last.values()];
  return all.includes("changes_requested") ? "changes" : all.includes("approved") ? "approved" : null;
}

// Every linked pull request, most relevant first: open (drafts after ready ones), then merged, then closed;
// newest first within each. `status` is open | draft | merged | closed.
export function prs(issue) {
  const rank = { open: 0, draft: 1, merged: 2, closed: 3 };
  return (issue?.attachments?.nodes ?? [])
    .filter((a) => prNumber(a.url) !== null)
    .map((a) => {
      const m = a.metadata ?? {};
      const raw = String(m.status ?? "").toLowerCase();
      const status = raw === "merged" || m.mergedAt ? "merged"
        : raw === "closed" || m.closedAt ? "closed"
        : m.draft || raw === "draft" ? "draft" : "open";
      return {
        url: a.url, number: typeof m.number === "number" ? m.number : prNumber(a.url), repo: m.repoName ?? null,
        status, draft: status === "draft", review: status === "open" || status === "draft" ? reviewState(m.reviews) : null,
        conflicts: (status === "open" || status === "draft") && m.hasConflicts === true, at: a.createdAt ?? "",
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || b.at.localeCompare(a.at));
}

// The pull request to show for an issue: the most relevant linked one, or null.
export function mainPr(issue) {
  return prs(issue)[0] ?? null;
}

// The linked open pull request (draft or not); the most recently linked when there are several.
export function openPr(issue) {
  const p = mainPr(issue);
  return p && (p.status === "open" || p.status === "draft") ? p : null;
}

// A team's workflow states in board order.
export async function teamStates(key, teamId) {
  const d = await gql(key, "query States($id: String!) { team(id: $id) { states { nodes { id name type position color } } } }", { id: teamId });
  return [...(d.team?.states?.nodes ?? [])].sort((a, b) => a.position - b.position);
}

export async function setState(key, issueId, stateId) {
  const q = `mutation SetState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ...IssueFields } } } ${FRAGMENT}`;
  const d = await gql(key, q, { id: issueId, stateId });
  return d.issueUpdate?.success ? d.issueUpdate.issue : null;
}

// Posts a comment (Markdown) on an issue; the new comment in the shape issueDetail returns.
export async function createComment(key, issueId, body) {
  const q = `mutation Comment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body createdAt editedAt user { id name displayName } } } }`;
  const d = await gql(key, q, { issueId, body });
  return d.commentCreate?.success ? d.commentCreate.comment : null;
}
