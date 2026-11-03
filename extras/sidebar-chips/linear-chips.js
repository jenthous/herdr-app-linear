// Linear issue chips for a spaces sidebar: copy this file into your sidebar mod's folder.
// A space named after an issue ("ENG-142 cart fix", or on branch "me/eng-142-…") gets a chip with
// the issue's state icon and identifier, in the state's color.
//
// Mods can't import another mod's files, so this is self-contained. The state icons are drawn from
// the Linear mod by path (mods/linear/icons), so install the Linear mod too.
//
//   import { LinearChips } from "./linear-chips.js";
//   init:    this.chips = new LinearChips();
//   a timer: this.chips.check(spaces().map((s) => [s.name, s.branch]), cx);
//   a row:   const c = this.chips.of(space.name, space.branch);
//            row.when(Boolean(c), (el) => el.child(this.chips.chip(c, theme())))
//               .child(c ? this.chips.nameWithout(space.name, c.id) : space.name)

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { readTextFile, home, exec, shared, setShared } from "herdr";

const EVERY = 90_000; // ask Linear again after this long, or sooner when the set of issues changes
const ICONS = "mods/linear/icons";

// LINEAR_API_KEY in the login environment, then the credentials files the Linear mod and herdr-linear use.
export async function loadKey() {
  try {
    const r = await exec("sh", ["-lc", 'printf %s "$LINEAR_API_KEY"']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  for (const p of [`${home()}/.config/herdr-linear/credentials`, `${home()}/.config/herdr/plugins/config/jh.linear/credentials`]) {
    try { const k = (await readTextFile(p))?.trim(); if (k) return k; } catch {}
  }
  return null;
}

// Identifiers in a name or branch: "ENG-142 cart", "feature/eng-142-fix" → ["ENG-142"].
export function idsIn(text) {
  return [...String(text ?? "").matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})(?!\d)/g)]
    .map((m) => `${m[1].toUpperCase()}-${Number(m[2])}`);
}

// The states of these issues in one request: { "ENG-142": { name, type, color } }; unknown ones are left out.
// Each team's numbers go in their own `and`: inside `or`, Linear keeps only one field of an object.
export async function issueStates(key, ids) {
  const byTeam = {};
  for (const id of ids) { const [k, n] = id.split("-"); (byTeam[k] ??= []).push(Number(n)); }
  const filter = { or: Object.entries(byTeam).map(([k, ns]) => ({ and: [{ team: { key: { eq: k } } }, { number: { in: ns } }] })) };
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({
      query: "query States($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first) { nodes { identifier state { name type color } } } }",
      variables: { filter, first: Math.min(250, ids.length + 10) },
    }),
  });
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { kind: "auth" });
  const body = JSON.parse(await res.text());
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return Object.fromEntries((body.data?.issues?.nodes ?? []).map((i) => [i.identifier, i.state]));
}

// The Linear mod's icon for a state: dashed circle backlog, empty todo, half in progress,
// three-quarter review (a started state named "review"), check done, cross canceled.
export function stateIcon(state) {
  const type = state?.type;
  if (type === "started" && /review|리뷰/i.test(state?.name ?? "")) return `${ICONS}/state-review.svg`;
  const known = ["backlog", "triage", "unstarted", "started", "completed", "canceled"];
  return `${ICONS}/state-${known.includes(type) ? type : type === "duplicate" ? "canceled" : "unstarted"}.svg`;
}

export class LinearChips {
  constructor() {
    this.key = undefined; // undefined: not looked up yet; null: none, or Linear rejected it
    this.ids = ""; this.at = 0; this.busy = false;
    // Shared, so another sidebar (or the next copy of this one) shows them at once.
    this.states = shared("linear.states") ?? {};
  }

  // The space's issue: an identifier in its name, else in its branch. { id, state } once its state is known.
  of(name, branch) {
    const id = idsIn(name)[0] ?? idsIn(branch)[0];
    return id && this.states[id] ? { id, state: this.states[id] } : null;
  }

  // Call from a timer with [name, branch] of every space (all machines). Cheap: it asks Linear only when
  // the set of issues changed or EVERY has passed, one request for all of them.
  check(pairs, cx) {
    if (this.busy || this.key === null) return;
    const ids = [...new Set(pairs.map(([n, b]) => idsIn(n)[0] ?? idsIn(b)[0]).filter(Boolean))].sort();
    const now = Date.now(), set = ids.join(" ");
    if (!ids.length || (set === this.ids && now - this.at < EVERY)) return;
    this.ids = set; this.at = now; this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.key ??= (await loadKey()) ?? null;
        if (!this.key) return;
        const states = await issueStates(this.key, ids);
        if (JSON.stringify(states) !== JSON.stringify(this.states)) {
          this.states = states;
          setShared("linear.states", states);
          cx.notify();
        }
      } catch (e) {
        if (e?.kind === "auth") this.key = null; // a rejected key stops it; anything else retries next round
      } finally { this.busy = false; }
    });
  }

  // The chip: an 18 px pill tinted with the state's color, its icon and the identifier.
  chip(c, t) {
    const col = /^#[0-9a-f]{6}$/i.test(c.state.color ?? "") ? c.state.color : null;
    return h_flex().h(18).px(5).gap(4).flex_none().items_center().rounded(5).border_1()
      .border_color(col ? `${col}55` : t.border).bg(col ? `${col}1f` : t.raised)
      .child(svg(stateIcon(c.state)).size(11).flex_none().text_color(col ?? t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.foreground).child(c.id));
  }

  // The name without the identifier the chip shows ("ENG-142 cart fix" → "cart fix").
  nameWithout(name, id) {
    const [key, n] = id.split("-");
    const rest = name.replace(new RegExp(`(?<![A-Za-z0-9])${key}-0*${n}(?!\\d)[\\s:·|\\-–—]*`, "i"), "").trim();
    return rest || name;
  }
}
