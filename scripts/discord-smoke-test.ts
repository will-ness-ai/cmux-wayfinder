#!/usr/bin/env bun
/**
 * Probe a provisioned Discord bot against everything Discord mode must do:
 * connect the gateway with the intents it needs, then make each structure the
 * design calls for — a category per repo, a channel per map, a ticket post, a
 * thread on that post, and a read-only channel for a closed map.
 *
 * Stage 6 of `scripts/discord-setup-wizard.sh` runs this. It is also safe to
 * run alone, at any later time, to prove the token still works.
 *
 * Usage:  bun scripts/discord-smoke-test.ts [--keep]
 *         --keep   leave the probe channels in the test guild
 */

export {};

const API = "https://discord.com/api/v10";

/** GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT — see the wizard for the rationale. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const KEEP = process.argv.includes("--keep");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    detail: string,
  ) {
    super(detail);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${RED}✗${RESET} ${name} is not set. Run scripts/discord-setup-wizard.sh, or export it.`,
    );
    process.exit(2);
  }
  return value;
}

const TOKEN = required("DISCORD_BOT_TOKEN");
const APPLICATION_ID = required("DISCORD_APPLICATION_ID");
const GUILD_ID = required("DISCORD_TEST_GUILD_ID");

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "cmux-wayfinder-smoke-test (https://github.com/will-ness-ai/cmux-wayfinder, 0.1.0)",
        ...init.headers,
      },
    });

    if (res.status === 429 && attempt < 3) {
      const body = (await res.json()) as { retry_after?: number };
      await Bun.sleep((body.retry_after ?? 1) * 1000 + 250);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let code: number | undefined;
      let message = text;
      try {
        const parsed = JSON.parse(text) as { code?: number; message?: string };
        code = parsed.code;
        message = parsed.message ?? text;
      } catch {
        // Discord returned a non-JSON error page; the raw text is the detail.
      }
      throw new ApiError(res.status, code, `HTTP ${res.status} — ${message}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Resolve after READY, or reject with what the gateway refused and why. */
async function identify(): Promise<{ user: string; sessionId: string }> {
  const { url } = await api<{ url: string }>("/gateway/bot");
  const socket = new WebSocket(`${url}?v=10&encoding=json`);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no READY within 20s — the gateway never answered"));
    }, 20_000);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };

    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as {
        op: number;
        t?: string;
        d?: unknown;
      };

      if (frame.op === 10) {
        socket.send(
          JSON.stringify({
            op: 2,
            d: {
              token: TOKEN,
              intents: INTENTS,
              properties: { os: "darwin", browser: "cmux-wayfinder", device: "cmux-wayfinder" },
            },
          }),
        );
        return;
      }

      if (frame.op === 0 && frame.t === "READY") {
        const data = frame.d as {
          user: { username: string };
          session_id: string;
        };
        settle(() => {
          socket.close(1000);
          resolve({ user: data.user.username, sessionId: data.session_id });
        });
      }
    });

    socket.addEventListener("close", (event) => {
      const reason =
        event.code === 4014
          ? "4014 disallowed intents — turn MESSAGE CONTENT INTENT on, on the Bot page"
          : event.code === 4013
            ? "4013 invalid intents — the intent bitfield this script sends is wrong"
            : event.code === 4004
              ? "4004 authentication failed — DISCORD_BOT_TOKEN is wrong or was reset"
              : `closed with ${event.code} ${event.reason}`;
      settle(() => reject(new Error(reason)));
    });

    socket.addEventListener("error", () => {
      settle(() => reject(new Error("the gateway socket errored before READY")));
    });
  });
}

interface Channel {
  id: string;
  name: string;
}

const created: Array<{ id: string; label: string }> = [];

