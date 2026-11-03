// Search text: free words plus tokens (s: l: @ # p:). Ported from herdr-linear's src/search and src/linear/filter.rs.
// Keywords work in English and Korean. A token takes several values joined by commas (any of them),
// and a leading - or ! (or ! after the colon) turns it around: -s:done is every issue that isn't done,
// -l:bug,infra has neither label, -@me isn't mine (unassigned included), -word lacks the word.

const STATE_TYPES = {
  triage: "triage", 분류: "triage",
  backlog: "backlog", 백로그: "backlog",
  unstarted: "unstarted", todo: "unstarted", 할일: "unstarted",
  started: "started", progress: "started", 진행: "started",
  completed: "completed", done: "completed", 완료: "completed",
  canceled: "canceled", cancelled: "canceled", 취소: "canceled",
  duplicate: "duplicate", 중복: "duplicate",
  // Finished either way.
  closed: ["completed", "canceled", "duplicate"], 종료: ["completed", "canceled", "duplicate"],
  // Not finished.
  open: ["triage", "backlog", "unstarted", "started"], 열림: ["triage", "backlog", "unstarted", "started"],
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

// q.conds: [{ field: state | label | assignee | team | priority, neg, vals }] — an issue matches a cond
// when any of its vals matches (none of them when neg). q.notWords: words the issue must not contain.
export function parse(input) {
  const q = { words: [], notWords: [], number: null, identifier: null, conds: [] };
  for (let tok of tokenize(input.normalize("NFC"))) {
    let neg = false;
    if (/^[-!]./.test(tok)) { neg = true; tok = tok.slice(1); }
    const low = tok.toLowerCase();
    const m = /^(s|l|p):(.*)$/i.exec(tok) ?? (/^[@#]./.test(tok) ? [tok, tok[0], tok.slice(1)] : null);
    if (m) {
      let raw = m[2];
      if (raw.startsWith("!")) { neg = !neg; raw = raw.slice(1); }
      const parts = raw.split(",").map((v) => v.trim()).filter(Boolean);
      if (!parts.length) continue;
      const kind = m[1].toLowerCase();
      let field, vals;
      if (kind === "s") {
        field = "state";
        vals = parts.flatMap((v) => { const t = STATE_TYPES[v.toLowerCase()]; return t ? [t].flat().map((type) => ({ type })) : [{ name: v }]; });
      } else if (kind === "l") { field = "label"; vals = parts; }
      else if (kind === "p") {
        field = "priority";
        vals = parts.map((v) => PRIORITIES[v.toLowerCase()]).filter((v) => v !== undefined);
        if (!vals.length) continue;
      } else if (kind === "@") {
        field = "assignee";
        vals = parts.map((v) => (["나", "me"].includes(v.toLowerCase()) ? { me: true } : { name: v }));
      } else { field = "team"; vals = parts.map((v) => v.toUpperCase()); }
      q.conds.push({ field, neg, vals });
    } else if (!neg && parseIdentifier(tok)) {
      q.identifier = parseIdentifier(tok);
    } else if (!neg && /^\d+$/.test(tok)) {
      q.number = parseInt(tok, 10);
    } else if (neg) {
      q.notWords.push(tok);
    } else {
      q.words.push(tok);
    }
  }
  return q;
}

export const isEmpty = (q) => !q.words.length && !q.notWords.length && q.number === null && !q.identifier && !q.conds.length;
export const hasText = (q) => q.words.length > 0 || q.number !== null || q.identifier !== null;
export const textOf = (q) => [...q.words, ...(q.identifier ? [q.identifier.join("-")] : []), ...(q.number !== null ? [String(q.number)] : [])].join(" ");

const any = (list) => (list.length === 1 ? list[0] : { or: list });
const all = (list) => (list.length === 1 ? list[0] : { and: list });

// One cond as a Linear IssueFilter. IssueFilter has no "not", so each field says it its own way;
// a negated assignee also lets unassigned issues through.
function condFilter(c) {
  const { field, neg, vals } = c;
  if (field === "state") {
    const types = vals.filter((v) => v.type).map((v) => v.type);
    const names = vals.filter((v) => v.name).map((v) => v.name);
    if (!neg) return any([...(types.length ? [{ state: { type: { in: types } } }] : []), ...names.map((n) => ({ state: { name: { containsIgnoreCase: n } } }))]);
    return all([...(types.length ? [{ state: { type: { nin: types } } }] : []), ...names.map((n) => ({ state: { name: { notContainsIgnoreCase: n } } }))]);
  }
  if (field === "label") {
    if (!neg) return any(vals.map((v) => ({ labels: { some: { name: { containsIgnoreCase: v } } } })));
    return all(vals.map((v) => ({ labels: { every: { name: { notContainsIgnoreCase: v } } } })));
  }
  if (field === "priority") return { priority: neg ? { nin: vals } : { in: vals } };
  if (field === "team") return neg ? all(vals.map((k) => ({ team: { key: { neqIgnoreCase: k } } }))) : any(vals.map((k) => ({ team: { key: { eqIgnoreCase: k } } })));
  // assignee
  const one = (v) => v.me
    ? { assignee: { isMe: { eq: !neg } } }
    : neg
      ? { assignee: { and: [{ name: { notContainsIgnoreCase: v.name } }, { displayName: { notContainsIgnoreCase: v.name } }] } }
      : { assignee: { or: [{ name: { containsIgnoreCase: v.name } }, { displayName: { containsIgnoreCase: v.name } }] } };
  return neg ? { or: [{ assignee: { null: true } }, all(vals.map(one))] } : any(vals.map(one));
}

function tokenParts(q) {
  const parts = q.conds.map(condFilter);
  for (const w of q.notWords) parts.push({ title: { notContainsIgnoreCase: w } }, { or: [{ description: { null: true } }, { description: { notContainsIgnoreCase: w } }] });
  return parts;
}
const combine = (parts) => parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { and: parts };
const containsWord = (w) => [{ title: { containsIgnoreCase: w } }, { description: { containsIgnoreCase: w } }];

// The server filter. Without a positive `#KEY` it's limited to every team the key belongs to.
export function serverFilter(q, teamIds) {
  const parts = q.words.map((w) => ({ or: containsWord(w) }));
  if (q.number !== null) parts.push({ or: [...containsWord(String(q.number)), { number: { eq: q.number } }] });
  if (q.identifier) {
    const [key, n] = q.identifier;
    // Each condition its own object: inside `or`, Linear drops all but one field of an object
    // ({team, number} matched the whole team).
    parts.push({ or: [{ and: [{ team: { key: { eqIgnoreCase: key } } }, { number: { eq: n } }] }, ...containsWord(`${key}-${n}`)] });
  }
  parts.push(...tokenParts(q));
  if (!q.conds.some((c) => c.field === "team" && !c.neg) && teamIds.length) parts.push({ team: { id: { in: teamIds } } });
  return combine(parts);
}

export function tokenFilter(q) {
  const p = tokenParts(q);
  return p.length ? combine(p) : null;
}

function condMatch(issue, c, viewerId) {
  const hit = c.vals.some((v) => {
    switch (c.field) {
      case "state": return v.type ? issue.state?.type === v.type : Boolean(issue.state?.name?.toLowerCase().includes(v.name.toLowerCase()));
      case "label": return (issue.labels?.nodes ?? []).some((l) => l.name.toLowerCase().includes(v.toLowerCase()));
      case "priority": return issue.priority === v;
      case "team": return issue.team?.key?.toUpperCase() === v;
      default:
        if (v.me) return Boolean(viewerId) && issue.assignee?.id === viewerId;
        return [issue.assignee?.name, issue.assignee?.displayName].some((x) => x?.toLowerCase().includes(v.name.toLowerCase()));
    }
  });
  return c.neg ? !hit : hit;
}

// Instant search over loaded issues: a score (higher first) when it matches, else -1.
export function localScore(issue, q, viewerId) {
  for (const c of q.conds) if (!condMatch(issue, c, viewerId)) return -1;
  if (q.notWords.length) {
    const text = `${issue.title ?? ""} ${issue.description ?? ""}`.toLowerCase();
    if (q.notWords.some((w) => text.includes(w.toLowerCase()))) return -1;
  }
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

// Issue identifiers in terminal text, the last mentioned first. Linear issue URLs always count;
// a bare `ENG-142` (also inside a branch like `me/eng-142-fix`) only when its team key is one of `teamKeys` (so `UTF-8` or `SHA-256` don't).
export function issueRefs(text, teamKeys, max = 9) {
  const keys = new Set((teamKeys ?? []).map((k) => String(k).toUpperCase()));
  const last = new Map();
  const note = (id, at) => { if (!last.has(id) || last.get(id) < at) last.set(id, at); };
  const s = String(text ?? "");
  for (const m of s.matchAll(/linear\.app\/[\w-]+\/issue\/([a-z][a-z0-9]*-\d+)/gi)) note(m[1].toUpperCase(), m.index);
  for (const m of s.matchAll(/(?<![\w.-])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})(?!\w)/g)) {
    const key = m[1].toUpperCase();
    if (keys.has(key)) note(`${key}-${Number(m[2])}`, m.index);
  }
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, max);
}
