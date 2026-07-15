/**
 * cmux plumbing for sync — typed state readers + mutators over the v2 socket
 * (`cmux rpc`) plus the v1 `cmux new-workspace` CLI. The recipe here is exactly
 * what an earlier spike proved live against cmux.
 *
 * Everything is additive/rename-only EXCEPT the two closers at the bottom
 * ({@link closeSurface}, {@link closeWorkspace}) — reached only from the
 * `--prune` path in sync, never the default.
 */

import { sh } from "./proc.ts";

export interface Workspace {
  id: string;
  ref: string;
  title: string;
  /** null for cmux-default workspaces (e.g. group anchors). */
  description: string | null;
  root_path: string;
}

export interface Group {
  id: string;
  ref: string;
  name: string;
  member_workspace_ids: string[];
  /** The workspace cmux auto-spawned for this group (the stray anchor). */
  anchor_workspace_id?: string | null;
}

export interface Surface {
  id: string;
  ref: string;
  title: string;
  /** "terminal", "browser", … */
  type: string;
}

export interface Snapshot {
  selected_workspace_id: string;
  workspaces: Workspace[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One v2 rpc call. Returns parsed JSON (or {} for empty responses). */
export async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const out = (await sh(["cmux", "rpc", method, JSON.stringify(params)])).trim();
  return out ? JSON.parse(out) : {};
}

/**
 * Poll `fn` until it returns something truthy. Live state settles within ~20ms
 * (per the spike), so this returns almost immediately; the loop just removes
 * the race between a mutation and the read-back.
 */
export async function settle<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("settle timeout");
    await sleep(50);
  }
}

// ---------- readers (all read-only) ----------

export async function snapshot(): Promise<Snapshot> {
  return rpc("extension.sidebar.snapshot");
}

export async function listGroups(): Promise<Group[]> {
  return (await rpc("workspace.group.list")).groups ?? [];
}

export async function listSurfaces(workspace_id: string): Promise<Surface[]> {
  return (await rpc("surface.list", { workspace_id })).surfaces ?? [];
}

/** Find a workspace by its (unique) description — the sync identity key. */
export async function findWorkspaceByDescription(description: string): Promise<Workspace | undefined> {
  return (await snapshot()).workspaces.find((w) => w.description === description);
}

// ---------- group ops ----------

/**
 * Create a group named `name` containing no pre-existing workspaces.
 *
 * `workspace.group.create` ignores the name, autonames itself, spawns a fresh
 * anchor workspace, AND pulls the currently-selected workspace in. So: create,
 * evict every member that already existed, then rename. `preexistingIds` are
 * the workspace ids observed before the call. Returns the renamed group.
 */
export async function createGroup(name: string, preexistingIds: Set<string>): Promise<Group> {
  const created: Group = (await rpc("workspace.group.create", {})).group;
  for (const wid of created.member_workspace_ids ?? []) {
    if (preexistingIds.has(wid)) {
      await rpc("workspace.group.remove", { group_id: created.id, workspace_id: wid });
    }
  }
  await rpc("workspace.group.rename", { group_id: created.id, name });
  return settle(async () => (await listGroups()).find((g) => g.name === name));
}

export async function addToGroup(group_id: string, workspace_id: string): Promise<void> {
  await rpc("workspace.group.add", { group_id, workspace_id });
}

// ---------- workspace ops ----------

/**
 * Create a workspace via the v1 CLI (the only path that honors title/cwd/
 * description/group/focus at creation — the v2 rpc equivalents ignore them).
 * Identified afterwards by its unique description. `--focus false` keeps the
 * user's selection put.
 */
export async function createWorkspace(opts: {
  name: string;
  description: string;
  cwd: string;
  group: string; // group ref or id
}): Promise<Workspace> {
  await sh([
    "cmux",
    "new-workspace",
    "--name",
    opts.name,
    "--description",
    opts.description,
    "--cwd",
    opts.cwd,
    "--group",
    opts.group,
    "--focus",
    "false",
  ]);
  return settle(() => findWorkspaceByDescription(opts.description));
}

