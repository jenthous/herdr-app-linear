// Images in descriptions and comments: markdown is split into text and image pieces, and images
// are downloaded into the mod's cache folder. uploads.linear.app needs the API key; it goes to curl
// through a 0600 header file so it never shows up on a command line.

import { exec, appHome, readTextFile, writeTextFile } from "herdr";

const REL = "mods/linear/.cache"; // hidden, so changes in it don't reload the mod
const IMG_MD = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const IMG_HTML = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
// A line that is only a link to a Linear upload (a bullet or number may lead it), as tools that post
// screenshots through the API write them: `- [caption](https://uploads.linear.app/...)`. It shows as an
// image when the file is one; otherwise as the link it was.
const UPLOAD_LINK = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?\[([^\]]*)\]\(\s*<?(https:\/\/uploads\.linear\.app\/[^)\s>]+)>?\s*\)[ \t]*$/gm;

// Text, images and tables in the order they appear. Image pieces from an upload link carry `link: true`
// and their markdown (`src`), to fall back to when the file isn't an image. A table is one piece
// ({kind: "table", head, rows, align, src}: cells are markdown, split again when drawn), so images
// inside cells don't break it apart.
export function splitMarkdown(md) {
  const parts = [];
  for (const block of splitTables(md)) {
    if (block.kind === "table") parts.push(block);
    else parts.push(...splitImages(block.text));
  }
  return parts;
}

const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

// Cells of one table line: split on | that isn't escaped or inside `code`, outer pipes dropped.
function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// Markdown in text blocks and GFM tables (a header line with |, then a |---| rule, then lines with |).
function splitTables(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let text = [], fence = false;
  const flush = () => { if (text.length) { out.push({ kind: "text", text: text.join("\n") }); text = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) fence = !fence;
    if (!fence && line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const rule = cells(lines[i + 1]);
      if (rule.length === head.length || line.trim().startsWith("|")) {
        const align = rule.map((r) => (r.startsWith(":") && r.endsWith(":") ? "center" : r.endsWith(":") ? "right" : "left"));
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) rows.push(cells(lines[j]));
        const n = Math.max(head.length, ...rows.map((r) => r.length));
        const pad = (r) => [...r, ...Array(Math.max(0, n - r.length)).fill("")].slice(0, n);
        flush();
        out.push({ kind: "table", head: pad(head), rows: rows.map(pad), align: pad(align).map((a) => a || "left"), src: lines.slice(i, j).join("\n") });
        i = j - 1;
        continue;
      }
    }
    text.push(line);
  }
  flush();
  return out;
}

function splitImages(md) {
  const hits = [];
  for (const m of md.matchAll(UPLOAD_LINK)) hits.push({ at: m.index, len: m[0].length, url: m[2], alt: m[1], link: true, src: m[0].trim() });
  for (const m of md.matchAll(IMG_MD)) hits.push({ at: m.index, len: m[0].length, url: m[2], alt: m[1] });
  for (const m of md.matchAll(IMG_HTML)) hits.push({ at: m.index, len: m[0].length, url: m[1], alt: "" });
  hits.sort((a, b) => a.at - b.at);
  const parts = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at < pos) continue;
    const text = md.slice(pos, h.at);
    if (text.trim()) parts.push({ kind: "text", text });
    parts.push(h.link ? { kind: "img", url: h.url, alt: h.alt, link: true, src: h.src } : { kind: "img", url: h.url, alt: h.alt });
    pos = h.at + h.len;
  }
  const rest = md.slice(pos);
  if (rest.trim()) parts.push({ kind: "text", text: rest });
  return parts;
}

// Every image piece, table cells included, in reading order.
export function imageParts(md) {
  return splitMarkdown(md ?? "").flatMap((p) => p.kind === "img" ? [p]
    : p.kind === "table" ? [p.head, ...p.rows].flat().flatMap((c) => splitImages(c).filter((x) => x.kind === "img"))
    : []);
}

export const imageUrls = (md) => imageParts(md).filter((p) => /^https?:\/\//.test(p.url)).map((p) => p.url);
export { splitImages };

function hash(s) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const SCRIPT = `
b="$2"
for f in "$b".png "$b".jpg "$b".gif "$b".webp "$b".svg; do
  if [ -f "$f" ]; then e="\${f##*.}"; break; fi
done
if [ -z "$e" ]; then
  if [ "$4" = 1 ]; then curl -sfL --max-time 25 -H @"$3" -o "$b.tmp" "$1" || { rm -f "$b.tmp"; echo "ERR download"; exit 2; }
  else curl -sfL --max-time 25 -o "$b.tmp" "$1" || { rm -f "$b.tmp"; echo "ERR download"; exit 2; }; fi
  case "$(file -b --mime-type "$b.tmp")" in
    image/png) e=png;; image/jpeg) e=jpg;; image/gif) e=gif;; image/webp) e=webp;; image/svg+xml) e=svg;;
    *) rm -f "$b.tmp"; echo "ERR type"; exit 3;;
  esac
  mv "$b.tmp" "$b.$e"
fi
echo "EXT $e"
sips -g pixelWidth -g pixelHeight "$b.$e" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print "DIM",w+0,h+0}'
`;

export class Images {
  constructor() {
    this.items = {}; // url → { state: "loading" | "ok" | "error", rel, abs, w, h }
    this.authFor = null;
  }

  dir() { return `${appHome()}/${REL}`; }

  // Writing the header file from several downloads at once makes them fail; write it once.
  writeAuth(key) {
    if (this.authFor !== key || !this.authDone) { this.authFor = key; this.authDone = this.writeAuthOnce(key).catch((e) => { this.authFor = null; throw e; }); }
    return this.authDone;
  }

  async writeAuthOnce(key) {
    const path = `${this.dir()}/auth-header`;
    // A 0700 folder keeps the file private even while it's being replaced
    await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1"', "sh", this.dir()]);
    const cur = await readTextFile(path);
    await writeTextFile(path, `Authorization: ${key}\n`, cur ?? null);
    await exec("chmod", ["600", path]);
  }

  get(url) { return this.items[url]; }

  async load(url, key) {
    if (this.items[url]) return;
    this.items[url] = { state: "loading" };
    try {
      const auth = /^https:\/\/uploads\.linear\.app\//.test(url);
      if (auth) await this.writeAuth(key);
      else await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1"', "sh", this.dir()]);
      const name = hash(url);
      const r = await exec("sh", ["-c", SCRIPT, "sh", url, `${this.dir()}/${name}`, `${this.dir()}/auth-header`, auth ? "1" : "0"]);
      const ext = /EXT (\w+)/.exec(r.stdout)?.[1];
      const dim = /DIM (\d+) (\d+)/.exec(r.stdout);
      if (r.code !== 0 || !ext) throw new Error(r.stdout.trim() || r.stderr.trim());
      this.items[url] = {
        state: "ok", rel: `${REL}/${name}.${ext}`, abs: `${this.dir()}/${name}.${ext}`,
        w: dim ? parseInt(dim[1], 10) : 0, h: dim ? parseInt(dim[2], 10) : 0,
      };
    } catch (e) {
      this.items[url] = { state: "error", why: String(e?.message ?? e) };
    }
  }
}
