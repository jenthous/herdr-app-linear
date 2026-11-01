// Images in descriptions and comments: markdown is split into text and image pieces, and images
// are downloaded into the mod's cache folder. uploads.linear.app needs the API key; it goes to curl
// through a 0600 header file so it never shows up on a command line.

import { exec, appHome, readTextFile, writeTextFile } from "herdr";

const REL = "mods/linear/.cache"; // hidden, so changes in it don't reload the mod
const IMG_MD = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const IMG_HTML = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

// Text and images in the order they appear.
export function splitMarkdown(md) {
  const hits = [];
  for (const m of md.matchAll(IMG_MD)) hits.push({ at: m.index, len: m[0].length, url: m[2], alt: m[1] });
  for (const m of md.matchAll(IMG_HTML)) hits.push({ at: m.index, len: m[0].length, url: m[1], alt: "" });
  hits.sort((a, b) => a.at - b.at);
  const parts = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at < pos) continue;
    const text = md.slice(pos, h.at);
    if (text.trim()) parts.push({ kind: "text", text });
    parts.push({ kind: "img", url: h.url, alt: h.alt });
    pos = h.at + h.len;
  }
  const rest = md.slice(pos);
  if (rest.trim()) parts.push({ kind: "text", text: rest });
  return parts;
}

export const imageUrls = (md) => splitMarkdown(md ?? "").filter((p) => p.kind === "img" && /^https?:\/\//.test(p.url)).map((p) => p.url);

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