/** Rename a workspace's title. Identity (description) is untouched. */
export async function renameWorkspace(workspace_id: string, title: string): Promise<void> {
  await rpc("workspace.rename", { workspace_id, title });
}

// ---------- tab (surface) ops ----------

/** Create a terminal tab in a workspace, unfocused; returns its surface id. */
export async function createSurface(workspace_id: string): Promise<string> {
  const res = await rpc("surface.create", { workspace_id, type: "terminal", focus: false });
  const id = res.surface_id ?? res.surface?.id;
  if (!id) throw new Error(`surface.create returned no id: ${JSON.stringify(res)}`);
  return id;
}

/**
 * Create a browser tab open to `url`, unfocused; returns its surface id. Uses
 * the v1 `new-surface` CLI (v2 `surface.create` has no url param); the new
 * surface is identified as the browser surface that wasn't there before.
 */
export async function createBrowserSurface(workspace_id: string, url: string): Promise<string> {
  const before = new Set((await listSurfaces(workspace_id)).map((s) => s.id));
  await sh([
    "cmux",
    "new-surface",
    "--type",
    "browser",
    "--url",
    url,
    "--workspace",
    workspace_id,
    "--focus",
    "false",
  ]);
  const created = await settle(async () =>
    (await listSurfaces(workspace_id)).find((s) => !before.has(s.id) && s.type === "browser"),
  );
  return created.id;
}

export async function renameTab(surface_id: string, title: string): Promise<void> {
  await rpc("tab.action", { action: "rename", surface_id, title });
}

export async function reorderTab(workspace_id: string, surface_id: string, index: number): Promise<void> {
  await rpc("surface.reorder", { workspace_id, surface_id, index });
}

/**
 * Send a shell command into a tab (text + Enter). Safe immediately after tab
 * creation — keystrokes queue in the pty until the shell is ready.
 */
export async function sendCommand(surface_id: string, text: string): Promise<void> {
  await rpc("surface.send_text", { surface_id, text });
  await rpc("surface.send_key", { surface_id, key: "enter" });
}

/** Type text into a tab WITHOUT submitting — no trailing Enter. */
export async function sendText(surface_id: string, text: string): Promise<void> {
  await rpc("surface.send_text", { surface_id, text });
}

// ---------- closers (--prune only) ----------

/** Close a single tab. Reached only from the `--prune` path. */
export async function closeSurface(surface_id: string): Promise<void> {
  await rpc("surface.close", { surface_id });
}

/**
 * Close a whole workspace. Reached only from the `--prune` path. Emptying a
 * group by closing its last workspace auto-removes the group (spike finding).
 */
export async function closeWorkspace(workspace_id: string): Promise<void> {
  await rpc("workspace.close", { workspace_id });
}

/** Read the tab's current visible screen text. */
export async function readScreen(surface_id: string): Promise<string> {
  const r = await rpc("surface.read_text", { surface_id });
  return typeof r.text === "string" ? r.text : "";
}

// The claude TUI paints a status bar with a mode indicator (⏵⏵ …), the input
// prompt (❯), and a shortcuts/effort footer once it is ready for input. Any of
// these appearing means the prompt can be typed. (Observed live: ~2s to ready.)
const CLAUDE_READY = /⏵⏵|❯|for shortcuts|-- INSERT --|\/effort/;

/**
 * Wait until claude's interactive TUI is ready to receive typed input, so a
 * prompt sent next lands in the input box rather than racing startup. Polls the
 * screen; returns true once ready, or false if it never appeared within the
 * timeout (caller may type anyway, best-effort).
 */
export async function waitForClaudeReady(surface_id: string, timeoutMs = 20000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (CLAUDE_READY.test(await readScreen(surface_id))) return true;
    await sleep(200);
  }
  return false;
}
