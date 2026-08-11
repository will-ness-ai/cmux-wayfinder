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
  network calls**, so it renders for private repos too. Rows carry
  **waiting-on chips** (red = open blocker, grey-struck = closed one); hovering
  a row dims the board and lights what it waits on amber and what it unblocks
  blue, and clicking a chip jumps to that blocker's row. Clicking a **row**
  opens the ticket's body as rendered markdown in a modal (meta chips + an
  "Open on GitHub ↗" link; scrim click or Escape closes it) — the self-reload
  pauses while it is open, so a refresh never interrupts your reading
- one **tab** per open+unblocked sub-issue (title `[XY]<ticket#>`): launches
  `claude --worktree wayfinder/<map#>/<ticket#>`, waits for the TUI, then types
  `/wayfinder map #<map#> work on ticket #<ticket#>` into the input box and
  **submits it** — each new tab lands already working its ticket.
  A **child map** (a sub-issue that is itself a `wayfinder:map`) is the one
  exception: it shows on the parent's board badged 🗺️, in the In progress lane,
  but never gets a tab — it already has its own workspace

Tab titles are `[XY]<ticket#>`:

- **X** — ticket type, from the `wayfinder:<type>` label: 🗣️ grilling, 🔨 task,
  🔎 research, 🧪 prototype (unlabeled counts as a task)
- **Y** — whose turn it is: 🫵 ready-for-human, 🤖 ready-for-agent. The ticket's
  `ready-for-human` / `ready-for-agent` labels are the source of truth (flip the
  label to flip the tab; human wins if both are present); a ticket with neither
  defaults HITL → 🫵. ✓ takes the slot once the ticket closes. Legacy
  `<n>`/`✓<n>` tabs upgrade to the bracketed form on the next run.

Sync is additive + rename-only by default (closed tickets → `[X✓]<n>` tabs); nothing is closed or deleted without `--prune`.

### The settle window

A ticket must be **2 minutes old** before sync opens a tab on it — and so before
it launches an agent.

A map is charted in a burst: the tickets are created, then linked to the map,
then wired with their `blocked_by` edges, over roughly a minute. A read that
lands between the linking and the wiring sees every ticket open with no blockers
— a frontier of the whole map — and without the window sync boots an agent on
each one, including tickets that are blocked seconds later. The window waits the
burst out. A settling ticket is reported each pass (`⏳ … takeable in 97s`) and
still shows in its board lane; only the tab waits.

The window measures a ticket's age from **creation**, so it costs nothing in
normal use: a ticket that reaches the frontier later, when its blocker closes,
is long settled and gets its tab on the very next pass. In `--watch` mode the
loop also wakes when a settling ticket comes due instead of at the following
tick — unless the rate governor is pacing that sleep against the API budget,
which always wins.

Two minutes is roughly twice the charting burst measured on a nine-ticket map.
A burst grows with the number of tickets, so a much larger map could still
outlast the window: it shortens the odds rather than abolishing them.

## Usage

```sh
bun install
cp tracked.example.yaml tracked.yaml   # then edit for your repos + local paths
bun src/sync.ts --dry-run     # print the plan, touch nothing
bun src/sync.ts               # materialize into live cmux (additive + rename-only)
bun src/sync.ts --prune       # also close stale tabs / dead-map workspaces + delete their boards
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
token), and two guards keep the loop inside it:

- **Probe-then-read.** Each pass spends one call per repo on the repo's newest
  issue `updated_at`; only a change triggers the full read (~2 GETs per repo +
  1 per open map + 1 per sub-issue — the per-ticket term dominates once a map
  fills up). A full re-read is forced every 5 minutes anyway, because some
  edits (a cross-repo blocker closing) may not move any `updated_at` the probe
  can see. The cmux reconcile is local and runs every pass either way, so a
  closed tab still heals at watch cadence.
- **Budget governor.** After each pass the loop reads `gh api rate_limit` (a
  free endpoint) and stretches the sleep so the measured pass cost spends at
  most half of the *remaining* window budget — it slows down before the limit
  instead of hitting it, whatever else the token is doing. A failed pass still
  sleeps until the window resets if the budget is already exhausted.

A live run **does start agents**: each new tab launches `claude` on its worktree,
waits for the TUI, types the `/wayfinder …` prompt and submits it. Only *new*
tabs — an existing ticket tab is never re-prompted — so a run is safe to repeat,
but `--dry-run` first if you want to see how many agents it will kick off.

Workspace creation uses the v1 `cmux new-workspace` CLI (the only path that
honors title/cwd/description/group at creation); everything else goes over the
v2 `cmux rpc` socket.

`--prune` is the only path that ever closes or deletes anything (never the
default). It runs a normal additive sync first, then closes:
- **done/stale ticket tabs** — a managed `[XY]<n>` (or legacy `<n>`/`✓<n>`) tab
  whose ticket is no longer open (closed, or dropped from the map). A ticket
  that is still open but
  merely fell off the frontier (re-blocked) keeps its tab, so a live session is
  never yanked out from under you.
- **child-map tabs** — a leftover tab on a child map, which sync no longer
  creates. The additive path only warns about one (it may hold a live session);
  `--prune` closes it.
- **dead/untracked map workspaces** — a wayfinder workspace whose map has closed
  or whose repo left `tracked.yaml`.
- **stray group anchors** — the empty workspace `workspace.group.create` leaves
  behind (identified by `group.anchor_workspace_id`); emptying a group then
  auto-removes it.

It then deletes the **stale lanes-board files**: every `.html` under
`~/.cache/cmux-wayfinder/` that no open, tracked map backs — the boards of maps
that closed and of repos that left `tracked.yaml`. A live map's board is never
touched, and nothing else sharing that directory is a candidate.

Pair it with `--dry-run` first (`bun src/sync.ts --prune --dry-run`) to see
exactly what would close and what would be deleted. Because `--prune` can close
the workspace you're sitting in, it may move your cmux selection — expected
under prune only.

Known v1 limitations:
- `cmux rpc workspace.group.create` leaves a stray empty anchor workspace in
  each new group — harmless, cleaned up by `--prune`.
- The map browser tab shows "Page not found" for a **private** repo until the
  cmux webview is logged into GitHub (the tab points at the right URL either way).

## Planning

Work is tracked as wayfinder issues in this repo: see the issue labeled `wayfinder:map`.

## License

MIT — see [LICENSE](./LICENSE). `cmux` itself is GPL-3.0-or-later, but this repo only subprocess-invokes the `cmux`/`gh` CLIs (never links or bundles them), so the MIT license here stays clean.
