// Linear for the Herdr app: find, read and start work on Linear issues in a window.
// A port of herdr-linear (github.com/jenthous/herdr-linear) from the herdr TUI to a native mod.
// Lists: my open issues · recently opened · all (every team the API key belongs to).
// Typing filters what's already loaded at once and asks the server after a 0.3 s pause.
// Wide windows preview the selected issue on the right; Enter opens it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { theme, props, closeOverlay, run, focused, panes, spaces, exec, home, appHome, nextCommand } from "herdr";
import * as fs from "fs/promises";
import * as api from "./api.js";
import * as Q from "./query.js";
import { Images, splitMarkdown, imageUrls } from "./media.js";
import { Store } from "./store.js";
import { T, setLanguage } from "./i18n.js";
import { demo } from "./demo.js";
import { Places } from "./places.js";

const BASE = "mods/linear";
const ICON = `${BASE}/icons`;
const WIDE = 760;
const LIST_W = 420;
const RECENT_MAX = 30;
const CACHE_MAX = 400;
const URGENT = "#eb5757";
const PRIO_ICON = { 0: "prio-none", 1: "prio-urgent", 2: "prio-3", 3: "prio-2", 4: "prio-1" };
const TAB_IDS = ["mine", "recent", "all"];
const IDENT_IN_NAME = /[A-Za-z][A-Za-z0-9]*-\d+/g;

