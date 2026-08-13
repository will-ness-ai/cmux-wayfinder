---
name: cmux-wayfinder-tracking
description: Edit cmux-wayfinder's tracked.yaml — register a repo so its wayfinder maps sync into cmux, deregister one, or turn Discord mode on or off for a repo.
---

# cmux-wayfinder-tracking

`tracked.yaml` is the list of repos that
[cmux-wayfinder](https://github.com/will-ness-ai/cmux-wayfinder) syncs into cmux.
This skill adds a repo to that list, removes one, and sets a repo's Discord mode.

The canonical copy of this file is `skills/cmux-wayfinder-tracking/SKILL.md` in
the cmux-wayfinder checkout. Edit it there.

## Find the file first

Every branch starts here. `tracked.yaml` sits at the root of the cmux-wayfinder
checkout, and it is gitignored — it holds local paths, so it never goes to
GitHub.

```sh
readlink ~/.bun/install/global/node_modules/cmux-wayfinder
```

`bun link` makes that symlink, and it prints the checkout root. If it prints
nothing, run `type cmux-sync` and read the checkout out of the command it names.
If both are empty, ask the human for the checkout path.

`tracked.yaml` is then `<checkout>/tracked.yaml`. If that file is absent, copy
`<checkout>/tracked.example.yaml` to it.

## The entry

One entry per repo, under the top-level `repos:` list. `repo` is the key: one
repo has one entry.

```yaml
repos:
  - repo: acme/example
    path: ~/code/example
```

- **`repo`** — `owner/name` on GitHub. Read it with
  `gh repo view --json nameWithOwner -q .nameWithOwner`. A rename is resolved to
  the canonical name at sync time, so an old name keeps working.
- **`path`** — the local checkout a map's workspace opens in. Write it with a
  leading `~`; the loader expands it.

### `path` is the main checkout

An agent often runs inside a worktree, where `git rev-parse --show-toplevel`
returns the worktree. This command returns the main checkout from both places:

```sh
dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
```

Give the main checkout. cmux-wayfinder makes its own worktree under this path
for each ticket it starts, so a worktree path here nests worktrees in a worktree.

## Register a repo

1. Find `tracked.yaml`.
2. Read it. If the repo is already listed, edit that entry.
3. Append the entry, with `repo` and `path`.
4. Add a `discord:` block if the human asks for Discord mode (next section).
5. Verify from the checkout: `bun src/sync.ts --dry-run`. It parses the file,
   reads GitHub, and prints every group, workspace and tab it would make. It
   never contacts cmux.

A running `cmux-sync --watch` re-reads `tracked.yaml` each pass, so the repo
appears on the next tick. There is nothing to restart.

## Discord mode

A `discord:` block turns Discord mode on for one repo. An absent block, or
`enabled: false`, keeps the repo **sync-only**: today's behaviour, unchanged.

```yaml
  - repo: acme/example
    path: ~/code/example
    discord:
      guild: "987654321098765432"      # required
      category: "112233445566778899"   # optional — a category to adopt
      enabled: true                    # optional, default true
```

- **Quote every ID.** An unquoted snowflake is a YAML number, and the parser
  silently changes its last digits. The result is a wrong guild and no error.
- **`guild`** — only the human can supply it: right-click the server in Discord,
  then **Copy Server ID**. The Discord UI says *Server*; the config says *guild*,
  because the API and every error message say *guild*.
- **`category`** — omit it, and the tool makes a category and owns it. Name one,
  and the tool adopts it. A category is one repo, so two repos never name the
  same one.
- **`enabled: false`** pauses Discord mode and keeps the IDs, which cost the
  human a hunt through the Discord UI to find again.
- **The token is not a field.** It lives in `DISCORD_BOT_TOKEN`, in
  `<checkout>/.env`. A `token:` key inside `discord:` is a hard error.
- An enabled block stops sync from opening ticket tabs for the repo. Sessions
  start from Discord instead. The map tab and the lanes tab stay.

The full design, and every failure rule, is
`<checkout>/design/discord-mode-config.md`. Read it before you add a field this
section does not name.

## Deregister a repo

Removing an entry destroys nothing. Sync is additive: the next pass ignores the
repo, and its workspaces, tabs and live agent sessions stay exactly as they are.
The lanes board stops refreshing, so a lanes tab goes stale.

1. Find `tracked.yaml`.
2. Comment the entry out, or delete it. A comment keeps the path and the Discord
   IDs for later.
3. Stop here to keep a live workspace. This is the safe end state.

Cleanup is a separate act, and it destroys. `--prune` closes every workspace the
repo left behind and deletes its lanes-board files, which kills any agent session
in those tabs.

- Prune is machine-wide, not per repo. The same run also closes the workspaces of
  maps that have closed in the repos that stay.
- Prune can close the workspace the human sits in, and move the cmux selection.

So run `bun src/sync.ts --prune --dry-run` first, show the human the list it
prints, and run the real `--prune` only after they agree and no session is live.