async function createChannel(body: Record<string, unknown>, label: string): Promise<Channel> {
  const channel = await api<Channel>(`/guilds/${GUILD_ID}/channels`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  created.push({ id: channel.id, label });
  return channel;
}

let failures = 0;

function pass(what: string, detail: string): void {
  console.log(`  ${GREEN}✓${RESET} ${what}${DIM} — ${detail}${RESET}`);
}

function fail(what: string, error: unknown, missing: string): void {
  failures++;
  const detail = error instanceof Error ? error.message : String(error);
  console.log(`  ${RED}✗${RESET} ${what}${DIM} — ${detail}${RESET}`);
  if (error instanceof ApiError && error.status === 403) {
    console.log(`    ${YELLOW}the bot is missing ${missing} in this guild${RESET}`);
  }
}

/** Run `body`; on failure record it and tell the caller to skip what depends on it. */
async function probe(what: string, missing: string, body: () => Promise<string>): Promise<boolean> {
  try {
    pass(what, await body());
    return true;
  } catch (error) {
    fail(what, error, missing);
    return false;
  }
}

console.log(`\n${BOLD}Discord mode — provisioning smoke test${RESET}`);
console.log(`${DIM}guild ${GUILD_ID} · application ${APPLICATION_ID}${RESET}\n`);

const identity = await probe("bot token accepted", "a valid token", async () => {
  const me = await api<{ id: string; username: string }>("/users/@me");
  if (me.id !== APPLICATION_ID) {
    throw new Error(
      `token belongs to application ${me.id}, but DISCORD_APPLICATION_ID is ${APPLICATION_ID}`,
    );
  }
  return `@${me.username}`;
});

if (identity) {
  await probe("gateway READY with the intents Discord mode needs", "MESSAGE CONTENT INTENT", async () => {
    const ready = await identify();
    return `${ready.user}, intents ${INTENTS}`;
  });
}

const inGuild = await probe("bot is a member of the test guild", "an invite to this guild", async () => {
  const guild = await api<{ name: string }>(`/guilds/${GUILD_ID}`);
  return guild.name;
});

let category: Channel | undefined;
if (inGuild) {
  const ok = await probe("create a category (one per tracked repo)", "MANAGE_CHANNELS", async () => {
    category = await createChannel({ name: "cmux-wayfinder-probe", type: 4 }, "category");
    return `#${category.name}`;
  });
  if (!ok) category = undefined;
}

if (category) {
  const parent = category.id;

  let text: Channel | undefined;
  await probe("create a text channel (one per open map)", "MANAGE_CHANNELS", async () => {
    text = await createChannel({ name: "probe-map-ledger", type: 0, parent_id: parent }, "text channel");
    return `#${text.name}`;
  });

  if (text) {
    const ledger = text.id;
    let post: { id: string } | undefined;

    await probe("post a ticket post in the ledger", "SEND_MESSAGES", async () => {
      post = await api<{ id: string }>(`/channels/${ledger}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "**Probe ticket** · Frontier · blocked by nothing" }),
      });
      return `message ${post.id}`;
    });

    if (post) {
      const ticketPost = post.id;
      let thread: Channel | undefined;

      await probe("open a thread on the ticket post", "CREATE_PUBLIC_THREADS", async () => {
        thread = await api<Channel>(`/channels/${ledger}/messages/${ticketPost}/threads`, {
          method: "POST",
          body: JSON.stringify({ name: "probe ticket conversation", auto_archive_duration: 1440 }),
        });
        return `thread ${thread.id}`;
      });

      if (thread) {
        const conversation = thread.id;
        await probe("talk in the thread", "SEND_MESSAGES_IN_THREADS", async () => {
          const reply = await api<{ id: string }>(`/channels/${conversation}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: "A Claude turn would land here." }),
          });
          return `message ${reply.id}`;
        });

        await probe("archive the thread", "MANAGE_THREADS", async () => {
          await api(`/channels/${conversation}`, {
            method: "PATCH",
            body: JSON.stringify({ archived: true }),
          });
          return "archived";
        });
      }
    }

    await probe("make the channel read-only, then undo it", "MANAGE_ROLES", async () => {
      await api(`/channels/${ledger}/permissions/${GUILD_ID}`, {
        method: "PUT",
        body: JSON.stringify({ type: 0, deny: String(1 << 11) }),
      });
      await api(`/channels/${ledger}/permissions/${GUILD_ID}`, { method: "DELETE" });
      return "denied then restored SEND_MESSAGES for @everyone";
    });
  }

  let forum: Channel | undefined;
  await probe("create a forum channel (the other ledger shape)", "MANAGE_CHANNELS", async () => {
    forum = await createChannel({ name: "probe-map-forum", type: 15, parent_id: parent }, "forum channel");
    return `#${forum.name}`;
  });

  if (forum) {
    const board = forum.id;
    await probe("open a forum post (ticket post and thread in one)", "SEND_MESSAGES", async () => {
      const entry = await api<Channel>(`/channels/${board}/threads`, {
        method: "POST",
        body: JSON.stringify({
          name: "Probe ticket",
          message: { content: "**Probe ticket** · Frontier · blocked by nothing" },
        }),
      });
      return `post ${entry.id}`;
    });
  }
}

if (KEEP) {
  console.log(`\n${DIM}--keep: leaving ${created.length} probe channel(s) in place.${RESET}`);
} else {
  for (const channel of [...created].reverse()) {
    try {
      await api(`/channels/${channel.id}`, { method: "DELETE" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(`  ${YELLOW}⚠${RESET} could not delete the probe ${channel.label}${DIM} — ${detail}${RESET}`);
    }
  }
  if (created.length) console.log(`\n${DIM}cleaned up ${created.length} probe channel(s).${RESET}`);
}

if (failures) {
  console.log(`\n${RED}${BOLD}${failures} check(s) failed.${RESET} Fix the cause above, then run this again.\n`);
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}All checks passed.${RESET} The bot can build everything Discord mode needs.\n`);
