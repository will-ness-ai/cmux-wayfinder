# cmux-wayfinder

`cmux-wayfinder sync` — a CLI that materializes [wayfinder](https://github.com/mattpocock/skills) map frontiers into [cmux](https://cmux.com) workspaces.

This is a niche tool: it's only useful if you already run `cmux` and drive your repos with the mattpocock wayfinder skills (`wayfinder:map` issues, `/wayfinder` prompts, etc.). If that's not your stack, there's nothing here for you.

## Prerequisites

- **macOS only** — cmux itself is macOS-only (Windows/Linux are in development upstream), so this tool is too.
- **[cmux](https://cmux.com)** — open source, install via Homebrew:
  ```sh
  brew tap manaflow-ai/cmux && brew install --cask cmux
  ```
  or grab the DMG directly.
- **[bun](https://bun.sh)** — used to run and test this project.
- **`gh`, authenticated** — `gh auth login`. Used to discover `wayfinder:map` issues per repo.
- **The [mattpocock wayfinder skills](https://github.com/mattpocock/skills)** — this tool only pays off if you already use `wayfinder:map` issues and `/wayfinder` prompts on your repos.

## What it does

Reads `tracked.yaml` (list of tracked repos + local checkout paths), discovers open `wayfinder:map` issues per repo via `gh`, and idempotently syncs cmux state over the v2 socket (`cmux rpc`):

- one workspace **group** per repo (`<repo> wayfinder`)
- one **workspace** per open map — titled with the map's **short name** (derived
  from its GitHub issue title, e.g. `Wayfinder map: app notifications — badge
  counts on the shell` → **`app notifications`**), cwd = local checkout. The
  full `owner/repo#map` stays as the workspace description (the identity key), so
  the sidebar reads by name while sync still matches on the stable id
- one **browser tab** per workspace (title `map #<map#>`), open to the map
  issue — *enforced*: recreated (pinned leftmost) if you close it
- a second **browser tab** right of it (title `lanes #<map#>`) — the **lanes
  board**: a generated, self-contained `file://` page showing the map's
  sub-issues as a sprint-lane ledger (In progress → Frontier → Blocked →
  Resolved). Also *enforced*. Each pass regenerates the file under
  `~/.cache/cmux-wayfinder/<owner>-<repo>/<map#>.html` and reloads the tab; the
  page also self-reloads every ~5s, so it never sits stale. It makes **zero
  network calls**, so it renders for private repos too
- one **tab** per open+unblocked sub-issue (title `[XY]<ticket#>`): launches
  `claude --worktree wayfinder/<map#>/<ticket#>`, waits for the TUI, then types
  `/wayfinder map #<map#> work on ticket #<ticket#>` into the input box and
  **submits it** — each new tab lands already working its ticket

Tab titles are `[XY]<ticket#>`:

- **X** — ticket type, from the `wayfinder:<type>` label: 🗣️ grilling, 🔨 task,
  🔎 research, 🧪 prototype (unlabeled counts as a task)
- **Y** — whose turn it is: 🫵 ready-for-human, 🤖 ready-for-agent. The ticket's
  `ready-for-human` / `ready-for-agent` labels are the source of truth (flip the
  label to flip the tab; human wins if both are present); a ticket with neither
  defaults HITL → 🫵. ✓ takes the slot once the ticket closes. Legacy
  `<n>`/`✓<n>` tabs upgrade to the bracketed form on the next run.

Sync is additive + rename-only by default (closed tickets → `[X✓]<n>` tabs); nothing is closed without `--prune`.

## Usage

```sh
bun install
cp tracked.example.yaml tracked.yaml   # then edit for your repos + local paths
bun src/sync.ts --dry-run     # print the plan, touch nothing
bun src/sync.ts               # materialize into live cmux (additive + rename-only)
bun src/sync.ts --prune       # also close stale tabs / dead-map workspaces
bun src/sync.ts --config path/to/tracked.yaml
bun src/sync.ts --watch       # re-sync every 30s until killed
bun src/sync.ts --watch 120   # ... every 120s
```

`bun link` registers the `cmux-sync` command globally, so a cmux terminal tab
can just run `cmux-sync --watch`.

`--dry-run` is the safe way to preview: it does the real GitHub reads and prints
every group/workspace/tab it *would* create, without contacting cmux.

`--watch [sec]` loops forever: sync, sleep `sec` seconds (default 30), repeat —
runs never overlap, and `tracked.yaml` is re-read each pass. GitHub's budget is
5,000 authenticated requests/hour (shared with everything else `gh` does on your
token); a pass costs ~2 GETs per repo + 1 per open map, so 30s (120 passes/hr)
is comfortable for typical setups — e.g. 3 repos / 6 maps ≈ 1,440/hr. The loop
warns if projected spend crosses half the budget, and on a failed pass it checks
`gh api rate_limit` (a free endpoint) and sleeps until the window resets if the
budget is exhausted.

A live run **does start agents**: each new tab launches `claude` on its worktree,
waits for the TUI, types the `/wayfinder …` prompt and submits it. Only *new*
tabs — an existing ticket tab is never re-prompted — so a run is safe to repeat,
but `--dry-run` first if you want to see how many agents it will kick off.

Workspace creation uses the v1 `cmux new-workspace` CLI (the only path that
honors title/cwd/description/group at creation); everything else goes over the
v2 `cmux rpc` socket.

`--prune` is the only path that ever closes anything (never the default). It
runs a normal additive sync first, then closes:
- **done/stale ticket tabs** — a managed `[XY]<n>` (or legacy `<n>`/`✓<n>`) tab
  whose ticket is no longer open (closed, or dropped from the map). A ticket
  that is still open but
  merely fell off the frontier (re-blocked) keeps its tab, so a live session is
  never yanked out from under you.
- **dead/untracked map workspaces** — a wayfinder workspace whose map has closed
  or whose repo left `tracked.yaml`.
- **stray group anchors** — the empty workspace `workspace.group.create` leaves
  behind (identified by `group.anchor_workspace_id`); emptying a group then
  auto-removes it.

Pair it with `--dry-run` first (`bun src/sync.ts --prune --dry-run`) to see
exactly what would close. Because `--prune` can close the workspace you're
sitting in, it may move your cmux selection — expected under prune only.

Known v1 limitations:
- `cmux rpc workspace.group.create` leaves a stray empty anchor workspace in
  each new group — harmless, cleaned up by `--prune`.
- The map browser tab shows "Page not found" for a **private** repo until the
  cmux webview is logged into GitHub (the tab points at the right URL either way).

## Planning

Work is tracked as wayfinder issues in this repo: see the issue labeled `wayfinder:map`.

## License

MIT — see [LICENSE](./LICENSE). `cmux` itself is GPL-3.0-or-later, but this repo only subprocess-invokes the `cmux`/`gh` CLIs (never links or bundles them), so the MIT license here stays clean.
