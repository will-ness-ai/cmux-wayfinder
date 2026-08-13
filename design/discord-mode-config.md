# Discord mode — the config block and the bot token

The settled configuration design for Discord mode. It answers ticket
[#21](https://github.com/will-ness-ai/cmux-wayfinder/issues/21) on map
[#15](https://github.com/will-ness-ai/cmux-wayfinder/issues/15).

Read this before you change `tracked.yaml` parsing, before you write the Discord
spec, and before you teach an agent to register a repo (ticket
[#23](https://github.com/will-ness-ai/cmux-wayfinder/issues/23)).

## The one rule

**The tool makes again what it owns. The tool never makes again what the human
declared.**

Every failure rule below comes from this sentence. A resource the human named in
`tracked.yaml` is a promise: if it is gone, the tool stops and tells the human. A
resource the tool made for itself is disposable: if it is gone, the tool makes it
again.

## Schema

```ts
interface DiscordBinding {
  /** Discord guild (server) ID. Snowflake, quoted. Required. */
  guild: string;
  /** Category to adopt. Snowflake, quoted. Absent → the tool makes and owns one. */
  category?: string;
  /** Default true. False behaves exactly as an absent block. */
  enabled?: boolean;
}

interface TrackedRepo {
  repo: string;
  path: string;
  /** Absent → sync-only: today's behaviour, unchanged. */
  discord?: DiscordBinding;
}
```

Three fields, all lowercase single words, like the `repo` and `path` keys beside
them. No separator convention is necessary.

The bot token is not a field. It lives in the environment — see
[The token](#the-token).

## Worked example

```yaml
repos:
  # Sync-only. No `discord:` block → exactly today's behaviour.
  - repo: acme/example
    path: ~/code/example

  # Discord mode. The tool makes a category in guild 9876…, and owns it.
  - repo: will-ness-ai/cmux-wayfinder
    path: ~/Documents/Projects/PERSONAL/cmux-wayfinder
    discord:
      guild: "987654321098765432"

  # Discord mode, in a category the human made. The tool adopts it.
  - repo: acme/homebase
    path: ~/code/homebase
    discord:
      guild: "987654321098765432"
      category: "112233445566778899"
      enabled: true
```

Both repos above share one guild. That is allowed: a guild holds many
categories, and a category is one repo.

## The fields

### `guild` — required

The Discord server that holds this repo's category. The tool cannot make a
server, so the human must always supply this one ID.

The key is `guild`, not `server`, because every API doc and every error the
human will read during a failure says *guild*. The Discord UI says *Server*, so
the doc and the tool's error messages must both name the UI action: right-click
the server, then **Copy Server ID**.

**Always quote a snowflake.** An unquoted snowflake is a YAML number, and a JS
number cannot hold 64 bits. The parser this repo already uses turns
`987654321098765432` into `987654321098765400` — a silent change of four digits,
and a wrong guild ID with no error. So the loader must reject a number and name
the fix: *quote it*.

### `category` — optional

A category the human already made, for the tool to adopt. Absent is the normal
case: the tool makes a category for the repo and owns it.

The field exists for one real case — a human who keeps a server with a layout
they care about, and wants this repo in a known place in it. That case costs one
optional field, so it is cheap to serve.

Adoption changes the failure behaviour, and this is the point of the field. An
adopted category is a human promise, so a missing one stops the repo. An owned
category is the tool's own, so a missing one is made again without a word. See
[Failures](#failures).

The config never names a **channel**. A channel is one open map, and maps open
and close continuously, so a human-written channel ID would go stale on its own.
The tool owns every channel.

### `enabled` — optional, default true

`enabled: false` turns Discord mode off for the repo, and keeps the IDs in the
file. It behaves exactly as an absent block: the repo returns to sync-only.

It earns its place because the IDs are expensive to find again. A human who wants
to pause Discord mode for an afternoon must not have to hunt through the Discord
UI to start it again.

## What the block means

The presence of an enabled `discord:` block is the opt-in switch, and it has two
effects:

1. The bot mirrors the repo's maps into Discord.
2. Sync stops opening ticket tabs for the repo. Sessions start from Discord, not
   from a lane. The map tab and the lanes tab stay.

Effect 2 follows from the map's shape: under Discord mode there is no
auto-launch. Ticket [#20](https://github.com/will-ness-ai/cmux-wayfinder/issues/20)
settles the process model that carries it out.

A repo with no block, or a disabled one, keeps today's behaviour exactly. There
is no half-opt-in state.

## The token

The token lives in the environment, as `DISCORD_BOT_TOKEN`. The human writes it
into a `.env` file at the tool's checkout root, which `.gitignore` already
covers. Bun reads `.env` on its own, so nothing else is necessary. Ticket
[#19](https://github.com/will-ness-ai/cmux-wayfinder/issues/19) puts it there.

Three rules keep it out of git and out of sight:

- **A `token:` key inside a `discord:` block is a hard error.** The loader must
  refuse the file and tell the human to move the value to `.env`. A config file
  travels: a human copies it, pastes it into a chat, or shares a screen. A loud
  refusal at the moment of the mistake is worth more than a `.gitignore` entry.
- **The tool never prints the token.** Logs and error messages redact it.
- **The tool never writes `tracked.yaml`.** The file is the human's, and their
  editor and their git own it. Resolved IDs go to the tool's own state file —
  see [What other tickets take from here](#what-other-tickets-take-from-here).

### One bot, not one per repo

One Discord application, one bot user, one token, for every repo on the machine.

- The bot runs on one Mac beside cmux. One bot is one gateway connection and one
  process. Per-repo bots multiply connections, tokens and presences, and buy
  nothing.
- One bot joins many guilds, so repos in different servers still work.
- Privileged intents stay free of review below 10,000 reachable users. A private
  personal server is far below that line, and one bot never approaches it.
- Discord rate limits are per token. A per-repo token would raise the budget, but
  the traffic here is a few posts per pass. The budget is not the constraint.

One case would justify a second token: a repo whose guild belongs to somebody
else, who will not invite your personal bot. Serve it later with an optional
`bot:` field that names a second environment variable. The file stays compatible,
so nothing is lost by leaving it out today.

## Validation

The loader checks these at load time, on every pass, because `--watch` re-reads
the file each pass.

| Rule | On failure |
| --- | --- |
| `guild` is present, and is a string of 17–20 digits | Error. A YAML number names the fix: quote it |
| `category`, if present, matches the same format | Error, same message |
| `enabled`, if present, is a boolean | Error |
| Every key inside `discord:` is known | Error, with the nearest known key. A typo such as `guild_id:` would otherwise turn Discord mode off in silence |
| No two repos name the same `category` | Error. A category is one repo |
| No `token:` key | Error. Move it to `.env` |

Strictness applies **inside the `discord:` block only**. The rest of the file
stays as permissive as it is today, so every existing `tracked.yaml` keeps
working.

## Failures

A bad Discord binding stops that repo's Discord work, and nothing else. The cmux
sync for the repo continues, and the other repos are untouched. One misconfigured
repo must never stop the loop.

| Condition | Behaviour |
| --- | --- |
| Token missing, and one or more repos are enabled | The bot does not start. Sync continues. One clear error |
| The bot is not a member of `guild` | Skip Discord for the repo. Print the invite URL |
| Adopted `category` not found | Error for the repo. **No new category.** Tell the human to fix the ID, or to delete the line and let the tool own one |
| Adopted `category` is not a category | Error for the repo. The human pasted a channel ID |
| Adopted `category` is in a different guild | Error for the repo |
| Owned category deleted | The tool makes it again, and records the new ID |
| The category holds 50 channels | Error naming the Discord limit. The tool must not try to exceed it |
| A human renames the guild, a category or a channel | Nothing. IDs are the identity; names are labels |
| A human deletes a map channel | The reconciler makes it again (ticket [#27](https://github.com/will-ness-ai/cmux-wayfinder/issues/27)) |
| The same error repeats every pass | Print it once per change, not once per pass |

Discord's limits are 500 channels per guild, 50 channels per category, and 50
categories per guild. One open map is one channel, so the open maps of a repo
will not reach 50. The **archive** is where 50 bites, because closed maps
accumulate there forever. Ticket #27 owns that overflow.

## Extension points

Later tickets add fields here. Each follows the same shape, so the file stays
compatible:

- **Archive location** — if ticket #27 needs the archive category to be
  configurable, it adds `archive:` with the same adopt-or-own rule as `category`.
- **Ping targets** — the *Notification and ping policy* fog patch adds fields for
  who to ping.
- **A second bot** — an optional `bot:` field naming a second environment
  variable, if the shared-guild case arrives.

A machine-wide top-level `discord:` block is not necessary. The only machine-wide
value is the token, and the token lives in the environment.

## What other tickets take from here

- **Ticket [#22](https://github.com/will-ness-ai/cmux-wayfinder/issues/22)** — the
  state store holds every resolved ID, because `tracked.yaml` holds none of them:
  repo → category ID, map → channel ID, ticket → post ID and thread ID.
- **Ticket #20** — an enabled block turns auto-launch off for the repo. When the
  bot cannot run, the repo stays inert; it does **not** fall back to auto-launch.
  Starting agents the human did not ask for is the surprising failure; doing
  nothing is the safe one.
- **Ticket #23** — the global skill teaches this block, and teaches the quoting
  rule with it.
- **`CONTEXT.md`** — this ticket introduces two terms for the glossary:
  **guild** (a Discord server; the API name, used in the config and in errors)
  and **sync-only** (a repo with no enabled `discord:` block, which keeps today's
  auto-launch behaviour).
