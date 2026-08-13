# Research: driving a Claude Code session from a bot

Findings for [ticket #16](https://github.com/will-ness-ai/cmux-wayfinder/issues/16) on the [discord mode map](https://github.com/will-ness-ai/cmux-wayfinder/issues/15).

Tested against **Claude Code 2.1.229** on macOS, 2026-08-12. Doc sources are at `https://code.claude.com/docs/en/`.

Each claim carries a confidence marker:

- **DOCUMENTED** — the official docs or `claude --help` state it.
- **OBSERVED** — a probe on this machine showed it. The command is given.
- **INFERRED** — reasoned from the above. Treat as a risk, not a fact.
- **INTERNAL** — found in the shipped binary, absent from the docs. It works today and can break in any release.

Version sensitivity is high. Claude Code ships almost daily, and this note is a snapshot of 2.1.229.

## Headline

Six findings change the shape of Discord mode. The rest of this note supports them.

0. **Channels are the supported way to push a message into a live session** — an MCP server that injects external events into a running session, with an official **Discord** plugin that already does threads, attachments and message editing. It is a research preview. This is the headline, and it displaces findings 1 and 2 as the first thing to evaluate. (§2.4)
1. **One process can take many turns.** `--input-format stream-json` keeps a single `claude` process alive across user messages, in one session, with context intact. The map assumed one `claude -p --resume` per message. That is no longer the only option. (§2.2)
2. **A running session has an inbox.** Every `claude` process — TUI included — opens a Unix socket that accepts a user message. This is INTERNAL, not documented, and channels supersede it. (§2.3)
3. **Hooks are a full side channel, and one of them can wait.** Hooks fire in both TUI and headless. A `PreToolUse` hook blocks the agent while it runs, for up to 10 minutes, and can allow or deny the tool. This is a working mechanism for "ask Discord for permission". Hooks also support an `http` type, so the bot can receive a POST instead of running a script. (§4)
4. **A headless turn accepts an image.** A base64 image block over `--input-format stream-json` works. A phone photo can reach the agent. (§6)
5. **The transcript format is explicitly unstable.** The docs tell you not to parse `.jsonl` files. The Agent SDK exposes `listSessions()` and `getSessionMessages()` for the same job. (§7)

## 1. Starting, resuming and stopping

### 1.1 The flags that matter

All are OBSERVED in `claude --help` on 2.1.229.

| Flag | Effect |
| --- | --- |
| `-p`, `--print` | Non-interactive. Runs the prompt and exits. |
| `-r`, `--resume [id]` | Resume by session id. With no value, opens an interactive picker. |
| `-c`, `--continue` | Resume the most recent session in this directory. |
| `--session-id <uuid>` | Pin the session id. Must be a valid UUID. |
| `--fork-session` | On resume, write a new session id instead of reusing the original. |
| `--input-format <text\|stream-json>` | Print mode only. `stream-json` is the multi-turn input channel. |
| `--output-format <text\|json\|stream-json>` | Print mode only. |
| `--include-partial-messages` | Adds token-level deltas. Needs `--print` and `--output-format=stream-json`. |
| `--replay-user-messages` | Echoes stdin user messages back on stdout, for acknowledgement. |
| `--forward-subagent-text` | Forwards subagent text and thinking, tagged with `parent_tool_use_id`. |
| `--permission-mode <mode>` | `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`, `manual`, `plan`. |
| `--allowedTools` / `--disallowedTools` | Permission rules, e.g. `"Read,Edit,Bash(git *)"`. |
| `--settings <file-or-json>` | Extra settings as a path **or an inline JSON string**. Carries hooks. |
| `--max-turns <n>` | Caps agentic turns. Ends with `error_max_turns`. |
| `--max-budget-usd <amount>` | Caps spend. Ends with `error_max_budget_usd`. |
| `--no-session-persistence` | Print mode only. Writes no transcript. |
| `--bare` | Skips discovery of hooks, skills, plugins, MCP and CLAUDE.md. |
| `--channels <servers...>` | Loads channel plugins (§2.4). **Hidden from `--help`** during the preview. |
| `--dangerously-load-development-channels <servers...>` | Loads a channel that is not on the allowlist. Local development only. Hidden too. |

**DOCUMENTED** conflicts: `--print` refuses `--bg`, and refuses `--cloud <description>`.

### 1.2 What a resume restores

**DOCUMENTED** as restored: conversation history, model, the session agent and system prompt, the active goal, and scheduled tasks that have not expired.

**DOCUMENTED** as *not* restored, and this is the trap for a bot:

- **Every configuration flag.** `--settings`, `--mcp-config`, `--add-dir`, `--plugin-dir` and `--fallback-model` must be passed again on **every** resume. A bot that attaches its hooks through `--settings` must re-attach them each turn, or it goes deaf.
- **Permission mode.** `plan` and `bypassPermissions` are never restored. `auto` restores only if the account still qualifies.
- Directories added mid-session with `/add-dir`.

### 1.3 TUI and headless are the same session

**OBSERVED**: a session started in the TUI resumes under `-p --resume <id>`, and the session id does not change. **DOCUMENTED**: nothing in the store records the mode. The transcript is one file either way.

### 1.4 Cross-directory resume

**DOCUMENTED**: from v2.1.223, `claude --resume <id>` runs from any directory. Lookup order is the current project and its git worktrees, then every other project on the machine. Two copies of the same session id make the lookup **fail** rather than pick one.

**DOCUMENTED**: same machine only. The transcript must exist locally.

This matters for ticket **Where a session runs and what remembers it**: a session whose worktree was removed is still resumable, because the transcript lives under `~/.claude/`, not in the worktree.

### 1.5 The summary dialog

**DOCUMENTED**: on resume, Claude Code offers "resume from summary" only when **all** of these hold — a Pro or Max plan, inactive for about an hour, over 100,000 tokens, and an expired prompt cache.

**INFERRED, and an open risk**: the docs do not say what a non-interactive `-p --resume` does when it meets that condition. A bot-driven session is exactly the shape that trips it — long, idle for hours between Discord messages, and large. **Not tested here.** Probe this before the build.

### 1.6 Stopping

**DOCUMENTED**: SIGTERM on a `-p` run aborts the turn, kills the process tree of any running Bash command, runs `SessionEnd` hooks, and exits **143**. Transcripts are written continuously, so the session stays resumable.

## 2. Feeding a session — four routes

This is the core of the ticket. Four ways exist to put a human message into a session. Read §2.4 first: it is the supported one, and it was missed at charting.

### 2.1 One process per message — `-p --resume`

The baseline, and what the map assumed. Each message spawns a process, replays history, answers, and exits.

Costs: process start on every message, and every configuration flag re-passed (§1.2).

### 2.2 One process, many messages — `--input-format stream-json`

**OBSERVED, decisive.** Two user messages were written to the stdin of one process:

```sh
cat turns.jsonl | claude -p \
  --input-format stream-json --output-format stream-json --verbose
```

Each line of `turns.jsonl` is one user turn:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

The result: **one process, two turns, one session id, context intact.** Turn 2 answered a question about turn 1's content. Nine events came out, with `result` twice — `num_turns: 1` each time, `subtype: "success"`, and the same `session_id`.

Two consequences for a stream reader:

- **`system/init` is emitted again at the start of every turn**, not once per process. A reader keyed on "init means a new session" is wrong.
- The process exits when stdin closes. Hold stdin open to hold the session open.

`--replay-user-messages` echoes each accepted stdin message back on stdout, which gives the bot an acknowledgement that a Discord message landed.

**Trade-off** against §2.1: a live process holds context and skips replay, but it is state the bot must supervise — one process per active conversation, lost if the bot restarts.

### 2.3 The messaging socket — INTERNAL

**OBSERVED**: the `system/init` event carries `messaging_socket_path`, pointing at `/tmp/cc-socks/<pid>.sock`.

**OBSERVED**: that directory holds live sockets whose pids match **running interactive TUI sessions** on this machine, not only print-mode runs.

**INTERNAL**: the shipped binary contains a usage example for it:

```sh
{ echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}'
  echo '{"type":"user","message":{"role":"user","content":"hello"}}'
} | socat - UNIX-CONNECT:<socket path>
```

Binary strings tagged `[uds-messaging]` show the protocol: newline-delimited JSON, an optional auth handshake, user messages "routed to queue" with a priority, `file_attachments` materialisation, control actions, and a 1 MiB cap on a line without a newline. It refuses a non-local socket path.

**Practical route**: the bot spawns the session, so it can set `CLAUDE_CODE_MESSAGING_TOKEN` itself and then talk to that session's socket.

**Not tested**: no message was injected into a live session, because that would interrupt a real session belonging to the user.

**Weigh this carefully.** It is undocumented and unsupported. It can vanish in any release. **Prefer §2.4**, which reaches the same live TUI session on a supported contract.

### 2.4 Channels — the supported push into a live session

**DOCUMENTED**: `https://code.claude.com/docs/en/channels` and `channels-reference`.

A **channel** is an MCP server that Claude Code spawns over stdio, which declares `capabilities.experimental["claude/channel"]` and then emits `notifications/claude/channel`. Claude Code injects each event into the running session as a tagged block:

```
<channel source="discord" attr="value">the message body</channel>
```

The `source` attribute is set from the registered channel name.

**OBSERVED** in the 2.1.229 binary: `--channels <servers...>`, `--dangerously-load-development-channels <servers...>`, `channelsEnabled`, `allowedChannelPlugins`, `claude/channel` and `claude/channel/permission` are all present.

**OBSERVED**: neither `--channels` nor `--dangerously-load-development-channels` appears in `claude --help` on 2.1.229. The flags work; they are hidden during the preview. Do not conclude from `--help` that the feature is absent.

#### Delivery

**DOCUMENTED**, and this is the constraint that shapes the design:

- Events **queue; they do not interrupt the current turn.** Several events arriving during one long turn are delivered together on the **next** turn.
- Claude Code never acknowledges a notification. The MCP call resolves when the event is written to the transport, not when Claude reads it.
- If the session did not load the server as a channel, or org policy blocks it, events are **silently dropped**.
- For independent event streams that must run concurrently, the docs say run **separate sessions** — which matches one session per ticket.

#### Replying outward

**DOCUMENTED**: there is no built-in reply tool. The channel server declares an ordinary MCP tool (the plugins call it `reply`), and the server's `instructions` field tells Claude when to use it. The terminal shows the inbound message and a short confirmation of the reply, not the reply text.

#### Permission relay

**DOCUMENTED**: a channel opts in with `capabilities.experimental["claude/channel/permission"]`. Then:

1. Claude Code emits `notifications/claude/channel/permission_request` with `request_id`, `tool_name`, `description` and `input_preview`. The `request_id` is five letters from `a-z` without `l`.
2. The server relays the prompt to the remote human.
3. The human replies `yes <id>` or `no <id>`.
4. The server emits `notifications/claude/channel/permission` with `behavior: "allow" | "deny"`.

**The local terminal dialog stays open in parallel. Whichever answer arrives first wins; the other is dropped.** There is no fixed ten-minute ceiling as with a blocking hook (§4.2).

**Security note, DOCUMENTED**: anyone who can reply through the channel can approve tool use. The allowlist is the whole defence.

#### Sender gating

**DOCUMENTED**: the server holds a sender allowlist and drops non-members **silently**, before notifying. Gate on the **sender's identity, not the room** — in a group channel, gating on the room lets any member inject. The plugins pair by DM: the human DMs the bot, the bot returns a code, the human approves the code in the Claude Code session.

#### The official Discord plugin

**DOCUMENTED**, and it is close to what this map wants:

- DMs by default, with **guild channels and threads opt-in** through its `access.json`.
- **File attachments** — up to 10 files, 25 MB each. Long replies auto-chunk.
- **`edit_message`** for editing a message in place.
- **`reply_to`** for threading.
- Inbound files are not auto-downloaded; the agent calls `download_attachment()`.

Telegram, iMessage and a `fakechat` development demo ship alongside it.

#### Maturity

**DOCUMENTED**: research preview. The flag syntax and the protocol contract may change. `--channels` accepts only plugins on an Anthropic-maintained allowlist, or an org's `allowedChannelPlugins`; anything else needs `--dangerously-load-development-channels`, which the binary's own text limits to local development. Org policy `channelsEnabled` must be true on Team/Enterprise. Not available on Bedrock, Google Cloud or Microsoft Foundry, and Anthropic authentication is required.

#### What it means here

Channels reach a **live** session, so the shape the map wanted — a real Claude session in a cmux tab, fed from Discord, watchable with `ctrl+o` — is available on a supported contract, with a reference implementation to copy. The cost is the preview status, the allowlist gate, and next-turn delivery rather than immediate.

The three routes above stay relevant: they run a session with **no** live process attached, which is what a phone-only conversation with nobody at the terminal actually is.

### 2.5 Interrupting a turn

**DOCUMENTED**: the Agent SDK exposes `interrupt()` on the query object, and it needs streaming-input mode. **OBSERVED**: `system/init` advertises `capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]`, so the protocol is feature-detectable. **INFERRED**: the plain CLI has no documented interrupt other than a signal.

## 3. The stream a bot parses

`--output-format stream-json` emits newline-delimited JSON. **DOCUMENTED**: it requires `--print`, so a TUI session cannot emit it.

### 3.1 Event types

OBSERVED in the probe, beyond the four the docs lead with:

| `type` | `subtype` | Carries |
| --- | --- | --- |
| `system` | `init` | `session_id`, `model`, `cwd`, `tools`, `slash_commands`, `permissionMode`, `capabilities`, `messaging_socket_path`, `claude_code_version` |
| `system` | `hook_started` | `hook_id`, `hook_name`, `hook_event` |
| `system` | `hook_response` | `hook_id`, `stdout`, `stderr`, `exit_code`, `outcome` |
| `system` | `compact_boundary` | Context was compacted |
| `system` | `api_retry` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status` |
| `assistant` | — | `message.content[]` of `text`, `thinking` and `tool_use` blocks |
| `user` | — | `message.content[]` of `tool_result` blocks, with `is_error` |
| `rate_limit_event` | — | `rate_limit_info` with `status`, `resetsAt`, `rateLimitType` |
| `stream_event` | — | Raw API deltas. Only with `--include-partial-messages` |
| `result` | `success` \| `error_*` | The terminal event of a turn |

The `hook_started` / `hook_response` pair means the bot **sees its own hooks fire in the stream**. That closes the loop between §2 and §4.

`rate_limit_event` gives the bot a live read on the account's five-hour window, which bears on ticket **Cost and rate control** in the map's fog.

### 3.2 The `result` event

OBSERVED keys: `subtype`, `is_error`, `result`, `session_id`, `num_turns`, `stop_reason`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `api_error_status`.

**`permission_denials` is an array on every result.** It is the direct answer to "the agent stopped, why?" — ticket **Permissions in headless** asks for exactly that.

Error subtypes: `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`.

### 3.3 Subagents

**DOCUMENTED**: messages carry `parent_tool_use_id`. It is `null` for the main thread and set to the spawning `tool_use` id for subagent work. `--forward-subagent-text` opts into subagent text and thinking appearing at all.

So a Discord renderer can fold subagent output under the tool call that started it, rather than interleaving it with the main thread. That is a direct input to the prototype ticket **Prototype: a Claude turn inside a Discord thread**.

## 4. Hooks — the side channel

**DOCUMENTED**: hooks fire in the TUI *and* in headless. This makes them the one channel that works the same whichever way the session runs.

### 4.1 Payload

Every hook receives JSON on stdin with common fields:

```json
{
  "session_id": "<uuid>",
  "transcript_path": "~/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse"
}
```

Event-specific fields include `tool_name` / `tool_input` / `tool_use_id` on the tool events, `prompt` on `UserPromptSubmit`, `last_assistant_message` and `stop_reason` on `Stop` and `SubagentStop`, `agent_id` and `agent_type` on subagent events, and `start_reason` / `end_reason` on the session events.

**OBSERVED** in the binary: `PermissionRequest`, `SubagentStop`, `UserPromptSubmit`, `PostToolUseFailure`, `SessionEnd`, `PreCompact` and `CwdChanged` all appear as event names in 2.1.229.

### 4.2 Blocking and deciding

**DOCUMENTED**: matching hooks run in **parallel**, and the agent waits for all of them. Exit 2 blocks on a blocking event. On stdout, a hook returns JSON:

```json
{
  "continue": false,
  "systemMessage": "shown to the user",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "why",
    "updatedInput": { "...": "rewritten tool input" },
    "additionalContext": "text injected into the conversation"
  }
}
```

Two capabilities matter for Discord mode:

- **A hook can decide a tool call.** `PreToolUse` returning `permissionDecision: "allow"` approves it; `"deny"` blocks it. Where several hooks answer, the most restrictive wins (`deny` > `defer` > `ask` > `allow`).
- **A hook can inject text.** `UserPromptSubmit`, `SessionStart` and `PostToolUse` can push `additionalContext` into the conversation.

**The timeout is the mechanism.** A command, HTTP or MCP hook may run for up to **10 minutes** by default, and the agent is blocked for that time. So "relay the permission request to Discord, wait for a human to tap Approve, answer the hook" works within a ten-minute human response window. Past it, the hook times out. Ticket **Permissions in headless** asks what happens while it waits — this is the answer, and the ten minutes is the budget.

### 4.3 Hook types beyond `command`

**DOCUMENTED**: four types exist.

| Type | Shape | Timeout |
| --- | --- | --- |
| `command` | Runs a shell command | 10 min |
| `http` | POSTs to a URL, with `headers` and `allowedEnvVars` for secret interpolation | 10 min |
| `prompt` | Asks a small model, returns `{"ok":bool,"reason":str}` | 30 s |
| `agent` | Spawns a subagent with tools, same return shape | 60 s |

**OBSERVED** in the binary: `allowedEnvVars` is real, and gates which environment variables an HTTP hook may interpolate into headers.

The `http` type removes a whole layer: the bot runs an HTTP server on the Mac and receives hook events directly, instead of shipping a script that shells back to it.

### 4.4 Attaching hooks per session

**DOCUMENTED**: `--settings` takes a path *or an inline JSON string*, so a bot attaches its own hooks to its own sessions and never edits the user's global config.

**OBSERVED precedent**: cmux already does exactly this. Its live `claude` processes carry a `--settings` JSON string wiring `SessionStart`, `Stop`, `SubagentStop`, `SessionEnd`, `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `PermissionRequest` to `cmux hooks …` commands, some marked `"async": true`.

