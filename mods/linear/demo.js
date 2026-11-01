// Demo data for screenshots and trying the mod without a key: `linear.demo` toggles it.
// Nothing here is sent anywhere or saved to the cache.

const S = {
  triage: { id: "s0", name: "Triage", type: "triage", color: "#fc7840" },
  backlog: { id: "s1", name: "Backlog", type: "backlog", color: "#bec2c8" },
  todo: { id: "s2", name: "Todo", type: "unstarted", color: "#e2e2e2" },
  progress: { id: "s3", name: "In Progress", type: "started", color: "#f2c94c" },
  review: { id: "s4", name: "In Review", type: "started", color: "#5e6ad2" },
  done: { id: "s5", name: "Done", type: "completed", color: "#4cb782" },
  canceled: { id: "s6", name: "Canceled", type: "canceled", color: "#95a2b3" },
};
const TEAMS = {
  ENG: { id: "t1", key: "ENG", name: "Engineering" },
  DES: { id: "t2", key: "DES", name: "Design" },
  OPS: { id: "t3", key: "OPS", name: "Operations" },
};
const PEOPLE = {
  me: { id: "u1", name: "Sam Rivera", displayName: "sam" },
  mia: { id: "u2", name: "Mia Chen", displayName: "mia" },
  leo: { id: "u3", name: "Leo Park", displayName: "leo" },
  ana: { id: "u4", name: "Ana Souza", displayName: "ana" },
};
const L = {
  bug: { id: "l1", name: "Bug", color: "#eb5757" },
  repo: { id: "l9", name: "acme/web", color: "#4cb782" },
  feature: { id: "l2", name: "Feature", color: "#bb87fc" },
  perf: { id: "l3", name: "Performance", color: "#4ea7fc" },
  ux: { id: "l4", name: "UX", color: "#f2994a" },
};

const now = Date.now();
const at = (mins) => new Date(now - mins * 60000).toISOString();

let n = 0;
function issue(team, number, title, state, priority, who, labels, mins, extra = {}) {
  n++;
  const identifier = `${team}-${number}`;
  return {
    id: `demo-${n}`, identifier, number, title, description: extra.description ?? "",
    priority, url: `https://linear.app/acme/issue/${identifier.toLowerCase()}`,
    branchName: `${who?.displayName ?? "sam"}/${identifier.toLowerCase()}`, dueDate: extra.dueDate ?? null,
    createdAt: at(mins + 4000), updatedAt: at(mins), archivedAt: null, trashed: false,
    team: TEAMS[team], state: S[state], assignee: who ?? null, project: extra.project ?? null, cycle: extra.cycle ?? null,
    parent: extra.parent ?? null, labels: { nodes: labels.map((l) => L[l]) },
    attachments: { nodes: extra.pr ? [{ url: `https://github.com/acme/web/pull/${extra.pr}`, sourceType: "github", createdAt: at(mins), metadata: { status: "open", number: extra.pr, draft: false } }] : [] },
  };
}

const checkoutBody = `## Summary
Checkout drops the cart when the session token refreshes mid-payment. People see an empty cart after confirming their card, and about **2%** of payments are retried by hand.

![Checkout after the token refresh](demo:checkout.svg)

## What happens
1. The payment sheet opens and the token is close to expiring.
2. The refresh succeeds, but the cart request still carries the old token.
3. The server answers \`401\`, the client treats it as a logged-out session and clears the cart.

## Plan
- Retry the cart request once with the new token before clearing anything.
- Keep the cart in local storage until the order is confirmed.
- Add a test that refreshes the token while the payment sheet is open.`;

const project = { id: "p1", name: "Checkout v2" };
const cycle = { id: "c1", number: 24, name: null };
const parent = { id: "demo-p", identifier: "ENG-120", title: "Checkout reliability", state: S.progress };

