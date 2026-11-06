// Tells the person when a newer release of this mod is out, as Git Graph does
// (github.com/rabeeh-ta/herdr-git-graph). At most once a day, one GET to
// GitHub's public releases API: no token, nothing about the person. "Stop
// checking" in the update window turns it off for good; CHECK = false turns it
// off before it ever asks.
//
// Kept identical in herdr-machine-rail (machine-switch) and herdr-app-linear
// (linear): everything that differs is in `makeUpdater({...})`.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { props, shared, setShared, closeOverlay, openOverlay, theme, settings } from "herdr";

const CHECK = true;
const DAY = 24 * 60 * 60 * 1000;

const STR = {
  en: {
    pill: (name) => `Update ${name}`,
    title: (name, tag) => `${name} ${tag} is out`,
    have: (v) => `You have v${v}. To update, ask your Herdr agent:`,
    changed: "What changed",
    noNotes: "See the release page.",
    stop: "Stop checking",
    later: "Later",
    page: "Release page",
    copy: "Copy prompt",
  },
  ko: {
    pill: (name) => `${name} 업데이트`,
    title: (name, tag) => `${name} ${tag} 나왔어요`,
    have: (v) => `지금은 v${v}입니다. 업데이트하려면 Herdr 에이전트에게 이렇게 말하세요:`,
    changed: "바뀐 점",
    noNotes: "릴리스 페이지를 보세요.",
    stop: "확인 그만하기",
    later: "나중에",
    page: "릴리스 페이지",
    copy: "프롬프트 복사",
  },
};
const text = (lang) => STR[String(lang ?? "en").slice(0, 2).toLowerCase()] ?? STR.en;

// a > b for tags like v1.2.3.
export function newer(a, b) {
  const parts = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * repo: "owner/name" on GitHub · version: this copy's version · key: shared-state key ·
 * mod: the mod that opens the window (it must hand props { role: "update" } to `Update`) ·
 * name: shown to the person · prompt: what to ask the agent.
 */
export function makeUpdater({ repo, version, key, mod, name, prompt }) {
  // Kept in shared state: it lasts across restarts and every copy of the mod sees it.
  // A result saved for another repository (a fork, a test) counts as never checked.
  const state = () => { const s = shared(key) ?? {}; return s.repo === repo ? s : { off: s.off }; };
  const save = (change) => setShared(key, { ...state(), ...change, repo });

  // The release to offer, or null.
  function available() {
    const s = state();
    if (!CHECK || s.off || !s.latest || !newer(s.latest.tag, version) || s.dismissed === s.latest.tag) return null;
    return s.latest;
  }

  async function check() {
    const s = state();
    if (!CHECK || s.off || Date.now() - (s.checked ?? 0) < DAY) return;
    save({ checked: Date.now() }); // before asking, so the other copies don't ask too
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `herdr-mod-${mod}` } });
      if (!r.ok) return;
      const j = await r.json();
      if (typeof j?.tag_name !== "string") return;
      const url = String(j.html_url ?? "");
      save({ latest: { tag: j.tag_name, notes: String(j.body ?? "").slice(0, 3000),
        url: url.startsWith(`https://github.com/${repo}/`) ? url : `https://github.com/${repo}/releases` } });
    } catch {}
  }

  function openUpdate(lang) {
    openOverlay({ mod, kind: "dialog", width: 460, height: 400, props: { role: "update", lang } });
  }

  // The header's pill: a dot and "Update <name>", only while a newer release waits.
  function pill(t, lang, h = 22) {
    return h_flex().id(`${mod}-update`).h(h).px(7).gap(5).flex_none().items_center().rounded(6).text_size(11.5)
      .cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openUpdate(lang)).child(div().size(6).rounded(3).bg(t.accent)).child(text(lang).pill(name));
  }

  // The update window, opened with props { role: "update", lang }.
  class Update {
    init(cx) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }

    render() {
      const t = theme(), s = text(props()?.lang), latest = state().latest, close = () => closeOverlay(props().overlay);
      const button = (id, label, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
        .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
        .hover((st) => st.opacity(0.88)).on_click(action).child(label);
      return v_flex().id(`${mod}-update-window`).track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(12.8)
        .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
        .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(s.title(name, latest?.tag ?? "")))
          .child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().pt(6).text_color(t.muted).child(s.have(version)))
        .child(div().mt(8).px(10).py(8).rounded(8).bg(t.background).border_1().border_color(t.border).font_family(settings().font_family ?? "JetBrains Mono").text_size(12).child(prompt))
        .child(div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(s.changed))
        // Release notes are markdown; links open in the browser.
        .child(div().flex_1().min_h(0).text_size(12).text_color(t.muted)
          .child(TextView.markdown(`${mod}-notes`, latest?.notes?.trim() || s.noNotes).scrollable(true).selectable(true).size_full()))
        .child(h_flex().pt(14).gap(8).items_center()
          .child(div().id("mu-stop").text_size(12).text_color(t.dim).cursor_pointer().hover((st) => st.text_color(t.foreground))
            .on_click(() => { save({ off: true }); close(); }).child(s.stop))
          .child(div().flex_1())
          .child(button("mu-later", s.later, false, () => { save({ dismissed: latest?.tag }); close(); }))
          .child(button("mu-page", s.page, false, (_e, cx) => cx.open_url(latest?.url ?? `https://github.com/${repo}/releases`)))
          .child(button("mu-copy", s.copy, true, (_e, cx) => { cx.write_to_clipboard(prompt); close(); })));
    }
  }

  return { available, check, openUpdate, pill, Update, version };
}
