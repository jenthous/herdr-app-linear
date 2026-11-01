// Where an agent can work on an issue: the open spaces, the git repos inside them (on their own
// machine), and a new worktree on the issue's branch. Repos are matched to the issue by labels
// written as "owner/repo" (e.g. a GitHub integration's repo label) against each checkout's origin.

import { spaces, exec, run } from "herdr";

// Git checkouts in a folder and up to three levels below: "path\torigin\tbranch\tmain|wt" per line.
const SCAN = `cd "\${1:-$HOME}" 2>/dev/null || exit 0
for d in . * */* */*/*; do
  [ -e "$d/.git" ] || continue
  u=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
  k=wt; [ -d "$d/.git" ] && k=main
  printf '%s\\t%s\\t%s\\t%s\\n' "$(cd "$d" && pwd -P)" "$u" "$(git -C "$d" branch --show-current 2>/dev/null)" "$k"
done`;

const placeKey = (machine, folder) => `${machine ?? ""}|${folder ?? ""}`;
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const on = (machine) => (machine ? { on: machine } : {});

// "git@github.com:Owner/Repo.git" or "https://github.com/owner/repo" → "owner/repo".
export function repoOf(url) {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? m[1].toLowerCase() : null;
}

export function repoLabels(issue) {
  return (issue?.labels?.nodes ?? []).map((l) => l.name.trim().toLowerCase()).filter((n) => /^[\w.-]+\/[\w.-]+$/.test(n));
}

export class Places {
  constructor() { this.scans = {}; this.pending = new Map(); }

  scanning() { return this.pending.size > 0; }

  // Scans every space's folder once per window.
  scanAll() {
    for (const s of spaces()) {
      const k = placeKey(s.machine, s.folder);
      if (this.scans[k] || this.pending.has(k)) continue;
      const p = exec("sh", ["-c", SCAN, "sh", s.folder || ""], on(s.machine))
        .then((r) => r.stdout.split("\n").filter(Boolean).map((l) => {
          const [path, origin, branch, kind] = l.split("\t");
          return { path, repo: repoOf(origin), branch: branch || null, main: kind === "main" };
        }))
        .catch(() => [])
        .then((list) => { this.scans[k] = list; this.pending.delete(k); });
      this.pending.set(k, p);
    }
    return Promise.all(this.pending.values());
  }

  // Choices, best first: a checkout already for this issue (its branch, or its or its parent's
  // identifier in the branch or path), the issue's repo (main checkouts only; other worktrees
  // belong to other work), a new worktree of that repo, then every space as it is.
  choices(issue) {
    const labels = repoLabels(issue);
    // Linear appends the title to its branch name; cut it at the first non-ASCII letter.
    const branch = (issue.branchName || "").split(/[^\x21-\x7e]/)[0].replace(/[-/.]+$/, "") || issue.identifier.toLowerCase();
    const ids = [issue.identifier, issue.parent?.identifier].filter(Boolean).map((x) => x.toLowerCase());
    const mine = (r) => r.branch === branch || ids.some((x) => `${r.path} ${r.branch ?? ""}`.toLowerCase().includes(x));
    const out = [], seen = new Set(), trees = new Set();
    const add = (c) => { const k = `${c.kind}|${c.space?.id ?? c.machine}|${c.folder}`; if (!seen.has(k)) { seen.add(k); out.push(c); } };
    for (const s of spaces()) {
      for (const r of this.scans[placeKey(s.machine, s.folder)] ?? []) {
        if (mine(r)) add({ kind: "tab", rank: 3, space: s, folder: r.path, repo: r.repo, branch: r.branch });
        else if (r.main && r.repo && labels.includes(r.repo)) {
          add({ kind: "tab", rank: 2, space: s, folder: r.path, repo: r.repo, branch: r.branch });
          const tk = `${s.machine ?? ""}|${r.path}`;
          if (!trees.has(tk)) { trees.add(tk); add({ kind: "worktree", rank: 1, machine: s.machine ?? null, folder: r.path, repo: r.repo, branch }); }
        }
      }
    }
    for (const s of spaces()) add({ kind: "tab", rank: 0, space: s, folder: s.folder, repo: null, branch: s.branch ?? null });
    return out.sort((a, b) => b.rank - a.rank);
  }

  // Starts the agent there. Worktrees go to ~/.herdr/worktrees/<repo>/<branch> on the repo's
  // machine, like Herdr's own worktree mod, and open as a new space.
  async start(c, { name, argv, task }) {
    if (c.kind === "tab") {
      run("tab.new", { space: c.space.id, folder: c.folder || undefined, name, argv, task });
      run("space.select", { id: c.space.id });
      return;
    }
    const o = on(c.machine);
    const home = (await exec("sh", ["-c", 'printf %s "$HOME"'], o)).stdout.trim();
    const path = `${home}/.herdr/worktrees/${c.folder.split("/").pop()}/${slug(c.branch)}`;
    if ((await exec("test", ["-e", path], o)).code !== 0) {
      const has = (await exec("git", ["-C", c.folder, "show-ref", "--verify", "--quiet", `refs/heads/${c.branch}`], o)).code === 0;
      const r = await exec("git", ["-C", c.folder, "worktree", "add", ...(has ? [path, c.branch] : ["-b", c.branch, path, "HEAD"])], o);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop());
    }
    run("space.new", { folder: path, ...(c.machine ? { machine: c.machine } : {}), tab: name, argv, task });
  }
}
