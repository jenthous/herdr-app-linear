# Linear

A floating window for Linear inside the Herdr app: your open issues on the left, the selected issue on the right with its description, images, comments and relations, and one key that starts a coding agent on the issue in a new tab. Tabs named after an issue show their agent's status and elapsed time next to that issue.

![Linear](preview.png)

## What you see

- **Window:** a Herdr `window` overlay, 980 px wide and 80% of the window tall, theme `popover` background, opened with `cmd-i`. It remembers where it was dropped and reopens on the next start.
- **Header (42 px):** "Linear" 14 px semibold, the organization name 11.5 px `dim`, then three list tabs (My issues · Recent · All) as 26 px pills with counts; selected is `selected` background. On the right a spinner while loading, refresh `↻` and close. In demo mode a small bordered "demo data" tag follows the organization.
- **Search bar:** a 34 px rounded field with a search icon; the token hint (`s:started l:bug @me #ENG p:urgent`) shows at its right end while empty.
- **List (420 px when the window is at least 760 px wide, else full width):** 30 px rows: priority icon (14 px: three bars filled by level, `muted`; urgent is a red `#eb5757` rounded square with `!`; none is three dashes), identifier 11.5 px `dim`, state icon in the state's Linear color (dashed circle backlog, empty circle todo, half-filled in progress, three-quarter in review, check done, cross canceled), title, then an agent badge if a tab is linked, then the assignee. The selected row is `selected`.
- **Preview / detail:** back button (detail only), identifier (click copies), a state chip with icon, the priority icon and name, team. The title as a markdown heading. A meta line (assignee, project, cycle, due, updated). Label chips. When a tab is linked: a `surface` box with the big agent badge, "space · tab name" and a primary "Go to tab" button. Action buttons: "Work with Claude" (primary when no tab is linked), Browser, Copy URL, Copy ID, and the PR number when one is open. A `surface` box of relations (Parent, Sub-issues, Blocked by in `blocked` color, Blocking, Related), each row with a state icon. Then an underlined segmented switch "Description | Comments n", and the selected section: markdown with images, or comment cards (initial avatar circle, name, time, markdown body).
- **Footer (26 px):** key hints, or a flash after copying (`done` color) or an error (`blocked` color); on the right the viewer's name and team keys.

## How it behaves

- **Agent badge:** working = spinner (`working` color) plus elapsed time ("2m 34s", ticking each second only while some linked agent works); blocked = dot plus "needs you" (`blocked`); done = dot plus "finished" (`done`); idle = terminal icon plus "tab". Clicking it selects that space and tab.
- **Linking:** any tab whose name contains `[A-Za-z][A-Za-z0-9]*-\d+` links to that issue; when several do, blocked > working > done > idle.
- **Search:** filters cached issues instantly (tokens must all match; identifiers and title-prefix rank first), then after 300 ms asks the server with an `IssueFilter` limited to the viewer's teams; results merge. A last row runs `searchIssues` with comments on request.
- **Keys:** list ↑/↓, ⌃N/⌃P, PageUp/Down, Enter opens detail, Tab/⇧Tab switch lists, ⌃O browser, ⌃Y copy URL, ⌃R refresh, Esc clears the search or closes. Detail: Esc/Backspace back, Tab switches sections, `c` agent tab, `g` go to tab, `o`, `y`, `Y` (PR), `i`, `r`, `q`.
- **Clicks:** a row selects (and previews after 220 ms); clicking the selected row or double-clicking opens it. Relations open their issue (and push onto a back stack). Images open full size with `open`.
- **Agent tab:** `tab.new {name: identifier, argv: config.agent, task: "Work on Linear ID: title\nurl"}`, then the window closes.
- **Refresh:** every 60 s (my issues, the first page of all, the shown detail). The current pane's git branch pins its issue on top of My issues.
- **Window drag:** presses on controls stop propagation so only empty areas drag the window.

## Built from

- Layout: none. `mods/linear/mod.json` declares `{place: "none", overlay: {kind: "window", key: "linear", keep: true, width: 980, height: 0.8}}`; `keys.json` binds `cmd-i` to `mod.open:linear`.
- Files: `main.js` (view), `api.js` (GraphQL: viewer, issues with filter and cursor, searchIssues, issue detail with comments, children, relations and inverseRelations, retried without relations on error), `query.js` (token parser, server filter, local score), `media.js` (markdown split into text and images, image download), `store.js` (cache file), `i18n.js` (en, ko), `demo.js` plus `demo/checkout.svg` (demo data), `icons/` (state, priority, spinner, search, terminal, close SVGs tinted with `svg()`).
- herdr: `spaces()`, `panes()`, `focused()`, `theme()`, `props()`, `run()` (`tab.new`, `space.select`, `tab.select`), `closeOverlay`, `nextCommand` (`linear.search|refresh|demo|comments|open:ID`), `exec`, `readTextFile`, `writeTextFile`, `home()`, `appHome()`, `fs/promises`, `fetch`, `cx.open_url`, `cx.write_to_clipboard`.
- gpui-base: `TextView.markdown` (selectable, link clicks open in the browser), `InputState`/`Input`, `h_flex`/`v_flex`; gpui-kit `svg`, `image`, `.spin()`.
- Programs: `curl -H @file` (Linear uploads need the key; the header lives in a 0600 file), `file --mime-type`, `sips` for pixel size, `sh` for permissions, `mv`.

## Watch out

- Every `mod.open` is a fresh copy with an empty `localStorage`; a cache there never hits. Keep the cache in one file (`mods/linear/.cache/data.json`, written every 2 s) and show it before fetching.
- A `for (;;) await nextCommand()` loop must return when the answer is empty: after a reload the old copy's `nextCommand()` stops waiting, and a loop that never yields freezes the whole window.
- Create `InputState` once in `init`; replacing it later from an async task broke re-rendering. Draw language-dependent hints beside the input instead of as its placeholder.
- `TextView` comes from `gpui-base`, not `gpui-kit`.
- Columns inside an `h_flex` need `h_full()` or they get zero height and draw nothing.
- `readTextFile` stops at 1 MiB; use `fs/promises` for the cache. `fs` writes only under the app folder, so files elsewhere (the credentials) go through a temp file and `sh`.
- Several images downloading at once must share one header-file write, or `writeTextFile`'s snapshot check fails all but one.
- `image()` needs an explicit width and height: read them with `sips` and scale (half size for retina screenshots, at most the pane width and 520 px tall).
- Images, the agent link and the branch pin assume macOS (`sips`, `open`).

## Done when

- `herdr-app check mods/linear` passes and `cmd-i` opens the window.
- `herdr-app do linear.demo` shows Acme's demo issues with state and priority icons, an agent badge ticking on ENG-142 and "needs you" on ENG-139.
- `herdr-app do linear.open:ENG-142` (demo) shows the checkout image, the PR button, relations and three comments under "Comments 3".
- With a real key, typing `s:started @me` filters at once and then merges server results; closing and reopening the window shows the lists before any request finishes.
- `c` on an issue opens a tab named after it running the configured agent; while that agent works, the issue's row shows a spinner and the elapsed time.
