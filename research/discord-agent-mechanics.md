# Research: Discord mechanics for agent conversations

Findings for **Research: Discord mechanics for agent conversations** on the **discord mode** map. Read against Discord's developer documentation on 2026-08-12, plus the source of ~16 real LLM Discord bots.

The question: how does a bot own a Discord server completely, and how does it carry an agent conversation inside a thread without fighting the platform?

**Two conventions in this document.**

1. **Discord moved its developer docs.** `discord.com/developers/docs/...` now gives a 301 to `docs.discord.com/developers/...`. All primary links below use the new host. Append `.md` to any of those URLs to read the page as raw Markdown.
2. **Sources are labelled.** A claim is **primary** when it comes from `docs.discord.com`, the Discord Developer Change Log, the discord.js guide, or the discord.py docs. A claim is **community-sourced** when it comes from a GitHub issue, a bot's source code, a support forum, or the press. Community numbers are not platform guarantees. Every one of them is labelled at the point of use.

---

## Read this against the channels correction

This research was done on the assumption that the bot speaks to Discord's HTTP and gateway API itself. The map's correction opens a second path: Claude Code ships **channels**, and Anthropic ships an official Discord channel plugin that already carries attachments both ways, auto-chunks long replies, and exposes `edit_message` and `reply_to`.

The findings hold either way. Their **weight** shifts.

