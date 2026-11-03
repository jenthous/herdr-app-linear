// Linear for the Herdr app: find, read and start work on Linear issues in a window.
// A port of herdr-linear (github.com/jenthous/herdr-linear) from the herdr TUI to a native mod.
// Lists: my open issues · recently opened · all (every team the API key belongs to).
// Typing filters what's already loaded at once and asks the server after a 0.3 s pause.
// Wide windows preview the selected issue on the right; Enter opens it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, h_resizable, resizable_panel } from "gpui-base";
import { theme, props, closeOverlay, run, focused, panes, spaces, exec, hc, home, appHome, nextCommand } from "herdr";
import * as fs from "fs/promises";
import * as api from "./api.js";
import * as Q from "./query.js";
import { Images, splitMarkdown, splitImages, imageParts, imageUrls } from "./media.js";
import { Store } from "./store.js";
import { T, setLanguage } from "./i18n.js";
import { demo } from "./demo.js";
import { Places } from "./places.js";
import { stateIcon } from "./states.js";

const BASE = "mods/linear";
const ICON = `${BASE}/icons`;
const WIDE = 760;
const LIST_W = 420; // the list's default width beside the preview; dragging the divider changes it
const LIST_MIN = 280, PREVIEW_MIN = 320;
const RECENT_MAX = 30;
const CACHE_MAX = 400;
const URGENT = "#eb5757";
// GitHub's pull request colors.
const PR_COLOR = { open: "#3fb950", draft: null, merged: "#a371f7", closed: "#f85149" };
const PR_ICON = { open: "pr", draft: "pr", merged: "pr-merged", closed: "pr-closed" };
const REVIEW_COLOR = { approved: "#3fb950", changes: "#d29922" };
const PRIO_ICON = { 0: "prio-none", 1: "prio-urgent", 2: "prio-3", 3: "prio-2", 4: "prio-1" };
const TAB_IDS = ["mine", "recent", "all"];
const IDENT_IN_NAME = /[A-Za-z][A-Za-z0-9]*-\d+/g;
const TREE_STEP = 22, TREE_X = 7; // a sub-issue level's indent, and where its line runs (under the parent's priority icon)
const CLOSED = new Set(["completed", "canceled", "duplicate"]);


// "42s", "7m 05s", "1h 12m".
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function ago(iso) {
  if (!iso) return "";
  const a = T().ago;
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return a.now;
  if (m < 60) return a.m(m);
  if (m < 1440) return a.h(Math.floor(m / 60));
  if (m < 43200) return a.d(Math.floor(m / 1440));
  return iso.slice(0, 10);
}

// Every open of the window is a fresh copy of the mod (its localStorage starts empty), so the
// cache is one file that every copy reads first. Nothing is saved while showing demo data.
const STORE = new Store();
let DEMO = false;
const load = (k, d) => STORE.get(k, d);
const save = (k, v) => { if (!DEMO) STORE.set(k, v); };
// Cached issues keep a shortened description; opening one fetches it in full.
const slim = (i) => (i?.description?.length > 3000 ? { ...i, description: i.description.slice(0, 3000) } : i);
const stop = (_e, cx) => cx.stop_propagation();

export default class Linear extends View {
  init(_props, cx) {
    this.config = { agent: ["claude"], agentName: null, refreshSeconds: 60, autoState: true, taskContext: true };
    this.states = {}; // team id → workflow states
    this.key = null;
    this.viewer = null;
    this.mine = [];
    this.all = [];
    this.allCursor = null;
    this.allMore = false;
    this.cache = {}; // identifier → issue
    this.recent = []; // identifiers, newest first
    this.found = []; // identifiers in the focused terminal shown on top, last mentioned first
    this.foundIds = []; // every identifier the terminal mentions, cached or not
    this.details = {}; // identifier → detail
    this.server = []; // server filter search results
    this.deep = []; // deep (comment) search results
    this.deepFor = null;
    this.tab = "mine";
    this.query = "";
    this.sel = 0;
    this.mode = "list"; // list | detail
    this.stack = []; // issues followed through relations in the detail view
    this.section = "body"; // body | comments
    this.places = new Places();
    this.pick = null; // { issue, sel }: choosing where the agent works
    this.status = null; // { text, level }
    this.flash = null;
    this.loading = new Set();
    this.width = 900;
    this.listW = LIST_W;
    this.layout = "split"; // split (list + preview) | list (the list alone, with more columns)
    this.filters = []; // saved searches: [{ query }]
    this.collapsed = new Set(); // parents whose sub-issues are folded in the list
    this.dataVer = 0; this.foldVer = 0; // bumped when cached issues or folds change (rows() is memoized on them)
    this.height = 700;
    this.lightbox = null; // { urls, idx }: an image shown large over the window
    this.typing = true;
    this.handle = cx.focus_handle();
    this.queryGen = 0; this.previewGen = 0; this.flashGen = 0;
    this.images = new Images();

    // The search hint is drawn beside the input (searchBar) so it follows the language set in config.json.
    this.input = InputState.new({ placeholder: "" });
    this.input.on("change", (_e, cx) => this.onQuery(this.input.value(), cx));
    this.input.on("submit", (_e, cx) => this.activate(this.selected(), cx));
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });

    // The comment composer: one textarea, for the issue in draftFor; drafts keep what was typed per issue.
    this.draft = TextareaState.new({ rows: 3 });
    this.draft.set_auto_grow(3, 12);
    this.draftFor = null;
    this.drafts = {};
    this.composing = false; // the textarea has the keyboard
    this.sending = false;
    this.draft.on("change", (_e, cx) => { if (this.draftFor) this.drafts[this.draftFor] = this.draft.value(); cx.notify(); });
    this.draft.on("submit", (e, cx) => { if (e?.secondary) this.sendComment(cx); });
    this.draft.on("focus", (_e, cx) => { this.composing = true; cx.notify(); });
    this.draft.on("blur", (_e, cx) => { this.composing = false; cx.notify(); });

    this.keyInput = InputState.new({ placeholder: "lin_api_…" });
    this.keyInput.set_masked(true);
    this.keyInput.on("submit", (_e, cx) => this.saveKey(this.keyInput.value().trim(), cx));

    cx.spawn(async (cx) => {
      // Read the focused terminal right away, so its issues are on the first frame and the list doesn't jump.
      const termText = this.readTerminal();
      await this.loadConfig();
      // Show the cache first, then fetch in the background.
      await STORE.load();
      this.viewer = load("viewer", null);
      this.mine = load("mine", []);
      this.all = load("all", []);
      this.cache = load("cache", {});
      this.recent = load("recent", []);
      this.tab = load("tab", "mine");
      this.details = load("details", {});
      this.listW = load("listW", LIST_W);
      this.layout = load("layout", "split");
      this.filters = load("filters", []);
      this.collapsed = new Set(load("collapsed", []));
      if (this.config.terminalIssues !== false) {
        this.foundIds = Q.issueRefs(await termText, (this.viewer?.teams?.nodes ?? []).map((t) => t.key));
        this.found = this.foundIds.filter((id) => this.cache[id]);
      }
      cx.notify();
      if (this.config.demo) { this.setDemo(true, cx); return; }
      this.key = await api.loadKey() ?? load("key", null);
      if (!this.key) { this.needKey = true; cx.notify(); this.keyInput.focus(); return; }
      this.input.focus();
      this.fetchFound(cx);
      // The shown issue's comments first: requests queue in the runtime, and the lists are big.
      const shown = this.shownId();
      if (shown) await this.loadDetail(cx, shown);
      await this.refresh(cx, true);
      await this.prefetchDetails(cx);
      await this.places.scanAll();
    });
    cx.timer.every(2000, () => { STORE.flush(); });
    cx.timer.every(Math.max(10, this.config.refreshSeconds) * 1000, (cx) => { if (this.key && !DEMO) this.refresh(cx, false); });
    // Redraw once a second only while an issue tab has a working agent (the elapsed time).
    cx.timer.every(1000, (cx) => {
      this.watchAgents(cx);
      if (DEMO || spaces().some((s) => s.tabs.some((tb) => tb.working_since && tb.name.match(IDENT_IN_NAME)))) cx.notify();
    });
    cx.timer.after(400, () => (this.needKey ? this.keyInput : this.input).focus());
    // From keys.json or `herdr-app do`: linear.search[:text], linear.refresh, linear.demo, linear.close, linear.layout[:split|list], linear.open:ENG-123
    // The loop must end when nextCommand() stops waiting (an empty answer after a reload or close),
    // or it spins without ever yielding and freezes the whole window.
    cx.spawn(async (cx) => {
      let burst = 0, since = Date.now();
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { return; }
        if (c === undefined || c === null || c === "") return;
        if (Date.now() - since > 1000) { burst = 0; since = Date.now(); }
        if (++burst > 50) return;
        const [name, arg] = String(c).split(/[:\s]+/, 2);
        if (name === "search") {
          this.mode = "list"; this.stack = []; this.input.focus();
          // linear.search:<text> types the search (the rest of the command, spaces included).
          const text = /^search[:\s](.*)$/s.exec(String(c))?.[1];
          if (text !== undefined) { this.input.set_value(text); this.onQuery(text, cx); }
        }
        else if (name === "refresh" && this.key) this.refresh(cx, false);
        else if (name === "demo") this.setDemo(!DEMO, cx);
        else if (name === "close") this.dismiss();
        else if (name === "layout") this.setLayout(arg === "split" || arg === "list" ? arg : this.layout === "split" ? "list" : "split", cx);
        else if (name === "open" && arg) this.openDetail(arg.toUpperCase(), cx, true);
        else if (name === "comments") this.section = this.section === "comments" ? "body" : "comments";
        else if (name === "comment") { const id = this.shownId(); if (id) this.openComposer(id, cx); }
        else if (name === "image") { const g = this.gallery(); if (g.length) this.openLightbox(g[0], cx); }
        else if (name === "work") { const id = this.shownId(); const i = id && (this.details[id]?.issue ?? this.cache[id]); if (i) this.work(i, cx); }
        cx.notify();
      }
    });
  }

  // config.json next to this file (optional):
  // { "language": "en" | "ko", "agent": ["claude"], "agentName": "Claude", "refreshSeconds": 60, "demo": false,