Two consequences. The pattern is proven on this exact stack. And **cmux's hooks and the bot's hooks would both be live on a checked-out session**, so they must compose rather than collide — a live question for ticket **Checkout and handback**.

### 4.5 Notification — the "needs a human" signal

**DOCUMENTED** matchers on the `Notification` event:

| Matcher | Fires when |
| --- | --- |
| `permission_prompt` | A tool needs approval and the human has been silent about 6 s |
| `idle_prompt` | Claude finished about 60 s ago and the human has not typed |
| `agent_needs_input` | A background session waits on input |
| `agent_completed` | A background session finished or failed |

These are the ping triggers the map's fog patch **Notification and ping policy** is waiting on.

## 5. Permissions in headless

**DOCUMENTED**: headless denies any tool that is not pre-approved and shows no prompt. Confirmed as the starting position.

The routes around it, in increasing risk:

1. `--allowedTools` with permission-rule syntax, e.g. `"Read,Edit,Bash(git *)"`. Static, and re-passed on every resume.
2. `--permission-mode`, remembering that `plan` and `bypassPermissions` never survive a resume.
3. A **`PreToolUse` hook that decides dynamically** (§4.2). This is the route that can ask Discord.
4. The Agent SDK's `canUseTool` callback. **DOCUMENTED** for Python.

