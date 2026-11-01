// Search text: free words plus tokens (s: l: @ # p:). Ported from herdr-linear's src/search and src/linear/filter.rs.
// Keywords work in English and Korean.

const STATE_TYPES = {
  triage: "triage", 분류: "triage",
  backlog: "backlog", 백로그: "backlog",
  unstarted: "unstarted", todo: "unstarted", 할일: "unstarted",
  started: "started", progress: "started", 진행: "started",
  completed: "completed", done: "completed", 완료: "completed",
  canceled: "canceled", 취소: "canceled",
};
const PRIORITIES = {
  none: 0, 없음: 0, 0: 0,
  urgent: 1, 긴급: 1, 1: 1,
  high: 2, 높음: 2, 2: 2,
  medium: 3, 보통: 3, 3: 3,
  low: 4, 낮음: 4, 4: 4,
};

function tokenize(s) {
  const out = [];
  let cur = "", q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    else if (/\s/.test(c) && !q) { if (cur) { out.push(cur); cur = ""; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseIdentifier(s) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(s);
  return m ? [m[1].toUpperCase(), parseInt(m[2], 10)] : null;
}

export function parse(input) {
  const q = { words: [], number: null, identifier: null, state: null, label: null, assignee: null, team: null, priority: null };
  for (const tok of tokenize(input.normalize("NFC"))) {
    const low = tok.toLowerCase();
    if (low.startsWith("s:")) {
      const v = tok.slice(2);
      const t = STATE_TYPES[v.toLowerCase()];
      if (t) q.state = { type: t }; else if (v) q.state = { name: v };
    } else if (low.startsWith("l:")) {
      if (tok.length > 2) q.label = tok.slice(2);
    } else if (low.startsWith("p:")) {
      const p = PRIORITIES[tok.slice(2).toLowerCase()];
      if (p !== undefined) q.priority = p;
    } else if (tok.startsWith("@") && tok.length > 1) {
      const v = tok.slice(1);
      q.assignee = ["나", "me"].includes(v.toLowerCase()) ? { me: true } : { name: v };
    } else if (tok.startsWith("#") && tok.length > 1) {
      q.team = tok.slice(1).toUpperCase();
    } else if (parseIdentifier(tok)) {
      q.identifier = parseIdentifier(tok);
    } else if (/^\d+$/.test(tok)) {
      q.number = parseInt(tok, 10);
    } else {
      q.words.push(tok);
    }
  }
  return q;
}

export const isEmpty = (q) => !q.words.length && q.number === null && !q.identifier && !q.state && !q.label && !q.assignee && !q.team && q.priority === null;
export const hasText = (q) => q.words.length > 0 || q.number !== null || q.identifier !== null;
export const textOf = (q) => [...q.words, ...(q.identifier ? [q.identifier.join("-")] : []), ...(q.number !== null ? [String(q.number)] : [])].join(" ");

function tokenParts(q) {
  const parts = [];
  if (q.state?.type) parts.push({ state: { type: { eq: q.state.type } } });
  if (q.state?.name) parts.push({ state: { name: { containsIgnoreCase: q.state.name } } });
  if (q.label) parts.push({ labels: { some: { name: { containsIgnoreCase: q.label } } } });
  if (q.assignee?.me) parts.push({ assignee: { isMe: { eq: true } } });
  if (q.assignee?.name) parts.push({ assignee: { or: [{ name: { containsIgnoreCase: q.assignee.name } }, { displayName: { containsIgnoreCase: q.assignee.name } }] } });
  if (q.team) parts.push({ team: { key: { eqIgnoreCase: q.team } } });
  if (q.priority !== null) parts.push({ priority: { eq: q.priority } });
  return parts;
}
const combine = (parts) => parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { and: parts };
const containsWord = (w) => [{ title: { containsIgnoreCase: w } }, { description: { containsIgnoreCase: w } }];

// The server filter. Without `#KEY` it's limited to every team the key belongs to.
export function serverFilter(q, teamIds) {
  const parts = q.words.map((w) => ({ or: containsWord(w) }));
  if (q.number !== null) parts.push({ or: [...containsWord(String(q.number)), { number: { eq: q.number } }] });
  if (q.identifier) {
    const [key, n] = q.identifier;
    parts.push({ or: [{ team: { key: { eqIgnoreCase: key } }, number: { eq: n } }, ...containsWord(`${key}-${n}`)] });
  }
  parts.push(...tokenParts(q));
  if (!q.team && teamIds.length) parts.push({ team: { id: { in: teamIds } } });
  return combine(parts);
}

export function tokenFilter(q) {
  const p = tokenParts(q);
  return p.length ? combine(p) : null;
}

// Instant search over loaded issues: a score (higher first) when it matches, else -1.
export function localScore(issue, q, viewerId) {
  if (q.state?.type && issue.state?.type !== q.state.type) return -1;
  if (q.state?.name && !issue.state?.name?.toLowerCase().includes(q.state.name.toLowerCase())) return -1;
  if (q.label && !(issue.labels?.nodes ?? []).some((l) => l.name.toLowerCase().includes(q.label.toLowerCase()))) return -1;
  if (q.assignee?.me && issue.assignee?.id !== viewerId) return -1;
  if (q.assignee?.name) {
    const n = q.assignee.name.toLowerCase();
    if (![issue.assignee?.name, issue.assignee?.displayName].some((x) => x?.toLowerCase().includes(n))) return -1;
  }
  if (q.team && issue.team?.key?.toUpperCase() !== q.team) return -1;
  if (q.priority !== null && issue.priority !== q.priority) return -1;
  let score = 0;
  if (q.identifier) {
    const [key, n] = q.identifier;
    if (issue.team?.key?.toUpperCase() === key && issue.number === n) score += 1000;
    else if (!`${issue.title} ${issue.description ?? ""}`.toUpperCase().includes(`${key}-${n}`)) return -1;
  }
  if (q.number !== null) {
    if (issue.number === q.number) score += 500;
    else if (!`${issue.title} ${issue.description ?? ""}`.includes(String(q.number))) return -1;
  }
  const title = (issue.title ?? "").toLowerCase(), desc = (issue.description ?? "").toLowerCase();
  for (const w of q.words) {
    const lw = w.toLowerCase();
    if (title.includes(lw)) score += title.startsWith(lw) ? 30 : 20;
    else if (desc.includes(lw) || issue.identifier.toLowerCase().includes(lw)) score += 5;
    else return -1;
  }
  return score;
}