//   "autoState": true, "taskContext": true, "terminalIssues": true, "nestSubIssues": true }
  async loadConfig() {
    try {
      const c = JSON.parse(await fs.readFile(`${appHome()}/${BASE}/config.json`, "utf8"));
      Object.assign(this.config, c);
    } catch {}
    setLanguage(this.config.language ?? "en");
  }

  agentName() {
    if (this.config.agentName) return this.config.agentName;
    const bin = String(this.config.agent?.[0] ?? "agent").split("/").pop();
    return bin.charAt(0).toUpperCase() + bin.slice(1);
  }

  setDemo(on, cx) {
    DEMO = on;
    this.demoStarted = Date.now();
    if (on) {
      this.saved = { viewer: this.viewer, mine: this.mine, all: this.all, cache: this.cache, details: this.details, recent: this.recent, found: this.found };
      this.viewer = demo.viewer; this.mine = demo.mine; this.all = demo.all; this.allMore = false;
      this.cache = Object.fromEntries(demo.all.map((i) => [i.identifier, i]));
      this.details = Object.fromEntries(Object.entries(demo.details).map(([k, d]) => [k, { ...d, at: Date.now() + 1e12 }]));
      this.recent = ["ENG-142", "ENG-139", "DES-51"];
      this.found = ["ENG-143", "ENG-139"];
      this.needKey = false;
    } else if (this.saved) {
      Object.assign(this, this.saved);
      this.saved = null;
      this.found = [];
      if (!this.key) this.needKey = true;
    }
    this.mode = "list"; this.stack = []; this.sel = 0; this.tab = "mine"; this.status = null;
    this.dataVer++;
    this.input.focus();
    cx.notify();
  }

  // ── Data ──────────────────────────────────────────────

  remember(list) {
    this.dataVer++;
    for (const i of list) if (i?.identifier) this.cache[i.identifier] = slim(i);
    const ids = Object.keys(this.cache);
    if (ids.length > CACHE_MAX) {
      const keep = new Set([...this.recent, ...this.mine.map((i) => i.identifier)]);
      ids.sort((a, b) => (this.cache[a].updatedAt ?? "").localeCompare(this.cache[b].updatedAt ?? ""));
      for (const id of ids.slice(0, ids.length - CACHE_MAX)) if (!keep.has(id)) delete this.cache[id];
    }
    save("cache", this.cache);
  }

  async call(cx, label, fn) {
    this.loading.add(label); cx.notify();
    try {
      const r = await fn();
      if (this.status?.level === "error") this.status = null;
      return r;
    } catch (e) {
      this.status = { text: T().err[e?.kind] ?? String(e?.message ?? e), level: "error" };
      if (e?.kind === "auth") { this.needKey = true; this.keyInput.focus(); }
      return undefined;
    } finally {
      this.loading.delete(label); cx.notify();
    }
  }

  teamIds() { return (this.viewer?.teams?.nodes ?? []).map((t) => t.id); }

  async refresh(cx, first) {
    if (DEMO) return;
    if (!this.viewer) {
      const v = await this.call(cx, "viewer", () => api.viewer(this.key));
      if (!v) return;
      this.viewer = v; save("viewer", v);
    } else if (first) {
      // With a cached viewer, fetch the lists right away and refresh the viewer alongside.
      this.call(cx, "viewer", () => api.viewer(this.key)).then((v) => { if (v) { this.viewer = v; save("viewer", v); } });
    }
    const [mine, page] = await Promise.all([
      this.call(cx, "mine", () => api.myIssues(this.key)),
      this.call(cx, "all", () => api.teamIssues(this.key, this.teamIds(), null)),
    ]);
    if (DEMO) return;
    if (mine) { this.mine = mine; save("mine", mine.map(slim)); this.remember(mine); }
    if (page) {
      // Keep pages loaded with "Load more"; replace only the first page.
      const fresh = new Set(page.nodes.map((i) => i.id));
      this.all = [...page.nodes, ...(first ? [] : this.all.slice(api.PAGE_SIZE).filter((i) => !fresh.has(i.id)))];
      if (first) { this.allCursor = page.pageInfo.endCursor; this.allMore = page.pageInfo.hasNextPage; }
      save("all", this.all.slice(0, api.PAGE_SIZE).map(slim)); this.remember(page.nodes);
    }
    const shown = this.shownId();
    if (shown) this.loadDetail(cx, shown, true);
    if (this.query) this.searchServer(cx, this.query);
    cx.notify();
  }

  async moreAll(cx) {
    if (DEMO || !this.allMore || this.loading.has("all")) return;
    const page = await this.call(cx, "all", () => api.teamIssues(this.key, this.teamIds(), this.allCursor));
    if (!page) return;
    const have = new Set(this.all.map((i) => i.id));
    this.all.push(...page.nodes.filter((i) => !have.has(i.id)));
    this.allCursor = page.pageInfo.endCursor; this.allMore = page.pageInfo.hasNextPage;
    this.remember(page.nodes);
  }

  async loadDetail(cx, id, force = false) {
    if (DEMO) return;
    const have = this.details[id];
    if (!force && have && Date.now() - have.at < this.config.refreshSeconds * 1000) return;
    if (this.loading.has(`d:${id}`)) return;
    const d = await this.call(cx, `d:${id}`, () => api.issueDetail(this.key, id));
    if (d === null) { this.status = { text: T().notFound(id), level: "error" }; return; }
    if (!d || DEMO) return;
    this.details[id] = d;
    this.remember([d.issue]);
    // Keep details of recent issues and the top of my list in the cache, for instant previews.
    const keep = new Set([...this.recent.slice(0, 20), ...this.mine.slice(0, 10).map((i) => i.identifier), id]);
    save("details", Object.fromEntries(Object.entries(this.details).filter(([k]) => keep.has(k)).slice(-30)));
    this.prefetchImages(cx, d);
  }

  // Details (comments, relations) of the top rows, one at a time, so moving through the list is instant.
  async prefetchDetails(cx) {
    const ids = this.pickable().filter((r) => r.kind === "issue").slice(0, 8).map((r) => r.issue.identifier);
    for (const id of ids) {
      if (DEMO || !this.key) return;
      await this.loadDetail(cx, id);
    }
  }

  prefetchImages(cx, d) {
    const urls = [...imageUrls(d.issue.description), ...d.comments.flatMap((c) => imageUrls(c.body))];
    for (const url of urls) {
      if (this.images.get(url)) continue;
      cx.spawn(async (cx) => { await this.images.load(url, this.key); cx.notify(); });
    }
  }

  image(url) { return DEMO ? demo.images[url] : this.images.get(url); }

  // Tabs whose name holds an issue identifier are that issue's agent tabs; the most urgent wins.
  tabLinks() {
    if (DEMO) return demo.links(this.demoStarted);
    const rank = { blocked: 4, working: 3, done: 2, idle: 1 };
    const out = {};
    for (const space of spaces()) for (const tab of space.tabs) {
      for (const m of tab.name.matchAll(IDENT_IN_NAME)) {
        const id = m[0].toUpperCase(), r = rank[tab.status] ?? 0;
        if (!out[id] || r > out[id].r) out[id] = { tab, space, r };
      }
    }
    return out;
  }

  goTab(link) {
    if (DEMO) return;
    run("space.select", { id: link.space.id });
    run("tab.select", { id: link.tab.id });
  }

  onQuery(text, cx) {
    this.query = text; this.sel = 0; this.deep = []; this.deepFor = null;
    const mine = ++this.queryGen;
    cx.timer.after(300, (cx) => { if (mine === this.queryGen) this.searchServer(cx, text); });
    cx.notify();
  }

  async searchServer(cx, text) {
    const q = Q.parse(text);
    if (Q.isEmpty(q) || DEMO) { this.server = []; return; }
    const r = await this.call(cx, "search", () => api.filterIssues(this.key, Q.serverFilter(q, this.teamIds())));
    if (r && this.query === text) { this.server = r; this.serverFor = text; this.remember(r); }
  }

  async searchDeep(cx) {
    if (DEMO) return;
    const q = Q.parse(this.query);
    const term = Q.textOf(q);
    if (!term) return;
    const r = await this.call(cx, "deep", () => api.deepSearch(this.key, term, Q.tokenFilter(q)));
    if (r) { this.deep = r; this.deepFor = this.query; this.remember(r); }
  }

  async saveKey(key, cx) {
    if (!key) return;
    this.status = { text: T().checkingKey, level: "info" }; cx.notify();
    try {
      const v = await api.viewer(key);
      this.key = key; this.viewer = v; save("viewer", v); this.needKey = false; this.status = null;
      // Saved where the herdr-linear CLI keeps it, mode 0600. Mods can only write under the app's
      // folder, so it goes through a private temp file there (never through a command line).
      const dir = `${home()}/.config/herdr-linear`, tmp = `${STORE.dir}/key.tmp`;
      try {
        await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1"', "sh", STORE.dir]);
        await fs.writeFile(tmp, `${key}\n`);
        const r = await exec("sh", ["-c", 'umask 077 && mkdir -p "$1" && cat "$2" > "$1/credentials"; s=$?; rm -f "$2"; exit $s', "sh", dir, tmp]);
        if (r.code !== 0) throw new Error(r.stderr);
      } catch { save("key", key); }
      STORE.flush();
      this.input.focus();
      await this.refresh(cx, true);
    } catch (e) {
      this.status = { text: T().err[e?.kind] ?? String(e?.message ?? e), level: "error" };
    }
    cx.notify();
  }

  // ── List ──────────────────────────────────────────────

  // The focused terminal's screen and recent history ("" when there's none or it can't be read).
  async readTerminal() {
    const term = focused()?.terminal;
    if (!term) return "";
    try { const r = await hc(["read", term, "--lines", "300"]); return r.code === 0 ? r.stdout : ""; } catch { return ""; }
  }

  // Issues the terminal mentions that aren't cached yet, in one request. They go below the ones
  // already shown, so nothing on screen moves.
  async fetchFound(cx) {
    const missing = (this.foundIds ?? []).filter((id) => !this.cache[id]);
    if (DEMO || !missing.length) return;
    const byTeam = {};
    for (const id of missing) { const [k, n] = id.split("-"); (byTeam[k] ??= []).push(Number(n)); }
    const filter = { or: Object.entries(byTeam).map(([k, ns]) => ({ team: { key: { eq: k } }, number: { in: ns } })) };
    const got = await this.call(cx, "found", () => api.filterIssues(this.key, filter));
    if (!got?.length || DEMO) return;
    this.remember(got);
    this.found = [...this.found, ...missing.filter((id) => this.cache[id])];
    cx.notify();
  }

  branchIssue() {
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const m = /(?:^|[/_-])([a-z][a-z0-9]*)-(\d+)/i.exec(pane?.branch ?? "");
    if (!m) return null;
    const key = m[1].toUpperCase();
    if (!(this.viewer?.teams?.nodes ?? []).some((t) => t.key === key)) return null;
    return `${key}-${m[2]}`;
  }

  // Everything rows() reads. A render asks for the rows several times (selection, preview, list),
  // and a search scores every cached issue, so it's computed once per change.
  rowsKey() {
    return [this.query, this.tab, this.mine, this.all, this.all.length, this.server, this.serverFor, this.deep, this.deepFor,
      this.found, this.recent, this.allMore, this.dataVer, this.foldVer, this.branchIssue(), DEMO];
  }

  rows() {
    const key = this.rowsKey();
    if (this.rowsMemo && key.every((v, n) => v === this.rowsMemoKey[n])) return this.rowsMemo;
    this.rowsMemoKey = key;
    this.rowsMemo = this.buildRows();
    this.pickMemo = this.rowsMemo.filter((r) => r.kind !== "head");
    return this.rowsMemo;
  }

  // Sub-issues go under their parent when both are in the list (in list order), as deep as they nest.
  // A parent in `collapsed` hides them. A sub-issue whose parent isn't in the list stays at the top level.
  nested(list, extra = {}) {
    if (this.config.nestSubIssues === false) return list.map((issue) => ({ kind: "issue", issue, ...extra }));
    const ids = new Set(list.map((i) => i.identifier));
    const kids = new Map();
    const roots = [];
    for (const issue of list) {
      const p = issue.parent?.identifier;
      if (p && p !== issue.identifier && ids.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(issue); }
      else roots.push(issue);
    }
    const out = [], seen = new Set();
    // guides: one entry per level for the tree lines: "line" (an ancestor's siblings continue below),
    // "none", and for the row's own level "mid" (├ more siblings below) or "end" (╰ the last one).
    const walk = (issue, depth, guides) => {
      if (seen.has(issue.identifier)) return;
      seen.add(issue.identifier);
      const ch = (kids.get(issue.identifier) ?? []).filter((c) => !seen.has(c.identifier));
      const folded = ch.length > 0 && this.collapsed.has(issue.identifier);
      out.push({ kind: "issue", issue, ...extra, depth, guides, kids: ch.length, folded, progress: this.subProgress(issue, ch) });
      if (folded) return;
      const up = guides.map((g) => (g === "mid" || g === "line" ? "line" : "none"));
      ch.forEach((c, n) => walk(c, depth + 1, [...up, n === ch.length - 1 ? "end" : "mid"]));
    };
    // A family goes where its best-placed member is (a search's top hit can be a sub-issue).
    const rank = new Map(list.map((i, n) => [i.identifier, n]));
    const best = (issue, seenUp = new Set()) => {
      if (seenUp.has(issue.identifier)) return Infinity;
      seenUp.add(issue.identifier);
      return Math.min(rank.get(issue.identifier), ...(kids.get(issue.identifier) ?? []).map((c) => best(c, seenUp)));
    };
    const order = roots.map((r) => [r, best(r)]).sort((a, b) => a[1] - b[1]).map(([r]) => r);
    for (const r of order) walk(r, 0, []);
    return out;
  }

  // Sub-issues done of all, for a parent's progress ring: from its fetched detail when there is one
  // (every sub-issue), else from the sub-issues in the list. null when it has none.
  subProgress(issue, inList) {
    const all = this.details[issue.identifier]?.relations?.children;
    const list = all?.length ? all : inList;
    if (!list.length) return null;
    return { done: list.filter((c) => c.state?.type === "completed").length, total: list.filter((c) => !["canceled", "duplicate"].includes(c.state?.type)).length || list.length };
  }

  buildRows() {
    const out = [];
    const q = Q.parse(this.query);
    if (Q.isEmpty(q)) {
      let list = this.tab === "mine" ? this.mine : this.tab === "all" ? this.all : this.recent.map((id) => this.cache[id]).filter(Boolean);
      const found = this.found.map((id) => this.cache[id] ?? this.details[id]?.issue).filter(Boolean);
      if (found.length) {
        const ids = new Set(found.map((i) => i.identifier));
        out.push({ kind: "head", text: T().foundHead(found.length) }, ...found.map((issue) => ({ kind: "issue", issue, found: true })));
        out.push({ kind: "head", text: T().tabs[this.tab] });
        list = list.filter((i) => !ids.has(i.identifier));
      }
      if (this.tab === "mine") {
        const b = this.branchIssue();
        const issue = b && !this.found.includes(b) && (this.cache[b] ?? this.details[b]?.issue);
        if (issue) { out.push({ kind: "issue", issue, pin: true }); list = list.filter((i) => i.identifier !== b); }
      }
      out.push(...this.nested(list));
      if (this.tab === "all" && this.allMore) out.push({ kind: "more" });
      return out;
    }
    const seen = new Map();
    // A cached issue shows only when it matches; a server result (bonus 0) shows anyway, since the
    // server saw the whole description and the current state.
    const consider = (i, bonus = -1) => {
      if (!i?.identifier || i.archivedAt || i.trashed) return;
      const s = Math.max(Q.localScore(i, q, this.viewer?.id), bonus);
      if (s < 0) return;
      const prev = seen.get(i.identifier);
      if (!prev || prev.s < s) seen.set(i.identifier, { i, s });
    };
    for (const i of Object.values(this.cache)) consider(i);
    // Server results count only for the search they answered (until the new one comes back).
    if (this.serverFor === this.query) for (const i of this.server) consider(i, 0);
    const ranked = [...seen.values()].sort((a, b) => b.s - a.s || (b.i.updatedAt ?? "").localeCompare(a.i.updatedAt ?? ""));
    out.push(...this.nested(ranked.map(({ i }) => i)));
    if (this.deepFor === this.query) {
      const have = new Set(ranked.map(({ i }) => i.identifier));
      const extra = this.deep.filter((i) => !have.has(i.identifier));
      if (extra.length) out.push({ kind: "head", text: T().deepHead }, ...extra.map((issue) => ({ kind: "issue", issue, deep: true })));
    } else if (Q.hasText(q) && !DEMO) {
      out.push({ kind: "deep" });
    }
    return out;
  }

  pickable() { this.rows(); return this.pickMemo; }
  selected() { const p = this.pickable(); return p[Math.min(this.sel, p.length - 1)] ?? null; }
  shownId() {
    if (this.mode === "detail") return this.stack[this.stack.length - 1] ?? null;
    const r = this.selected();
    return r?.kind === "issue" ? r.issue.identifier : null;
  }

  move(d, cx) {
    const n = this.pickable().length;
    if (!n) return;
    this.sel = Math.max(0, Math.min(n - 1, this.sel + d));
    this.section = "body";
    this.schedulePreview(cx);
    cx.notify();
  }

  // Selects the issue `id` if it's a row (keeps the selection on the same issue when rows move).
  selectIssue(id, cx) {
    const n = this.pickable().findIndex((r) => r.kind === "issue" && r.issue.identifier === id);
    if (n < 0) return false;
    this.sel = n;
    this.schedulePreview(cx);
    return true;
  }

  // Folds or unfolds a parent's sub-issues (open: true unfolds, false folds, omitted flips).
  toggleFold(id, cx, open) {
    const cur = this.selected();
    const unfold = open ?? this.collapsed.has(id);
    if (unfold === !this.collapsed.has(id)) return;
    if (unfold) this.collapsed.delete(id); else this.collapsed.add(id);
    this.foldVer++;
    save("collapsed", [...this.collapsed].slice(-500));
    // A sub-issue that just got hidden hands the selection to its parent.
    if (cur?.kind === "issue" && !this.selectIssue(cur.issue.identifier, cx)) this.selectIssue(id, cx);
    cx.notify();
  }

  // ← folds (or goes to the parent), → unfolds (or goes to the first sub-issue).
  foldKey(d, cx) {
    const r = this.selected();
    if (r?.kind !== "issue") return;
    const id = r.issue.identifier;
    if (d > 0) {
      if (r.kids && r.folded) this.toggleFold(id, cx, true);
      else if (r.kids) this.move(1, cx);
    } else if (r.kids && !r.folded) this.toggleFold(id, cx, false);
    else if (r.depth && r.issue.parent && this.selectIssue(r.issue.parent.identifier, cx)) cx.notify();
  }

  setLayout(layout, cx) {
    this.layout = layout; save("layout", layout);
    if (layout === "split") this.schedulePreview(cx);
    cx.notify();
  }

  // ── Saved filters ─────────────────────────────────────
  // A saved filter is a search (words and tokens). ⌃S saves the current one (or removes it if saved),
  // a pill or ⌃1–9 runs one, running the active one again clears the search.

  savedIndex(query) { const q = query.trim(); return this.filters.findIndex((f) => f.query === q); }

  toggleSaveFilter(cx) {
    const q = this.query.trim();
    if (!q) { this.say(T().filterEmpty, cx); return; }
    const n = this.savedIndex(q);
    if (n >= 0) { this.filters = this.filters.filter((_f, k) => k !== n); this.say(T().filterRemoved(q), cx); }
    else { this.filters = [...this.filters, { query: q }]; this.say(T().filterSaved(q), cx, "success"); }
    save("filters", this.filters);
    cx.notify();
  }

  removeFilter(n, cx) {
    const f = this.filters[n];
    if (!f) return;
    this.filters = this.filters.filter((_f, k) => k !== n);
    save("filters", this.filters);
    this.say(T().filterRemoved(f.query), cx);
  }

  applyFilter(n, cx) {
    const f = this.filters[n];
    if (!f) return;
    const q = this.query.trim() === f.query ? "" : f.query;
    if (this.mode === "detail") { this.stack = []; this.mode = "list"; }
    this.input.set_value(q);
    this.onQuery(q, cx);
    this.input.focus();
  }

  schedulePreview(cx) {
    if (this.width < WIDE || this.layout !== "split") return;
    const id = this.shownId();
    if (!id) return;
    const gen = ++this.previewGen;
    cx.timer.after(220, (cx) => { if (gen === this.previewGen) this.loadDetail(cx, id); });
  }

  activate(r, cx) {
    if (!r) return;
    if (r.kind === "issue") this.openDetail(r.issue.identifier, cx, true);
    else if (r.kind === "deep") this.searchDeep(cx);
    else if (r.kind === "more") this.moreAll(cx);
  }

  openDetail(id, cx, reset) {
    this.stack = reset ? [id] : [...this.stack, id];
    this.section = "body";
    this.mode = "detail";
    this.recent = [id, ...this.recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
    save("recent", this.recent);
    this.loadDetail(cx, id);
    this.handle.focus();
    cx.notify();
  }

  back(cx) {
    this.stack.pop();
    if (!this.stack.length) { this.mode = "list"; this.input.focus(); }
    else this.loadDetail(cx, this.stack[this.stack.length - 1]);
    cx.notify();
  }

  setTab(tab, cx) {
    this.tab = tab; save("tab", tab); this.sel = 0;
    if (this.query) { this.query = ""; this.input.set_value(""); }
    this.schedulePreview(cx);
    cx.notify();
  }

  dismiss() {
    STORE.flush();
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // Called by Herdr when the window goes: write what's pending.
  async close() {
    await STORE.flush();
  }

  // ── Agent ↔ Linear ────────────────────────────────────
  // The agent's first message: the issue, its description and recent comments, and the downloaded
  // images as local files (left out when the agent runs on another machine, where the paths don't exist).

  async taskFor(issue, remote, cx) {
    const head = T().task(issue);
    if (!this.config.taskContext || !this.key) return head;
    const id = issue.identifier;
    try { await this.loadDetail(cx, id); } catch {}
    const d = this.details[id];
    if (!d) return head;
    const x = T().ctx;
    const imgs = []; // [label, path]
    const refs = {};
    const ref = async (url) => {
      if (refs[url]) return refs[url];
      let path = null;
      if (!remote && /^https?:\/\//.test(url)) {
        await this.images.load(url, this.key);
        const img = this.images.get(url);
        if (img?.state === "ok") path = img.abs;
      }
      const label = `${x.image} ${imgs.length + 1}`;
      imgs.push([label, path ?? url]);
      return (refs[url] = label);
    };
    const flat = async (md, max) => {
      let out = "";
      // Images become [image n]; a table stays a table, its cells' images inline.
      const cell = async (c) => {
        let x = "";
        for (const p of splitImages(c)) x += p.kind === "text" ? p.text : `[${await ref(p.url)}]`;
        return x.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
      };
      for (const p of splitMarkdown(md ?? "")) {
        if (p.kind === "text") out += p.text;
        else if (p.kind === "img") out += `${p.link && p.alt ? `${p.alt} ` : ""}[${await ref(p.url)}]\n`;
        else {
          const line = async (r) => `| ${(await Promise.all(r.map(cell))).join(" | ")} |\n`;
          out += `\n${await line(p.head)}|${p.head.map(() => " --- ").join("|")}|\n`;
          for (const r of p.rows) out += await line(r);
          out += "\n";
        }
      }
      out = out.trim();
      return out.length > max ? `${out.slice(0, max)}…` : out;
    };
    const parts = [head];
    const desc = await flat(d.issue.description, 4000);
    if (desc) parts.push(`## ${x.description}\n${desc}`);
    const recent = d.comments.slice(-10);
    if (recent.length) {
      const lines = [];
      for (const c of recent) {
        const who = c.user?.displayName || c.user?.name || "?";
        lines.push(`- ${who} (${(c.createdAt ?? "").slice(0, 10)}): ${(await flat(c.body, 800)).replace(/\n+/g, " ")}`);
      }
      parts.push(`## ${x.comments(recent.length, d.comments.length)}\n${lines.join("\n")}`);
    }
    if (imgs.length) parts.push(`## ${remote ? x.imagesRemote : x.images}\n${imgs.map(([l, p]) => `- ${l}: ${p}`).join("\n")}`);
    return parts.join("\n\n");
  }

  // Started from here: To do/Backlog moves to In Progress, and the issue is remembered so that when
  // its agent stops after working, it moves to In Review. The window only runs while open, so that
  // check also runs when it opens next.
  async markStarted(issue) {
    if (!this.config.autoState || DEMO || !this.key) return;
    const type = issue.state?.type;
    if (["completed", "canceled", "duplicate"].includes(type)) return;
    const auto = load("auto", {});
    auto[issue.identifier] = { at: Date.now(), phase: "started" };
    save("auto", auto);
    STORE.flush();
    if (["backlog", "unstarted", "triage"].includes(type)) {
      try { await this.moveTo(issue, "progress"); } catch {}
    }
  }

  async moveTo(issue, kind) {
    const isReview = (st) => st.type === "started" && /review|리뷰/i.test(st.name);
    const states = this.states[issue.team.id] ??= await api.teamStates(this.key, issue.team.id);
    const target = kind === "review" ? states.find(isReview) : states.find((st) => st.type === "started" && !isReview(st));
    if (!target || target.id === issue.state?.id) return null;
    const upd = await api.setState(this.key, issue.id, target.id);
    if (!upd) return null;
    this.remember([upd]);
    const d = this.details[upd.identifier];
    if (d) d.issue = { ...d.issue, ...upd };
    this.mine = this.mine.map((i) => (i.id === upd.id ? upd : i));
    return target;
  }

  watchAgents(cx) {
    if (!this.config.autoState || DEMO || !this.key) return;
    const auto = load("auto", {});
    const ids = Object.keys(auto);
    if (!ids.length) return;
    const links = this.tabLinks();
    let changed = false;
    for (const id of ids) {
      const a = auto[id];
      if (a.phase !== "started" || Date.now() - a.at > 14 * 864e5) { delete auto[id]; changed = true; continue; }
      const tab = links[id]?.tab;
      // Stopped after working: done (or already looked at, idle) and changed well after the start.
      if (!tab || !["done", "idle"].includes(tab.status) || !(tab.changed_at > a.at + 15000)) continue;
      const issue = this.details[id]?.issue ?? this.cache[id];
      delete auto[id]; changed = true;
      if (!issue?.team || issue.state?.type !== "started") continue;
      cx.spawn(async (cx) => {
        try {
          const st = await this.moveTo(issue, "review");
          if (st) this.say(T().moved(id, st.name), cx, "success");
        } catch (e) { this.say(`${T().moveFailed(id)}: ${e?.message ?? e}`, cx, "error"); }
      });
    }
    if (changed) save("auto", auto);
  }

  // ── Actions ───────────────────────────────────────────

  say(text, cx, level = "info") {
    this.flash = { text, level };
    const gen = ++this.flashGen;
    cx.timer.after(1800, (cx) => { if (gen === this.flashGen) { this.flash = null; cx.notify(); } });
    cx.notify();
  }

  // ── Comments ──────────────────────────────────────────
  // m (or the button under the comments) opens the composer for the shown issue, with what was typed
  // for it before. ⌘Enter posts, Esc leaves it (an empty draft closes; a typed one stays for later).

  openComposer(id, cx) {
    if (this.draftFor !== id) {
      if (this.draftFor && !this.draft.value().trim()) delete this.drafts[this.draftFor];
      this.draftFor = id;
      this.draft.set_value(this.drafts[id] ?? "");
    }
    this.section = "comments";
    // After this key press is done, so the "m" that opened it isn't typed into it.
    cx.timer.after(0, () => this.draft.focus());
    cx.notify();
  }

  closeComposer(cx) {
    if (!this.draft.value().trim()) { delete this.drafts[this.draftFor]; this.draftFor = null; }
    this.composing = false;
    if (this.mode === "list" && !this.pick) this.input.focus(); else this.handle.focus();
    cx.notify();
  }

  sendComment(cx) {
    const id = this.draftFor;
    const body = this.draft.value().trim();
    if (!id || this.sending) return;
    if (!body) { this.say(T().commentEmpty, cx); return; }
    const issue = this.details[id]?.issue ?? this.cache[id];
    if (!issue?.id) return;
    this.sending = true;
    this.say(T().commentSending, cx);
    cx.spawn(async (cx) => {
      try {
        const c = DEMO
          ? { id: `demo-c-${Date.now()}`, body, createdAt: new Date().toISOString(), editedAt: null, user: this.viewer }
          : await api.createComment(this.key, issue.id, body);
        if (!c) throw new Error(T().err.graphql);
        const d = this.details[id];
        if (d && !d.comments.some((x) => x.id === c.id)) d.comments = [...d.comments, c];
        delete this.drafts[id];
        if (this.draftFor === id) {
          this.draft.set_value("");
          this.draftFor = null;
          if (this.composing) this.closeComposer(cx);
        }
        this.say(T().commentSent(id), cx, "success");
        if (!DEMO) this.loadDetail(cx, id, true);
      } catch (e) {
        // The draft stays, so nothing typed is lost.
        this.say(`${T().commentFailed}: ${T().err[e?.kind] ?? e?.message ?? e}`, cx, "error");
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
  }

  composerView(t, id) {
    const tr = T();
    if (this.draftFor !== id) {
      return h_flex().id(`c-new-${id}`).h(34).px(12).items_center().rounded(8).border_1().border_color(t.border)
        .text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.muted))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.openComposer(id, cx))
        .child(div().flex_1().child(tr.commentPrompt)).child(div().text_size(11).child("m"));
    }
    const empty = !this.draft.value().trim();
    return v_flex().gap(8)
      .child(div().id(`c-draft-${id}`).w_full().on_mouse_down("left", stop).child(Textarea.new(this.draft)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tr.commentHint))
        .child(this.button(t, "c-cancel", tr.cancel, (cx) => {
          this.draft.set_value(""); delete this.drafts[id]; this.draftFor = null; this.closeComposer(cx);
        }))
        .child(this.button(t, "c-send", this.sending ? tr.commentSending : tr.commentSend, (cx) => this.sendComment(cx), !empty && !this.sending)));
  }

  copy(text, what, cx) { cx.write_to_clipboard(text); this.say(T().copied(what, text), cx, "success"); }
  openUrl(url, cx) { if (/^https?:/.test(url)) cx.open_url(url); }

  // Asks where to work, then opens a tab (or a worktree space) named after the issue, running
  // the agent with the issue as its first message.
  work(issue, cx) {
    this.pick = { issue, sel: 0 };
    if (!DEMO) cx.spawn(async (cx) => { await this.places.scanAll(); cx.notify(); });
    cx.notify();
  }

  choices() {
    if (!this.pick) return [];
    return DEMO ? demo.places : this.places.choices(this.pick.issue);
  }

  startChoice(c, cx) {
    const issue = this.pick?.issue;
    if (!c || !issue) return;
    if (DEMO) { this.pick = null; cx.notify(); return; }
    this.say(T().starting, cx);
    cx.spawn(async (cx) => {
      try {
        const remote = Boolean(c.kind === "tab" ? c.space?.machine : c.machine);
        const task = await this.taskFor(issue, remote, cx);
        await this.places.start(c, { name: issue.identifier, argv: this.config.agent, task });
        await this.markStarted(issue);
        this.pick = null;
        this.dismiss();
      } catch (e) {
        this.status = { text: `${T().pickFailed}: ${e?.message ?? e}`, level: "error" };
        cx.notify();
      }
    });
  }

  pickKey(k, cx) {
    const list = this.choices();
    const n = list.length;
    const mv = (d) => { if (n) this.pick.sel = Math.max(0, Math.min(n - 1, this.pick.sel + d)); };
    const m = {
      down: () => mv(1), up: () => mv(-1), "ctrl-n": () => mv(1), "ctrl-p": () => mv(-1), tab: () => mv(1), "shift-tab": () => mv(-1),
      enter: () => this.startChoice(list[this.pick.sel], cx),
      escape: () => { this.pick = null; }, q: () => { this.pick = null; },
    };
    if (/^[1-9]$/.test(k) && Number(k) <= n) m[k] = () => this.startChoice(list[Number(k) - 1], cx);
    if (!m[k]) return false;
    m[k](); cx.notify(); return true;
  }

  onKey(e, cx) {
    const k = e.keystroke;
    const id = this.shownId();
    const issue = id ? (this.details[id]?.issue ?? this.cache[id]) : null;
    if (this.needKey) { if (k === "escape") this.dismiss(); return; }
    // The composer went away under the keyboard (another issue was selected): the keys are ours again.
    if (this.composing && this.draftFor !== id) this.composing = false;
    if (this.composing) {
      // Typing a comment: the keys are the textarea's, apart from send and leave.
      if (k === "cmd-enter" || k === "ctrl-enter") { this.sendComment(cx); cx.stop_propagation(); }
      else if (k === "escape") { this.closeComposer(cx); cx.stop_propagation(); }
      return;
    }
    if (this.lightbox) { this.lightboxKey(k, cx); cx.stop_propagation(); return; }
    if (this.pick) { if (this.pickKey(k, cx)) cx.stop_propagation(); return; }
    if (this.mode === "detail") {
      const m = {
        escape: () => this.back(cx), backspace: () => this.back(cx), q: () => this.dismiss(),
        o: () => issue && this.openUrl(issue.url, cx), y: () => issue && this.copy(issue.url, "URL", cx),
        "shift-y": () => { const pr = api.mainPr(issue); pr ? this.copy(pr.url, T().prLink, cx) : this.say(T().noPr, cx); },
        i: () => issue && this.copy(issue.identifier, "ID", cx), c: () => issue && this.work(issue, cx),
        r: () => id && this.loadDetail(cx, id, true),
        g: () => { const l = id && this.tabLinks()[id]; l ? this.goTab(l) : this.say(T().noTab, cx); },
        tab: () => { this.section = this.section === "body" ? "comments" : "body"; cx.notify(); },
        m: () => id && this.openComposer(id, cx),
        "ctrl-l": () => this.setLayout(this.layout === "split" ? "list" : "split", cx),
        v: () => { const g = this.gallery(); g.length ? this.openLightbox(g[0], cx) : this.say(T().noImage, cx); },
      };
      if (!m[k]) return;
      m[k](); cx.stop_propagation(); return;
    }
    const step = (d) => this.setTab(TAB_IDS[(TAB_IDS.indexOf(this.tab) + d + TAB_IDS.length) % TAB_IDS.length], cx);
    const m = {
      down: () => this.move(1, cx), up: () => this.move(-1, cx),
      "ctrl-n": () => this.move(1, cx), "ctrl-p": () => this.move(-1, cx),
      pagedown: () => this.move(10, cx), pageup: () => this.move(-10, cx),
      tab: () => step(1), "shift-tab": () => step(-1),
      "ctrl-o": () => issue && this.openUrl(issue.url, cx),
      "ctrl-y": () => issue && this.copy(issue.url, "URL", cx),
      "ctrl-r": () => this.refresh(cx, false),
      "ctrl-l": () => this.setLayout(this.layout === "split" ? "list" : "split", cx),
      "ctrl-s": () => this.toggleSaveFilter(cx),
      escape: () => { if (this.query) { this.input.set_value(""); this.onQuery("", cx); } else this.dismiss(); },
      enter: () => { if (!this.typing) this.activate(this.selected(), cx); },
    };
    // ← → fold sub-issues; with a search typed they stay the input's.
    if (!this.query) { m.left = () => this.foldKey(-1, cx); m.right = () => this.foldKey(1, cx); }
    const fk = /^ctrl-([1-9])$/.exec(k);
    if (fk && this.filters[Number(fk[1]) - 1]) m[k] = () => this.applyFilter(Number(fk[1]) - 1, cx);
    if (!m[k]) return;
    m[k](); cx.stop_propagation();
  }

  // ── Drawing ───────────────────────────────────────────

  render() {
    const t = theme();
    const root = v_flex().id("linear-root").size_full().min_h(0).bg(t.popover).text_size(13).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1 || Math.abs(size.height - this.height) > 1) { this.width = size.width; this.height = size.height; cx.notify(); }
      })
      .on_key_down((e, cx) => this.onKey(e, cx));
    if (this.needKey) return root.child(this.keyScreen(t));
    this.links = this.tabLinks();
    const wide = this.width >= WIDE;
    if (this.pick) return root.child(this.header(t)).child(this.pickView(t)).child(this.footer(t));
    const body = this.mode === "detail"
      ? this.detailView(t, this.stack[this.stack.length - 1], true)
      : wide && this.layout === "split"
        ? h_resizable("linear-split").flex_1().min_h(0).w_full()
          .on_resize((sizes, cx) => { if (sizes[0] > 0) { this.listW = Math.round(sizes[0]); save("listW", this.listW); cx.notify(); } })
          .child(resizable_panel().size(this.listW).size_range(LIST_MIN, Math.max(LIST_MIN, this.width - PREVIEW_MIN))
            .child(v_flex().size_full().min_h(0).child(this.listView(t))))
          .child(resizable_panel().size_range(PREVIEW_MIN)
            .child(v_flex().size_full().min_w(0).min_h(0).child(this.shownId() ? this.detailView(t, this.shownId(), false) : this.empty(t, T().selectHint))))
        : this.listView(t);
    return root.child(this.header(t)).when(this.mode === "list", (el) => el.child(this.searchBar(t))).child(body).child(this.footer(t))
      .when(Boolean(this.lightbox), (el) => el.child(this.lightboxView(t)));
  }

  header(t) {
    const busy = this.loading.size > 0;
    const count = { mine: this.mine.length, recent: this.recent.length, all: this.all.length };
    return h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(14).font_semibold().child("Linear"))
      .child(div().text_size(11.5).text_color(t.dim).child(this.viewer?.organization?.name ?? ""))
      .when(DEMO, (el) => el.child(div().text_size(11).px(6).rounded(4).border_1().border_color(t.border).text_color(t.dim).child(T().demo)))
      .child(h_flex().ml(8).gap(2).children(TAB_IDS.map((id) => {
        const on = this.mode === "list" && !this.query && this.tab === id;
        return h_flex().id(`lt-${id}`).h(26).px(9).gap(5).items_center().rounded(6).text_size(12)
          .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click((_e, cx) => { if (this.mode === "detail") { this.stack = []; this.mode = "list"; this.input.focus(); } this.setTab(id, cx); })
          .child(T().tabs[id]).child(div().text_size(10.5).text_color(t.dim).child(String(count[id] ?? "")));
      })))
      .child(div().flex_1())
      .when(busy, (el) => el.child(svg(`${ICON}/spinner.svg`).size(13).text_color(t.dim).spin(900)))
      .when(this.width >= WIDE, (el) => el.child(this.layoutSwitch(t)))
      .child(this.iconButton(t, "l-refresh", "↻", (cx) => this.refresh(cx, false)))
      .when(Boolean(props()?.overlay), (el) => el.child(this.iconButton(t, "l-close", svg(`${ICON}/close.svg`).size(13), () => this.dismiss())));
  }

  // Split (list + preview) or the list alone. ⌃L flips it.
  layoutSwitch(t) {
    const tr = T().layout;
    const seg = (key, label) => {
      const on = this.layout === key;
      return h_flex().id(`ly-${key}`).h(22).px(8).items_center().rounded(5).text_size(11.5)
        .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.setLayout(key, cx)).child(label);
    };
    return h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border)
      .child(seg("split", tr.split)).child(seg("list", tr.list));
  }

  iconButton(t, id, label, action) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => action(cx)).child(label);
  }

  searchBar(t) {
    return v_flex().px(12).py(8).gap(8).flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id("l-search").h(34).flex_1().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", stop)
        .child(svg(`${ICON}/search.svg`).size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .when(!this.query, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(T().searchPlaceholder))))
      .when(this.filters.length > 0 || Boolean(this.query.trim()), (el) => el.child(this.filterBar(t)));
  }

  // Saved filters as pills; the active one is selected and has × to remove it. "+ Save" for a new search.
  filterBar(t) {
    const tr = T();
    const active = this.savedIndex(this.query);
    const pill = (id) => h_flex().id(id).h(24).px(9).gap(6).items_center().rounded(12).border_1().text_size(11.5).cursor_pointer()
      .on_mouse_down("left", stop);
    return h_flex().gap(6).flex_wrap().items_center()
      .children(this.filters.map((f, n) => {
        const on = n === active;
        return pill(`lf-${n}`).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.popover)
          .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.applyFilter(n, cx))
          .when(n < 9, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`⌃${n + 1}`)))
          .child(div().max_w(220).truncate().child(f.query))
          .when(on, (el) => el.child(div().id(`lf-x-${n}`).px(2).rounded(4).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.removeFilter(n, cx); }).child("×")));
      }))
      .when(Boolean(this.query.trim()) && active < 0, (el) => el.child(pill("lf-save").border_color(t.border).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggleSaveFilter(cx))
        .child(tr.saveFilter).child(div().text_size(10.5).text_color(t.dim).child("⌃S"))));
  }

  listView(t) {
    const rows = this.rows();
    if (!rows.length) {
      const msg = this.query ? (this.loading.has("search") ? T().searching : T().noMatch)
        : this.tab === "recent" ? T().noRecent : this.loading.size ? T().loading : T().noIssues;
      return this.empty(t, msg);
    }
    const pickable = rows.filter((r) => r.kind !== "head");
    const sel = pickable[Math.min(this.sel, pickable.length - 1)];
    return v_flex().id("l-list").flex_1().w_full().min_h(0).py(4).overflow_y_scrollbar()
      .children(rows.map((r, n) => this.row(t, r, r === sel, pickable.indexOf(r), n)));
  }

  row(t, r, on, index, n) {
    if (r.kind === "head") return div().px(14).pt(10).pb(3).text_size(11).font_semibold().text_color(t.dim).child(r.text);
    const base = (id) => h_flex().id(id).mx(6).px(8).h(30).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_mouse_down("left", stop)
      .on_click((e, cx) => {
        if (on || e.click_count === 2) this.activate(r, cx);
        else { this.sel = index; this.section = "body"; this.schedulePreview(cx); cx.notify(); }
      });
    if (r.kind === "deep") return base("l-deep").mt(4).text_color(t.muted).child(T().deepRow);
    if (r.kind === "more") return base("l-more").mt(4).text_color(t.muted).child(this.loading.has("all") ? T().loading : T().more);
    const i = r.issue;
    const link = this.links?.[i.identifier];
    const pr = api.mainPr(i);
    // The list's own width: beside the preview it's the left panel, else the window.
    const w = this.width >= WIDE && this.layout === "split" && this.mode === "list" ? this.listW : this.width;
    const nest = this.config.nestSubIssues !== false && r.depth !== undefined;
    // Done and canceled issues fade, so open work stands out.
    const closed = CLOSED.has(i.state?.type);
    const labels = (i.labels?.nodes ?? []).slice(0, 2);
    return base(`l-${i.identifier}-${n}`)
      .when(nest && r.depth > 0, (el) => el.child(this.treeGuides(t, r.guides)))
      .child(h_flex().flex_1().min_w(0).h_full().gap(8).items_center().when(closed, (el) => el.opacity(0.45))
        .child(this.prioIcon(t, i.priority))
        .child(div().w(76).flex_none().text_size(11.5).text_color(t.dim).truncate().child(i.identifier))
        .child(svg(stateIcon(i.state)).size(14).flex_none().text_color(i.state?.color ?? t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(closed ? t.muted : t.foreground).when(closed, (el) => el.line_through()).child(i.title))
        .when(Boolean(r.progress), (el) => el.child(this.progressPill(t, r, `lpg-${i.identifier}-${n}`)))
        .when(Boolean(r.pin), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(T().currentBranch)))
        .when(Boolean(pr), (el) => el.child(this.prBadge(t, pr, `lp-${i.identifier}-${n}`)))
        .when(Boolean(link), (el) => el.child(this.agentBadge(t, link, `lb-${i.identifier}-${n}`)))
        // The list alone has room for more: labels and project, state, assignee, last update.
        .when(w >= 980 && labels.length > 0, (el) => el.child(h_flex().flex_none().gap(4).children(labels.map((l) =>
          h_flex().h(18).px(6).gap(4).items_center().rounded(9).border_1().border_color(t.border).text_size(10.5).text_color(t.muted)
            .child(div().size(6).rounded(3).bg(l.color ?? t.dim)).child(div().max_w(90).truncate().child(l.name))))))
        .when(w >= 980, (el) => el.child(div().w(120).flex_none().truncate().text_size(11).text_color(t.dim).child(i.project?.name ?? "")))
        .when(w >= 760, (el) => el.child(div().w(96).flex_none().truncate().text_size(11).text_color(t.muted).child(i.state?.name ?? "")))
        .when(w >= 400, (el) =>
          el.child(div().w(w >= 760 ? 96 : 72).flex_none().truncate().text_size(11).text_color(t.dim).child(i.assignee?.displayName ?? i.assignee?.name ?? "")))
        .when(w >= 760, (el) => el.child(div().w(56).flex_none().text_size(11).text_color(t.dim).child(ago(i.updatedAt)))));
  }

  // Tree lines left of a sub-issue: a column per level, the line under the parent's priority icon,
  // a rounded elbow into the row on its own level. Rows touch (30 px, no gap), so the lines join.
  treeGuides(t, guides) {
    // The row's 8 px gap follows the last column, so it's that much narrower: level d's icon starts d steps in.
    const col = (g, n) => {
      const c = div().relative().w(n === guides.length - 1 ? TREE_STEP - 8 : TREE_STEP).h_full().flex_none();
      const line = (el) => el.child(div().absolute().left(TREE_X).top(0).bottom(0).w(1).bg(t.border));
      if (g === "line") return line(c);
      if (g === "mid" || g === "end") {
        return (g === "mid" ? line(c) : c).child(div().absolute().left(TREE_X).top(0).h(15).w(TREE_STEP - TREE_X - 3)
          .border_l(1).border_b(1).rounded_bl(6).border_color(t.border));
      }
      return c;
    };
    return h_flex().h_full().flex_none().children(guides.map(col));
  }

  // "1/7" with a ring filled by the share done, beside a parent. Clicking folds or unfolds its sub-issues.
  progressPill(t, r, id) {
    const { done, total } = r.progress;
    const k = total ? Math.round((done / total) * 8) : 0;
    const full = total > 0 && done >= total;
    const ring = div().relative().size(13).flex_none()
      .child(svg(`${ICON}/prog-ring.svg`).absolute().inset_0().size(13).text_color(t.border))
      .when(k > 0, (el) => el.child(svg(`${ICON}/prog-${Math.min(8, k)}.svg`).absolute().inset_0().size(13).text_color(full ? t.done : t.accent)));
    return h_flex().id(id).flex_none().h(20).px(7).gap(5).items_center().rounded(10).border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).cursor_pointer().when(r.folded, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.toggleFold(r.issue.identifier, cx); })
      .child(ring).child(`${done}/${total}`)
      .when(r.folded, (el) => el.child(div().text_size(10).text_color(t.dim).child("▸")));
  }

  prioIcon(t, p) {
    return svg(`${ICON}/${PRIO_ICON[p] ?? "prio-none"}.svg`).size(14).flex_none().text_color(p === 1 ? URGENT : p ? t.muted : t.dim);
  }

  // The issue's main pull request: state icon and number in GitHub's colors, then the review
  // (✓ approved, ± changes requested) and a conflict mark. Clicking opens it. `big` adds the words.
  prBadge(t, pr, id, big = false) {
    const tr = T().pr;
    const color = PR_COLOR[pr.status] ?? t.dim;
    const words = big ? [tr.status[pr.status], pr.review && tr.review[pr.review], pr.conflicts && tr.conflicts].filter(Boolean).join(" · ") : "";
    return h_flex().id(id).flex_none().h(big ? 24 : 20).px(big ? 8 : 5).gap(4).items_center().rounded(5).cursor_pointer()
      .text_size(big ? 12 : 11).text_color(color).hover((s) => s.bg(t.hover))
      .when(big, (el) => el.border_1().border_color(t.border))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.openUrl(pr.url, cx); })
      .child(svg(`${ICON}/${PR_ICON[pr.status]}.svg`).size(big ? 13 : 12).text_color(color))
      .child(`${big && pr.repo ? `${pr.repo} ` : ""}#${pr.number ?? ""}`)
      .when(Boolean(pr.review), (el) => el.child(div().text_color(REVIEW_COLOR[pr.review]).font_semibold().child(pr.review === "approved" ? "✓" : "±")))
      .when(pr.conflicts, (el) => el.child(div().text_color(t.blocked).child("⚠")))
      .when(Boolean(words), (el) => el.child(div().text_color(t.muted).child(words)))
      .when(big, (el) => el.child(div().text_color(t.dim).child("Y")));
  }

  // The agent in the issue's tab. Clicking goes to that tab.
  agentBadge(t, link, id, big = false) {
    const st = link.tab.status, a = T().agent;
    const color = st === "working" ? t.working : st === "blocked" ? t.blocked : st === "done" ? t.done : t.dim;
    const label = st === "working" ? elapsed(Date.now() - (link.tab.working_since ?? Date.now()))
      : st === "blocked" ? a.blocked : st === "done" ? a.done : big ? a.idle : a.tab;
    return h_flex().id(id).flex_none().h(big ? 24 : 20).px(big ? 8 : 6).gap(5).items_center().rounded(5).cursor_pointer()
      .text_size(big ? 12 : 11).text_color(color).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.goTab(link); })
      .child(st === "working"
        ? svg(`${ICON}/spinner.svg`).size(big ? 13 : 11).text_color(color).spin(900)
        : st === "blocked" || st === "done" ? div().size(6).rounded(3).bg(color)
        : svg(`${ICON}/terminal.svg`).size(big ? 13 : 11).text_color(color))
      .child(label);
  }

  // ── Lightbox ──────────────────────────────────────────
  // Every loaded image of the shown issue (description, then comments), so ← → walk through them.

  gallery() {
    const d = this.details[this.shownId()];
    if (!d) return [];
    const mds = [d.issue?.description ?? "", ...(d.comments ?? []).map((c) => c.body ?? "")];
    const urls = mds.flatMap((md) => imageParts(md).map((p) => p.url));
    return [...new Set(urls)].filter((u) => { const i = this.image(u); return i?.state === "ok" && i.w > 0; });
  }

  openLightbox(url, cx) {
    const urls = this.gallery();
    if (!urls.includes(url)) urls.unshift(url);
    this.lightbox = { urls, idx: urls.indexOf(url) };
    this.handle.focus();
    cx.notify();
  }

  closeLightbox(cx) {
    this.lightbox = null;
    if (this.mode === "list" && !this.pick) this.input.focus();
    cx.notify();
  }

  lightboxKey(k, cx) {
    const lb = this.lightbox;
    const n = lb.urls.length;
    const mv = (d) => { lb.idx = (lb.idx + d + n) % n; cx.notify(); };
    const m = {
      escape: () => this.closeLightbox(cx), space: () => this.closeLightbox(cx), q: () => this.closeLightbox(cx), enter: () => this.closeLightbox(cx),
      left: () => mv(-1), right: () => mv(1), h: () => mv(-1), l: () => mv(1), tab: () => mv(1), "shift-tab": () => mv(-1),
      o: () => { const img = this.image(lb.urls[lb.idx]); if (img?.abs) exec("open", [img.abs]); },
    };
    m[k]?.();
  }

  lightboxView(t) {
    const { urls, idx } = this.lightbox;
    const img = this.image(urls[idx]);
    const pad = 28, bar = 34;
    const maxW = Math.max(100, this.width - pad * 2), maxH = Math.max(100, this.height - pad * 2 - bar);
    // Fit the window, enlarging up to 2× (a retina screenshot's own pixels).
    let w = img?.w ? (img.w / 2 > 200 && !DEMO ? img.w / 2 : img.w) : 0;
    let h = img?.w ? (w * img.h) / img.w : 0;
    const s = w && h ? Math.min(2, maxW / w, maxH / h) : 0;
    w = Math.round(w * s); h = Math.round(h * s);
    const nav = (dir, label) => div().id(`lb-${dir}`).size(36).flex_none().flex().items_center().justify_center().rounded(18)
      .bg(t.popover).border_1().border_color(t.border).text_color(t.muted).text_size(16).cursor_pointer()
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.lightboxKey(dir, cx); });
    const many = urls.length > 1;
    return v_flex().id("lightbox").absolute().inset_0().items_center().justify_center().gap(10).bg("#000000e6")
      .on_mouse_down("left", stop).on_scroll_wheel(stop)
      .on_click((_e, cx) => this.closeLightbox(cx))
      .child(h_flex().gap(14).items_center()
        .when(many, (el) => el.child(nav("left").child("‹")))
        .child(img?.state === "ok" && w > 0
          ? div().id("lb-img").w(w).h(h).flex_none().rounded(6).overflow_hidden().on_mouse_down("left", stop).on_click((_e, cx) => cx.stop_propagation())
            .child(image(img.rel).w(w).h(h))
          : div().text_color(t.dim).child(T().imgLoading("")))
        .when(many, (el) => el.child(nav("right").child("›"))))
      .child(h_flex().h(bar - 10).px(12).gap(10).items_center().rounded(12).bg("#00000099").text_size(11.5).text_color("#ffffffc0")
        .when(many, (el) => el.child(div().child(`${idx + 1} / ${urls.length}`)))
        .child(div().child(T().lightboxHint)));
  }

  // Markdown in text and image pieces. Images are downloaded once and fitted to the width.
  markdown(t, key, md, maxW) {
    const parts = splitMarkdown(md);
    return v_flex().gap(8).w_full().children(parts.map((part, n) => {
      if (part.kind === "table") return this.table(t, `${key}-t${n}`, part, maxW);
      if (part.kind === "text") {
        return TextView.markdown(`${key}-${n}`, part.text).selectable().on_link_click((url, cx) => this.openUrl(url, cx));
      }
      const img = this.image(part.url);
      // An upload link whose file isn't an image (a PDF, a video): the link it was.
      if (part.link && img?.state === "error" && /type/.test(img.why ?? "")) {
        return TextView.markdown(`${key}-${n}`, part.src).selectable().on_link_click((url, cx) => this.openUrl(url, cx));
      }
      if (img?.state === "ok" && img.w > 0) {
        // Retina screenshots show at half their pixel size. Fit the width and at most 520 px of height.
        let w = Math.min(img.w / 2 > 200 && !DEMO ? img.w / 2 : img.w, maxW);
        let h = (w * img.h) / img.w;
        if (h > 520) { w = (w * 520) / h; h = 520; }
        w = Math.round(w); h = Math.round(h);
        const pic = div().id(`${key}-img-${n}`).w(w).h(h).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
          .on_mouse_down("left", stop).on_click((_e, cx) => this.openLightbox(part.url, cx))
          .child(image(img.rel).w(w).h(h));
        // A link's text is the screenshot's caption.
        return part.link && part.alt.trim()
          ? v_flex().gap(4).child(div().text_size(11.5).text_color(t.muted).child(part.alt)).child(pic)
          : pic;
      }
      const failed = img?.state === "error";
      return h_flex().id(`${key}-img-${n}`).h(44).px(12).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.surface)
        .text_size(11.5).text_color(failed ? t.muted : t.dim).cursor_pointer().on_mouse_down("left", stop)
        .on_click((_e, cx) => this.openUrl(part.url, cx))
        .child(failed ? T().imgFailed(part.alt) : T().imgLoading(part.alt));
    }));
  }

  // A markdown table: bordered grid, header on `surface`, each cell markdown of its own (images
  // fitted to the column). Columns share the width evenly; a wide table scrolls sideways.
  table(t, key, tb, maxW) {
    const n = tb.head.length;
    const colW = Math.max(120, Math.floor((maxW - 2) / n));
    const cell = (md, r, c, head) => {
      const al = tb.align[c];
      return v_flex().w(colW).flex_none().min_w(0).px(10).py(7).gap(6).text_size(12.5)
        .when(c > 0, (el) => el.border_l(1).border_color(t.border))
        .when(al === "center", (el) => el.items_center()).when(al === "right", (el) => el.items_end())
        .when(head, (el) => el.font_semibold())
        .when(Boolean(md.trim()), (el) => el.child(this.inline(t, `${key}-${r}-${c}`, md, colW - 22)));
    };
    const row = (cells, r, head) => h_flex().items_start().flex_none()
      .when(r > 0, (el) => el.border_t(1).border_color(t.border)).when(head, (el) => el.bg(t.surface))
      .children(cells.map((md, c) => cell(md, r, c, head)));
    const grid = v_flex().flex_none().child(row(tb.head, 0, true)).children(tb.rows.map((r, k) => row(r, k + 1, false)));
    return div().id(key).w_full().rounded(6).border_1().border_color(t.border).overflow_x_scrollbar().child(grid);
  }

  // A table cell: its text and images (no tables inside).
  inline(t, key, md, maxW) {
    const parts = splitImages(md.replace(/<br\s*\/?>/gi, "\n"));
    return v_flex().gap(6).w_full().children(parts.map((part, n) => part.kind === "text"
      ? TextView.markdown(`${key}-${n}`, part.text).selectable().on_link_click((url, cx) => this.openUrl(url, cx))
      : this.markdown(t, `${key}-${n}`, part.src ?? `![${part.alt}](${part.url})`, maxW)));
  }

  empty(t, text) {
    return v_flex().flex_1().items_center().justify_center().text_color(t.dim).text_size(12.5).child(text);
  }

  chip(t, color, text) {
    return h_flex().h(22).px(8).gap(6).items_center().rounded(11).border_1().border_color(t.border).text_size(11.5)
      .child(div().size(7).rounded(4).bg(color ?? t.dim)).child(text);
  }

  button(t, id, label, action, primary = false) {
    return h_flex().id(id).h(26).px(10).items_center().rounded(6).text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .border_1().border_color(primary ? t.solid : t.border).hover((s) => s.opacity(0.85))
      .on_mouse_down("left", stop).on_click((_e, cx) => action(cx)).child(label);
  }

  detailView(t, id, full) {
    const tr = T();
    const d = this.details[id];
    const issue = d?.issue ?? this.cache[id];
    if (!issue) return this.empty(t, this.loading.has(`d:${id}`) ? tr.loading : `${id}`);
    const pr = api.mainPr(issue);
    const meta = [
      issue.assignee && `${tr.assignee} ${issue.assignee.displayName ?? issue.assignee.name}`,
      issue.project && `${tr.project} ${issue.project.name}`,
      issue.cycle && `${tr.cycle} ${issue.cycle.name ?? issue.cycle.number}`,
      issue.dueDate && `${tr.due} ${issue.dueDate}`,
      `${tr.updated} ${ago(issue.updatedAt)}`,
    ].filter(Boolean).join("  ·  ");

    const rel = d?.relations;
    const link = this.links?.[issue.identifier];
    const maxW = Math.max(160, (full || this.width < WIDE ? this.width : this.width - this.listW) - 40);
    const relRow = (x, n, kind) => h_flex().id(`rel-${kind}-${x.id}-${n}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click((_e, cx) => this.openDetail(x.identifier, cx, !full))
      .when(CLOSED.has(x.state?.type), (el) => el.opacity(0.5))
      .child(svg(stateIcon(x.state)).size(13).flex_none().text_color(x.state?.color ?? t.dim))
      .child(div().w(64).flex_none().text_size(11.5).text_color(t.dim).child(x.identifier))
      .child(div().flex_1().min_w(0).truncate().child(x.title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(x.state?.name ?? ""))
      .when(Boolean(this.links?.[x.identifier]), (el) => el.child(this.agentBadge(t, this.links[x.identifier], `rb-${kind}-${x.id}-${n}`)));
    const relGroup = (title, list, kind, color) => list?.length
      ? v_flex().gap(1).child(div().text_size(11).font_semibold().text_color(color ?? t.dim).child(`${title} ${list.length}`)).children(list.map((x, n) => relRow(x, n, kind)))
      : null;
    const groups = [
      issue.parent && relGroup(tr.rel.parent, [issue.parent], "parent"),
      rel && relGroup(rel.moreChildren ? tr.rel.childrenSome : tr.rel.children, rel.children, "child"),
      rel && relGroup(tr.rel.blockedBy, rel.blockedBy, "blockedby", t.blocked),
      rel && relGroup(tr.rel.blocking, rel.blocking, "blocking"),
      rel && relGroup(tr.rel.related, rel.related, "related"),
    ].filter(Boolean);
    const agent = this.agentName();

    const body = v_flex().gap(14).p(16)
      .child(h_flex().gap(8).items_center().flex_wrap()
        .when(full, (el) => el.child(this.button(t, "d-back", tr.back, (cx) => this.back(cx))))
        .child(div().id("d-ident").text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.copy(issue.identifier, "ID", cx)).child(issue.identifier))
        .child(h_flex().h(22).px(8).gap(6).items_center().rounded(11).border_1().border_color(t.border).text_size(11.5)
          .child(svg(stateIcon(issue.state)).size(13).text_color(issue.state?.color ?? t.dim)).child(issue.state?.name ?? "?"))
        .when(Boolean(tr.priority[issue.priority]), (el) => el.child(h_flex().gap(5).items_center().text_size(11.5).text_color(issue.priority === 1 ? URGENT : t.muted)
          .child(this.prioIcon(t, issue.priority)).child(tr.priority[issue.priority])))
        .child(div().text_size(11.5).text_color(t.dim).child(issue.team?.name ?? "")))
      .child(TextView.markdown(`d-title-${id}`, `## ${issue.title.replace(/[\\`*_[\]#]/g, "\\$&")}`).selectable())
      .child(div().text_size(11.5).text_color(t.muted).child(meta))
      .when((issue.labels?.nodes ?? []).length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(issue.labels.nodes.map((l) => this.chip(t, l.color, l.name)))))
      .when(Boolean(link), (el) => el.child(h_flex().gap(10).p(10).items_center().rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(this.agentBadge(t, link, `db-${id}`, true))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(tr.tabIn(link.space.name, link.tab.name)))
        .child(this.button(t, "d-go", tr.goTab, () => this.goTab(link), true))))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button(t, "d-work", link ? tr.newAgentTab(agent) : tr.workWith(agent), (cx) => this.work(issue, cx), !link))
        .child(this.button(t, "d-open", tr.browser, (cx) => this.openUrl(issue.url, cx)))
        .child(this.button(t, "d-url", tr.copyUrl, (cx) => this.copy(issue.url, "URL", cx)))
        .child(this.button(t, "d-id", tr.copyId, (cx) => this.copy(issue.identifier, "ID", cx)))
        .when(Boolean(pr), (el) => el.child(this.prBadge(t, pr, "d-pr", true))))
      .when(groups.length > 0, (el) => el.child(v_flex().gap(10).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border).children(groups)));

    const nComments = d ? `${d.comments.length}${d.moreComments ? "+" : ""}` : "…";
    const seg = (key, label) => {
      const on = this.section === key;
      return h_flex().id(`seg-${key}`).h(30).px(4).mr(14).items_center().text_size(12.5).cursor_pointer()
        .border_b(2).border_color(on ? t.foreground : t.popover).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_semibold()).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => { this.section = key; cx.notify(); }).child(label);
    };
    body.child(h_flex().items_end().border_b(1).border_color(t.border)
      .child(seg("body", tr.body)).child(seg("comments", tr.comments(nComments))));

    if (this.section === "body") {
      body.child(issue.description?.trim()
        ? this.markdown(t, `d-body-${id}`, issue.description, maxW)
        : div().text_size(12).text_color(t.dim).child(tr.noBody));
    } else if (!d) {
      body.child(div().text_size(12).text_color(t.dim).child(tr.commentsLoading));
    } else if (!d.comments.length) {
      body.child(div().text_size(12).text_color(t.dim).child(tr.noComments));
    } else {
      body.children(d.comments.map((c) => v_flex().gap(6).p(12).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center().text_size(11.5)
          .child(h_flex().size(20).flex_none().rounded(10).bg(t.raised).items_center().justify_center().text_size(10.5).font_semibold().text_color(t.muted)
            .child([...(c.user?.displayName ?? c.user?.name ?? "?")][0].toUpperCase()))
          .child(div().font_semibold().child(c.user?.displayName ?? c.user?.name ?? tr.unknownUser))
          .child(div().text_color(t.dim).child(ago(c.createdAt) + (c.editedAt ? tr.edited : ""))))
        .child(this.markdown(t, `c-${c.id}`, c.body ?? "", maxW - 26))));
      if (d.moreComments) body.child(div().text_size(11.5).text_color(t.dim).child(tr.moreComments));
    }
    if (this.section === "comments" && d) body.child(this.composerView(t, id));
    return v_flex().id(`d-scroll-${id}`).flex_1().w_full().min_h(0).overflow_y_scrollbar().on_mouse_down("left", stop).child(body);
  }

  footer(t) {
    const s = this.flash ?? this.status;
    const hint = this.composing ? T().commentHint : this.mode === "detail" ? T().hintDetail : T().hintList;
    return h_flex().h(26).flex_none().px(12).gap(10).items_center().border_t(1).border_color(t.border).text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(s ? (s.level === "error" ? t.blocked : s.level === "success" ? t.done : t.muted) : t.dim).child(s?.text ?? hint))
      .child(div().flex_none().text_color(t.dim).child(this.viewer ? `${this.viewer.displayName ?? this.viewer.name} · ${T().teams} ${(this.viewer.teams?.nodes ?? []).map((x) => x.key).join(" ")}` : ""));
  }

  pickView(t) {
    const tr = T(), issue = this.pick.issue, list = this.choices();
    const sel = Math.min(this.pick.sel, Math.max(0, list.length - 1));
    const tilde = (p) => (p || "~").replace(home(), "~").replace(/^\/(Users|home)\/[^/]+/, "~");
    const machine = (m) => div().flex_none().text_size(10.5).px(6).py(1).rounded(4).border_1().border_color(t.border)
      .text_color(m ? t.accent : t.dim).child(m ?? tr.thisComputer);
    const rows = list.map((c, n) => {
      const on = n === sel;
      const wt = c.kind === "worktree";
      const main = wt
        ? h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().font_semibold().child(tr.newWorktree))
          .child(div().min_w(0).truncate().text_color(t.muted).child(`${c.branch}  ←  ${tilde(c.folder)}`))
        : h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().font_semibold().child(c.space.name || tr.space))
          .child(div().min_w(0).truncate().text_color(t.muted).child(tilde(c.folder)))
          .when(Boolean(c.branch), (el) => el.child(div().flex_none().text_size(11).text_color(c.rank === 3 ? t.done : t.dim).child(c.branch)));
      return h_flex().id(`pk-${n}`).h(40).px(12).gap(10).items_center().rounded(8).cursor_pointer()
        .bg(on ? t.selected : t.popover).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { if (on) this.startChoice(c, cx); else { this.pick.sel = n; cx.notify(); } })
        .child(div().w(14).flex_none().text_size(11).text_color(t.dim).child(n < 9 ? String(n + 1) : ""))
        .child(machine(wt ? c.machine : c.space.machine))
        .child(main)
        .when(c.rank >= 2, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(c.rank === 3 ? tr.onBranch : tr.recommended)));
    });
    const busy = !DEMO && this.places.scanning();
    return v_flex().flex_1().min_h(0).w_full().p(16).gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(15).font_semibold().child(tr.pickTitle(this.config.agentName ?? "Claude", issue.identifier)))
        .when(busy, (el) => el.child(svg(`${ICON}/spinner.svg`).size(13).text_color(t.dim).spin(900)).child(div().text_size(11.5).text_color(t.dim).child(tr.scanning))))
      .child(div().text_size(12).text_color(t.muted).truncate().child(issue.title))
      .child(v_flex().id("pk-list").flex_1().min_h(0).gap(2).overflow_y_scrollbar().children(rows))
      .child(div().text_size(11.5).text_color(t.dim).child(tr.pickHint));
  }

  keyScreen(t) {
    return v_flex().flex_1().p(28).gap(12).justify_center()
      .child(div().text_size(16).font_semibold().child(T().keyTitle))
      .child(div().text_size(12.5).text_color(t.muted).child(T().keyHelp))
      .child(h_flex().id("l-key").h(36).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).on_mouse_down("left", stop)
        .child(Input.new(this.keyInput).flex_1().h_full().text_size(12.8)))
      .when(Boolean(this.status), (el) => el.child(div().text_size(12).text_color(this.status.level === "error" ? t.blocked : t.muted).child(this.status.text)));
  }
}
