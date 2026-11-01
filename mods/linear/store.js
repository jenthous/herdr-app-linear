// One cache file. Each open of the window is a new copy of the mod with an empty localStorage,
// so everything fetched goes to a hidden file in the mod folder and shows first next time.
// Writes are batched and done by flush().

import * as fs from "fs/promises";
import { appHome, exec } from "herdr";

export class Store {
  constructor() {
    this.dir = `${appHome()}/mods/linear/.cache`;
    this.path = `${this.dir}/data.json`;
    this.data = {};
    this.dirty = false;
    this.writing = false;
  }

  async load() {
    try { this.data = JSON.parse(await fs.readFile(this.path, "utf8")) ?? {}; }
    catch { this.data = {}; }
    return this.data;
  }

  get(key, fallback) { return this.data[key] ?? fallback; }
  set(key, value) { this.data[key] = value; this.dirty = true; }

  async flush() {
    if (!this.dirty || this.writing) return;
    this.dirty = false; this.writing = true;
    try {
      await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1"', "sh", this.dir]);
      await fs.writeFile(`${this.path}.tmp`, JSON.stringify(this.data));
      const r = await exec("mv", ["-f", `${this.path}.tmp`, this.path]);
      if (r.code !== 0) throw new Error(r.stderr);
    } catch {
      this.dirty = true;
    } finally {
      this.writing = false;
    }
  }
}