**DOCUMENTED caveat**: the `PermissionRequest` hook event is conditional in headless — it fires when the SDK's `canUseTool` supplies the prompt, or for tool calls inside background subagents. In a plain `-p` run, use `PreToolUse` instead. A bot that wires only `PermissionRequest` will look correct and never fire.

## 6. Images and attachments

**OBSERVED, tested end to end.** A 64×64 solid red PNG was base64-encoded into a stdin content block:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}},
  {"type":"text","text":"Name the dominant colour of this image in exactly one word."}
]}}
```

The agent answered `Red`. A following text-only turn, in the same process, correctly recalled that the first message held an image.

So the path for ticket **Attachments and images** is: download the Discord attachment, base64 it, send it as an `image` block on the stream-json stdin. No file is written to the worktree, and no `Read` tool permission is needed.

**INTERNAL**: the messaging socket (§2.3) also mentions `file_attachments`, suggesting a second route. Untested.

## 7. The session store

### 7.1 Location and naming

**DOCUMENTED**: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, or under `$CLAUDE_CONFIG_DIR` when set.

**DOCUMENTED** encoding: every non-alphanumeric character of the absolute path becomes `-`. Over 200 characters, the name is truncated and a hash of the full path appended.

```
/Users/dev/Projects/example-repo   ->   -Users-dev-Projects-example-repo
```

**OBSERVED**: a git worktree gets its own encoded directory, because its path differs.

### 7.2 The format is unstable by design

**DOCUMENTED, and it overrides any field list**: "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead."

Entries are one JSON object per line, threaded by `uuid` and `parentUuid`, with `sessionId`, `cwd`, `gitBranch` and `timestamp`, and `isSidechain` marking subagent work. **OBSERVED**: files are mode `600`.

**DOCUMENTED alternative**: the Agent SDK exposes `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()` and `tagSession()` (with `snake_case` names in Python). This is the supported way to enumerate sessions. There is no CLI command that lists sessions as JSON; `--resume` with no value opens an interactive picker.

**Recommendation for ticket "Where a session runs and what remembers it"**: keep the bot's own store of ticket → session id → working directory → thread id, and treat the transcript as opaque. Read it through the SDK, never by parsing lines.

### 7.3 Retention

**DOCUMENTED**: `cleanupPeriodDays` in `settings.json`, default **30**, minimum 1. Claude Code deletes transcripts older than that **at startup**. Auto-memory files are excluded from the sweep.

A Discord thread outlives its session by default. A conversation quiet for over 30 days loses its transcript, and the thread then refers to a session that no longer exists. The map's fog patch **Failure and recovery** must cover it; raising `cleanupPeriodDays` is the cheap mitigation.

### 7.4 Other paths under `~/.claude/`

`settings.json` (user settings and hooks), `history.jsonl` (prompt and paste history), `daemon.lock` / `daemon.log` / `daemon.status.json` (the background-agent daemon), `.last-cleanup` (timestamp of the last sweep), `backups/`, `cache/`, `todos/`, `file-history/`, and `.credentials.json` — never read the last one.

## 8. Concurrency and liveness

**OBSERVED**: many `claude` processes run at once on this machine, and cmux already drives about a dozen.

**DOCUMENTED**: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` caps subagent fan-out per session at 20 by default. Subagent nesting reaches 3 levels.