| Sections | Under a hand-built client | If the official plugin carries the conversation |
| --- | --- | --- |
| [1](#1-owning-the-guild), [2](#2-channels-and-categories), [3](#3-the-ticket-post-and-its-thread) — owning the guild, the channel tree, the ticket post | build spec | **unchanged — still a build spec.** No chat plugin creates a category per repo, a channel per map, a ticket post per ticket, or archives a closed map. That work is the bot's either way. |
| [4](#4-carrying-a-turn-into-a-thread), [5](#5-buttons-and-the-interaction-lifecycle), [6](#6-attachments) — carrying a turn, buttons, attachments | build spec | **audit checklist.** Check the plugin against 4.4 (chunking), 4.5 (code fences), 4.6 (tables), 4.7 (`allowed_mentions`) and 6 (CDN expiry, size caps) rather than building them. Where it falls short, these sections say what "correct" looks like. |
| [7](#7-a-bot-on-a-laptop-that-sleeps) — gateway, sleep, recovery | build spec | applies to **whichever process holds the websocket**. If that is the plugin, these are the questions to put to it. |

**Stand up the plugin and see** — [Task: stand up the official Discord channel plugin and see if channels work here](https://github.com/will-ness-ai/cmux-wayfinder/issues/38) produces the run-and-observed evidence that decides which column applies.

---

## Headline findings

The twelve facts that change the design. Each links to the section that proves it.

| # | Finding | Section |
| --- | --- | --- |
| 1 | A bot can no longer create a Discord server. The endpoint was removed in July 2025. A human must create the guild and invite the bot. | [1.1](#11-the-bot-cannot-create-the-server) |
| 2 | The ticket post's message id **is** its thread id. One snowflake identifies both the ledger row and the conversation. | [3.1](#31-one-snowflake-two-objects) |
| 3 | Renaming a channel is the scarcest operation in the design — roughly 2 per 10 minutes, per channel, and undocumented. | [2.3](#23-renaming-is-the-scarcest-operation) |
| 4 | Error `30046` caps how often you may edit a message older than one hour. The ticket post is edited for days. The rate is unpublished. | [3.5](#35-editing-the-ticket-post-error-30046) |
| 5 | Discord has no channel archive. Archiving a closed map's channel is a permission overwrite. | [2.4](#24-archiving-a-closed-map) |
| 6 | An edit fires no notification and moves nothing. An edited ledger is a dashboard, not a feed. | [3.6](#36-an-edited-ledger-is-a-dashboard-not-a-feed) |
| 7 | Stream a turn as **edit-in-place inside a chunk, new message across chunks**, on a 1.0–1.5 s timer. The 2000-character cap makes pure edit-in-place impossible. | [4.4](#44-streaming-the-recommendation) |
| 8 | Discord has **no table syntax**. Agents emit GFM tables constantly. A rewrite step is mandatory. | [4.6](#46-markdown-there-are-no-tables) |
| 9 | A button press is a doorbell, not a request. ACK in 3 seconds, then discard the token. A 5-minute turn cannot report through it. | [5.2](#52-three-seconds-then-fifteen-minutes) |
| 10 | The gateway does not backfill messages missed while the bot was down. You must build REST catch-up on `last_seen_message_id`. | [7.3](#73-missed-messages-rest-catch-up) |
| 11 | `MESSAGE_CONTENT` is privileged and unavoidable. It gates `attachments` as well as `content`. A thread the bot created earns no exemption. | [1.3](#13-gateway-intents) |
| 12 | Omitting `allowed_mentions` on a plain channel message parses `@everyone`. It is also dropped on edit. | [4.7](#47-mentions-and-link-unfurling) |

---

## 1. Owning the guild

### 1.1 The bot cannot create the server

The `Create Guild` endpoint (`POST /guilds`) is gone for applications.

> "To address security concerns, we are deprecating the ability for applications to create guilds using the `Create Guild` endpoint."
> - "The Create Guild endpoint (`POST /guilds`) will be restricted for applications starting July 15, 2025"
> - "Existing Guilds owned by bots will have their ownership transferred to a real user"
> - "After the deprecation date, the endpoint will no longer be available"

— [Change Log, "Deprecating Guild Creation by Apps", 2025-04-15](https://docs.discord.com/developers/change-log#deprecating-guild-creation-by-apps)

> "Apps can no longer create guilds. The documentation for these endpoints has been removed and the endpoints have been removed from the OpenAPI specification."

— [Change Log, "Guild Create Deprecation", 2025-07-28](https://docs.discord.com/developers/change-log)

Verified against the live docs source: `developers/resources/guild.mdx` has no `## Create Guild` heading and no `POST /guilds` route. The old "only usable by bots in less than 10 guilds" rule described an endpoint that no longer exists. It is obsolete.

**Consequence.** The human creates the server by hand. The bot owns the server's *contents*, not the server itself. Setup is a two-step wizard.

### 1.2 Invite URL and permission set

| Item | Fact | Source |
| --- | --- | --- |
| Application vs bot user | The application is the container. The bot user is part of it, configured on the **Bot** page of the Developer Portal. | [OAuth2](https://docs.discord.com/developers/topics/oauth2) |
| Bot token | Read from the Developer Portal, **Bot** page. Sent as `Authorization: Bot <token>`. | [Authentication](https://docs.discord.com/developers/reference#authentication) |
| Invite URL | `https://discord.com/oauth2/authorize?client_id=<id>&scope=bot%20applications.commands&permissions=<int>` | [OAuth2](https://docs.discord.com/developers/topics/oauth2) |
| `bot` scope | Required to add the app as a bot to a guild. | [OAuth2](https://docs.discord.com/developers/topics/oauth2) |
| `applications.commands` scope | Lets the app register slash commands. | [discord.js guide](https://discordjs.guide/legacy/preparations/adding-your-app) |
| `guild_id`, `disable_guild_select` | Preselect and lock the target guild in the authorization dialog. | [OAuth2](https://docs.discord.com/developers/topics/oauth2) |
| Who can add the bot | A human with the correct guild permission authorizes the URL. If **Public Bot** is off in the portal, only the app owner can add it. | [OAuth2](https://docs.discord.com/developers/topics/oauth2) |

Turn **Public Bot** off. A local, personal bot must not be installable by strangers.

Permission bits this design needs. Values from [Permissions](https://docs.discord.com/developers/topics/permissions).

| Permission | Bit | Decimal | Purpose here |
| --- | --- | --- | --- |
| MANAGE_CHANNELS | `1 << 4` | 16 | Create, edit and move channels and categories |
| ADD_REACTIONS | `1 << 6` | 64 | React |
| VIEW_CHANNEL | `1 << 10` | 1024 | See the channel |
| SEND_MESSAGES | `1 << 11` | 2048 | Post ticket posts |
| MANAGE_MESSAGES | `1 << 13` | 8192 | Pin, and delete other users' messages |
| EMBED_LINKS | `1 << 14` | 16384 | Auto-embed links |
| ATTACH_FILES | `1 << 15` | 32768 | Upload files |
| READ_MESSAGE_HISTORY | `1 << 16` | 65536 | Read back existing ticket posts on restart |
| MANAGE_ROLES | `1 << 28` | 268435456 | Edit channel permission overwrites |
| MANAGE_THREADS | `1 << 34` | 17179869184 | Archive and unlock threads |
| CREATE_PUBLIC_THREADS | `1 << 35` | 34359738368 | Start a thread on a ticket post |
| CREATE_PRIVATE_THREADS | `1 << 36` | 68719476736 | Start a private thread |
| SEND_MESSAGES_IN_THREADS | `1 << 38` | 274877906944 | Post inside a thread |

Sum = **395405552720**. That is the `permissions=` value for the invite URL.

`SEND_MESSAGES` "has no effect in threads" — `SEND_MESSAGES_IN_THREADS` governs thread posting ([Threads](https://docs.discord.com/developers/topics/threads)). ADMINISTRATOR is deliberately absent: it bypasses every channel overwrite, so a bot that holds it cannot be constrained by the read-only recipe in [2.4](#24-archiving-a-closed-map).

### 1.3 Gateway intents

Intents are bitwise values in the `intents` field of the Identify payload. Source: [Gateway — Intents](https://docs.discord.com/developers/events/gateway#gateway-intents).

Exactly three are privileged: **GUILD_MEMBERS** (`1 << 1`), **GUILD_PRESENCES** (`1 << 8`), **MESSAGE_CONTENT** (`1 << 15`). The rest are on request. The ones this design needs: `GUILDS` (`1 << 0`), `GUILD_MESSAGES` (`1 << 9`), `MESSAGE_CONTENT`.

Enable a privileged intent in the Developer Portal: your app → **Bot** page → **Privileged Gateway Intents** → toggle on.

**The review threshold changed on 2026-06-10.**

> "Previously, apps in fewer than 100 servers could access Privileged Intents by toggling them on in the Developer Portal, and apps in 100+ servers needed to apply for access.
>
> Starting today, the threshold is based on the number of users your app can access across all the servers it belongs to. If your app has fewer than 10,000 users, you can continue accessing Privileged Intents by toggling them on in the Developer Portal. **Once your app reaches 10,000 users, you'll need to apply for Privileged Intent access**."

— [Change Log, "Changes to Privileged Intent Access for Discord Apps", 2026-06-10](https://docs.discord.com/developers/change-log)

The same entry adds: apps reapply once a year, apps may keep growing during review, and App Verification is now separate from Privileged Intent review. A single private guild with a handful of humans stays far below 10,000 users. The intent is a portal toggle. No review, no verification.

**What the bot reads without MESSAGE_CONTENT.** The app receives "empty values in fields that contain user-inputted content" — `content`, **`attachments`**, `embeds`, `components`, poll data. Attachments are not a separate question from text; one intent gates both. The documented exceptions:

1. "Messages your app sends"
2. "Direct Messages sent to your app"
3. "Messages that @mention your app"
4. "Replies to your app's messages" — Discord's reply feature on a normal bot message, **not** a slash command response
5. The message targeted by a message context menu command

— [You Might Not Need a Privileged Intent](https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent), [Gateway — Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent)

**Threads are absent from that list.** A thread the bot created carries no special right. A human types prose into a ticket thread, and it arrives with an empty `content` field unless one of the five exceptions covers that individual message. discord.py states the same effect ([A Primer to Gateway Intents](https://discordpy.readthedocs.io/en/stable/intents.html)).

Exception 4 is the one loophole worth knowing: the ticket post is a bot message, so a Discord **reply** to it delivers content without the intent. A screenshot dropped into the thread with no mention still arrives with an empty `attachments` array. Take the intent.

Passing a privileged intent you have not enabled closes the gateway with code `4014`. Passing an invalid intent closes with `4013`.

**Gateway send budgets** ([Gateway — Rate limiting](https://docs.discord.com/developers/events/gateway#rate-limiting)):

| Limit | Value |
| --- | --- |
| Gateway events sent per connection | 120 per 60 seconds. Exceeding it disconnects the app immediately. |
| IDENTIFY calls | 1000 per 24 hours. Exceeding it terminates all sessions, **resets the bot token**, and emails the owner. |
| Concurrent IDENTIFY | Governed by `max_concurrency` per 5 seconds. Over-limit gives Invalid Session (opcode `9`). |

The IDENTIFY budget matters on a laptop. A lid opened and closed 40 times a day, behind a buggy backoff, reaches 1000 faster than it looks.

### 1.4 Permission overwrites

Permissions resolve in eight stages ([Permissions](https://docs.discord.com/developers/topics/permissions)):

1. base `@everyone` guild permissions
2. role guild permissions
3. `@everyone` channel **deny**
4. `@everyone` channel **allow**
5. role channel **deny**
6. role channel **allow**
7. member channel **deny**
8. member channel **allow**

A member overwrite beats a role overwrite. A member-targeted allow is the safest way to keep the bot posting into a channel it just locked.

```json
{ "id": "<role or user id>", "type": 0, "allow": "0", "deny": "2048" }
```

`type` is `0` for a role and `1` for a member. `allow` and `deny` are **strings** ([Channel — Overwrite object](https://docs.discord.com/developers/resources/channel)). The `@everyone` role id equals the guild id — Discord's own example is `guild.get_role(guild.id)  # get @everyone role`.

Two constraints on the bot:

- Editing overwrites needs `MANAGE_ROLES`. "Only permissions your bot has in the guild or parent channel (if applicable) can be allowed/denied (unless your bot has a `MANAGE_ROLES` overwrite in the channel)." ([Modify Channel](https://docs.discord.com/developers/resources/channel))
- The bot can grant, edit and sort only roles **lower** than its own highest role.

---

## 2. Channels and categories

### 2.1 Endpoints

| Operation | Method and path | Permission |
| --- | --- | --- |
| Create channel or category | `POST /guilds/{guild.id}/channels` | `MANAGE_CHANNELS` |
| Modify channel (rename, topic, move, overwrites) | `PATCH /channels/{channel.id}` | `MANAGE_CHANNELS`, plus `MANAGE_ROLES` for overwrites |
| Bulk reorder or move | `PATCH /guilds/{guild.id}/channels` | `MANAGE_CHANNELS`, returns **204** |
| Start thread on a message | `POST /channels/{channel.id}/messages/{message.id}/threads` | `SEND_MESSAGES` (`CREATE_PUBLIC_THREADS` is ignored) |
| Edit a message | `PATCH /channels/{channel.id}/messages/{message.id}` | author only, for `content` / `embeds` / `components` |

Create a category with `type: 4` and no `parent_id`. Create a map channel with `type: 0` and `parent_id` set to the category id.

```json
POST /guilds/{guild.id}/channels
{ "name": "map-142-discord-mode", "type": 0, "parent_id": "<category id>", "topic": "wayfinder map #142" }
```

Modify Channel parameter bounds: `name` 1–100 characters, `topic` 0–1024 characters (0–4096 for forum and media), `rate_limit_per_user` 0–21600 seconds, `position` an integer where equal positions sort by id. Modifying a **category** fires an individual Channel Update event for every child channel that also changes.

**Bulk position changes move at most one channel between categories per request.**

```json
PATCH /guilds/{guild.id}/channels
[ { "id": "111", "position": 0 },
  { "id": "222", "position": 1 },
  { "id": "333", "position": 2, "parent_id": "<category id>", "lock_permissions": true } ]
```

> "At most one entry per request may change `parent_id`. A request that changes `parent_id` for more than one channel fails with a `400` response and error code `40009` (`Only one channel can have a parent_id modified at a time`)."

Permission checks are per entry:

> "An entry that only changes `position` requires the `MANAGE_CHANNELS` permission at the guild level ... It does **not** require access to the individual channel, so a full reordering may include channels the current user cannot view.
> An entry that changes `parent_id` requires the `MANAGE_CHANNELS` permission on that channel and on the destination ... Setting `lock_permissions` additionally requires `MANAGE_ROLES`."

— [Modify Guild Channel Positions](https://docs.discord.com/developers/resources/guild)

`lock_permissions: true` syncs the channel's overwrites to its new parent category. That is the cheap way to apply a category-wide policy.

### 2.2 Structural limits

| Limit | Value | Source |
| --- | --- | --- |
| Channels per guild | **500** | Error `30013` "Maximum number of guild channels reached (500)" — [JSON error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes) |
| Channels per category | **50** | GUILD_CATEGORY is "an organizational category that contains up to 50 channels" — [Channel types](https://docs.discord.com/developers/resources/channel#channel-object-channel-types) |
| Categories per guild | **50** — *not in the API docs* | [Discord support community](https://support.discord.com/hc/en-us/community/posts/360052020254-Increase-the-maximum-number-of-categories-a-server-can-have-from-50-to-75) — community-sourced |
| Roles per guild | 250 | Error `30005` |
| Pins per channel | 250 | Error `30003` |
| Thread participants | 1000 | Error `30033` |
| Reactions per message | 20 distinct | Error `30010` |
| Attachments per message | 10 | Error `30015` |
| Threads against the channel cap | **Threads do not count** | [Threads](https://docs.discord.com/developers/topics/threads) |

Every structural limit sits far above "tens of channels". None of them binds this design. The binding limits are all temporal.

One trap: error `30030` reads "Maximum number of server categories has been reached (5)". That is **server discovery** categories, not channel categories. Do not design against it.

### 2.3 Renaming is the scarcest operation

Renaming a channel, or changing its topic, is far more restricted than any other edit. **This number appears nowhere in Discord's documentation.** Verified by reading the live docs source `developers/resources/channel.mdx`: Modify Channel carries no rate-limit callout, and `topics/rate-limits.mdx` names only emoji routes as a stricter special case.

The figures below are **community-sourced**, reported twice on Discord's own tracker and never contradicted:

| Change | Reported limit | Source |
| --- | --- | --- |
| `name` only, `topic` only, or a PATCH containing either | **2 per 10 minutes**, per channel | [discord-api-docs #1900](https://github.com/discord/discord-api-docs/issues/1900) (2020-08-13), [#2190](https://github.com/discord/discord-api-docs/issues/2190) (2020-10-30) — community-sourced |
| Any other field (`position`, `parent_id`, `permission_overwrites`, `nsfw`, …) | ~10 per 15 seconds | [#2190](https://github.com/discord/discord-api-docs/issues/2190) — community-sourced |

Issue #2190 reports that a name-only edit drains **both** buckets, and that the headers report the buckets inconsistently. Both issues closed with no staff answer and no documentation change. The reports are from 2020 and were never confirmed. Treat 2-per-10-minutes as the working figure, and read `retry_after` at runtime rather than hard-coding it.

Exceeding it returns a 429 whose `retry_after` is measured in **hundreds of seconds**. Every such 429 also spends the invalid-request budget in [4.3](#43-rate-limits-documented-and-folklore).

### 2.4 Archiving a closed map

**Discord has no native archive for a channel or a category.** The [Channel Flags](https://docs.discord.com/developers/resources/channel#channel-object-channel-flags) table holds only `PINNED` (`1 << 1`), `REQUIRE_TAG` (`1 << 4`), `HIDE_MEDIA_DOWNLOAD_OPTIONS` (`1 << 15`) and `IS_SPOILER_CHANNEL` (`1 << 21`). There is no `ARCHIVED` bit. Only **threads** have real `archived` and `locked` fields.

The real mechanism is a permission overwrite:

```json
PATCH /channels/{channel.id}
{
  "permission_overwrites": [
    { "id": "<guild id>", "type": 0, "allow": "0", "deny": "377957124160" },
    { "id": "<bot user id>", "type": 1, "allow": "2048", "deny": "0" }
  ]
}
```

```
deny = SEND_MESSAGES | SEND_MESSAGES_IN_THREADS
     | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | ADD_REACTIONS
     = 377957124160
```

This keeps `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` intact, so humans still read the closed map. The member allow on the bot (stage 8) beats the `@everyone` deny (stage 3), so the bot still writes the final state of each ticket post.

It changes no name and no topic, so it lands in the fast bucket, not the 2-per-10-minutes one.

Two common companions each cost something:

- **Moving the channel into an Archive category** — `PATCH /guilds/{guild.id}/channels` with `parent_id` and `lock_permissions: true`, **one channel per request** (error `40009`). Sweeping N channels costs N sequential requests.
- **Prefixing the name**, for example `closed-map-142` — this **is** a rename and spends the scarce budget. Keep it separate from the archive action, or archiving inherits the rename limit.

---

## 3. The ticket post and its thread

### 3.1 One snowflake, two objects

`POST /channels/{channel.id}/messages/{message.id}/threads` — Start Thread from Message:

- "When called on a `GUILD_TEXT` channel, creates a `PUBLIC_THREAD`."
- "**The id of the created thread will be the same as the id of the source message, and as such a message can only have a single thread created from it.**"
- "Does not work on a `GUILD_FORUM` or a `GUILD_MEDIA` channel."
- JSON params: `name` (1–100 chars, required), `auto_archive_duration?`, `rate_limit_per_user?` (0–21600 seconds).

— [Start Thread from Message](https://docs.discord.com/developers/resources/channel#start-thread-from-message)

**The ticket post's message id is the thread id.** Store one snowflake per ticket, not two. The `PATCH` target for a status update and the `POST` target for an agent reply differ only by route shape.

Beware the sibling endpoint. `POST /channels/{channel.id}/threads` — Start Thread without Message — has a trap: "`type` currently defaults to `PRIVATE_THREAD` in order to match the behavior when thread documentation was first published." Pass `type: 11` explicitly.

A public thread "can be 'orphaned' if that message is deleted" — the thread survives, the header post does not.

### 3.2 Thread types, and the forum channel alternative

| Name | Value | Where it can exist |
| --- | --- | --- |
| `GUILD_TEXT` | 0 | — |
| `GUILD_CATEGORY` | 4 | — |
| `GUILD_ANNOUNCEMENT` | 5 | — |
| `ANNOUNCEMENT_THREAD` | 10 | only in a `GUILD_ANNOUNCEMENT` channel |
| `PUBLIC_THREAD` | 11 | in a `GUILD_TEXT` **or** `GUILD_FORUM` channel |
| `PRIVATE_THREAD` | 12 | only in a `GUILD_TEXT` channel; visible to invitees and `MANAGE_THREADS` holders |
| `GUILD_FORUM` | 15 | channel that can contain **only** threads |
| `GUILD_MEDIA` | 16 | as forum, but in beta |

Source: [Channel types](https://docs.discord.com/developers/resources/channel#channel-object-channel-types). `GUILD_MEDIA` carries a warning: "in beta and still being actively developed. The API and other technical details are subject to change."

For a channel the whole team reads, **`PUBLIC_THREAD` is the only fit**.

**Forum channel as the alternative.**

| | Text channel + thread-on-message | Forum channel (`GUILD_FORUM`) |
| --- | --- | --- |
| Ticket post | a real message you `PATCH` in place | the **first message of the thread**, `PATCH`-able the same way |
| Conversation | thread whose id == post id | the thread itself |
| Create call | 2 calls: `POST .../messages`, then `POST .../messages/{id}/threads` | 1 call: `POST /channels/{id}/threads` with a nested `message` object |
| Ordinary chat in the channel body | allowed | **impossible** — "Messages cannot be sent directly in forum channels" |
| Status as metadata | encode in message text | `applied_tags` — filterable, coloured, with emoji |
| Permission to create | `CREATE_PUBLIC_THREADS` | only `SEND_MESSAGES` |
| Pinning | thread pin | `PINNED` flag `1 << 1`; "A pinned thread will *not* auto-archive" |

Sources: [Threads — Forums](https://docs.discord.com/developers/topics/threads#forums), [Start Thread in Forum or Media Channel](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel).

Forum tag limits: **20** `available_tags` per forum channel, **5** `applied_tags` per thread, tag `name` 0–20 characters, at most one emoji per tag. The `REQUIRE_TAG` channel flag is `1 << 4`. A `moderated` tag can only be applied or removed by a `MANAGE_THREADS` holder — that is how you stop a human faking a lane.

**Assessment.** A forum channel is the closer structural match. "One post per ticket, thread on the post" is literally what a forum post is. It costs one API call instead of two, and `applied_tags` gives server-side filtering by **lane** with a coloured chip in the client, which a text channel cannot do without reading message bodies. The costs are concrete:

- The guild must be a **Community** server. "Forum channels (`GUILD_FORUM` or `15`) have been released to **all community servers**" — [Change Log, "Forum Channels Release", 2022-09-14](https://docs.discord.com/developers/change-log).
- You cannot post a plain message to the channel body. A "map opened" or "sync failed" banner must become a post.
- 5 tags per ticket and 20 per channel is a hard ceiling on how much state you can encode as tags.

### 3.3 Auto-archive: `archived` is right, `locked` is a trap

`auto_archive_duration` accepts exactly four values: **60, 1440, 4320, 10080** minutes ([Thread Metadata object](https://docs.discord.com/developers/resources/channel#thread-metadata-object)).

**The boost gate is gone.** The current docs carry no boost or premium condition on any of the four values. The field description is identical on Thread Metadata, Modify Channel, Start Thread from Message, Start Thread without Message and Start Thread in Forum: "can be set to: 60, 1440, 4320, 10080". Boost conditions *are* still documented elsewhere on the same page (voice bitrate), which shows the docs state them where they exist.

**What the field means now:**

> "The `auto_archive_duration` field **previously controlled how long a thread could stay active, but is now repurposed to control how long the thread stays in the channel list**."

> "Threads automatically archive after a period of inactivity. **As a server approaches the max thread limit this timer will automatically lower, usually not below the `auto_archive_duration`.** In very busy channels, threads set to a 7 day auto archive may archive earlier to help avoid the server becoming 'full'."

— [Threads — Active & Archived](https://docs.discord.com/developers/topics/threads#active--archived-threads)

"Activity" is sending a message, unarchiving a thread, or changing the auto-archive time. Deleting a message is not activity. So `10080` is a *request*, not a guarantee. Design for archiving as normal, not exceptional.

**What archiving does.**

| Question | Answer | Source |
| --- | --- | --- |
| Still readable? | **Yes.** The prohibition list is explicit and does not include reading: "Users cannot edit messages, add reactions, use application commands, or join archived threads. The only operation that should happen within an archived thread is messages being deleted." | [Threads](https://docs.discord.com/developers/topics/threads#active--archived-threads) |
| Still searchable? | **Yes.** `GET /guilds/{guild.id}/messages/search` is guild-scoped with a `channel_id` filter (max 500 channels) and excludes no archived thread. Needs `READ_MESSAGE_HISTORY`, and is "restricted according to whether the `MESSAGE_CONTENT` Privileged Intent is enabled". | [Search Guild Messages](https://docs.discord.com/developers/resources/message#search-guild-messages) |
| Archived threads are… | "generally immutable" | [Channel object](https://docs.discord.com/developers/resources/channel#channel-object) |

**Un-archiving is free.** Three things unarchive a thread: sending a message, setting `archived: false`, or changing `auto_archive_duration`. The docs state the first twice:

> "**Sending a message will automatically unarchive the thread**, unless the thread has been locked by a moderator."

> "Archived threads are generally immutable. To send a message or add a reaction, a thread must first be unarchived. **The API will helpfully automatically unarchive a thread when sending a message in that thread.**"

The same auto-add applies to membership: "The API will helpfully automatically add users to a thread when sending a message in that thread."

**`locked` vs `archived`.** They have been independent flags since 2023-03-06.

- `archived` blocks nearly everything except deletes, and **sending a message reverses it automatically**.
- `locked`: "Users (including bot users) without the `MANAGE_THREADS` permission are more restricted in locked threads. Users won't be able to create or update messages in locked threads, or update properties like its title or tags." A locked thread **cannot** be reopened by posting.

For a **Resolved** ticket whose conversation is the asset, `archived` is correct and `locked` is a trap. Locked rejects a returning human's follow-up outright, and the bot needs `MANAGE_THREADS` to undo it. Archived stays readable and searchable, and silently reopens the instant anyone posts — which is exactly the "talking continues after a ticket closes" behaviour, for free.

### 3.4 Thread limits and enumeration

| Limit | Documented value | Source |
| --- | --- | --- |
| Active threads per guild | **Exists, number not documented.** "Threads do not count against the max-channels limit in a guild, but there is a limit on the maximum number of active threads in a guild." | [Threads](https://docs.discord.com/developers/topics/threads#active--archived-threads) |
| Members per thread | **Exists, number not documented.** "Once these are reached additional threads cannot be created or unarchived, and users cannot be added." | [Channel object](https://docs.discord.com/developers/resources/channel#channel-object) |
| Threads per channel | Not documented — no per-channel cap appears anywhere | — |
| Do archived threads count? | **No.** "archiving exists to limit the working set of threads that need to be kept around… Therefore guilds are capped at a certain number of **active** threads" | [Threads](https://docs.discord.com/developers/topics/threads#active--archived-threads) |
| `member_count` | "stops counting at 50 (this is only used in our UI, so it is not valuable to bots)" — a display cap, not a membership cap | [Thread fields](https://docs.discord.com/developers/topics/threads#thread-fields) |

**Community figure, not official: 1,000 active threads per guild**, and the same 1,000 cap on active forum posts. The number is in no Discord developer doc. Evidence it is real: a support feature request titled ["Please increase the limit for active posts in forum from 1000 currently"](https://support.discord.com/hc/en-us/community/posts/19128860011543-Please-increase-the-limit-for-active-posts-in-forum-from-1000-currently), and third-party operator documentation stating "Discord allows up to 1,000 active threads per server, including public and private ones" ([Mava docs](https://mava.gitbook.io/mava-docs/ticket-behavior-and-settings/discord-threads-and-limits)) — both community-sourced. Treat 1,000 as the working number and enforce your own budget.

**Listing threads.**

| Route | Ordering | Permissions |
| --- | --- | --- |
| `GET /guilds/{guild.id}/threads/active` | all active threads in the guild the user can see | — |
| `GET /channels/{channel.id}/threads/archived/public` | by `archive_timestamp`, descending | `READ_MESSAGE_HISTORY` |
| `GET /channels/{channel.id}/threads/archived/private` | by `archive_timestamp`, descending | `READ_MESSAGE_HISTORY` and `MANAGE_THREADS` |

Pagination on the archived routes is a **timestamp cursor**, not a page number:

```
GET /channels/{id}/threads/archived/public?before=<ISO8601>&limit=<n>
→ { "threads": [...], "members": [...], "has_more": true }
```

Loop while `has_more` is true, feeding the last thread's `archive_timestamp` back as `before`. `limit` has no documented maximum.

Note the asymmetry: there is **no** "list active threads in this channel" route. `GET /channels/{channel.id}/threads/active` "is decommissioned in favor of `GET /guilds/{guild.id}/threads/active`". Active threads arrive over the gateway in the `GUILD_CREATE` payload's `threads` array. Archived threads are "not synced up-front via the gateway" and must be fetched over REST.

**Slowmode is free.** `rate_limit_per_user` (0–21600 seconds) can be set per thread at creation, and "**bots are not affected by slowmode restrictions**" — the upcoming `BYPASS_SLOWMODE` permission (`1 << 52`, effective 2026-02-23) "primarily affects users" ([Change Log](https://docs.discord.com/developers/change-log)). You can pace *humans* in a busy ticket thread without throttling the agent's own stream.

### 3.5 Editing the ticket post: error `30046`

`PATCH /channels/{channel.id}/messages/{message.id}` edits `content`, `embeds`, `flags`, `components`, `attachments`, `files[n]` and `allowed_mentions`. "All parameters to this endpoint are optional and nullable." ([Edit Message](https://docs.discord.com/developers/resources/message#edit-message))

Discord's JSON error code table contains, with no rate published anywhere:

> **`30046` — Maximum number of edits to messages older than 1 hour reached. Try again later**

— [JSON error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#json-json-error-codes)

Read that against this design. **A ticket post is edited for its whole life** — lane flips, blockers appear and clear, over days. Every one of those edits lands on a message far older than one hour, squarely in the bucket `30046` meters. Discord documents the error and never the number. [Issue #4413](https://github.com/discord/discord-api-docs/issues/4413) (2022-01-29) asked for the figure and closed with no answer; the reporter confirmed the limit does not surface in response headers. The error appears in **none** of the ~16 LLM bots surveyed in [8](#8-what-builders-of-agent-in-discord-bots-get-wrong).

This is the failure mode a ledger of permanently-edited posts walks into, and it is invisible until it fires.

The same error does **not** threaten a streaming reply. A streaming reply is edited only in the first minute or two of its life, while it is young.

**Mitigation:** debounce ticket-post updates to at most one edit per ~30–60 s, collapse rapid lane flapping into one write, and skip the `PATCH` when the rendered text is byte-identical. Do not `PATCH` the ledger row on every sync tick. Handle `30046` by backing off, not by retrying — every failed retry also spends the invalid-request budget.

### 3.6 An edited ledger is a dashboard, not a feed

| Question | Answer |
| --- | --- |
| Does editing re-trigger notifications? | **No.** An edit fires `MESSAGE_UPDATE`, not `MESSAGE_CREATE` ([Gateway events](https://docs.discord.com/developers/events/gateway-events#message-update)). Notifications and unread badges are driven by message creation. `SUPPRESS_NOTIFICATIONS` (`1 << 12`) is a create-time flag and is not in the Edit Message editable-flags list. |
| Does editing move the message in the channel? | **No.** `GET /channels/{id}/messages` returns messages "from newest to oldest" and paginates purely by snowflake. `last_message_id` is "the id of the last message **sent** in this channel". Position is a function of the creation snowflake; an edit mints no new one. |
| Is there a cap on the number of edits? | No documented cap, but see `30046` above. `edited_timestamp` is one field — no counter, no history. |

Edit-in-place gives a stable, permanently addressable row per ticket. The post never jumps, the reader's scroll position stays meaningful, and the thread link never breaks.

The flip side: **an edit is invisible.** No notification, no reorder, no unread mark. If a ticket goes **Blocked** at 3am, nobody finds out by watching the channel. They find out by scrolling past the row.

That is exactly right for a scrollable ticket board, and exactly wrong for "a ticket just reached the **Frontier**". Anything that must reach a human on a phone has to be a **newly created** message or a mention. Notification is inseparable from creation.

---

## 4. Carrying a turn into a thread

### 4.1 Message and embed limits

| Limit | Value | Source |
| --- | --- | --- |
| `content` | **up to 2000 characters** — identical wording on Create Message, Edit Message, and forum thread message params | [Create Message](https://docs.discord.com/developers/resources/message#create-message) |
| Embeds per message | **10** rich embeds | same |
| Total across all embeds | **6000 characters** | [Embed limits](https://docs.discord.com/developers/resources/message#embed-object-embed-limits) |
| Max request size | **25 MiB** | [Create Message](https://docs.discord.com/developers/resources/message#create-message) |
| `allowed_mentions.users` / `.roles` | max 100 each | [Allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object) |

**The 4000-character Nitro limit does not apply to bots.** The Create Message and Edit Message parameter tables say "Message contents (up to 2000 characters)" with no premium exception. The strings "Nitro" and "premium" appear nowhere in the message resource docs in connection with `content` length. A support feature request titled ["Allow bots to use the new 4000 character limit in messages"](https://support.discord.com/hc/en-us/community/posts/4403651786135-Allow-bots-to-use-the-new-4000-character-limit-in-messages) is still open and unimplemented. **Treat 2000 as hard.**

One genuine escape hatch exists, and it is not `content`.

| Embed field | Limit |
| --- | --- |
| `title` | 256 characters |
| `description` | **4096 characters** |
| `fields` | up to 25 field objects |
| `field.name` | 256 characters |
| `field.value` | 1024 characters |
| `footer.text` | 2048 characters |
| `author.name` | 256 characters |
| Sum of all the above across all embeds on one message | **6000 characters** |

"All of the following limits are measured inclusively. **Leading and trailing whitespace characters are not included (they are trimmed automatically).**" Rich embeds "do not follow the traditional limits of message content" — the 2000-character `content` cap and the 6000-character embed budget are **separate**. A message can carry both.

**Editing attachments has a v10 trap.** "Starting with API v10, the `attachments` array must contain **all** attachments that should be present after edit, including retained and new attachments provided in the request body." Omit it and the files drop.

### 4.2 What counts toward the 2000

**Raw markup, always.** Discord's wire format is the literal string you send. The client renders it.

| Rendered as | You send | Cost |
| --- | --- | --- |
| `@willness` | `<@80351110224678912>` | 21 chars |
| `#tickets` | `<#103735883630395392>` | 21 chars |
| `@backend` role | `<@&165511591545143296>` | 22 chars |
| `:mmLol:` custom emoji | `<:mmLol:216154654256398347>` | 27 chars |
| animated emoji | `<a:b1nzy:392938283556143104>` | 28 chars |
| `/deploy` command link | `</airhorn:816437322781949972>` | 29 chars |
| a relative timestamp | `<t:1618953630:R>` | 16 chars |

Source: [Message formatting](https://docs.discord.com/developers/reference#message-formatting). Standard emoji are the exception — they are Unicode characters, sent literally, so they cost only their own length.

Markdown syntax counts too. A fenced code block costs ~8 characters of pure overhead before any code. Discord does not document *which* unit it counts — bytes, code points, or UTF-16 code units — so budget conservatively around multi-byte content.

A ticket post that mentions three people and links two channels burns ~105 characters on markup alone.

### 4.3 Rate limits: documented, and folklore

**What is documented** ([Rate limits](https://docs.discord.com/developers/topics/rate-limits)):

| Item | Value |
| --- | --- |
| Global limit, per bot token | **50 requests per second** across the whole API. Independent of per-route limits. |
| Interaction endpoints | **exempt** from the global limit |
| Invalid request limit | **10,000 per 10 minutes** → temporary Cloudflare IP ban. "An invalid request is one that results in **401**, **403**, or **429** statuses." |
| 429s that do not count against you | those returned with `X-RateLimit-Scope: shared` |
| Per-route limits | **dynamic**, published only in headers |
| Unauthenticated requests | metered against the **IP address**, not a token |

**Top-level resources are metered independently.** "Top-level resources are currently limited to channels (`channel_id`), guilds (`guild_id`), and webhooks (`webhook_id` or `webhook_id + webhook_token`)… if you exceeded a rate limit when calling one endpoint `/channels/1234`, you could still call another similar endpoint like `/channels/9876` without a problem."

**Every thread is its own `channel_id`.** Two agents streaming into two ticket threads do not share a per-route bucket. Only the global 50/s is shared.

Headers to read: `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-After` (seconds, fractional), `-Bucket`, and on 429s only `-Global` and `-Scope` (`user` | `global` | `shared`).

```json
{
  "message": "You are being rate limited.",
  "retry_after": 64.57,
  "global": false,
  "code": 0
}
```

**"5 messages per 5 seconds per channel" is folklore.** The number is in no current Discord documentation. Its origin is `discord/discord-api-docs` issue #20, opened by Discord staff member `jhgg` on 2016-04-12:

> "Bot Rate Limits are as follows:
> 1. A global 50/10 rate limit…
> 2. **A 5/5 per server rate limit.**
> 3. A 5/5 global DM rate limit.
>
> **The rate limit applies to message creation and editing.**"

— [discord-api-docs #20](https://github.com/discord/discord-api-docs/issues/20)

It says **per server**, not per channel. Four months later, on 2016-08-19, Discord staff member `night` replied in the same thread:

> "**These limits are no longer valid.** If you're looking for info on managing rate limits in your bot please read our new docs…"

— [#20, comment](https://github.com/discord/discord-api-docs/issues/20#issuecomment-240796290)

So the 5/5 figure is a decade-old, officially retracted number that the community still repeats. The honest statement: **the per-channel message limit is undocumented and dynamic. Read the headers.**

One durable lesson survives issue #20 — Discord has historically metered **edits and creates together**. The discord.py author confirms it: "Note that sending and editing is under the same rate limit bucket" ([discord.py #6073](https://github.com/Rapptz/discord.py/issues/6073) — community-sourced). **You cannot buy throughput by switching from `POST` to `PATCH`.**

And on why none of this is documented, Discord staff `yonilerner`, in [#4413](https://github.com/discord/discord-api-docs/issues/4413), entire comment: *"We dont put rate limit details in our documentation"*.

**A second lane exists.** Webhooks bucket on `webhook_id`, and `POST /webhooks/{id}/{token}?thread_id={thread.id}` posts into a thread — "The thread will automatically be unarchived." `username` and `avatar_url` override the sender per message (name up to 80 characters), so each agent session could carry its own identity with no extra bot accounts. Caveat: webhook execution carries no bot Authorization header, so its traffic meters against the Mac's **IP**, not the bot token. That decouples it from the bot's 50/s but does not make it free, and its 429s still spend the same 10,000-per-10-minutes ban budget on that IP.

**The cheapest liveness signal is the typing indicator.** `POST /channels/{channel.id}/typing` — "Post a typing indicator for the specified channel, which expires after 10 seconds." Discord's own guidance:

> "Generally bots should **not** use this route. However, **if a bot is responding to a command and expects the computation to take a few seconds, this endpoint may be called to let the user know that the bot is processing their message.**"

— [Trigger Typing Indicator](https://docs.discord.com/developers/resources/channel#trigger-typing-indicator)

That is exactly this situation. One request every ~9 seconds sustains "typing…" for a whole turn at ~0.11 req/s, against 2–3 req/s for an edit loop. It conveys liveness without conveying content.

### 4.4 Streaming: the recommendation

**Four primary facts constrain every possible strategy.**

1. **A message tops out at 2000 characters.** An agent turn of thousands of characters *will* cross it. Pure edit-in-place cannot be a whole strategy — at 2000 characters you are forced into a second message regardless.
2. **Per-route buckets key on `channel_id`, and every thread is a channel.** Concurrent tickets never contend with each other.
3. **The per-channel quota is undocumented and dynamic**, and Discord tells you not to hard-code it. The only official figure ever published metered creates and edits together, and was retracted.
4. **429s are not free.** They spend the 10,000-per-10-minutes ban budget. A tight edit loop that routinely 429s is not backpressure working. It is spending the ban budget.

One more, from the library side: **discord.js and discord.py queue rather than throw.** Overdriving the edit loop produces unbounded latency, not errors. The stream falls behind and keeps falling behind, with nothing in the logs.

**What real LLM Discord bots do.** All community-sourced, read from repository HEAD on 2026-08-12.

| Project | Strategy | Throttle (verbatim constant) | Fence-safe splits? |
| --- | --- | --- | --- |
| [jakobdylanc/llmcord](https://github.com/jakobdylanc/llmcord) | edit-in-place, into an **embed** | `EDIT_DELAY_SECONDS = 1` | no |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | edit-in-place | `DEFAULT_THROTTLE_MS = 1200`, floor `Math.max(250, …)` | **yes** |
| [stanley2058/js-llmcord](https://github.com/stanley2058/js-llmcord) | edit-in-place, multi-message | `EDIT_DELAY_SECONDS = 0.1`, diffs and skips no-op edits | **yes** |
| [SteelPh0enix/unreasonable-llama-discord](https://github.com/SteelPh0enix/unreasonable-llama-discord) | edit-in-place | `edit-cooldown-ms = 750`, `length-limit = 1990` | **yes, carries the language tag** |
| [Gaia-PBC/axi-assistant](https://github.com/Gaia-PBC/axi-assistant) | edit-in-place + explicit 429 backoff | `STREAMING_EDIT_INTERVAL = 1.5` | no |
| [mdolton/jarvis](https://github.com/mdolton/jarvis) | edit-in-place, drops frames | `min_edit_interval: float = 1.5` | no |
| [Oneirocom/Magick](https://github.com/Oneirocom/Magick) | edit-in-place, embed | `EDITS_PER_SECOND = 1.3` | no |
| [HKUDS/nanobot](https://github.com/HKUDS/nanobot) | edit-in-place | `_STREAM_EDIT_INTERVAL = 0.8` | no |
| [chrisrude/oobabot](https://github.com/chrisrude/oobabot) | edit-in-place | `stream_responses_speed_limit` default `0.7` | no |
| [mxyng/discollama](https://github.com/mxyng/discollama) | edit-in-place | `timedelta(seconds=1)` | no |
| [kevinthedang/discord-ollama](https://github.com/kevinthedang/discord-ollama) | edit-in-place | **none — edits every token** | no |
| [Zero6992/chatGPT-discord-bot](https://github.com/Zero6992/chatGPT-discord-bot) (2.7k★) | **post once at the end** | n/a | partial |

**The converged number is 0.75–1.5 seconds per edit.** The cluster across independent projects: 0.75, 0.8, 1.0, 1.0, 1.0, 1.2, 1.3/s, 1.5, 1.5.

Two data points bracket it. The permissive end: a 2026 live probe ([PwrAgent #220](https://github.com/pwrdrvr/PwrAgent/issues/220) — community-sourced) reports "one send plus 60 one-second edits on each surface passed without 429; Discord reported a 5 requests / 1 second edit bucket". The restrictive end is more interesting, because it is a maintainer walking a default *backwards*: oobabot commit [`201dd84a`](https://github.com/chrisrude/oobabot/commit/201dd84a) "increases default `stream_responses_speed_limit` from 0.2 to 0.7. **This is reported to have smoother performance by user testing**."

**Fast edits degrade the reading experience before they 429.** The client re-renders and the text jitters.

The anti-pattern is documented in its own UI. `kevinthedang/discord-ollama` edits per token with no time check, and its slash-command description reads: `'change preference on message streaming from ollama. WARNING: can be very slow due to Discord limits.'` ([`messageStream.ts#L6`](https://github.com/kevinthedang/discord-ollama/blob/master/src/commands/messageStream.ts#L6)). That is the silent queueing made visible.

Worth noting that the most-starred repo in the space, `Zero6992/chatGPT-discord-bot`, does not stream at all. It awaits the complete string and posts once.

**Does edit-in-place actually 429?** The evidence is thinner than the folklore suggests. No streaming-edit 429 issue exists in the trackers of llmcord, discord-ollama, or discollama — because the libraries pre-emptively queue and auto-sleep `retry_after`, so the symptom presents as **lag, not errors**. Only two surveyed projects handle 429 in their own code ([axi-assistant](https://github.com/Gaia-PBC/axi-assistant), [SMILE-factory](https://github.com/leehanchung/SMILE-factory)); axi's approach is neat — it pushes `last_edit_time` into the future so the existing throttle absorbs the backoff. Community header captures ([Discord.Net #2375](https://github.com/discord-net/Discord.Net/issues/2375)) show `PATCH` returning `Limit: 5`, `ResetAfter: 00:00:05`, yet 429s firing while `Remaining: 4` — implying a hidden sub-limit. That contradicts the 2026 probe above, which is what an undocumented, dynamic, server-side limit looks like.

#### The recommendation

**Edit in place *within* a chunk. Post a new message *across* chunks.** Neither strategy alone. This is the hybrid every serious bot in the survey converged on independently.

1. On the human's message, `POST /channels/{thread_id}/typing` and refresh it every ~9 s until the first token lands. Free liveness, zero content risk, Discord's own sanctioned use.
2. Post one message when the first tokens arrive. `PATCH` it on a **~1.0–1.5 second timer** — never per token — and skip the call when the text has not changed.
3. When the next token would overflow the budget, finalize the current message and `POST` a new one.
4. Balance code fences on **every intermediate edit**, not only the last, and reopen with the language tag on the next chunk.

**Why not pure edit-in-place.** It cannot express a reply longer than 2000 characters, so it is not a candidate. The question answers itself at the first long turn. Even inside one message, `PATCH` buys no throughput: sends and edits share a bucket.

**Why not pure chunked posts.** Posting every N characters with no in-message editing produces a shredded, unreadable transcript — and the transcript is the asset that must stay readable for years. It also spends *more* requests than throttled editing for the same visual result.

**Pick the interval at 1.0–1.5 s, not lower.** The measured bucket has headroom at 1 s/edit, so this is conservative on limits. The binding constraint is human, not technical. Start at 1.2 s (openclaw's shipped default), make it configurable, and log the `rateLimited` event so lag is visible rather than silent.

**Consider streaming into an embed `description` (4096 chars) rather than `content` (2000).** llmcord and Magick both do. It halves the number of splits, at the cost of embed styling and the 6000-character total budget.

### 4.5 Splitting without breaking a code fence

**Only 4 of ~16 surveyed projects preserve code fences across a split.** All community-sourced.

`llmcord`'s loop is the reference implementation ([`llmcord.py`](https://github.com/jakobdylanc/llmcord/blob/main/llmcord.py)):

```python
time_delta = datetime.now().timestamp() - last_task_time
ready_to_edit = time_delta >= EDIT_DELAY_SECONDS
msg_split_incoming = finish_reason == None and len(response_contents[-1] + curr_content) > max_message_length
is_final_edit = finish_reason != None or msg_split_incoming
if start_next_msg or ready_to_edit or is_final_edit:
    if start_next_msg:
        await reply_helper(embed=embed, silent=True)   # roll to a NEW message
    else:
        await asyncio.sleep(EDIT_DELAY_SECONDS - time_delta)
        await response_msgs[-1].edit(embed=embed)
    last_task_time = datetime.now().timestamp()
```

The two implementations worth copying:

- [openclaw `chunk.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/chunk.ts) reserves budget for the closing fence *before* filling a chunk, and degrades from "reopen with the language tag" to "bare marker" when space is tight. It is the most-forked implementation in the ecosystem.
- [unreasonable-llama `split_message`](https://github.com/SteelPh0enix/unreasonable-llama-discord/blob/master/unllamabot/llama_backend.py) counts fence markers, and on an odd count closes the first chunk and reopens the second **carrying the language tag forward**.

There is a subtler bug that only appears when streaming: a mid-stream snapshot frequently ends *inside* an open fence, which Discord will not render. `js-llmcord` handles it with a repair pass, `closeUnclosedCodeFences` ([`token-complete.ts`](https://github.com/stanley2058/js-llmcord/blob/main/src/token-complete.ts)). **Balance every intermediate edit independently, not only the final one.**

Avoid the naive `split("```")` toggle used by `Zero6992`. It loses the language tag and desyncs on any odd fence count.

**Library support is worse than you would expect.**

- **discord.js removed its splitter.** `Util.splitMessage()` was deprecated in v13 and removed in v14: "This utility method is something the developer themselves should do" ([changes in v14](https://discordjs.guide/legacy/additional-info/changes-in-v14)). Rationale from [PR #5918](https://github.com/discordjs/discord.js/pull/5918): "No other method in the entire library does two requests to the same path." The v13 implementation was not fence-aware anyway, but its `prepend`/`append` options let you pass ````{ prepend: '```js\n', append: '\n```' }```` — that is the capability people lost. `@discordjs/formatters` ships `codeBlock()`, a wrapper, not a splitter.
- **discord.py has a real one**, and it is fence-safe by construction, because the prefix and suffix are re-emitted on every page ([`discord/ext/commands/help.py`](https://github.com/Rapptz/discord.py/blob/master/discord/ext/commands/help.py)):

  ```python
  def __init__(self, prefix: Optional[str] = '```', suffix: Optional[str] = '```',
               max_size: int = 2000, linesep: str = '\n') -> None:
  ```

  `close_page()` appends the suffix and re-seeds the next page with the prefix, and the budget check reserves both. **Caveat: it is line-granular and raises `RuntimeError` on a single over-long line**, so it cannot consume a raw token stream without pre-wrapping.

### 4.6 Markdown: there are no tables

Discord "utilizes **a subset of** markdown for rendering message content on its clients, while also adding some custom functionality" ([Message formatting](https://docs.discord.com/developers/reference#message-formatting)). The subset is narrower than what an LLM emits.

The authoritative machine-readable enumeration is `@discordjs/formatters`, the official discord.js formatting package — one exported function per supported construct ([`formatters.ts`](https://github.com/discordjs/discord.js/blob/main/packages/formatters/src/formatters.ts)):

| Construct | Syntax | Notes |
| --- | --- | --- |
| Headings | `# `, `## `, `### ` | **exactly three levels.** The `HeadingLevel` enum is `One`/`Two`/`Three`. `#### ` and deeper render as literal text |
| Subtext | `-# ` | small grey text |
| Bold / italic / underline / strike | `**` / `_` / `__` / `~~` | italic is `_x_` in the helper, not `*x*` |
| Spoiler | `\|\|x\|\|` | Discord-specific |
| Quote / block quote | `> ` / `>>> ` | `>>>` quotes to end of message |
| Inline code | `` `x` `` | |
| Code block | ````` ```lang ````` … ````` ``` ````` | language hint supported |
| Unordered list | `- ` with **2 spaces per nesting level** | `listCallback` emits `'  '.repeat(depth - 1)` |
| Ordered list | `1. ` with the same 2-space indent | `orderedList(list, startNumber = 1)` |
| Masked link | `[text](url)` | `hyperlink()`; `hideLinkEmbed()` wraps a bare URL in `<>` to suppress the preview |

**Tables do not exist.** There is no table construct in Discord's message-formatting reference, and no table function in `@discordjs/formatters` beside its 20+ helpers. Discord's own feature-request forum carries long-running, unimplemented requests: ["Request for markdown tables"](https://support.discord.com/hc/en-us/community/posts/16131946321815-Request-for-markdown-tables) and ["Feature Request: Advanced markdown (tables, lists, headers and more.)"](https://support.discord.com/hc/en-us/community/posts/360040079832-Feature-Request-Advanced-markdown-tables-lists-headers-and-more).

**A GFM table pasted into Discord renders as a wall of pipes and dashes.** Agents emit tables constantly. The bot needs a render step that rewrites a table — into aligned text inside a code fence, or into bullet lists — before posting. This is not optional polish.

Also absent: heading levels 4–6, horizontal rules, images (only auto-embedded URLs), footnotes, definition lists, interactive task-list checkboxes, and HTML.

**Stale-doc warning.** The threads topic still says "In thread-only channels, the first message in a thread and the channel topic can both contain markdown for bulleted lists and headings (**unlike text channels**)". That parenthetical predates Discord's 2023 rollout of headings and lists to all messages, which `heading()` and `unorderedList()` in `@discordjs/formatters` (message-general, not forum-specific) confirm. Do not read that line as a live restriction.

**Escaping.** Discord escapes with a leading backslash. The complete set `escapeMarkdown()` neutralizes, all defaulting to `true` ([`escapers.ts`](https://github.com/discordjs/discord.js/blob/main/packages/formatters/src/escapers.ts)):

```
blockQuote, bold, bulletedList, codeBlock, codeBlockContent,
escape (the backslash itself), heading, inlineCode, inlineCodeContent,
italic, maskedLink, numberedList, quote, spoiler, strikethrough, underline
```

`codeBlockContent` and `inlineCodeContent` are separate options, because the common case leaves fenced content alone.

**Five mangling risks when agent output is posted verbatim:**

1. **Backticks.** Agent output containing a triple backtick inside its own prose — common when an agent explains code fences, or dumps a file that *is* markdown — closes your wrapper fence early, and the rest renders as chaos.
2. **Underscores in identifiers.** `snake_case_name_here` italicizes the middle. File paths with underscores are the usual victim.
3. **`#` at line start.** A shell comment or a markdown-style bullet header becomes an H1.
4. **Silent character stripping.** "Discord may strip certain characters from message content, like invalid unicode characters or characters which cause unexpected message formatting" — the message you read back may not be the one you sent.
5. **`@`.** See [4.7](#47-mentions-and-link-unfurling).

The practical rule: agent output inside a **code fence** is safe from 1–4 in one move, at the cost of losing all rendering. Prose output needs escaping *and* `allowed_mentions`.

### 4.7 Mentions and link unfurling

**The `allowed_mentions` object** ([Allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object)):

| Field | Meaning |
| --- | --- |
| `parse` | array of `"roles"`, `"users"`, `"everyone"` |
| `roles` | role ids to allow, max 100 |
| `users` | user ids to allow, max 100 |
| `replied_user` | ping the author of the replied-to message; **defaults false** |

**The default when you omit it is dangerous, and it differs by route.**

- **Regular messages: all mention types are parsed** — `["users", "roles", "everyone"]`.
- **Interactions and webhooks: only `["users"]`.**

So the safe-looking half of the bot (interaction responses) and the dangerous half (plain channel messages, which is where agent output goes) have *different* defaults. Agent output posted to a thread with no `allowed_mentions` will happily ping `@everyone`. Discord's own warning: "If you are passing user-generated strings into message content, consider sanitizing the data to prevent unexpected behavior and **using `allowed_mentions` to prevent unexpected mentions**."

Agent output routinely contains `@types/node`, `user@host`, `@Override` and npm scopes. A bare `@everyone` in a code sample pings the server.

**Edits need it too, every time.** `allowed_mentions` is not sticky. On edit, "When the `content` field is edited, the arrays `mentions` and `mention_roles` and the boolean `mention_everyone` will be **reconstructed from scratch**… If there is no explicit `allowed_mentions` in the edit request, the content will be parsed with *default* allowances". Two community reports confirm the effect: [discord-api-docs #1419](https://github.com/discord/discord-api-docs/issues/1419) (2020-03-10) "Looks to me like `allowed_mentions`'s data is dropped"; [#2474](https://github.com/discord/discord-api-docs/issues/2474) (2021-01-10) is the sharper case — "Editing reply message that doesn't initially ping, pings the user", with the reporter's conclusion: "Only way to fix this problem is by using `"allowed_mentions": {"parse": []}` in the edit too".

The safe posture, on every outbound message **and every edit**:

```jsonc
// paranoid: render mentions as text, ping nobody
{ "allowed_mentions": { "parse": [] } }

// pragmatic: humans you explicitly name get pinged, nothing else
{ "allowed_mentions": { "parse": ["users"], "roles": [], "replied_user": true } }
```

Set the policy once at client construction, not per call site. That is the altitude the one real-world fix was applied at (see [8.5](#8-what-builders-of-agent-in-discord-bots-get-wrong)).

**Notification behaviour of edits** (community-sourced): a new message containing a mention notifies; adding a mention by *editing* generally does not. Discord has a standing feature request to change this ([support community](https://support.discord.com/hc/en-us/community/posts/6707927967767-Notify-user-when-a-message-mentioning-them-is-significantly-edited)). This reinforces [3.6](#36-an-edited-ledger-is-a-dashboard-not-a-feed): an edit cannot get a human's attention.

**Link unfurling is an exfiltration channel.** Every bare URL in agent output tries to unfurl a preview card, and Discord's renderer fetches it server-side with no click. Wrap URLs in `<…>` (`hideLinkEmbed`) or set the `SUPPRESS_EMBEDS` flag (`1 << 2`), which — unusually — *is* settable on edit. See [8.6](#8-what-builders-of-agent-in-discord-bots-get-wrong).

---

## 5. Buttons and the interaction lifecycle

### 5.1 Component limits and `custom_id`

Source unless noted: [Component Reference](https://docs.discord.com/developers/components/reference).

| Thing | Limit |
| --- | --- |
| Total components per message (V2 flag set) | **40** |
| Buttons per Action Row | **up to 5** |
| Action Row contents | "Up to 5 contextually grouped buttons **or** a single select component" — never both |
| `custom_id` length | **1 to 100 characters** |
| `custom_id` uniqueness | "Multiple components on the same message must not share the same `custom_id`" |
| String Select options | max 25 |

Button styles: `Primary 1`, `Secondary 2`, `Success 3`, `Danger 4`, `Link 5`, `Premium 6`.

On the legacy "5 action rows per message" figure: the current reference page no longer states it. Do not treat it as a documented guarantee. It does not bind this design — a ticket post needs 2–4 buttons in one row.

**`custom_id` is a key, not a payload.** 100 characters is the whole budget, and it is the only state that rides back with a press. The interaction payload gives you `custom_id`, `component_type`, and (for selects) `values`. Encode a verb and a ticket number, and look up the rest locally.

```
start:2417        # 10 chars
checkout:2417     # 13 chars
```

### 5.2 Three seconds, then fifteen minutes

**The two hard numbers**, both from [Receiving and Responding](https://docs.discord.com/developers/interactions/receiving-and-responding):

> "you **must send an initial response within 3 seconds of receiving the event**. If the 3 second deadline is exceeded, the token will be invalidated."

> "Interaction `tokens` are valid for **15 minutes** and can be used to send followup messages."

A button press is interaction type `3` (`MESSAGE_COMPONENT`). Callback types for the initial response:

| Value | Name | Effect |
| --- | --- | --- |
| 1 | `PONG` | ACK a ping (HTTP-endpoint mode only) |
| 4 | `CHANNEL_MESSAGE_WITH_SOURCE` | Reply with a new message |
| 5 | `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` | ACK now, send later; shows a loading state |
| 6 | `DEFERRED_UPDATE_MESSAGE` | Components only: ACK now, edit the original later; **no visible loading state** |
| 7 | `UPDATE_MESSAGE` | Components only: edit the message the button is on |
| 9 | `MODAL` | Pop a modal |

**Deferring converts the 3-second deadline into a 15-minute one, and nothing more.** It does not create a channel that survives a 5-minute Claude turn plus a laptop sleep. The token dies at 15 minutes regardless.

**The correct pattern for a "start session" button.** This is the load-bearing conclusion of this section.

1. On the press, respond **within 3 seconds** with `UPDATE_MESSAGE (7)` — repaint the ticket post to "starting", grey the button. This is a state change on a durable object, not a reply.
2. **Drop the interaction token.** Do not hold it. Do not plan a followup on it. A button is a doorbell, not a request/response socket.
3. Run the session. Report results by **posting a fresh message to the thread** (`POST /channels/{channel_id}/messages`) and by **editing the ticket post** (`PATCH /channels/{channel_id}/messages/{message_id}`), both on the bot token.

Channel messages never expire. Interaction tokens do. Anything that can outlive 15 minutes must land on a channel message.

The followup endpoints all key on the interaction token and all die with it:

```
PATCH  /webhooks/{application_id}/{interaction_token}/messages/@original
POST   /webhooks/{application_id}/{interaction_token}
PATCH  /webhooks/{application_id}/{interaction_token}/messages/{message_id}
DELETE /webhooks/{application_id}/{interaction_token}/messages/{message_id}
```

**Failure codes you will meet** ([Opcodes and status codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)):

| Code | Meaning | Cause here |
| --- | --- | --- |
| `10062` | Unknown interaction | Missed the 3-second window; the user sees "This application did not respond" |
| `40060` | "Interaction has already been acknowledged" | Two handlers ACKed the same press |
| `50027` | "Invalid webhook token provided" | Used the interaction token past 15 minutes |

One upside worth remembering: **interaction endpoints are exempt from the global 50 req/s limit**. Controls are cheap. Conversation is not.

### 5.3 Ephemeral replies in a shared thread

Flag `EPHEMERAL` = **64** (`1 << 6`). The message is visible only to the user who triggered the interaction — the right tool for a per-user answer in a thread several humans read. "You do not own this ticket." "A session is already running, started by @X."

Two limits: "It is not possible to edit a reply to change its ephemeral state once sent" ([discord.js guide](https://discordjs.guide/slash-commands/response-methods)), and an ephemeral message is reachable only through the interaction token, so it dies at 15 minutes and cannot be edited after.

### 5.4 Components V2: skip it

Opt in per message with the `IS_COMPONENTS_V2` flag, `1 << 15` = **32768**. When set:

- "The `content` and `embeds` fields will no longer work"
- "Attachments won't show by default — they must be exposed through components"
- "The `poll` and `stickers` fields are disabled"
- Messages allow up to 40 total components

New component types: `Section 9`, `Text Display 10`, `Thumbnail 11`, `Media Gallery 12`, `File 13`, `Container 17`, `Label 18`.

Legacy is safe: "Legacy message component behavior will **not** be deprecated and will continue to be available to your apps on a message-by-message basis" ([Components Overview](https://docs.discord.com/developers/components/overview)).

**Verdict: marginal for a ticket post.** V2 buys layout — a Container with a coloured accent bar, text and buttons interleaved — and costs `content` and `embeds`, and forces every attachment through a component. A ticket post is a title, a lane, a blocker list and two buttons. An embed does that today. Revisit only if visual grouping of many tickets in one message becomes the requirement.

---

## 6. Attachments

**Attachment object fields** ([Message resource](https://docs.discord.com/developers/resources/message)): `id`, `filename`, `content_type` (optional), `size` (bytes), `url`, `proxy_url`, `height`/`width` (optional), `ephemeral` (optional), `flags` (optional).

**Reading an upload needs the MESSAGE_CONTENT intent.** The intent gates `attachments` as well as `content` — see [1.3](#13-gateway-intents). A screenshot dropped into a thread with no mention arrives with an empty `attachments` array without it.

**CDN URLs are signed and expire.** Verbatim from the [API Reference](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls):

> "Attachments uploaded to Discord's CDN (like user and bot-uploaded images) have signed URLs with a preset expiry time. Discord automatically refreshes attachment CDN URLs that appear within the client, so when your app receives a payload with a signed URL (like when you fetch a message), it will be valid."
>
> "The standard CDN endpoints listed above are not signed, so they will not expire."

Query parameters, same page: `ex` = "Hex timestamp indicating when an attachment CDN URL will expire"; `is` = when it was issued; `hm` = "Unique signature that remains valid until the URL's expiration".

- **Auth:** the URL carries its own signature. No `Authorization` header. A plain GET works while `ex` is in the future.
- **Validity:** Discord's docs say "a preset expiry time" and **name no number**. The widely reported figure is **24 hours**, from Discord's September 2023 CDN-authentication announcement ([BleepingComputer](https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware-delivery/), [XDA](https://www.xda-developers.com/discord-download-links-expire-24-hours/)) — **press-sourced, not primary**. Read `ex` and trust it over any constant.
- **Refresh:** the documented way is to **re-fetch the message** (`GET /channels/{channel_id}/messages/{message_id}`). The docs guarantee the returned payload's URL "will be valid". A `POST /api/v9/attachments/refresh-urls` endpoint circulates in the community but appears in no published reference. Treat it as undocumented.

**Practical rule: download the bytes to local disk when the `MESSAGE_CREATE` arrives**, before handing anything to the agent. A CDN URL is never a durable pointer to a screenshot.

**Posting files back** ([Uploading files](https://docs.discord.com/developers/reference#uploading-files)): switch `Content-Type` from `application/json` to `multipart/form-data`. Parts are `payload_json` plus uniquely indexed `files[0]`, `files[1]`, … each with a `Content-Disposition` header. The `attachments` array in `payload_json` maps each file by `id` (an index placeholder) and `filename`. Embeds reference an upload as `attachment://filename.png`; supported embed image formats are `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`.

```jsonc
// payload_json part
{
  "content": "diff for ticket 2417",
  "attachments": [{ "id": 0, "filename": "patch.diff" }]
}
// plus a files[0] part carrying the bytes
```

**Size caps.** The message docs specify one number: "The maximum request size when sending a message is 25 MiB". Discord's developer docs publish **no bot upload cap**. Community and press figures: **10 MB** for a free user or non-boosted guild since September 2024, lowered from 25 MB ([Discord Previews](https://x.com/DiscordPreviews/status/1831066626411880866), [Dataconomy](https://dataconomy.com/2024/09/05/discord-upload-limit-10mb-per-file/)); boost Level 2 raises it to 50 MB, Level 3 to 100 MB. Bots historically sat at 8 MB and were raised toward the user default ([discord-api-docs #2037](https://github.com/discord/discord-api-docs/issues/2037), [#6058](https://github.com/discord/discord-api-docs/issues/6058) — the latter reports plain webhooks still returning `413 Payload Too Large (error code: 40005)` above 8 MB).

**Plan for 8–10 MB and handle `413`.** Agent output that exceeds it — a big log, a full diff — must be truncated or linked, not attached.

The 10-attachments-per-message figure is confirmed by error code `30015`. The message docs themselves specify no count; the nearest documented counts are on components (a Media Gallery holds 1–10 items; a modal File Upload allows 0–10 files).

---

## 7. A bot on a laptop that sleeps

### 7.1 RESUME vs re-IDENTIFY

From [Gateway](https://docs.discord.com/developers/events/gateway) and [Gateway Events](https://docs.discord.com/developers/events/gateway-events):

- The `Ready` event gives you **`session_id`** and **`resume_gateway_url`**. Cache both.
- Track the **`s`** (sequence) field on every dispatch (opcode `0`) — "sequence number of event used for resuming sessions and heartbeating". `s` is `null` when `op` is not `0`.
- To resume: open a socket to `resume_gateway_url` and send **Resume (opcode `6`)** with `{token, session_id, seq}`. "Unlike the initial connection, your app does **not** need to re-Identify when Resuming." A successful resume ends with a `Resumed` dispatch.
- **Reconnect (opcode `7`)**: "a client should reconnect to the gateway (and resume their existing session, if they have one)." Expect the server to close the socket a few seconds later.
- **Invalid Session (opcode `9`)**: the `d` field is a boolean, "whether the session may be resumable". "If the `d` field is set to `false` (which is most of the time), your app should disconnect" and re-Identify against the **cached gateway URL**, not the resume URL.

**Close codes that decide resume vs re-identify** ([Opcodes and status codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)):

| Code | Meaning | Reconnect? |
| --- | --- | --- |
| 4000 | "We're not sure what went wrong. Try reconnecting?" | yes |
| 4004 | "The account token sent with your identify payload is incorrect." | **no** |
| 4007 | "The sequence sent when resuming the session was invalid." | yes |
| 4008 | "You're sending payloads to us too quickly. Slow it down!" | yes |
| 4009 | "Your session timed out. Reconnect and start a new one." | yes, new session |
| 4013 / 4014 | invalid / disallowed Gateway Intent | **no** |

**`4009` is the sleep case.** A laptop that sleeps for an hour comes back to a timed-out session. Resume fails. You re-identify and get a fresh session with no history.

### 7.2 Heartbeat, and the zombie socket

- Heartbeat is **opcode `1`**. The interval arrives as `heartbeat_interval` (ms) in `Hello`. Delay the first beat by `heartbeat_interval * jitter`, jitter random in 0–1.
- Discord ACKs with **opcode `11`**.
- The zombie rule, verbatim: "If a client does not receive a heartbeat ACK between its attempts at sending heartbeats … the client should immediately terminate the connection with any close code besides `1000` or `1001`, then reconnect and attempt to Resume."

**The close code matters.** `1000` and `1001` tell Discord the session is finished and **destroy it**, making a later Resume impossible. Use `4000`.

**What sleep does at the socket level** (community-sourced: [WebSocket.org, Zombie Detection](https://websocket.org/guides/heartbeat/), [websockets docs, Keepalive and latency](https://websockets.readthedocs.io/en/stable/topics/keepalive.html)): macOS suspends the network stack, and the TCP connection is torn down or silently blackholed. Frequently **no FIN and no RST reach the peer**. The socket looks open to your process. Writes succeed into a buffer that goes nowhere. There is no error to catch.

**The only reliable detector is the missing heartbeat ACK.** That is exactly why Discord specifies the rule. A bot that sends heartbeats and never checks for an opcode-11 cannot tell a healthy connection from a dead one. It sits "connected" and silent indefinitely.

Two failure shapes, both verified in real agent projects on macOS (community-sourced):

- **Display sleep alone drops the socket.** [NousResearch/hermes-agent #21697](https://github.com/NousResearch/hermes-agent/issues/21697) (open): "when the display turns off or the screen locks (lid closed on MacBook, display sleep, or lock screen), the message channel (WebSocket) between the Hermes Agent client and the gateway can disconnect. This causes the agent to go offline and miss messages until the user manually wakes the machine". Suggested mitigations include an IOKit `NoIdleSleep` power assertion (the `caffeinate -s` mechanism) and auto-reconnect with exponential backoff.
- **Timers do not survive sleep, so the detector itself dies.** [openclaw/openclaw #9084](https://github.com/openclaw/openclaw/issues/9084) (closed): "The heartbeat timer … doesn't reliably resume after the host system (macOS) goes to sleep and wakes up. This leaves the heartbeat permanently stalled until the gateway is manually restarted." Root cause given: "Node.js `setTimeout` doesn't account for system sleep… Upon wake, the timer may be in an invalid state". The reporter's fix was an external cron watchdog that restarts the gateway when the heartbeat log line goes stale.

The second is the nastier one. **Your liveness check is itself a timer, and the same sleep that killed the socket can kill the timer.** Add a wall-clock drift check — compare the clock against the expected next-beat time — or a wake-event listener, and treat a large jump as "assume disconnected, reconnect, run catch-up".

### 7.3 Missed messages: REST catch-up

**Discord replays on a successful RESUME.** Verbatim: "After Resuming, your app will receive the missed events in the same way it would have had the connection had stayed active."

**Discord does not backfill for a process that was fully down.** Replay is a property of the *session*, and a session survives a disconnect only for a limited, undocumented window before `4009` or Invalid Session retires it. Once you re-IDENTIFY, the events sent in the gap are gone. The gateway has no "give me everything since sequence N" for a session it no longer holds, the docs never promise buffering across a process restart, and they never state how long a session stays resumable.

**The catch-up pattern is REST, and you must build it:**

```
GET /channels/{channel.id}/messages?after={last_seen_message_id}&limit=100
```

`around`, `before` and `after` are mutually exclusive. `limit` is **1–100, default 50** ([Message resource](https://docs.discord.com/developers/resources/message)). Paginate by advancing `after` to the newest id returned, until a page comes back short.

**Persist `last_seen_message_id` per thread to disk on every processed message.** That single durable value is what makes sleep survivable. RESUME covers short drops. Catch-up covers everything else. They are not alternatives — build both.

### 7.4 Duplicates and ordering

Discord does not promise exactly-once delivery. A resume replays events you may already have processed, if you crashed after acting and before persisting your cursor. An unclosed old socket delivers everything twice (see [8.2](#8-what-builders-of-agent-in-discord-bots-get-wrong)).

**Key an idempotency set on the message snowflake, persist it, and check it before spawning any Claude process.** Persisting matters: an in-memory dedupe set is empty after the restart that caused the duplicates. Make the check-and-mark **atomic**, not check-then-mark.

**Ordering.** Gateway dispatches carry a monotonically increasing `s` per session, which orders events *within one session* and is what Resume uses. Across sessions, `s` restarts and is useless.

**Snowflakes give a durable total order.** Per the [API Reference](https://docs.discord.com/developers/reference), a snowflake is 64 bits: bits 63–22 are "Milliseconds since Discord Epoch, the first second of 2015 or **1420070400000**", then 5 bits worker id, 5 bits process id, 12 bits increment.

```
timestamp_ms = (snowflake >> 22) + 1420070400000
```

Sorting by numeric id sorts by time. That is the ordering key for merging REST catch-up results with live gateway events. Compare as **integers or BigInt** — never as strings, and never as a JS `Number`. 64-bit ids exceed `Number.MAX_SAFE_INTEGER`, which is why the API returns them as strings.

---

## 8. What builders of agent-in-Discord bots get wrong

**Every claim in this section is community-sourced.** All URLs were fetched and confirmed to resolve, with a title matching the claim. None of it is a platform guarantee.

**8.1 — Rate-limit blowups from streaming edits.** Streaming LLM tokens by repeatedly editing one message is the most common design, and it hits per-route limits fast. The commonly cited "5 edits per 5 seconds per channel" is **not in Discord's rate-limit docs** — it is folklore with a retracted origin ([4.3](#43-rate-limits-documented-and-folklore)); it appears as an implementation note in [hermes-agent #16754](https://github.com/NousResearch/hermes-agent/issues/16754). Worse, the 429 does not always surface as a clean retry: [discord.py #9418, "Rate limits occasionally lead to errors"](https://github.com/Rapptz/discord.py/issues/9418) — "the expected behavior is to log a warning and reschedule the request… However, occasionally an `HTTPException` is raised instead", so "the requests are not rescheduled" and the update is simply lost. See also [discord-api-docs #1454](https://github.com/discord/discord-api-docs/issues/1454).
→ **Mitigation:** the hybrid in [4.4](#44-streaming-the-recommendation). Throttle to one edit per 1.0–1.5 s behind a coalescing timer that drops intermediate states.

**8.2 — Double-replying after a reconnect.** [hermes-agent #18187, "Discord adapter creates zombie websocket connection on reconnect, causing double responses"](https://github.com/NousResearch/hermes-agent/issues/18187): "`DiscordAdapter.connect()` creates a new `commands.Bot` client but never closes the old one. Discord doesn't immediately terminate the old websocket, leaving two live connections for a window of time. Both connections receive every incoming message, resulting in two separate agent turns being spawned — each generating a different response." The log shows the same message arriving twice ~400 ms apart. They *had* a deduplicator and it did not help: "The `MessageDeduplicator` (per-adapter instance) cannot prevent duplicates because both websockets deliver the event independently, and the two `on_message` coroutines may check `is_duplicate` before either has marked the ID as seen (race condition)."
→ **Mitigation:** close the old client before opening a new one. Make the dedupe check-and-mark atomic. A per-ticket lock around "spawn a session" is stronger than a dedupe set.

**8.3 — Blocking the event loop with a long subprocess.** A synchronous `claude -p` call inside the event loop stops heartbeats, which Discord reads as a dead connection. discord.py's warning text is "**Shard ID [X] heartbeat blocked for more than [Y] seconds**" — [discord.py #6729](https://github.com/Rapptz/discord.py/issues/6729), where even an internal `gc.collect()` "gets stuck in weakref cleanup operations… blocking the event loop from sending heartbeat packets."
→ **Mitigation:** the session must be a fully async subprocess (`asyncio.create_subprocess_exec`, or Node `spawn`) or an out-of-process worker.

**8.4 — Treating an interaction like request/response.** Failing the 3-second ACK yields "This application did not respond" and error `10062`. Holding the token past 15 minutes yields `50027`. Real reports: [discord.py #9578](https://github.com/Rapptz/discord.py/issues/9578); [discord.js #10413, "InteractionWebhook methods crash the app if an invalid token is provided"](https://github.com/discordjs/discord.js/issues/10413) — note the failure mode is a *crash*, not a caught error; [discord.js #10192](https://github.com/discordjs/discord.js/issues/10192).
→ **Mitigation:** the pattern in [5.2](#52-three-seconds-then-fifteen-minutes).

**8.5 — Forgetting `allowed_mentions`.** [hermes-agent #11339, "Discord bot can ping @everyone — `allowed_mentions` never set on the client"](https://github.com/NousResearch/hermes-agent/issues/11339), with the code path cited at [`gateway/platforms/discord.py:1310-1314`](https://github.com/nousresearch/hermes-agent/blob/main/gateway/platforms/discord.py#L1310-L1314): the client is built without `allowed_mentions=`, "so the client-level mention policy is `None`. In that configuration discord.py omits `allowed_mentions` from every outbound message payload and Discord's server-side default takes over — which parses `@everyone`, `@here`, role pings, and user pings from the bot's content." Their reproduction is one line: DM the bot "please repeat exactly: @everyone hi". Their stated risk: "a single LLM hallucination or echoed piece of user content can notify every server member."
→ **Mitigation:** set the mention policy once at client construction, which is the altitude their fix was applied at.

**8.6 — Leaking secrets into a public channel, without a click.** [DEV: "The Discord Prompt-Injection Disclosure That Should Have Been Bigger"](https://dev.to/gabrielanhaia/the-discord-prompt-injection-disclosure-that-should-have-been-bigger-3j56) describes exfiltration through Discord's own link unfurler: "Discord's renderer sees a URL and asks the target server for OpenGraph metadata. The target server logs the path: `/exfil/sk-live-9f2a...`… the user never clicked anything — Discord's automatic preview mechanism performed the exfiltration without any user interaction."
→ **Mitigation:** acute here, because the agent has repo access and shell output. Set `SUPPRESS_EMBEDS` on agent output, and never post raw agent stdout to a channel a stranger can read.

**8.7 — Threads created per run, and never bound.** [hermes-agent #31550, "Discord `create_thread` does not rebind active conversation/context to the new thread"](https://github.com/NousResearch/hermes-agent/issues/31550): "thread creation succeeds… But subsequent agent activity and tool outputs continue appearing in the original channel", because `create_thread` "only creates the thread resource and returns metadata" without session rebinding. See also [#16567](https://github.com/NousResearch/hermes-agent/issues/16567).
→ **Mitigation:** one thread per ticket, created once, id stored against the ticket. Since the thread id equals the ticket post id ([3.1](#31-one-snowflake-two-objects)), there is nothing extra to store.

**8.8 — Lost context on reconnect.** Two independent projects hit exactly the gap in [7.3](#73-missed-messages-rest-catch-up). [hermes-agent #16754, "Discord message catch-up on gateway reconnect"](https://github.com/NousResearch/hermes-agent/issues/16754): "When the Hermes Discord gateway goes offline (restart, crash, network issue), any messages sent by the user during the downtime are lost… it relies solely on WebSocket push notifications for real-time delivery. When the connection drops, there's no mechanism to retrieve messages that arrived while the bot was unavailable." Their proposed fix is exactly the REST catch-up pattern. And on macOS specifically — [openclaw #51116, "Discord WebSocket disconnects every ~10 minutes, messages lost during reconnect window"](https://github.com/openclaw/openclaw/issues/51116), reported on "macOS (Darwin 25.3.0, arm64)" over wired gigabit fibre: "Messages sent during the reconnect window are permanently lost. The bot does not replay missed events after reconnecting. This causes real reliability issues — user sends a message, gets no response, assumes the bot is offline." Their diagnosis is a full re-init instead of a RESUME on every drop.
→ **Mitigation:** implement RESUME properly *and* build the REST catch-up.

---

## 9. Libraries

Both are actively maintained as of August 2026. Both queue requests and honour the rate-limit headers for you, so a small bot rarely writes rate-limit code by hand. Both handle gateway reconnect and resume.

| | discord.js | discord.py |
| --- | --- | --- |
| Latest release | 14.27.0, 2026-07-15 | v2.7.1 |
| Last commit | 2026-08-08 | 2026-07-22 |
| Docs | [discord.js.org](https://discord.js.org), [discordjs.guide](https://discordjs.guide) | [discordpy.readthedocs.io](https://discordpy.readthedocs.io/en/stable/) |

Release and commit dates from the GitHub API on `discordjs/discord.js` and `Rapptz/discord.py`.

discord.js has the larger surface and the more current guide, and ships its REST layer as a maintained package (`@discordjs/rest`, 2.6.3, 2026-07-19) with an observable [`RateLimitData`](https://discord.js.org/docs/packages/discord.js/main/RateLimitData:Interface) event. Its `RESTOptions` defaults matter here:

| Option | Default | Meaning |
| --- | --- | --- |
| `globalRequestsPerSecond` | `50` | "the standard global limit used by Discord" |
| `offset` | `50` | extra milliseconds added to every rate-limit wait, to absorb clock skew |
| `timeout` | `15_000` | ms before a request is aborted |
| `retries` | `3` | retries for 5xx and timeouts |
| `rejectOnRateLimit` | `null` | **null = wait it out rather than throw** |
| `invalidRequestWarningInterval` | `0` | warn every N invalid requests inside the 10-minute window (0 = never) |

discord.py is the calmer, smaller API, and its [intents primer](https://discordpy.readthedocs.io/en/stable/intents.html) is the clearest short explanation of the MESSAGE_CONTENT trade-off in either ecosystem. It sleeps on the bucket reset and on `Retry-After` in [`discord/http.py`](https://github.com/Rapptz/discord.py/blob/master/discord/http.py).

**Two gaps, in both.**

1. Neither knows the undocumented 2-per-10-minutes channel-edit limit in advance. They discover it by receiving a 429 and sleeping for `retry_after`, which can block a shared queue for minutes. **Debouncing renames is the caller's job in either language.**
2. **If you fire edits faster than the bucket allows, neither errors — they silently queue, and the "live" stream falls arbitrarily far behind.** Latency, not exceptions, is the failure mode. Set `invalidRequestWarningInterval` and log the `rateLimited` event so lag is visible.

---

## 10. Numbers Discord will not publish

Every number here is real, load-bearing, and absent from the official documentation. Each one is a place where the design must read a runtime value rather than a constant.

| Limit | Working figure | Status |
| --- | --- | --- |
| Channel rename / topic edit | 2 per 10 minutes, per channel | Community-sourced, 2020, never confirmed. Read `retry_after`. [2.3](#23-renaming-is-the-scarcest-operation) |
| Edits to a message older than 1 hour (`30046`) | **unknown** | Error documented, rate never published, absent from headers. [3.5](#35-editing-the-ticket-post-error-30046) |
| Messages per channel | **unknown, dynamic** | The 5/5 figure was retracted in 2016. Read the headers. [4.3](#43-rate-limits-documented-and-folklore) |
| Active threads per guild | 1,000 | Documented to exist, number never stated. [3.4](#34-thread-limits-and-enumeration) |
| Members per thread | 1,000 (error `30033`) | Error code gives the number; prose does not. |
| Categories per guild | 50 | Community-sourced only. [2.2](#22-structural-limits) |
| Bot upload cap | 8–10 MB | Press and issue reports. Handle `413`. [6](#6-attachments) |
| Signed CDN URL lifetime | 24 hours | Press-sourced. Read the `ex` parameter. [6](#6-attachments) |
| How long a session stays resumable | **unknown** | Never stated. Assume it does not survive sleep. [7.3](#73-missed-messages-rest-catch-up) |

Discord's own position, from [Rate limits](https://docs.discord.com/developers/topics/rate-limits): "Because rate limits depend on a variety of factors and are subject to change, **rate limits should not be hard coded into your app**. Instead, your app should parse response headers."

---

## What this means for Discord mode

Grouped by the ticket each constraint feeds.

### For **Server reconciliation — how the bot owns the Discord tree, and what a closed map becomes**

- **A human creates the server.** The bot builds and owns everything inside it. Setup is a two-step wizard: the human creates the guild, then authorizes the invite URL with `scope=bot applications.commands` and `permissions=395405552720`.
- **Renaming is the scarcest operation in the whole design.** Budget 2 per 10 minutes per channel. A map title edit, a `closed-` prefix and a category rename all draw on the same bucket, and the channel **topic** shares it. Debounce renames behind a timer, coalesce them, and hold the current name in local state so a restart does not re-issue a rename that already applied. Put volatile state — lane, blocker count — in message content, never in the channel name or topic.
- **Archiving a closed map is a permission overwrite, not a feature.** Deny `377957124160` on the `@everyone` overwrite and add a member allow for the bot. Keep any `closed-` rename separate, or archiving inherits the rename budget.
- **Reorganizing the tree is serial.** One `parent_id` change per bulk-positions request (error `40009`). Sweeping N channels into an Archive category costs N sequential requests. Pace them against the 50 req/s global limit and treat the sweep as a background job.
- **`archived` on a thread, never `locked`.** Archived stays readable and searchable and reopens the instant anyone posts. Locked rejects a returning human outright and needs `MANAGE_THREADS` to undo. Set `auto_archive_duration: 10080`, and treat it as a request — a busy guild archives earlier.
- **Budget active threads.** The cap is real, undocumented, and community-guessed at 1,000. Archived threads do not count. Proactively `PATCH` `archived: true` on **Resolved** tickets rather than waiting for the timer.
- **Do not `PATCH` the ledger row on every sync tick.** Error `30046` caps edits to old messages at an unpublished rate. Debounce to one edit per ~30–60 s, skip byte-identical writes, and back off rather than retry.
- **Decide text channel vs forum channel.** A forum channel is the closer structural match — one API call per ticket instead of two, and `applied_tags` renders the **lane** as a filterable coloured chip. The price: the guild must be a Community server, and there is no channel body to post a "map opened" banner into.

### For **Prototype: a Claude turn inside a Discord thread**

- **Stream as edit-in-place within a chunk, new message across chunks**, on a 1.0–1.5 s timer, starting at 1.2 s. Pure edit-in-place is impossible past 2000 characters. Pure chunking shreds the transcript.
- **Hold a typing indicator while the turn runs.** One request per ~9 s, Discord's own sanctioned use, and far cheaper than an edit loop.
- **Rewrite tables before posting.** Discord has no table syntax. Agents emit GFM tables constantly, and they land as a wall of pipes. Rewrite into aligned text inside a fence, or into bullet lists.
- **Balance code fences on every intermediate edit**, and carry the language tag onto the next chunk. Copy openclaw's `chunk.ts` or unreasonable-llama's `split_message`.
- **The 2000 characters count raw markup.** A mention costs 21 characters, a custom emoji 27. A ticket post that mentions three people and links two channels burns ~105 characters before any prose.
- **Consider streaming into an embed `description` (4096 chars)** rather than `content` (2000). It halves the number of splits.
- **An edited ledger is a dashboard, not a feed.** Edits raise no notification and move nothing. Anything that must reach a human on a phone — a ticket reaching the **Frontier**, a session needing input — must be a newly created message.
- **A button is a doorbell.** ACK within 3 seconds with `UPDATE_MESSAGE (7)`, repaint the ticket post, grey the button, then discard the token. Report the result as a new thread message plus a `PATCH` of the ticket post.
- **Use ephemeral (`flags: 64`) for per-user answers** in a thread several humans read.

### For **Attachments and images — a phone photo into a Claude session**

- **The MESSAGE_CONTENT intent gates `attachments`, not just `content`.** Without it, a screenshot dropped into a thread with no mention arrives as an empty array. The intent is a portal toggle at this scale — no review, no verification.
- **Download the bytes on `MESSAGE_CREATE`.** A CDN URL is signed and expires; read `ex` rather than assuming 24 hours. Re-fetching the message is the documented refresh path. A CDN URL is never a durable pointer.
- **Budget 8–10 MB for uploads and handle `413`.** Discord publishes no bot cap. A big log or a full diff must be truncated or linked, not attached.
- **Post files back as `multipart/form-data`** with `payload_json` plus indexed `files[n]`, and reference them from embeds as `attachment://filename.png`.

### Cross-cutting, for every ticket on this map

- **Set `allowed_mentions` once at client construction, and re-send it on every edit.** Plain channel messages default to parsing `@everyone`, and the field is dropped on edit. This is a one-line fix and an embarrassing outage if missed.
- **Suppress embeds on agent output.** Discord's unfurler fetches URLs the agent emits, server-side, with no click. That is an exfiltration channel for an agent with repo access.
- **Never block the event loop with the Claude subprocess.** A blocked loop stops heartbeats and Discord drops the connection.
- **Persist `last_seen_message_id` per thread and run REST catch-up on every connect.** The gateway does not backfill a process that was down. This is the single feature that makes a sleeping laptop viable.
- **Dedupe on the message snowflake, in durable storage, with an atomic check-and-mark.** Order by snowflake compared as BigInt.
- **Detect death by missing heartbeat ACK, close with `4000`, and put a wall-clock watchdog behind the detector** — the same sleep that kills the socket can stall the timer that would notice.
