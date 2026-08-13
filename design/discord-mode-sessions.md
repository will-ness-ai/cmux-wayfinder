# Discord mode — where a session runs, and what remembers it

The settled worktree policy and session store for Discord mode. It answers
ticket [#22](https://github.com/will-ness-ai/cmux-wayfinder/issues/22) on map
[#15](https://github.com/will-ness-ai/cmux-wayfinder/issues/15).

Read this before you write the checkout mechanism (ticket
[#24](https://github.com/will-ness-ai/cmux-wayfinder/issues/24)), before you
choose the process model (ticket
[#20](https://github.com/will-ness-ai/cmux-wayfinder/issues/20)), and before you
change how a ticket tab launches `claude`.

## The three rules

1. **The Discord thread is the identity of a session.** The session id is
   `uuidv5(WAYFINDER_NS, "discord-thread:" + thread_id)`. The bot computes the
   id. It does not have to remember it.
2. **The working directory is not the address of a session.** Claude Code finds
   a session by id from any directory. The directory says only where the tools
   operate. A session outlives its worktree.
3. **The session store is a cache.** It holds one piece of live state, the turn
   lease, and the lease is void when its process stops. Delete the file, and the
   bot builds it again from GitHub, Discord and the transcript files.

Rules 1 and 2 make the store small. A small store makes each failure cheap to
repair.

## The facts the rules stand on

Measured on Claude Code 2.1.229 on 2026-08-12. Research ticket
[#16](https://github.com/will-ness-ai/cmux-wayfinder/issues/16) must confirm
these and record them under `research/`.

| Fact | How it was measured |
| --- | --- |
| The caller chooses the session id: `claude -p --session-id <uuid> "…"`. | A headless turn with a chosen id started and answered. |
| Resume keeps the id. `claude -p --resume <uuid>` returns the same `session_id`. `--fork-session` is the only way to get a new id. | Two turns; the result envelope of the second held the id of the first. |
| **Resume ignores the working directory.** A session started in directory A and resumed from directory B answers from its history. The transcript stays in the project directory of A. Each turn records its own `cwd`. Directory B gets an empty project directory and no transcript. | Resumed from `/private/tmp` a session started in a different directory. It answered from history. No transcript appeared under the new key. |
| `--session-id` with an id that exists fails with `Session ID <uuid> is already in use.` `--resume` with an id that does not exist fails with `No conversation found with session ID: <uuid>`. | Both errors seen. Together they are a two-way probe for "does this session exist". |
| A transcript is `~/.claude/projects/<encoded-first-cwd>/<session-id>.jsonl`. A session that entered a worktree writes a `worktree-state` line with the worktree name, its path and its branch. | Read from this repo's own ticket sessions. It makes ticket → session recoverable by a scan. |
| `claude --worktree wayfinder/<map>/<ticket>` makes the directory `<checkout>/.claude/worktrees/wayfinder+<map>+<ticket>` and the branch `worktree-wayfinder+<map>+<ticket>`. It never removes them. | This repo still holds the worktrees of maps #1 and #2. |

## Worktree policy

- **One worktree for each ticket, as today.** The name stays
  `wayfinder/<map>/<ticket>`, so the path and the branch do not change.
- **The bot makes the worktree with `git worktree add`.** It does not use
  `claude --worktree`. The bot must know the path before it starts the process,
  because that path is the `cwd` of the turn. `claude --worktree` chooses the
  path itself, and reports it only in the transcript.
- **The worktree is made late — at the first turn on the ticket, not at
  charting.** Discord mode has no auto-launch. A map of 15 tickets must not make
  15 branches that nobody asked for. `git worktree add` takes under a second, so
  the first message pays a cost the human does not see.
- **A checkout uses the same directory.** The cmux tab command becomes
  `cd <worktree> && claude --resume <session-id>`. It replaces
  `claude --worktree <name>`. A checkout continues the conversation; it does not
  start one.
- **The bot never removes a worktree.** A worktree can hold work that is not
  committed. `sync --prune` removes tabs, workspaces and board files today, and
  no code. That limit stays.
- A repo with no `discord:` block keeps the launch command it has today. See
  [`design/discord-mode-config.md`](./discord-mode-config.md).

### Where a turn runs

| The ticket is | The worktree is | The turn runs in | Tools |
| --- | --- | --- | --- |
| open | there | the worktree | as ticket [#25](https://github.com/will-ness-ai/cmux-wayfinder/issues/25) decides |
| open | gone | the worktree, made again | as #25 decides |
| closed | there | the worktree | as #25 decides |
| closed | gone | the repo checkout from `tracked.yaml` | read-only |

A closed ticket whose branch was merged does not get its worktree back. The
decision is already made, and the work is already in the default branch. To read
the default branch is more correct than to make a new branch that copies merged
work. The bot says one line in the thread:

> the worktree for this ticket is gone; this turn runs in the main checkout.

A turn in the repo checkout must not write, because a human can be at work in
that directory. This is the one permission rule this design sets. Ticket
[#25](https://github.com/will-ness-ai/cmux-wayfinder/issues/25) sets all the
others.

A human who wants the old code says so in the thread. The agent then makes a
worktree at the merge commit. That is a request, not a policy.

## The session store

One file for each repo:

```
~/.cache/cmux-wayfinder/sessions/<owner>-<repo>.json
```

This is the cache root that already holds the lanes boards, so the tool keeps
one cache directory. One file for each repo keeps each write small, and lets
`--prune` delete the file of a repo that left `tracked.yaml`.

### Schema

```ts
interface SessionStore {
  version: 1;
  /** owner/name, as in tracked.yaml. */
  repo: string;
  /** Discord guild snowflake, cached from the config. */
  guild_id: string;
  /** map number → channel snowflake. */
  channels: Record<string, string>;
  /** ticket number → row. */
  tickets: Record<string, TicketRow>;
}

interface TicketRow {
  map: number;
  /** The ticket post, and the thread on it. */
  post_id: string;
  thread_id: string;
  /** Cache of uuidv5(WAYFINDER_NS, "discord-thread:" + thread_id). */
  session_id: string | null;
  session_started_at: string | null;
  /** Absolute directory of the last turn. */
  cwd: string | null;
  last_turn_at: string | null;
  /**
   * Newest message in the thread the bot has answered.
   * AMENDED by ticket #26: renamed `last_consumed_message_id`, and `lease` and
   * `muted` change with it. See design/discord-mode-turn-taking.md.
   */
  last_answered_message_id: string | null;
  driver: { kind: "bot" }
        | { kind: "checkout"; user: string; since: string };
  /** The turn that runs now. Null when no turn runs. */
  lease: { pid: number; started_at: string } | null;
}
```

```json
{
  "version": 1,
  "repo": "will-ness-ai/cmux-wayfinder",
  "guild_id": "987654321098765432",
  "channels": { "15": "1290000000000000000" },
  "tickets": {
    "22": {
      "map": 15,
      "post_id": "1291000000000000000",
      "thread_id": "1291000000000000000",
      "session_id": "8f14e45f-ceea-467a-9a3e-3b1d0c9f2a11",
      "session_started_at": "2026-08-12T21:04:11Z",
      "cwd": "/Users/willness/…/.claude/worktrees/wayfinder+15+22",
      "last_turn_at": "2026-08-12T21:41:02Z",
      "last_answered_message_id": "1292000000000000000",
      "driver": { "kind": "bot" },
      "lease": null
    }
  }
}
```

- `driver` records who holds the wheel. cmux is the truth: a ticket tab exists
  if, and only if, the ticket is checked out. Ticket
  [#24](https://github.com/will-ness-ai/cmux-wayfinder/issues/24) sets the
  handshake.
- `lease` stops two `claude` processes on one session. It is the only field that
  no other system holds.
- `session_id` is a cache of rule 1. It stays in the file to make the file easy
  for a human to read.
- `last_answered_message_id` is a cache. Discord holds the same fact: the newest
  message from the bot in that thread.

### What the store does not hold

| Fact | Owner |
| --- | --- |
| tickets, lanes, blockers, closure | GitHub |
| the conversation | Discord |
| what Claude remembers of it | the transcript |
| the code | git |
| who holds the wheel | cmux |
| the turn that runs now | the process, through the lease |

### Write discipline

One writer: the process that ticket
[#20](https://github.com/will-ness-ai/cmux-wayfinder/issues/20) settles. Write
the whole file to a temporary name, then rename it. Rows are tens, not
thousands, so there is no database and no lock file. A second process may read
the file. It must not write it.

## Lifecycle of a row

1. **Charted.** The reconcile pass makes the ticket post. It writes a row with
   `post_id`, `thread_id` and `map`, and no session.
2. **Live.** A human sends the first message. The bot makes the worktree,
   computes the session id, and runs `claude -p --session-id <id>`. It writes
   `session_id`, `cwd` and `session_started_at`.
3. **Idle.** No turn runs. The row keeps `last_turn_at`.
4. **Checked out.** A human takes the ticket in cmux. `driver` changes. The bot
   answers no message until handback.
5. **Resolved.** The ticket closes. The row does not change. Messages and turns
   continue, because the conversation outlives the ticket.
6. **Retired.** The map closes, or the ticket leaves the map, or the repo leaves
   `tracked.yaml`. The bot drops the row. It archives the channel and keeps the
   thread, because the conversation is the asset.

To drop a row is always safe. The next pass makes the row again from GitHub and
Discord.

## Recovery

| What went stale | How the bot finds it | What the bot does |
| --- | --- | --- |
| Store file is gone or damaged | The file does not parse | Move it to `.bad`. Read the maps and tickets from GitHub, and the channels, posts and threads from Discord. Compute each session id from its thread id, and probe it. Write a new file. |
| Transcript is gone (retention, or a human removed it) | `--resume` says `No conversation found` | Start a session again with the same id. Say in the thread: *"I have lost the earlier context. I have read the ticket again."* The first prompt must carry the ticket and the recent thread — ticket [#26](https://github.com/will-ness-ai/cmux-wayfinder/issues/26) owns that prompt. |
| Store says "no session", but one exists | `--session-id` says `already in use` | Use `--resume` for this turn. Write the row. |
| Store says "session", but none exists | `--resume` says `No conversation found` | Start a session with `--session-id`. Write the row. |
| Worktree is gone, ticket open | The directory does not exist | Make the worktree again at the same path. Use the branch if it exists; if not, branch from the default branch. Say one line in the thread. |
| Worktree is gone, ticket closed | The directory does not exist | Run the turn in the repo checkout, with read-only tools. Say one line in the thread. |
| Branch is merged, worktree is there | `git` reports it | Do nothing. Never pull, and never reset a directory a human can be in. |
| Repo checkout moved | `path:` in `tracked.yaml` changed | Sessions still resume, because resume ignores the directory. Compute the worktree path from the new checkout. Leave the old directory alone. The transcripts stay filed under the old path, which has no effect on resume. |
| Thread is gone | Discord returns 404 | The conversation is gone, so the session goes with it. The reconcile pass makes a new post and a new thread. The new thread id gives a new session id, so Claude starts with no memory the humans cannot see. The old transcript stays on disk until Claude Code retention removes it. |
| Ticket post is gone | Discord returns 404 | The same as "thread is gone". Ticket [#27](https://github.com/will-ness-ai/cmux-wayfinder/issues/27) owns what the bot makes again. |
| Ticket left the map, or was deleted | GitHub no longer lists it as a sub-issue | Drop the row. Archive the post. Never delete it. |
| Lease is set, but the process stopped | The pid is not alive | Clear the lease at start-up. Say in the thread: *"my last turn did not finish."* The next message resumes the session. |
| A message arrives while a turn runs | The lease is held | Do not start a second process on one session. Queue the message. Ticket [#26](https://github.com/will-ness-ai/cmux-wayfinder/issues/26) owns the queue rules. |
| Checked out, but the cmux tab is gone | The tab is not in the cmux tree | cmux is the truth, so the ticket is not checked out. Set `driver` to `bot`. Ticket [#24](https://github.com/will-ness-ai/cmux-wayfinder/issues/24) sets the delay before this happens. |
| Repo left `tracked.yaml` | The config no longer lists it | `--prune` deletes `sessions/<owner>-<repo>.json`, as it deletes board files today. |

## What this settles for other tickets

- **Checkout and handback ([#24](https://github.com/will-ness-ai/cmux-wayfinder/issues/24)):**
  a checkout is `cd <worktree> && claude --resume <session-id>` in a cmux tab.
  The bot and the human use one directory and one session, so a handback loses
  nothing. `claude --worktree` leaves the design.
- **CLI surface and process model ([#20](https://github.com/will-ness-ai/cmux-wayfinder/issues/20)):**
  one process writes the store. The store sits beside the lanes boards under
  `~/.cache/cmux-wayfinder/`.
- **Permissions in headless ([#25](https://github.com/will-ness-ai/cmux-wayfinder/issues/25)):**
  a turn that falls back to the repo checkout is read-only. #25 sets every other
  permission.
- **Server reconciliation ([#27](https://github.com/will-ness-ai/cmux-wayfinder/issues/27)):**
  the reconcile pass writes the rows. A post the bot makes again starts a new
  conversation, and a new session with it.
- **Turn-taking ([#26](https://github.com/will-ness-ai/cmux-wayfinder/issues/26)):**
  the first prompt of a session must also work as the prompt that primes a
  session that lost its transcript. **Settled** in
  [`design/discord-mode-turn-taking.md`](./discord-mode-turn-taking.md), which
  also amends the store schema above.
- **`CONTEXT.md`, at map close:** add **session store**, **turn lease**, and
  **session id** (derived from the thread id).

## What this does not settle

- How many turns may run at one time. That is the cost and rate item in **Not
  yet specified** on the map.
- What happens to a queued message when the Mac sleeps. That is the failure and
  recovery item in **Not yet specified**.
- Whether `--prune` should report worktrees that are safe to remove. Not needed
  now.