**OBSERVED**: two processes resumed the **same** session id concurrently, and both wrote to the same transcript. **INFERRED**: transcripts are append-only with no mutex, so concurrent drivers interleave and can corrupt the thread. The map's rule "exactly one driver at a time" is therefore not a preference — it is a correctness requirement the platform does not enforce. The bot must enforce it.

**Liveness**: there is **no supported per-session signal** that tells you whether a session is being driven right now. Two INTERNAL routes exist — `/tmp/cc-socks/<pid>.sock` (§2.3) shows a live process per pid, and `~/.claude/daemon.lock` holds the daemon pid. Both are unsupported. A bot should track the processes it spawned and treat everything else as unknown.

## 9. Corrections to the map's charting facts

The map records five facts from a first capability pass. Verifying them:

| Charted fact | Verdict |
| --- | --- |
| Resume by UUID works; transcripts at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` | **Confirmed.** Cross-directory since v2.1.223, same machine only. |
| Interactive and headless are interchangeable; the mode is not stored | **Confirmed.** |
| `--output-format stream-json` is headless-only | **Confirmed.** |
| There is no supported way to send a message into a running TUI session | **Wrong.** **Channels** are a documented, supported push into a live session, with an official Discord plugin (§2.4). An INTERNAL socket inbox also exists (§2.3). |
| Headless denies any tool that is not pre-approved and shows no prompt | **Confirmed as the default, but not the whole picture.** A `PreToolUse` hook decides tool calls dynamically and blocks the agent up to 10 minutes while it decides (§4.2). |

And one charted assumption is now wrong, twice over:

> "The bot drives headless: one `claude -p --resume` per message."

- One process can take **many** messages (§2.2).
- The bot need not drive headless at all. A channel feeds a **live** session (§2.4).

So the driver model is a real decision with four candidate routes, not a given. It belongs to ticket **CLI surface and process model — what cmux-sync becomes**.

The rest of the map's charted shape survives. Structure, scope and ownership are untouched by this note.

## 10. What this settles, per ticket

| Ticket | What this note gives it |
| --- | --- |
| **CLI surface and process model** | Four feeding routes with their trade-offs (§2). The one-process-per-message assumption is no longer forced, and channels remove the need to drive headless at all. |
| **Where a session runs and what remembers it** | Cross-directory resume survives a removed worktree (§1.4). Do not parse transcripts; use the SDK (§7.2). 30-day retention kills old conversations (§7.3). |
| **Permissions in headless** | Two mechanisms: the channel permission relay, answered `yes <id>` / `no <id>` with the terminal dialog live in parallel (§2.4), and a `PreToolUse` hook that decides and blocks up to 10 min (§4.2). `permission_denials` on every result explains a stop (§3.2). Wire `PreToolUse`, not `PermissionRequest` (§5). |
| **Turn-taking with several humans** | One driver at a time is a correctness requirement, not a preference (§8). Channel sender gating must key on the **sender**, not the room (§2.4). |
| **Attachments and images** | Base64 image block over stream-json stdin, verified working (§6). The Discord channel plugin already carries attachments both ways (§2.4). |
| **Prototype: a Claude turn in a thread** | The full event vocabulary to render, and `parent_tool_use_id` for folding subagents (§3). Under channels the rendering problem changes shape — the plugin auto-chunks and can `edit_message` (§2.4). |
| **Checkout and handback** | Channels reach a session a human is watching, so checkout may stop being a handover at all (§2.4). cmux's own hooks are already attached and must compose with the bot's (§4.4). |
| Fog: **Notification and ping policy** | The four `Notification` matchers and their timings (§4.5). |
| Fog: **Cost and rate control** | `rate_limit_event` on the stream, and `total_cost_usd` per result (§3). |

## 11. Not tested

Carry these into the build as risks.

- What a non-interactive `-p --resume` does when it meets the summary dialog (§1.5). The most likely bot-breaking unknown.
- Injecting a message into a live session over the messaging socket (§2.3). Existence is observed; the write path is not.
- Whether an `http` hook behaves under a bot that restarts while a hook is in flight.
- Long-run behaviour of a held-open stream-json process over hours of Discord idling.
- **Every channels claim in §2.4 is DOCUMENTED, not run.** No channel was enabled on this machine. Before the design leans on channels, stand up the official Discord plugin and confirm: that this account is inside the preview rollout, that guild channels and threads work as the docs claim, and how next-turn delivery feels when a human sends three messages in a row.
