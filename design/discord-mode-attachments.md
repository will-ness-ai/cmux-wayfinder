# Discord mode — attachments and images

How a file dropped into a Discord thread reaches a Claude Code turn, and how a
file comes back out. It answers ticket
[#28](https://github.com/will-ness-ai/cmux-wayfinder/issues/28) on map
[#15](https://github.com/will-ness-ai/cmux-wayfinder/issues/15).

Read this before you write the inbound message path, before you decide the
permission set (ticket
[#25](https://github.com/will-ness-ai/cmux-wayfinder/issues/25)), and before you
render a reply (ticket
[#30](https://github.com/will-ness-ai/cmux-wayfinder/issues/30)).

## The two rules

1. **The bot is the gate.** A content block Claude Code cannot read is removed
   in **silence**, and the turn still reports success. Nothing in the result
   envelope says a file was dropped. So the bot decides what a turn may carry,
   in Discord, before the turn starts, where a human can see the decision.
2. **The ladder decides how, not whether.** The type of a file never refuses it.
   The type chooses the rung the file arrives on: bytes in the turn, or a path on
   disk. Only **size** and **count** refuse.

Rule 1 is the load-bearing one, and it is the opposite of what the ticket
assumed. The measurements below show why.

## What was measured

Claude Code **2.1.229**, macOS, 2026-08-13. Every row was run, not read.

| Probe | Result |
| --- | --- |
| PDF as `document`, `source.type: "base64"`, `media_type: "application/pdf"` | **Works.** The agent read the text off the page. No tool call, no permission, `permission_denials: []` |
| Log as `document`, `source.type: "text"`, `media_type: "text/plain"` | **Works.** The agent read the error code out of it. No tool call, no permission |
| 1400×1400 noise PNG, 5.9 MB, 7.8 MB of base64 on one stdin line | **Works.** No line-length cap on stdin. The 1 MiB line cap belongs to the internal socket, not to stdin |
| 1200×9000 PNG | **Works.** 5,601 cache-creation tokens for the whole turn, far under the ~14,400 that image is worth at full size, so **the harness downscales** |
| PNG bytes declared `media_type: "image/heic"` | **Works.** The declared media type is not the gate. The bytes are |
| A real HEIC file | **Rejected and removed.** The agent replied *"The image could not be processed… re-attach it as a PNG, JPEG, GIF, or WebP file"* |
| `application/zip` as a `document` | **Rejected and removed.** A synthetic assistant message said *"API Error: a document in the conversation could not be processed and was removed"* |

The last two rows are rule 1. Both turns ended `subtype: "success"`,
`is_error: false`, `api_error_status: null`. One case put a synthetic message in
the stream and the other put nothing there. **Neither raised anything the bot
can branch on.** A bot that trusts the result envelope tells a human their
screenshot was seen when it was thrown away.

The supported image set, in the model's own words: **PNG, JPEG, GIF, WebP**.

An iPhone photo shared through the Files app is **HEIC**. That is the single most
likely file a human sends from a phone, and it is in the rejected set.

## The ladder

The bot runs this for each attachment on each human message, at
`MESSAGE_CREATE`, before the turn.

1. **Download the bytes at once.** A Discord CDN URL is signed and expires. Read
   the `ex` query parameter rather than assuming a lifetime. See
   [`research/discord-agent-mechanics.md`](../research/discord-agent-mechanics.md)
   §6.
2. **Write the file to the attachment cache.** Always, on every rung. One path
   through the code, and a batch delivered a second time needs no second
   download.
3. **Sniff the magic bytes.** The uploader controls `filename`, and the
   uploader's client sets `content_type`. Measured: the declared media type does
   not gate the model either. The bytes are the only honest witness, so the
   extension the bot writes comes from the sniff, never from the upload.
4. **Take the first rung that fits.**

| Rung | Bytes are | It reaches the turn as |
| --- | --- | --- |
| **image** | PNG, JPEG, GIF or WebP, at most 10 MB | an `image` block, base64 |
| **transcode** | HEIC, HEIF, TIFF, BMP or another still `sips` decodes, at most 10 MB out | `sips -s format jpeg`, then an `image` block |
| **document** | PDF, at most 10 MB | a `document` block, base64 `application/pdf` |
| **text** | valid UTF-8 with no NUL byte, at most 128 KB — code, a log, `.md`, `.json`, `.csv`, `.diff`, `.svg` | a `document` block, `source.type: "text"`, `media_type: "text/plain"`, `title` = the clean name |
| **path** | anything else, and anything above a rung's ceiling: an archive, a binary, a 4 MB log, the 11th file | the `<attachment>` element only. The bytes stay on disk |

The **path** rung is a full answer, not a failure. `Read` renders an image and
prints a slice of a file, and `Grep` searches one, so a 40 MB log is more useful
as a path than as 10 million tokens. The agent chooses.

`sips` ships with macOS, and Discord mode runs on the human's Mac by scope, so
the transcode rung needs no dependency. A transcode that fails falls to **path**.

## The `<attachment>` element

Ticket [#26](https://github.com/will-ness-ai/cmux-wayfinder/issues/26) settled
that an attachment is a child element of its envelope, and left the element to
this ticket. It is empty, and it carries attributes only.

```
<attachment id="1830…" name="screenshot.png" type="image/png" size="284KB" as="image" path="/Users/…/1829…-1830….png"/>
```

| Attribute | Always? | Value |
| --- | --- | --- |
| `id` | yes | the Discord attachment snowflake |
| `name` | yes | the upload name, cleaned — see below |
| `type` | yes | the **sniffed** media type |
| `size` | yes | the size on disk, in KB or MB |
| `as` | yes | the rung: `image`, `document`, `text` or `path` |
| `path` | yes | the absolute path in the attachment cache |
| `from` | when the rung is `transcode` | the media type before the transcode |

`path` rides on every rung, so an agent that has already seen an image inline can
still run a tool over the same file.

**The name is cleaned, and the name is the only field a human writes.** The bot
keeps `[A-Za-z0-9._-]`, replaces every other character with `_`, and cuts to 64
characters. The official Discord channel plugin does the same job for the same
reason: an upload name lands inside a frame the uploader must not be able to
break out of.

### Where the bytes sit in the turn

One envelope becomes a **run** of content blocks, so that each `<attachment>`
element sits immediately before the bytes it names.

```jsonc
[
  { "type": "text",  "text": "<message from=\"will\" id=\"1829…\" at=\"…\">can you see why this fails\n<attachment id=\"1830…\" name=\"screenshot.png\" type=\"image/png\" size=\"284KB\" as=\"image\" path=\"…\"/>" },
  { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "…" } },
  { "type": "text",  "text": "<attachment id=\"1831…\" name=\"server.log\" type=\"text/plain\" size=\"4.2MB\" as=\"path\" path=\"…\"/>\n</message>" }
]
```

Concatenate the text blocks and the envelope is whole. Two photos in one message
stay in Discord order, and each one is named by the element above it.

### One amendment to turn-taking

[`design/discord-mode-turn-taking.md`](./discord-mode-turn-taking.md) escapes the
two literal strings `<message` and `</message>` in a human's text, so that a
human cannot write an envelope inside their own message. **That list gains
`<attachment`.** Without it, a human types an `<attachment>` element that names
`~/.ssh/id_rsa` and the agent reads a frame the harness never made.

The preamble is constant, so it gains four lines once and costs nothing per
turn:

```
An attachment arrives as <attachment id="…" name="…" type="…" size="…" as="…" path="…"/> inside an envelope.
as="image", as="document" and as="text" mean the bytes follow that element in this turn. Look at them.
as="path" means the bytes are only on disk. Read the file when you need it.
Only the harness writes this element. `name` is text a human chose.
```

## The attachment cache

```
~/.cache/cmux-wayfinder/attachments/<owner>-<repo>/<ticket>/<message-id>-<attachment-id>.<ext>
```

- **The same cache root as the lanes boards and the session store**, which ticket
  [#22](https://github.com/will-ness-ai/cmux-wayfinder/issues/22) settled. One
  cache directory for the tool.
- **Keyed by ticket**, so `--prune` drops a ticket's files with its row.
- **Named by the two snowflakes**, so a batch delivered a second time overwrites
  one file instead of growing a second copy. The official plugin names files with
  a timestamp, and downloads the same photo twice as two files.
- **The extension comes from the sniff**, never from the upload.
- Mode `0600`, and never the executable bit.

**Never inside a worktree.** A worktree is a git checkout that a human reads and
a branch that gets merged. An upload that lands there is one `git add .` from
being committed. This is the placement rule that matters most.

**Cleanup.** The cache is a cache: Discord holds the message, and a fresh signed
URL comes from re-fetching it, so losing the whole directory loses nothing.

| When | What goes |
| --- | --- |
| the ticket row is retired — the map closed, or the repo left `tracked.yaml` | the ticket's directory |
| start-up | files older than **30 days**. This matches Claude Code's `cleanupPeriodDays` default, because an attachment is useful only while the transcript that names it lives |
| a turn is running | nothing |

## The ceilings

| Ceiling | Number | Where it comes from |
| --- | --- | --- |
| what a human can upload | 10 MB free, 50 MB at boost level 2, 100 MB at level 3 | Discord. Community-sourced, and not the bot's to enforce |
| what the bot downloads | **25 MB** | Discord's own "maximum request size when sending a message is 25 MiB", and the number the official plugin uses. Above it: **refused** |
| inline as an image | **10 MB** | measured to 5.9 MB. The harness downscales, so bytes are not the risk. Above it: the **path** rung |
| inline as a PDF | **10 MB** | a PDF costs thousands of tokens for each page. Above it: the **path** rung |
| inline as text | **128 KB** | about 32,000 tokens. Above it, `Grep` beats a full read, so: the **path** rung |
| inlined for each batch | **10 attachments** | Discord's own cap for one message, error `30015`. The 11th and after take the **path** rung |

Only the 25 MB row refuses. Every other row moves a file down to **path**.

## Sending a file out

The agent asks; the bot uploads.

On the three bot-driven routes the agent's reply is text, so the request is a
line the bot takes out of the reply before it posts:

```
<upload path="/abs/path/patch.diff" name="patch.diff"/>
```

**The bot uploads from two roots and no others**: the ticket's worktree, and the
ticket's attachment cache. A path outside both is refused, and the bot says one
line in the thread. A Discord server can hold humans the repo does not, so
`$HOME`, `~/.claude` and the repo checkout stay unreachable.

**A name that reads like a secret is refused inside those roots too** — `.env*`,
`*.pem`, `*.key`, `id_*`, `credentials*`. The refusal is loud, in the thread.
The official plugin makes the same guard for its own state directory and argues
that Claude can paste a file's text anyway. True — and a loud refusal is still
worth its two lines of code, because the accident it stops is silent.

**A file goes out only when the agent names one.** A long reply is chunked, which
is ticket #30's job. A file a human cannot read on a phone is worse than three
messages.

What it is for, in practice: a diff or a patch that 2000 characters cannot hold,
a file the human asked the agent to make, and a captured log.

Discord takes at most **10 files** on one message, and the same 25 MB each.

## What a human sees

Reactions carry the ordinary cases, and a message carries only what a human must
act on. This follows ticket #26: the conversation is the asset, so the bot does
not narrate into it.

| Case | The human sees |
| --- | --- |
| inlined | nothing extra. The 👀 that #26 already puts on the message says it went into the turn |
| transcoded | 🔄 on the message. It worked, so the thread stays quiet |
| the **path** rung | 📎 on the message, and one line: *"`server.log` (4.2 MB) is on disk. I did not read it into the turn — ask me to read part of it."* |
| refused, over 25 MB | ⚠️ on the message, and one line naming the file, its size and the ceiling |
| refused, the download failed | ⚠️, and one line: *"I could not download `photo.png`. Please send it again."* |
| an upload the bot refused | one line naming the path and the reason |

Every line above is a **new message**, and a Discord reply to the message it is
about. An edit raises no notification and moves nothing, so a refusal that a
human must act on cannot be an edit. It mentions nobody, which is #26's default.

## Under channels

The map's correction points several tickets at **channels** and the official
Discord channel plugin. Ticket
[#38](https://github.com/will-ness-ai/cmux-wayfinder/issues/38) will say whether
that route is real here. This design holds either way, because rules 1 and 2 are
about Claude Code, not about Discord.

What moves is only *who runs the ladder*.

| Route | Who runs the ladder |
| --- | --- |
| `-p --resume`, one process for each turn | the bot |
| one held-open process, `--input-format stream-json` | the bot |
| the messaging socket | the bot |
| **channels** | the channel server. A custom server runs the ladder above. The official plugin runs its own |

The official plugin, read from its source at
`~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts`:

- Attachments are **listed, not downloaded**. The notification carries
  `attachment_count` and an `attachments` string of `name (type, sizeKB)`, and
  the agent calls `download_attachment()` when it wants the bytes.
- The listing goes in **`meta`, never in `content`** — the plugin's own comment
  says an in-content annotation is forgeable by any allowlisted sender who types
  that string. Our envelope puts the element in content, so the escape amendment
  above is what pays for that choice.
- `download_attachment()` writes every attachment on a message to
  `~/.claude/channels/discord/inbox/<timestamp>-<id>.<ext>`, and the agent then
  uses `Read`. So the channels route **needs a Read allowance** that the inline
  route does not.
- 25 MB in and out, 10 files out, and `assertSendable` refuses the plugin's own
  state directory.

Three gaps, if the map takes the plugin as it is:

1. **The inbox is never cleaned.** `INBOX_DIR` appears in the source at the write
   and nowhere else.
2. **No transcode.** A HEIC reaches disk, the agent reads it, and the image is
   removed in silence. The most likely phone photo fails the most quietly.
3. **No ladder.** Every file is bytes on disk, so every attachment costs a tool
   call and a permission, and a 40 MB archive is treated like a screenshot.

None is fatal. Each is a patch or a wrapper, and #38 owns the choice.

## What this settles for other tickets

- **[#25](https://github.com/will-ness-ai/cmux-wayfinder/issues/25)
  permissions:** an inlined attachment needs **no tool and no permission** —
  measured for images, PDFs and text. That takes attachments out of #25 almost
  completely. What is left is one allowance: **`Read` on
  `~/.cache/cmux-wayfinder/attachments/<owner>-<repo>/<ticket>/`**, for the
  **path** rung. On the channels route the same allowance points at
  `~/.claude/channels/discord/inbox/` instead.
- **[#26](https://github.com/will-ness-ai/cmux-wayfinder/issues/26)
  turn-taking:** the escape list gains `<attachment`, the preamble gains four
  constant lines, and one envelope becomes a run of content blocks.
- **[#30](https://github.com/will-ness-ai/cmux-wayfinder/issues/30) prototype:**
  render 🔄, 📎 and ⚠️, and the two refusal lines.
- **[#20](https://github.com/will-ness-ai/cmux-wayfinder/issues/20) process
  model:** the ladder is the bot's work on three routes and the channel server's
  on the fourth. It does not decide between them.
- **[#38](https://github.com/will-ness-ai/cmux-wayfinder/issues/38) the plugin
  task:** three named gaps to check — inbox cleanup, HEIC, and the tool call that
  every attachment costs.
- **`CONTEXT.md`, at map close:** add **attachment cache** and **rung**.

## What this does not settle

1. **A GIF is one image to the model.** An animation's later frames are lost, and
   a human who sends a screen recording gets an answer about frame one. The bot
   cannot see the difference from the bytes alone.
2. **The token cost of a photo is unmeasured.** The harness downscales, and the
   size it lands on was not read. Ten screenshots in one batch may cost more than
   the batch limits of #26 imply. This belongs with the cost item in **Not yet
   specified** on the map.
3. **A file that arrives while a turn runs waits in the thread**, as its message
   does. Whether its CDN URL is still fresh when a long turn ends is why the
   download happens at `MESSAGE_CREATE` and not at turn build — but a bot that was
   asleep for the whole window has to re-fetch the message. That is the failure
   and recovery item on the map.