const mine = [
  issue("ENG", 142, "Cart is cleared when the session token refreshes during payment", "progress", 1, PEOPLE.me, ["bug", "repo"], 12, { description: checkoutBody, project, cycle, parent, pr: 1873 }),
  issue("ENG", 139, "Retry failed webhook deliveries with exponential backoff", "review", 2, PEOPLE.me, ["feature"], 48, { project, pr: 1866 }),
  issue("DES", 51, "Empty states for the orders page", "progress", 3, PEOPLE.me, ["ux"], 95),
  issue("ENG", 133, "Search results flicker while typing", "todo", 2, PEOPLE.me, ["bug", "ux"], 180),
  issue("ENG", 128, "Cache product images at the edge", "todo", 3, PEOPLE.me, ["perf"], 320, { cycle }),
  issue("OPS", 27, "Rotate the staging database credentials", "todo", 2, PEOPLE.me, [], 600, { dueDate: "2026-11-07" }),
  issue("ENG", 121, "Drop the legacy coupon endpoint", "backlog", 4, PEOPLE.me, [], 1500),
  issue("DES", 48, "Dark mode for the invoice PDF", "backlog", 0, PEOPLE.me, ["feature"], 2900),
  issue("ENG", 117, "Flaky test: order totals with mixed currencies", "triage", 3, PEOPLE.me, ["bug"], 4300),
];
const others = [
  issue("ENG", 145, "Rate-limit the password reset form", "todo", 1, PEOPLE.leo, ["bug"], 30),
  issue("DES", 53, "New illustration set for onboarding", "progress", 3, PEOPLE.mia, ["ux"], 70),
  issue("ENG", 143, "Show delivery estimates on the product page", "review", 2, PEOPLE.ana, ["feature"], 140, { project }),
  issue("OPS", 29, "Alert when the payment queue backs up", "progress", 2, PEOPLE.leo, ["perf"], 210),
  issue("ENG", 141, "Remove unused feature flags", "done", 4, PEOPLE.ana, [], 400),
  issue("DES", 50, "Audit color contrast in forms", "done", 3, PEOPLE.mia, ["ux"], 900),
  issue("ENG", 140, "Support Apple Pay in checkout", "canceled", 3, null, ["feature"], 1300),
];

const byId = Object.fromEntries([...mine, ...others].map((i) => [i.identifier, i]));
const rel = (id) => ({ id: byId[id].id, identifier: id, title: byId[id].title, state: byId[id].state });

const comment = (id, who, mins, body) => ({ id, body, createdAt: at(mins), editedAt: null, user: who });

// Where the agent picker offers to work (fake spaces; nothing starts in demo mode).
const sp = (name, machine) => ({ id: `s-${name}`, name, machine });
const places = [
  { kind: "tab", rank: 3, space: sp("web", null), folder: "~/.herdr/worktrees/web/sam-eng-142-cart-token", repo: "acme/web", branch: "sam/eng-142-cart-token" },
  { kind: "tab", rank: 2, space: sp("web", null), folder: "~/code/acme/web", repo: "acme/web", branch: "main" },
  { kind: "tab", rank: 2, space: sp("gpu-box", "build-1"), folder: "~/src/web", repo: "acme/web", branch: "main" },
  { kind: "worktree", rank: 1, machine: null, folder: "~/code/acme/web", repo: "acme/web", branch: "sam/eng-142-cart-token" },
  { kind: "tab", rank: 0, space: sp("notes", null), folder: "~/notes", repo: null, branch: null },
];

export const demo = {
  places,
  viewer: {
    id: PEOPLE.me.id, name: PEOPLE.me.name, displayName: PEOPLE.me.displayName,
    organization: { id: "o1", name: "Acme", urlKey: "acme" },
    teams: { nodes: Object.values(TEAMS) },
  },
  mine,
  all: [...others, ...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  details: {
    "ENG-142": {
      issue: byId["ENG-142"],
      comments: [
        comment("dc1", PEOPLE.mia, 300, "Reproduced on iOS with a 5 minute token lifetime. The cart request fires about 40 ms before the refresh lands."),
        comment("dc2", PEOPLE.leo, 90, "The 401 handler in `session.ts` clears everything. Retrying once with the new token should be enough.\n\n```ts\nif (res.status === 401 && refreshed) return retry(req)\n```"),
        comment("dc3", PEOPLE.me, 20, "PR is up: acme/web#1873. Added a test that refreshes the token while the sheet is open."),
      ],
      moreComments: false,
      relations: {
        children: [rel("ENG-139"), rel("ENG-133")], moreChildren: false,
        blockedBy: [rel("OPS-29")], blocking: [rel("ENG-143")], related: [rel("ENG-128")],
      },
    },
  },
  images: { "demo:checkout.svg": { state: "ok", rel: "mods/linear/demo/checkout.svg", abs: null, w: 640, h: 400 } },
  // Pretend some issues have agent tabs, so the badges show.
  links: (started) => ({
    "ENG-142": { tab: { id: "demo-tab-1", name: "ENG-142", status: "working", working_since: started - 154000 }, space: { id: "demo-space", name: "web" }, r: 3 },
    "ENG-139": { tab: { id: "demo-tab-2", name: "ENG-139 webhooks", status: "blocked", working_since: null }, space: { id: "demo-space", name: "web" }, r: 4 },
    "DES-51": { tab: { id: "demo-tab-3", name: "DES-51", status: "done", working_since: null }, space: { id: "demo-space", name: "design" }, r: 2 },
  }),
};
