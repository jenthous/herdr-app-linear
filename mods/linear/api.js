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

// The linked open pull request; the most recently linked when there are several.
export function openPr(issue) {
  const prNumber = (url) => {
    for (const m of ["/pull/", "/merge_requests/"]) {
      const rest = url.split(m)[1];
      if (rest) { const n = parseInt(rest.split(/[/?#]/)[0], 10); if (!isNaN(n)) return n; }
    }
    return null;
  };
  const open = (issue?.attachments?.nodes ?? [])
    .filter((a) => prNumber(a.url) !== null)
    .filter((a) => /^open(ed)?$/i.test(String(a.metadata?.status ?? "")))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const a = open[0];
  if (!a) return null;
  const m = a.metadata ?? {};
  return { url: a.url, number: typeof m.number === "number" ? m.number : prNumber(a.url), repo: m.repoName ?? null, draft: Boolean(m.draft) };
}