function stateIcon(state) {
  const type = state?.type;
  if (type === "started" && /review|리뷰/i.test(state?.name ?? "")) return `${ICON}/state-review.svg`;
  const known = ["backlog", "triage", "unstarted", "started", "completed", "canceled"];
  return `${ICON}/state-${known.includes(type) ? type : type === "duplicate" ? "canceled" : "unstarted"}.svg`;
}

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
    this.config = { agent: ["claude"], agentName: null, refreshSeconds: 60 };
    this.key = null;
    this.viewer = null;
    this.mine = [];
    this.all = [];
    this.allCursor = null;
    this.allMore = false;
    this.cache = {}; // identifier → issue
    this.recent = []; // identifiers, newest first
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

    this.keyInput = InputState.new({ placeholder: "lin_api_…" });
    this.keyInput.set_masked(true);
    this.keyInput.on("submit", (_e, cx) => this.saveKey(this.keyInput.value().trim(), cx));

    cx.spawn(async (cx) => {
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
      cx.notify();
      if (this.config.demo) { this.setDemo(true, cx); return; }
      this.key = await api.loadKey() ?? load("key", null);
      if (!this.key) { this.needKey = true; cx.notify(); this.keyInput.focus(); return; }
      this.input.focus();
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
      if (DEMO || spaces().some((s) => s.tabs.some((tb) => tb.working_since && tb.name.match(IDENT_IN_NAME)))) cx.notify();
    });
    cx.timer.after(400, () => (this.needKey ? this.keyInput : this.input).focus());
    // From keys.json or `herdr-app do`: linear.search, linear.refresh, linear.demo, linear.open:ENG-123
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
        if (name === "search") { this.mode = "list"; this.stack = []; this.input.focus(); }
        else if (name === "refresh" && this.key) this.refresh(cx, false);
        else if (name === "demo") this.setDemo(!DEMO, cx);
        else if (name === "open" && arg) this.openDetail(arg.toUpperCase(), cx, true);
        else if (name === "comments") this.section = this.section === "comments" ? "body" : "comments";
        else if (name === "work") { const id = this.shownId(); const i = id && (this.details[id]?.issue ?? this.cache[id]); if (i) this.work(i, cx); }
        cx.notify();
      }
    });
  }

  // config.json next to this file (optional):
  // { "language": "en" | "ko", "agent": ["claude"], "agentName": "Claude", "refreshSeconds": 60, "demo": false }
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
      this.saved = { viewer: this.viewer, mine: this.mine, all: this.all, cache: this.cache, details: this.details, recent: this.recent };
      this.viewer = demo.viewer; this.mine = demo.mine; this.all = demo.all; this.allMore = false;
      this.cache = Object.fromEntries(demo.all.map((i) => [i.identifier, i]));
      this.details = Object.fromEntries(Object.entries(demo.details).map(([k, d]) => [k, { ...d, at: Date.now() + 1e12 }]));
      this.recent = ["ENG-142", "ENG-139", "DES-51"];
      this.needKey = false;
    } else if (this.saved) {
      Object.assign(this, this.saved);
      this.saved = null;
      if (!this.key) this.needKey = true;
    }
    this.mode = "list"; this.stack = []; this.sel = 0; this.tab = "mine"; this.status = null;
    this.input.focus();
    cx.notify();
  }

  // ── Data ──────────────────────────────────────────────

  remember(list) {
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
    if (r && this.query === text) { this.server = r; this.remember(r); }
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

  branchIssue() {
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const m = /(?:^|[/_-])([a-z][a-z0-9]*)-(\d+)/i.exec(pane?.branch ?? "");
    if (!m) return null;
    const key = m[1].toUpperCase();
    if (!(this.viewer?.teams?.nodes ?? []).some((t) => t.key === key)) return null;
    return `${key}-${m[2]}`;
  }

  rows() {
    const out = [];
    const q = Q.parse(this.query);
    if (Q.isEmpty(q)) {
      let list = this.tab === "mine" ? this.mine : this.tab === "all" ? this.all : this.recent.map((id) => this.cache[id]).filter(Boolean);
      if (this.tab === "mine") {
        const b = this.branchIssue();
        const issue = b && (this.cache[b] ?? this.details[b]?.issue);
        if (issue) { out.push({ kind: "issue", issue, pin: true }); list = list.filter((i) => i.identifier !== b); }
      }
      out.push(...list.map((issue) => ({ kind: "issue", issue })));
      if (this.tab === "all" && this.allMore) out.push({ kind: "more" });
      return out;
    }
    const seen = new Map();
    const consider = (i, bonus = 0) => {
      if (!i?.identifier || i.archivedAt || i.trashed) return;
      const s = Math.max(Q.localScore(i, q, this.viewer?.id), bonus);
      if (s < 0) return;
      const prev = seen.get(i.identifier);
      if (!prev || prev.s < s) seen.set(i.identifier, { i, s });
    };
    for (const i of Object.values(this.cache)) consider(i);
    for (const i of this.server) consider(i, 0);
    const ranked = [...seen.values()].sort((a, b) => b.s - a.s || (b.i.updatedAt ?? "").localeCompare(a.i.updatedAt ?? ""));
    out.push(...ranked.map(({ i }) => ({ kind: "issue", issue: i })));
    if (this.deepFor === this.query) {
      const have = new Set(ranked.map(({ i }) => i.identifier));
      const extra = this.deep.filter((i) => !have.has(i.identifier));
      if (extra.length) out.push({ kind: "head", text: T().deepHead }, ...extra.map((issue) => ({ kind: "issue", issue, deep: true })));
    } else if (Q.hasText(q) && !DEMO) {
      out.push({ kind: "deep" });
    }
    return out;
  }

  pickable() { return this.rows().filter((r) => r.kind !== "head"); }
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

  schedulePreview(cx) {
    if (this.width < WIDE) return;
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

  // ── Actions ───────────────────────────────────────────

  say(text, cx, level = "info") {
    this.flash = { text, level };
    const gen = ++this.flashGen;
    cx.timer.after(1800, (cx) => { if (gen === this.flashGen) { this.flash = null; cx.notify(); } });
    cx.notify();
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
        await this.places.start(c, { name: issue.identifier, argv: this.config.agent, task: T().task(issue) });
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
    if (this.pick) { if (this.pickKey(k, cx)) cx.stop_propagation(); return; }
    if (this.mode === "detail") {
      const m = {
        escape: () => this.back(cx), backspace: () => this.back(cx), q: () => this.dismiss(),
        o: () => issue && this.openUrl(issue.url, cx), y: () => issue && this.copy(issue.url, "URL", cx),
        "shift-y": () => { const pr = api.openPr(issue); pr ? this.copy(pr.url, T().prLink, cx) : this.say(T().noPr, cx); },
        i: () => issue && this.copy(issue.identifier, "ID", cx), c: () => issue && this.work(issue, cx),
        r: () => id && this.loadDetail(cx, id, true),
        g: () => { const l = id && this.tabLinks()[id]; l ? this.goTab(l) : this.say(T().noTab, cx); },
        tab: () => { this.section = this.section === "body" ? "comments" : "body"; cx.notify(); },
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
      escape: () => { if (this.query) { this.input.set_value(""); this.onQuery("", cx); } else this.dismiss(); },
      enter: () => { if (!this.typing) this.activate(this.selected(), cx); },
    };
    if (!m[k]) return;
    m[k](); cx.stop_propagation();
  }

  // ── Drawing ───────────────────────────────────────────

  render() {
    const t = theme();
    const root = v_flex().id("linear-root").size_full().min_h(0).bg(t.popover).text_size(13).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_key_down((e, cx) => this.onKey(e, cx));
    if (this.needKey) return root.child(this.keyScreen(t));
    this.links = this.tabLinks();
    const wide = this.width >= WIDE;
    if (this.pick) return root.child(this.header(t)).child(this.pickView(t)).child(this.footer(t));
    const body = this.mode === "detail"
      ? this.detailView(t, this.stack[this.stack.length - 1], true)
      : wide
        ? h_flex().flex_1().min_h(0).w_full()
          .child(v_flex().w(LIST_W).h_full().flex_none().min_h(0).border_r(1).border_color(t.border).child(this.listView(t)))
          .child(v_flex().flex_1().h_full().min_w(0).min_h(0).child(this.shownId() ? this.detailView(t, this.shownId(), false) : this.empty(t, T().selectHint)))
        : this.listView(t);
    return root.child(this.header(t)).when(this.mode === "list", (el) => el.child(this.searchBar(t))).child(body).child(this.footer(t));
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
      .child(this.iconButton(t, "l-refresh", "↻", (cx) => this.refresh(cx, false)))
      .when(Boolean(props()?.overlay), (el) => el.child(this.iconButton(t, "l-close", svg(`${ICON}/close.svg`).size(13), () => this.dismiss())));
  }

  iconButton(t, id, label, action) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => action(cx)).child(label);
  }

  searchBar(t) {
    return h_flex().px(12).py(8).flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id("l-search").h(34).flex_1().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", stop)
        .child(svg(`${ICON}/search.svg`).size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .when(!this.query, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(T().searchPlaceholder))));
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
    return base(`l-${i.identifier}-${n}`)
      .child(this.prioIcon(t, i.priority))
      .child(div().w(62).flex_none().text_size(11.5).text_color(t.dim).truncate().child(i.identifier))
      .child(svg(stateIcon(i.state)).size(14).flex_none().text_color(i.state?.color ?? t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(i.title))
      .when(Boolean(r.pin), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(T().currentBranch)))
      .when(Boolean(link), (el) => el.child(this.agentBadge(t, link, `lb-${i.identifier}-${n}`)))
      .when(this.width >= 560, (el) =>
        el.child(div().max_w(72).flex_none().truncate().text_size(11).text_color(t.dim).child(i.assignee?.displayName ?? i.assignee?.name ?? "")));
  }

  prioIcon(t, p) {
    return svg(`${ICON}/${PRIO_ICON[p] ?? "prio-none"}.svg`).size(14).flex_none().text_color(p === 1 ? URGENT : p ? t.muted : t.dim);
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

  // Markdown in text and image pieces. Images are downloaded once and fitted to the width.
  markdown(t, key, md, maxW) {
    const parts = splitMarkdown(md);
    return v_flex().gap(8).w_full().children(parts.map((part, n) => {
      if (part.kind === "text") {
        return TextView.markdown(`${key}-${n}`, part.text).selectable().on_link_click((url, cx) => this.openUrl(url, cx));
      }
      const img = this.image(part.url);
      if (img?.state === "ok" && img.w > 0) {
        // Retina screenshots show at half their pixel size. Fit the width and at most 520 px of height.
        let w = Math.min(img.w / 2 > 200 && !DEMO ? img.w / 2 : img.w, maxW);
        let h = (w * img.h) / img.w;
        if (h > 520) { w = (w * 520) / h; h = 520; }
        w = Math.round(w); h = Math.round(h);
        return div().id(`${key}-img-${n}`).w(w).h(h).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
          .on_mouse_down("left", stop).on_click(() => { if (img.abs) exec("open", [img.abs]); })
          .child(image(img.rel).w(w).h(h));
      }
      const failed = img?.state === "error";
      return h_flex().id(`${key}-img-${n}`).h(44).px(12).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.surface)
        .text_size(11.5).text_color(failed ? t.muted : t.dim).cursor_pointer().on_mouse_down("left", stop)
        .on_click((_e, cx) => this.openUrl(part.url, cx))
        .child(failed ? T().imgFailed(part.alt) : T().imgLoading(part.alt));
    }));
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
    const pr = api.openPr(issue);
    const meta = [
      issue.assignee && `${tr.assignee} ${issue.assignee.displayName ?? issue.assignee.name}`,
      issue.project && `${tr.project} ${issue.project.name}`,
      issue.cycle && `${tr.cycle} ${issue.cycle.name ?? issue.cycle.number}`,
      issue.dueDate && `${tr.due} ${issue.dueDate}`,
      `${tr.updated} ${ago(issue.updatedAt)}`,
    ].filter(Boolean).join("  ·  ");

    const rel = d?.relations;
    const link = this.links?.[issue.identifier];
    const maxW = Math.max(160, (full || this.width < WIDE ? this.width : this.width - LIST_W) - 40);
    const relRow = (x, n, kind) => h_flex().id(`rel-${kind}-${x.id}-${n}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click((_e, cx) => this.openDetail(x.identifier, cx, !full))
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
        .when(Boolean(pr), (el) => el.child(this.button(t, "d-pr", `PR #${pr.number ?? ""}${pr.draft ? " (draft)" : ""}  Y`, (cx) => this.openUrl(pr.url, cx)))))
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
    return v_flex().id(`d-scroll-${id}`).flex_1().w_full().min_h(0).overflow_y_scrollbar().on_mouse_down("left", stop).child(body);
  }

  footer(t) {
    const s = this.flash ?? this.status;
    const hint = this.mode === "detail" ? T().hintDetail : T().hintList;
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
