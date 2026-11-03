# Linear for Herdr

**Find, read and start work on Linear issues without leaving the [Herdr app](https://herdr.dev).** A window with your open issues, instant search, a live preview with images and comments, and one key to hand an issue to a coding agent in a new tab. The list then shows how long that agent has been working.

A native port of [herdr-linear](https://github.com/jenthous/herdr-linear), the terminal plugin for herdr, to a Herdr app mod.

![Linear for Herdr: my issues on the left, the selected issue on the right](preview.png)

## Features

- **Three lists.** My open issues, recently opened, and all issues of every team your API key belongs to (no team setup).
- **Search as you type.** Loaded issues filter at once; after a 0.3 s pause the server is asked too. Mix free text with tokens: `s:started`, `l:bug`, `@me`, `#ENG`, `p:urgent`, or an identifier like `ENG-142`. The last row searches comments as well.
- **Linear's look.** State icons (backlog, todo, in progress, in review, done, canceled) in each state's color, and priority bars with the urgent mark.
- **Pull requests.** Each row shows the issue's pull request in GitHub's colors: open, draft, merged or closed, with ✓ when approved, ± when changes are requested and ⚠ on conflicts. Click it to open the PR.
- **Preview and detail.** Description with images, comments, the pull request (repo, number, state and review), and parent, sub-issues, blocked by, blocking and related issues. Click a relation to follow it; Esc comes back. Write a comment under the comments with `m` (Markdown, ⌘Enter posts).
- **Images.** Images in descriptions and comments are downloaded once (Linear uploads with your key) and fitted to the window. A line that is just a link to a Linear upload (`- [caption](https://uploads.linear.app/…)`, as scripts that post screenshots through the API write them) shows the image under its caption, or stays a link when the file isn't an image. Click one (or press `v`) to see it large over the window; ←/→ step through the issue's images, `o` opens it in Preview, Esc or a click closes.
- **Agents.** `c` asks where to work, then opens a tab named after the issue running your agent (Claude Code by default) with the issue as its first message: description, recent comments and the images' local files, so the agent sees the screenshots too. The issue moves to In Progress, and to In Review when the agent finishes. The choices cover every space on every machine: a checkout already on the issue (its branch, or its or its parent's identifier in the path), the issue's repo found by an `owner/repo` label (e.g. from the GitHub integration) against each checkout's `origin`, and a new git worktree on the issue's branch. Any tab whose name contains an identifier is linked: the issue shows a spinner and the elapsed time while the agent works, "needs you" when it's blocked, and `g` takes you there.
- **Issues in the terminal.** Opening the window reads the focused terminal (its screen and the last 300 lines) and lists the issues it mentions on top, last mentioned first: Linear issue links, and identifiers like `ENG-142` of your teams (in branch names too). Pick one with ↑/↓ and Enter. Terminal links themselves still open in the browser; Herdr doesn't let a mod take over their clicks.
- **Current branch.** The issue of the focused pane's branch (`me/eng-142-…`) is pinned on top of My issues.
- **Fast reopen.** Everything fetched is cached, so the window shows your lists instantly and refreshes in the background every 60 s.

![An issue with an image, its pull request, relations and the agent working on it](docs/detail.png)

## Install

1. Copy `mods/linear` into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into `~/.config/herdr-app/keys.json` (it binds `cmd-i` to open the window; pick another key if you use that one).
3. Run `herdr-app check ~/.config/herdr-app/mods/linear`, then press `cmd-i`.

Or ask the agent in your Herdr terminal: *"add herdr.dev/mods/jenthous/herdr-app-linear"*.

### API key

Create a personal API key in Linear → Settings → Security & access → Personal API keys. The mod looks for it in this order:

1. `LINEAR_API_KEY` in your login environment
2. `~/.config/herdr/plugins/config/jh.linear/credentials` (herdr-linear's)
3. `~/.config/herdr-linear/credentials`

If none is found, the window asks for it and saves it to the last path with mode 0600. The key is only sent to `api.linear.app` and `uploads.linear.app`, in the `Authorization` header.

## Search

Free words match the title and description; tokens narrow it down. A token takes several values joined by commas (any of them), and a leading `-` or `!` turns it around.

| Token | Means |
|---|---|
| `s:started`, `s:done`, `s:review` | state type (`triage backlog todo started done canceled duplicate`, also in Korean) or a state name |
| `s:open` / `s:closed` | not finished / done, canceled or duplicate |
| `l:bug`, `@me`, `@name`, `#ENG`, `p:urgent` | label, assignee, team, priority |
| `-s:done`, `s:!done`, `-l:bug,infra`, `-@me`, `-wip` | everything that isn't (`-@me` includes unassigned; `-wip` lacks the word) |
| `ENG-123`, `123` | that issue first |

Sub-issues nest under their parent when both are in the list, with a done/total ring beside the parent; click it (or ←/→) to fold. Done and canceled issues are faded and struck through.

## Keys

| Where | Keys |
|---|---|
| List | type to search, ↑/↓ or ⌃N/⌃P move, ←/→ fold/unfold sub-issues, Enter open, Tab/⇧Tab switch list, ⌃S save/remove the search as a filter, ⌃1–9 run a saved filter, ⌃L split/list layout, ⌃O browser, ⌃Y copy URL, ⌃R refresh, Esc clear search or close |
| Detail | Esc back, Tab description/comments, `m` write a comment, `c` agent tab, `g` go to the agent's tab, `o` browser, `y` copy URL, `Y` copy PR link, `i` copy ID, `v` view images, `r` refresh, `q` close |
| Comment box | ⌘Enter send, Esc leave (a typed draft stays with its issue) |
| Image viewer | ←/→ or Tab previous/next image, `o` open in Preview, Esc/Space/click close |

Commands for `keys.json` or `herdr-app do`: `linear.search` (or `linear.search:<text>` to type a search), `linear.layout[:split|list]`, `linear.close`, `linear.refresh`, `linear.open:ENG-123`, `linear.comments` (switch description/comments), `linear.comment` (write a comment on the shown issue), `linear.work` (the agent picker for the shown issue), `linear.image` (the image viewer on the shown issue's first image), `linear.demo` (toggles demo data, no key needed).

## Settings

Optional `mods/linear/config.json` (see `config.example.json`):

```json
{
  "language": "en",
  "agent": ["claude"],
  "agentName": "Claude",
  "refreshSeconds": 60,
  "autoState": true,
  "taskContext": true,
  "terminalIssues": true
}
```

- `language`: `en` (default) or `ko`.
- `agent`: the command `c` starts in the new tab, e.g. `["codex"]`.
- `autoState`: starting an agent with `c` moves a Backlog/Todo issue to the team's first started state (In Progress); when that agent stops after working (its tab turns done), the issue moves to the team's review state (a started state named "review"), if it has one. The window only runs while open, so a finished agent is noticed the next time it opens. Set `false` to leave states alone.
- `terminalIssues`: list the issues mentioned in the focused terminal on top when the window opens. Set `false` to skip reading the terminal.
- `taskContext`: the agent's first message also carries the description, the last 10 comments and the images as `[image n]` with their downloaded local paths (Linear links when the agent runs on another machine). Set `false` for just the title and link.

![Comments](docs/comments.png)

## What it touches

- **Network:** `api.linear.app` (GraphQL) and the image hosts linked in issues.
- **Programs:** `hc read` on the focused terminal when the window opens (`terminalIssues`); `git` and `sh` in each space's folder, on that space's machine, to find repos (three levels deep) and add worktrees under `~/.herdr/worktrees/`; `curl`, `file` and `sips` (image size, macOS) for images, `open` to show an image full size, `sh` for file permissions.
- **Files:** reads the credential files above; writes its cache to `mods/linear/.cache/` (mode 0700).

## License

MIT
