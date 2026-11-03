// The detail view's pieces: the description cut at its headings (what the outline lists and jumps
// to), comments grouped into threads, and reactions.

const HEAD = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

// Heading text without its markdown: **bold**, `code`, [links](url), images.
export function plain(md) {
  return String(md ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// The description in sections, each starting at an h1–h3 heading (the text before the first one is a
// section without a title). Headings inside code fences don't count.
// [{ key: "h0", level, title, text }]
export function sections(md) {
  const out = [];
  let cur = { level: 0, title: null, lines: [] }, fence = false;
  const push = () => {
    const text = cur.lines.join("\n");
    if (cur.title !== null || text.trim()) out.push({ key: `h${out.length}`, level: cur.level, title: cur.title, text });
  };
  for (const line of String(md ?? "").split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    const m = !fence && HEAD.exec(line);
    if (m) {
      push();
      cur = { level: m[1].length, title: plain(m[2]) || m[2], lines: [line] };
    } else cur.lines.push(line);
  }
  push();
  return out;
}

// Top-level comments in order, each with its replies (oldest first). A reply whose parent isn't
// loaded is shown as a comment of its own.
export function threads(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const top = [], kids = new Map();
  for (const c of comments) {
    const p = c.parent?.id;
    if (p && byId.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c); }
    else top.push(c);
  }
  return top.map((c) => ({ comment: c, replies: kids.get(c.id) ?? [] }));
}

// Linear stores reactions by name. The ones offered in the picker first, then other common names.
export const QUICK = ["+1", "heart", "laughing", "tada", "eyes", "pray", "white_check_mark", "rocket"];
const EMOJI = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", heart: "❤️", laughing: "😆", smile: "😄", joy: "😂",
  tada: "🎉", eyes: "👀", pray: "🙏", white_check_mark: "✅", heavy_check_mark: "✔️", rocket: "🚀", fire: "🔥",
  thinking_face: "🤔", clap: "👏", raised_hands: "🙌", muscle: "💪", ok_hand: "👌", "100": "💯", x: "❌",
  warning: "⚠️", bug: "🐛", sparkles: "✨", star: "⭐", sob: "😭", cry: "😢", sweat_smile: "😅", wave: "👋",
  slightly_smiling_face: "🙂", grinning: "😀", heart_eyes: "😍", party_popper: "🎉", hourglass: "⌛",
};
export const emoji = (name) => EMOJI[name] ?? (/[^\x00-\x7f]/.test(name) ? name : `:${name}:`);

// reactionData → [{ emoji, count, mine (my reaction's id or null), users: [userId] }], most used first.
export function reactionGroups(data, me) {
  return (Array.isArray(data) ? data : [])
    .map((g) => {
      const list = g.reactions ?? [];
      return { emoji: g.emoji, count: list.length, mine: list.find((r) => r.userId === me)?.id ?? null, users: list.map((r) => r.userId) };
    })
    .filter((g) => g.count > 0);
}

// reactionData with my reaction added or removed (what's shown until the server answers).
export function withReaction(data, emojiName, me, id) {
  const list = (Array.isArray(data) ? data : []).map((g) => ({ ...g, reactions: [...(g.reactions ?? [])] }));
  let g = list.find((x) => x.emoji === emojiName);
  if (id) {
    if (!g) { g = { emoji: emojiName, reactions: [] }; list.push(g); }
    g.reactions = g.reactions.filter((r) => r.userId !== me).concat([{ id, userId: me, reactedAt: new Date().toISOString() }]);
  } else if (g) g.reactions = g.reactions.filter((r) => r.userId !== me);
  return list.filter((x) => x.reactions.length);
}
