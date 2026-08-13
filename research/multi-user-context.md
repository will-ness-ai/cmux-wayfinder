# Research: multi-user conversation in one agent context

For [Wayfinder map: discord mode](https://github.com/will-ness-ai/cmux-wayfinder/issues/15), ticket [Research: multi-user conversation in one agent context](https://github.com/will-ness-ai/cmux-wayfinder/issues/18). Researched 2026-08-12.

**The problem.** In Discord mode, many humans can speak in one thread. All of their messages become user turns in one Claude Code session. A Claude Code user turn is a plain string. The harness has no first-class idea of who speaks.

Each claim below is marked **VERIFIED** (a primary source, a command, or a file) or **INFERENCE** (reasoning from the evidence). Discord platform mechanics are not in this document. They belong to [Research: Discord mechanics for agent conversations](https://github.com/will-ness-ai/cmux-wayfinder/issues/17).

## Answer in brief

1. **Anthropic gives you no speaker field.** The Messages API has `role` and `content` only. Speaker identity can live in the text, and nowhere else. Neither does Claude Code: no CLI flag, no transcript field, and no `stream-json` input field carries a speaker.
2. **Put the speaker in the message body.** Wrap each turn as `<message from="will" id="182…">text</message>`. This is the only channel that survives a `--resume`, because the turn is written to the transcript and the system prompt is not.
3. **Put the convention and the roster in a constant appended system prompt**, and pass it on every spawn. Without the explanation, the wrapper is noise the model can ignore. Keep it byte-identical, or you destroy the prompt cache on every message.
4. **Serialize turns. One `claude -p --resume` per session, with a queue.** Two concurrent resumes do not corrupt the file and do not fail. They fork the conversation and **one human's message is silently lost**. This is the most dangerous failure in the design.
5. **The mention joins the thread, not the message.** Require a mention to start a thread. Then answer every human message in that thread.
6. **Do not ask the model to judge if a message was for it.** The best model scores 64% on that task, and humans score 60-66%. Ship an explicit per-thread mute that any direct mention cancels.
7. **Do not build per-user memory. Keep per-thread state.** No shipped group bot keeps memory per person.
8. **Identity must not be able to detach quietly.** With no speaker marker, the agent does not say "unknown". It reads the environment and confidently names the owner of the Mac.

## 1. How to tell the model who speaks

| Mechanism | Where it exists | Does it reach the model? |
| --- | --- | --- |
| Name prefix in the content (`<@U123>: text`) | Application code only | Yes. It is the text. |
| OpenAI `name` field on a message | [Chat Completions spec](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) | Yes, but it is only sugar for a prefix |
| Anthropic per-message speaker field | Does not exist | Not applicable |
| System-prompt roster | Application code | Yes |
| XML envelope | Anthropic prompting guidance | Yes |
| Per-speaker memory | No mainstream group bot does this | Not applicable |

### Anthropic has no speaker affordance — VERIFIED

The [Messages API reference](https://platform.claude.com/docs/en/api/messages) gives each `messages[]` entry two fields: `role` and `content`. There is no `name`, no participant id, and no per-message metadata. The one identity-shaped field is the top-level `metadata.user_id`, which is an abuse-tracking id. Anthropic tells you to keep names, emails and phone numbers out of it, and it is per request, not per message.

**Result: the content block is the only place for speaker identity.**

Anthropic's [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) recommend XML tags to separate the parts of a prompt:

> XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs.

That is general advice. Anthropic publishes no speaker-attribution guidance for multi-human conversations (VERIFIED absent).

### The OpenAI `name` field is only a prefix — VERIFIED

The field exists on the `system`, `user`, `assistant` and `tool` message types, with one description in [`openai-python`](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_user_message_param.py) and the [OpenAPI spec](https://github.com/openai/openai-openapi/blob/master/openapi.yaml):

> An optional name for the participant. Provides the model information to differentiate between participants of the same role.

Three facts show it is not special:

- It is text in the prompt, not out-of-band data. OpenAI's [token-counting cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb) adds `tokens_per_name = 1` for a message that carries a name, and counts the name's own tokens. On `gpt-3.5-turbo-0301` the value was `-1`, because the name replaced the role in the chat template.
- The schema is a bare `type: string`. The often-repeated `^[a-zA-Z0-9_-]{1,64}$` rule is not in the spec.
- The Responses API dropped the field. It returns `unknown_parameter`, with no documented replacement ([thread 1](https://community.openai.com/t/dealing-with-multiple-participants-using-the-responses-api-message-name/1154818), [thread 2](https://community.openai.com/t/clarification-on-missing-name-field-in-responses-api-and-handling-multi-persona-multi-user-dialogues/1365804)). No OpenAI staff replied in either thread.

INFERENCE: OpenAI does not treat `name` as load-bearing, because the successor API removed it with no migration path.

### The system-prompt roster is the strongest documented pattern — VERIFIED

[ChatGPT-in-Slack](https://github.com/seratch/ChatGPT-in-Slack), written by a Slack staff engineer, does not only prefix the name. It teaches the model the convention. From [`app/env.py`](https://github.com/seratch/ChatGPT-in-Slack/blob/main/app/env.py):

```
You are a bot in a slack chat room. You might receive messages from multiple people.
Format bold text *like this*, italic text _like this_ and strikethrough text ~like this~.
Slack user IDs match the regex `<@U.*?>`.
Your Slack user ID is <@{bot_user_id}>.
Each message has the author's Slack user ID prepended, like the regex `^<@U.*?>: ` followed by the message text.
```

It does four things: it says the room has many people; it gives the id grammar; it gives the bot its own id, so the bot can see when a message names it; and it describes the prefix.

[llmcord](https://github.com/jakobdylanc/llmcord), a Discord bot, gives the same advice in its README: *"User messages are prefixed with their Discord ID as `<@ID>`. Use this format to mention users."*

**The convergent pattern is prefix plus a system-prompt sentence that explains the prefix.** Neither project uses the OpenAI `name` field, although both speak to OpenAI-compatible APIs.

### Research on speaker labels

- [Contrastive Speaker-Aware Learning (arXiv:2503.08842)](https://arxiv.org/abs/2503.08842) tags each utterance with a speaker id (`[Sα] utterance`) and reports gains on Ubuntu IRC and Movie Dialogues. VERIFIED that the method uses explicit tags. The ablation isolates the training objective, not the tags, so this is not a clean measurement of tags against no tags.
- [Addressee Recognition (arXiv:2501.16643)](https://arxiv.org/abs/2501.16643) — GPT-4o predicts who speaks next in three-way dialogue at accuracy *"only marginally above chance"*. Explicit addressees appear in about 20% of turns. VERIFIED.
- [EverMemBench (arXiv:2602.01313)](https://arxiv.org/html/2602.01313) — reasoning across speakers collapses. Gemini-3-Flash falls from 97.65% single-hop to 26.51% multi-hop; GPT-4.1-mini from 83.57% to 2.41%. Accuracy falls 54.5% → 33.6% → 19.7% as one, two and then three groups take part. The authors conclude *"cross-group attribution — not context length — is the dominant challenge."* VERIFIED.

## 2. What breaks without attribution

### Measured cost of a second speaker — VERIFIED

[Beyond Single-User Dialogue (arXiv:2506.10504)](https://arxiv.org/abs/2506.10504) is the closest source to this problem. The authors add a second speaker to MultiWOZ 2.1 (1,000 conversations, 7.36 turns on average, five domains) and measure the drop in Joint Goal Accuracy:

| Model | Average JGA drop | Worst domain |
| --- | --- | --- |
| GPT-4o | −3.54% | −7.1% |
| Claude 3.5 Sonnet | −3.26% | −6.7% |
| Gemini-2.0-Flash | −2.32% | — |
| LLaMA-3.1-8B | −1.06% | — |

The named failure modes are exactly the ones this map cares about:

- A value from one person is given to the other person.
- Two people's preferences collapse into one set.
- A correction by person A is applied to person B's request.

Read the number with care. **The paper tested no mitigation**, and the task is short and well structured. −3.5% is a floor, not a ceiling.

[LLMs Get Lost in Multi-Turn Conversation (arXiv:2505.06120)](https://arxiv.org/abs/2505.06120), Laban et al., Microsoft, measures a 39% average drop from single-turn to multi-turn across six tasks, including Python and API calling ([code](https://github.com/microsoft/lost_in_conversation)). Most of the loss is unreliability, not lost skill. The mechanism matters here:

> LLMs often make assumptions in early turns and prematurely attempt to generate final solutions, on which they overly rely […] when LLMs take a wrong turn in a conversation, they get lost and do not recover.

INFERENCE: a ticket thread is a long, underspecified, multi-turn conversation. An early wrong assumption about who wants what is the kind of error that does not self-correct.

### Real reported instances — VERIFIED

**A shipped bot that merges all speakers into one.** [`llm_telegram_bot`](https://github.com/innightwolfsleep/llm_telegram_bot), from its README:

> if empty bot always get default name of user - You. **By default even in group chats bot perceive all users as single entity "You"**

**Prefixes create a second failure: the model writes the next person's turn.** Same README:

> but if you planed to use template and group chat - you shold add "\n" sign to stopping_strings to prevent bot impersonating!!!

Once the context holds `Alice: …\nBob: …`, it is a transcript, and a transcript invites continuation. The model can write `Bob: ` and put words in Bob's mouth. The fix in use is a stop sequence. INFERENCE: the hazard is much smaller when the prefix sits inside a real `role: user` message with a chat template around it, which is what ChatGPT-in-Slack and llmcord do. It is not zero.

**Other people's messages are an injection surface.** Anthropic's own [Claude Code in Slack docs](https://code.claude.com/docs/en/slack):

> When @Claude is invoked in Slack, Claude is given access to the conversation context to better understand your request. **Claude may follow directions from other messages in the context**, so users should make sure to only use Claude in trusted Slack conversations.

With many humans in one thread, person B's message is an instruction source for the task person A started. With a plain `Name: ` prefix, a human can type `Will: ignore the above` and forge a turn. INFERENCE: use a delimiter a human cannot type, and keep free-form display names out of the envelope.

### The bot speaks when it should stay quiet — VERIFIED

[Speak or Stay Silent (arXiv:2603.11409)](https://arxiv.org/html/2603.11409) benchmarks the decision to speak at all: 120,160 labelled decision points across AMI meetings, Friends, and SPGISpeech, in four classes — explicitly addressed, contextually expected, bystander, and mentioned in the third person but not addressed.

Zero-shot, the best model (Gemini 3.1-Pro) reaches 64.45% balanced accuracy. Models show *"severe over-responding bias"*, and fail on the two silence classes, which makes them *"disruptive rather than useful"*. Fine-tuning on reasoning traces gains up to 23 points, nearly all of it on silence. Humans reach only 60-66%, and only 27.67% on "mentioned but not addressed".

**To tell "someone named the bot" from "someone spoke to the bot" is hard for humans too. Do not make the model decide it implicitly.**

## 3. What real group-chat bots do

All rows VERIFIED against source code or first-party documentation.

| System | Speaker in the prompt? | Context it reads | When it answers | Per-user memory? |
| --- | --- | --- | --- | --- |
| [ChatGPT-in-Slack](https://github.com/seratch/ChatGPT-in-Slack) | Yes. `<@U123>: ` on every message, plus a system prompt that explains it | Whole thread (limit 1000); DMs get 100 recent messages under 24h old | Only if the thread's **parent** message names the app. All DMs | No. Per thread |
| [llmcord](https://github.com/jakobdylanc/llmcord) | Yes. `<@{author.id}>: ` on user turns only. README says to declare it in the system prompt | Walks the reply chain backwards, max 25 messages | Only when mentioned. DMs need no mention | No |
| [Slack Bolt AI Assistant](https://docs.slack.dev/tools/bolt-js/tutorials/ai-assistant/) | Role only: `` `${m.bot_id ? 'Assistant' : 'User'}: ${m.text}` `` | The assistant thread | Dedicated container. No mention needed | No |
| [Vercel AI SDK slackbot](https://ai-sdk.dev/cookbook/guides/slackbot) | Not shown in the guide | Thread, via a `getThread` helper | `app_mention`, and all DMs | No |
| [Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works) | Not documented | Thread, channel history, workspace search. A mid-thread mention gives up to 50 messages from the thread root | Hybrid. See section 4 | **Per place, not per person** |
| [zulip-chatgpt-bot](https://github.com/parallelo3301/zulip-chatgpt-bot) | No. Mention text is stripped | Previous messages up to the token limit | Mention, `/gpt`, or DM | No |
| [llm_telegram_bot](https://github.com/innightwolfsleep/llm_telegram_bot) | Off by default. All users become "You" | Per-chat history | Group config | No |

Three points stand out:

1. **Every bot that handles more than one human writes the speaker into the message text.** None use the OpenAI `name` field, not even the ones that speak to OpenAI. llmcord [PR #102](https://github.com/jakobdylanc/llmcord/pull/102) exists because the author wanted *"a way to insert user IDs into the prompt manually for APIs that don't support the 'name' parameter."* The text prefix is the portable answer.
2. **They prefix the opaque id, not the display name** — `<@U123>`, not `Will`. A user cannot forge another user's mention token, the id survives a rename, and the bot can mention the person back correctly.
3. **None keep memory per user.** Memory is per thread, per channel, or per workspace. Claude Tag is explicit: *"Memory follows places the same way access does, and it accumulates for the team rather than for any individual."*

## 4. Addressing — when the bot answers

### Two camps and one hybrid

**Strict gate** (llmcord, ChatGPT-in-Slack). llmcord returns at once unless the bot is in `new_msg.mentions`. ChatGPT-in-Slack decides once for the whole thread: if the thread's root message does not name the app, it ignores the thread. The cost is real. A human who says "can you also check the logs" in a live thread is dropped in silence. That is llmcord [issue #69](https://github.com/jakobdylanc/llmcord/issues/69).

**Hybrid** (Claude Tag). Anthropic's [Control when Claude Tag responds](https://claude.com/docs/claude-tag/users/when-claude-responds) is the fullest public treatment of this problem:

> Claude replies without an @-mention in DMs, in any thread it's already part of, and to channel messages it judges warrant a reply. It's an ambient presence in the channel, and **the @-mention is how you guarantee a response, not a requirement for one.**

The key move is that **the mention joins the thread, not the message**. After it joins, every reply reaches Claude. From [how it works](https://claude.com/docs/claude-tag/concepts/how-it-works):

> Anyone in the channel can steer a running session by replying in its thread, not just the person who started it… Without re-mentioning `@Claude` or starting over, he replied in Jordan's thread, and **the session folded his instruction into work already in progress.**

> Once a session is active in a thread, it belongs to everyone there.

### Two humans talk to each other while the bot listens

Claude Tag answers this with explicit opt-out at three levels, not with model judgement:

| Control | Scope | Effect |
| --- | --- | --- |
| `@Claude only respond when I @-mention you` | One thread | Claude stops following the thread |
| `@Claude !mute` / `!unmute` | One thread | Silences it. Any direct mention unmutes |
| Respond-automatically toggle | Channel | Mention-only in that channel |
| Self-quieting | Channel | *"When a channel's messages stop giving Claude anything to respond to… Claude turns unprompted replies off there on its own."* |
| `/remove @Claude` | Channel | Ends its presence |

Two details are worth copying. Mute is per thread by design: run it at channel level and it posts a hint instead of acting. And **any direct mention unmutes**, so nobody is stuck with a bot they cannot wake.

For the opposite failure — a human speaks to the bot indirectly and is ignored — Claude Tag uses a visible signal, not a guess. The reply's display name separates an ambient reply (`Claude`) from a task session (`Claude [reviewing the launch checklist]`), so a human can see which one answered.

### Messages that arrive during a long turn — VERIFIED

Three real behaviours, at three points on a scale:

| System | Behaviour when a message arrives during a run |
| --- | --- |
| OpenAI Assistants API | Hard failure: `400 Can't add messages to thread while a run is active` ([n8n #13378](https://github.com/n8n-io/n8n/issues/13378), [openai-python #1023](https://github.com/openai/openai-python/issues/1023)). No built-in queue |
| llmcord | One task per message. A second mention starts a second independent chain, with no coordination |
| Claude Tag | Folds it in: *"While a session runs, check in by replying in the same thread… **it reads new replies as it works**"* |

Claude Tag also documents three edge cases that naive bots get wrong:

> **Editing a message**: Claude receives a note each time you edit, showing what the message said before the edit and what it says now. It reads the note but doesn't act on it, so it won't reply, redo finished work, or treat words you added as a new request.
> **Deleting a reply**: Claude gets no notification and keeps the version it already read.
> **Correcting course**: Claude acts on replies, not on edits or deletions.

And it ships an exit for a poisoned context, `@Claude !restart`:

> Use this when a session is stuck, or when it's carrying context you don't want the next reply to build on. Claude archives the current session and starts a fresh one in its place. The fresh session rereads the thread, so it keeps what's in the messages and drops everything else the old one was carrying.

INFERENCE: "fold in" is what humans expect, and the other two are what naive builds produce. But folding in needs a running agent that accepts input mid-loop, or a queue that appends waiting messages to the next turn. **One process per message with no mid-run input channel leaves the queue as the only option.** It must be a queue, not a parallel spawn. Section 5 shows what a parallel spawn does to a Claude Code session.

## 5. The Claude Code adaptation

Everything in this section was run live against **`claude` v2.1.229** on this Mac, with the working directory in a throwaway scratchpad. No real session was touched. Behaviour is version-specific: re-test before you build.

| # | Mechanism | Reaches model | Survives `--resume` | Model honours it | Transcript effect | Per message? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Body envelope** `<message from="will">…</message>` in the `-p` string | **Yes** | **Yes.** It is the turn. Stored verbatim, replayed forever | **Yes** | Stored verbatim. The human's literal text is now wrapped | **Yes** |
| 2 | `--append-system-prompt[-file]` | Yes | **No.** Per process. Re-pass it every turn | Yes | **None.** Never written to disk | Current turn only. A value that changes **destroys the prompt cache** |
| 3 | `CLAUDE.md` / memory | Yes | **No.** Re-read from disk every invocation | Yes | **None** | Only by rewriting the file per spawn. Racy, so unusable |
| 4a | `UserPromptSubmit` hook → `additionalContext` | **Yes** | **Yes.** Persisted as an `attachment` line | **Yes** | Clean. User text stays byte-exact | **Yes**, through an env var on the spawn |
| 4b | `UserPromptSubmit` hook → plain stdout | Yes | Yes. Stored as a `hook_success` attachment | Yes | Same as 4a | Yes |
| 4c | `UserPromptSubmit` hook → `updatedPrompt` | **No** | — | **No** | Nothing written | **Broken in 2.1.229, although documented** |
| 5 | `--input-format stream-json` richer message | **No** | — | **No** | Extra fields dropped in silence | No identity field exists |

### 5.1 The body envelope works — VERIFIED

Session `11d3f660`, no hooks and no system prompt:

- Turn 1: `-p '<message from="quinn">Say OK and nothing else.</message>'` → `OK`.
- Turn 2: `--resume … '<message from="rhea">Who was the human that sent the FIRST message…</message>'` → **`quinn`**.

Nothing strips the envelope. The transcript stores it exactly:

```json
{"type":"user","message":{"role":"user","content":"<message from=\"quinn\">Say OK and nothing else.</message>"}}
```

The prompt cache survives: turn 2 reported `cache_read=6702`, `cache_create=101`.

The one cost: the wrapper also appears in the `queue-operation` and `last-prompt` records, so the `/resume` picker shows the wrapper, not the clean human text.

### 5.2 The system prompt does not survive a resume — VERIFIED

This CLI has `--system-prompt`, `--append-system-prompt`, and also `--system-prompt-file` and `--append-system-prompt-file`, which work but are absent from the main help list. There is **no settings.json equivalent**: the documented key list at <https://code.claude.com/docs/en/settings> has no such key. The nearest is `outputStyle`, which is a named global preset.

- **The original append is gone after a resume.** Session `dd60bdcc`: turn 1 with `--append-system-prompt 'the secret codeword is ZQXW7741'` → `READY`. Turn 2 resumed without the flag → **`UNKNOWN`**. `grep -c 'ZQXW7741'` on the transcript returns **0**. The system prompt is never written to disk.
- **A new append does apply to a resumed turn.** Session `47510e03`: resumed with a new codeword → the model returned it.

So the flag is per process. Pass it on every invocation or it is gone.

**The prompt-cache trap decides the design** — VERIFIED:

| System prompt across two turns | Turn 2 `cache_read` | Turn 2 `cache_create` |
| --- | --- | --- |
| Constant | **6727** | 60 |
| Varies (`Speaker now: aaa` → `bbb`) | **0** | 6815 |

A constant appended system prompt, re-passed every turn, is free. Put the **changing speaker name** in it and you re-create the full ~6.7k-token prefix on every Discord message, forever. **Keep the part that changes at the end of the prompt, in the turn.**

### 5.3 CLAUDE.md is re-read every invocation — VERIFIED

Session `f3e9c59a`: `CLAUDE.md` held `ROSTER CODEWORD: AAA111`, and turn 1 answered `AAA111`. The file was rewritten to `BBB222`; the resumed turn 2 answered **`BBB222`**. The file body is not stored in the transcript.

So CLAUDE.md behaves like the system prompt: fresh per process, invisible to history. It suits a stable thread roster. It cannot carry a per-message speaker, because the bot would have to rewrite the file before each spawn, which races with any other spawn. Note that `--bare` and `--safe-mode` skip CLAUDE.md completely.

### 5.4 The `UserPromptSubmit` hook — the clean alternative

**It fires in headless `-p` mode and on resumed sessions** — VERIFIED, session `025edf81`, three invocations (one new, two resumed), hook fired all three times.

**The stdin payload holds no speaker** — VERIFIED:

```json
{"session_id":"025edf81-…","transcript_path":"/Users/…/025edf81-….jsonl",
 "cwd":"…","prompt_id":"e682a264-…","permission_mode":"default",
 "hook_event_name":"UserPromptSubmit","prompt":"Who is speaking to you right now?"}
```

The field is **`prompt`**, not `prompt_text` as <https://code.claude.com/docs/en/hooks> states. Nothing in the payload identifies a human.

**An environment variable is the only per-message identity channel a hook has** — VERIFIED. The hook is a child process, so it inherits the bot's environment. `DISCORD_SPEAKER=alice claude -p …` gave the hook `DISCORD_SPEAKER=alice`, and `bob` and `carol` on the two resumes.

**`additionalContext` works and persists** — VERIFIED, session `6f6faad6`. Turn 1 (speaker `zelda`) used a neutral prompt, so no name could leak into the reply. Turn 2 (speaker `yorick`) asked who sent the first message → **`zelda`**. It is stored as its own transcript line, parented to the user message:

```json
{"parentUuid":"e24ac25d-…","type":"attachment",
 "attachment":{"type":"hook_additional_context",
   "content":["The human speaking on this turn is: alice"],
   "hookName":"UserPromptSubmit","hookEvent":"UserPromptSubmit"}}
```

The user turn's `message.content` stays byte-exact with what the human typed, and the cache survives (`cache_read=6728`). Plain stdout from the hook does the same, stored as `attachment.type = "hook_success"`.

**`updatedPrompt` is documented but broken in 2.1.229** — VERIFIED. Session `eaa14e2c`: the hook fired (proved by its own log) and emitted `updatedPrompt` at both the top level and inside `hookSpecificOutput`, with the same envelope that makes the model answer `quinn` when it is sent in the prompt body. The model answered **`UNKNOWN`**, and the transcript stored the original prompt. Snake-case `updated_prompt` failed too. **Do not build on `updatedPrompt`.**

### 5.5 Silence is not neutral — VERIFIED

In the failed test above the model did not answer "unknown". It answered **`Willness`**, inferring the owner of the Mac from the environment block and the user's global `CLAUDE.md`. Another run's thinking read *"I have a user email: willness210@gmail.com"*.

**If the identity channel ever detaches, the agent attributes every Discord message to the owner of the Mac, with confidence.** This is the strongest argument for the envelope, which cannot detach.

### 5.6 Nothing else in the CLI carries identity — VERIFIED

`--session-id`, `--fork-session`, `--resume`, `--continue`, `--agents`, `--setting-sources` and `--include-partial-messages` all exist. None carries identity.

`--input-format stream-json` gives no richer message object. Three probes:

| Input | Result |
| --- | --- |
| `…"message":{"role":"user","content":"…","name":"delta"}` | `UNKNOWN`. `name` dropped in silence, with no error |
| `…"speaker":"epsilon","metadata":{"speaker":"epsilon"}…` | `UNKNOWN`. Dropped |
| `…"content":[{"type":"text","text":"[speaker=zeta] …"}]` | **`zeta`**. Only the text reaches the model |

This agrees with the SDK type at <https://code.claude.com/docs/en/agent-sdk/streaming-input>: `SDKUserMessage` is `{type, message: {role, content}, parent_tool_use_id}`, and the inner object is a plain Messages API message with no `name`.

### 5.7 What the transcript records for a user turn — VERIFIED

At `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`:

```json
{"parentUuid":"624ce1a0-…","isSidechain":false,"promptId":"e682a264-…",
 "type":"user","message":{"role":"user","content":"…"},
 "uuid":"e24ac25d-…","timestamp":"2026-08-13T03:06:51.792Z",
 "permissionMode":"default","promptSource":"sdk","userType":"external",
 "entrypoint":"sdk-cli","cwd":"…","sessionId":"…","version":"2.1.229","gitBranch":"HEAD"}
```

Three fields look identity-shaped and are not. `userType` (`"external"`), `promptSource` (`"sdk"`) and `entrypoint` (`"sdk-cli"`) are harness enums that describe **how** a turn arrived, not **who** sent it. Other line types are `queue-operation`, `attachment`, `assistant`, `last-prompt` and `mode`. `~/.claude/history.jsonl` holds only `display`, `pastedContents`, `timestamp`, `project` and `sessionId`.

**No field can hold a human's name.** A bot could append a synthetic attachment line itself, but that means guessing the current leaf UUID, racing any live process, and depending on an undocumented format. The hook writes the identical line safely. Keep to the hook.

### 5.8 Two concurrent resumes lose a turn, in silence — VERIFIED

This is the most important finding in the document.

Session `65f2bd02`, one turn established, then two `claude -p --resume <same id>` processes started at the same moment (`ALPHA` and `BETA`). Both exited 0. Both printed a correct answer. The JSONL stayed valid, because appends are line-atomic — **there is no file corruption**. But the conversation tree forked:

```
FORK POINTS (parent with >1 child):
  parent 1b0e3146 has children ['0051752f', 'dc0a855d']

last-prompt leaf records, in file order:
  leaf 1b0e3146  lastPrompt='Remember the number 5. Say OK and nothing else.'
  leaf 13bd8c7c  lastPrompt='Reply with exactly: ALPHA'
  leaf d6302db3  lastPrompt='Reply with exactly: BETA'
```

Neither process saw the other's message. Both resumed from the same leaf and made sibling branches. The last `last-prompt` written wins. A third resume was asked what it had received:

```
ALPHA=no BETA=yes
```

**The ALPHA turn was discarded in silence.** In Discord both humans got a reply and nothing looked wrong. In the agent, one person's message never happened.

The bot must hold one in-flight resume per session, with a queue. `--resume` now finds a session by id from any directory (<https://code.claude.com/docs/en/headless>), so **the lock must key on the session id, not the working directory**.

### 5.9 The recommended invocation

One process per delivered prompt:

```bash
claude -p \
  --resume "$SESSION_ID" \
  --append-system-prompt-file /path/to/thread-preamble.txt \
  --output-format stream-json --verbose \
  --allowedTools "…" \
  '<message from="will" id="182…">the human'"'"'s text, verbatim</message>'
```

`thread-preamble.txt` stays byte-identical for the life of the thread:

```
This session is a Discord thread. Several different humans talk to you here.
Every user turn arrives wrapped as <message from="NAME" id="DISCORD_ID">…</message>.
NAME is the human speaking on that turn; it changes from turn to turn.
Never assume the machine's owner is the speaker. Address people by name.
Thread roster: will (182…), sam (447…), …
```

Why this shape:

1. **Only the envelope survives everything.** It is the turn, so past speakers stay attributable forever. The system prompt cannot do this, because it never reaches the transcript.
2. **It cannot detach in silence.** No hook to fail, no env var to forget, no settings file to load. It works under `--bare` and `--safe-mode`.
3. **The prompt cache stays intact**, because the part that changes sits at the end.
4. **Batching falls out of the queue for free.** Messages that arrive during a turn become one next prompt with several elements, which is one spawn instead of two and gives the model a natural multi-speaker view:

```
<message from="will" id="182…">can you check the auth flow</message>
<message from="sam" id="447…">+1, and the token refresh</message>
```

If `message.content` must stay byte-exact with what humans typed, swap the envelope for the `UserPromptSubmit` hook with `additionalContext`, reading the speaker from an env var on the spawn. It is verified to work and to persist. It costs a settings file, a hook script and an env var, and it goes dark under `--bare` and `--safe-mode`.

## 6. What this leaves open

1. **Envelope identifier.** Display names change and collide. Discord ids are stable but mean nothing to the model. Carrying both is cheap. Confirm that is wanted.
2. **`--bare` or not.** It cuts startup time and is the documented choice for scripted calls, but it disables hooks and CLAUDE.md **and forces `ANTHROPIC_API_KEY`** — OAuth and the keychain are never read. If Discord mode must bill to the Max subscription, `--bare` is out. This also decides whether the hook mechanism exists at all.
3. **Compaction.** Untested (INFERENCE). Envelope text is part of the message, so a summary keeps it. A `hook_additional_context` attachment might be dropped. If long threads matter, this favours the envelope again.
4. **Roster churn.** Each edit to the preamble busts the cache once. That is fine when membership changes rarely. A live per-message roster cannot live in the system prompt.
5. **Queue policy.** Whether a message that arrives mid-turn batches into the next turn, interrupts, or waits — and what Discord shows the humans while they wait.

