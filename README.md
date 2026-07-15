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
- one **workspace** per open map (title `<repo>/<map#>`, cwd = local checkout)
- one **browser tab** per workspace (title `map #<map#>`), open to the map
  issue — *enforced*: recreated (pinned leftmost) if you close it
- one **tab** per open+unblocked sub-issue (title `<ticket#>`): launches
  `claude --worktree wayfinder/<map#>/<ticket#>`, waits for the TUI, then types
  `/wayfinder map #<map#> work on ticket #<ticket#>` into the input box and
  **leaves it unsubmitted** — you review each and press Enter yourself

Sync is additive + rename-only by default (closed tickets → `✓<n>` tabs); nothing is closed without `--prune`.

## Usage

```sh
bun install
cp tracked.example.yaml tracked.yaml   # then edit for your repos + local paths
bun src/sync.ts --dry-run     # print the plan, touch nothing
bun src/sync.ts               # materialize into live cmux (additive + rename-only)
bun src/sync.ts --prune       # also close stale tabs / dead-map workspaces
bun src/sync.ts --config path/to/tracked.yaml
```

`--dry-run` is the safe way to preview: it does the real GitHub reads and prints
every group/workspace/tab it *would* create, without contacting cmux.

A live run never auto-starts an agent: each new tab launches `claude` on its
worktree and pre-types the `/wayfinder …` prompt, leaving it **unsubmitted** so
you review each tab and press Enter yourself.

Workspace creation uses the v1 `cmux new-workspace` CLI (the only path that
honors title/cwd/description/group at creation); everything else goes over the
v2 `cmux rpc` socket.

`--prune` is the only path that ever closes anything (never the default). It
runs a normal additive sync first, then closes:
- **done/stale ticket tabs** — a managed `<n>`/`✓<n>` tab whose ticket is no
  longer open (closed, or dropped from the map). A ticket that is still open but
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
