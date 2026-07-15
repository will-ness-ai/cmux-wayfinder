/**
 * Pure reconciliation core for cmux-wayfinder sync (ticket #5).
 *
 * All decisions live here as pure functions so they can be unit-tested without
 * a live cmux: identity keys, the managed-tab matcher, and the per-workspace
 * tab plan. The executor (`sync.ts`) reads live state, calls these to decide
 * *what* to do, then applies the ops via the proven cmux primitives (#2).
 *
 * Default path is additive + rename-only: we create workspaces/tabs and flip
 * ✓-marks, but never close anything. Closing lives behind `--prune` (ticket #6),
 * plumbed as pure functions here too: {@link planTabs}'s `prune` option turns
 * done/stale tab renames into closes, and {@link planWorkspacePrune} decides
 * which workspaces (dead maps + stray group anchors) to close.
 */

import type { SubIssue, WayfinderMap } from "./frontier.ts";

// ---------- identity keys & formatters ----------

/** The last path segment of `owner/name`. */
export function repoShort(repo: string): string {
  return repo.split("/").pop()!;
}

/** Per-repo workspace group title: all of a repo's map workspaces live here. */
export function groupName(repo: string): string {
  return `${repoShort(repo)} wayfinder`;
}

/**
 * Workspace title — human-facing, may collide across owners (see description).
 * `done` prefixes a ✓ (same marker the ticket tabs use) once the map itself is
 * complete — see {@link isMapComplete}.
 */
export function workspaceTitle(repo: string, mapNumber: number, done = false): string {
  return `${done ? "✓" : ""}${repoShort(repo)}/${mapNumber}`;
}

/**
 * Whether `title` is a workspace title sync minted for this map (either the
 * plain `repoShort/map` or its ✓-done variant) — so we only ever re-mark a
 * title we still own, never a hand-renamed workspace.
 */
export function isManagedWorkspaceTitle(title: string, repo: string, mapNumber: number): boolean {
  return (
    title === workspaceTitle(repo, mapNumber, false) ||
    title === workspaceTitle(repo, mapNumber, true)
  );
}

/**
 * A map is *complete* when it has sub-issues and every one of them is closed —
 * i.e. the frontier is empty and nothing is left open. (An open map with no
 * sub-issues yet is not complete.) Drives the ✓ on the workspace title.
 */
export function isMapComplete(map: WayfinderMap): boolean {
  return map.subIssues.length > 0 && map.subIssues.every((s) => s.state === "closed");
}

/**
 * Workspace description — the strong identity key. Full `owner/repo#map` is
 * globally unique, so sync matches workspaces on this, not the title.
 */
export function workspaceDescription(repo: string, mapNumber: number): string {
  return `${repo}#${mapNumber}`;
}

/**
 * Inverse of {@link workspaceDescription}: recover `{repo, mapNumber}` from a
 * workspace description, or null if it isn't one we minted. The repo half may
 * contain `/` but never `#`, so we split on the *last* `#`. This is how prune
 * tells a wayfinder-owned workspace (parseable) from a stray anchor (not).
 */
export function parseWorkspaceDescription(
  description: string | null | undefined,
): { repo: string; mapNumber: number } | null {
  if (!description) return null; // anchors carry a null description
  const m = /^(.+)#(\d+)$/.exec(description.trim());
  if (!m) return null;
  return { repo: m[1], mapNumber: Number(m[2]) };
}

/**
 * Title of the map's browser tab — a pinned marker (not a bare number, so the
 * managed-tab matcher ignores it) that survives the user navigating the tab.
 * Sync enforces one browser tab with this title per workspace, open to the map
 * issue, recreating it if closed.
 */
export function mapTabTitle(mapNumber: number): string {
  return `map #${mapNumber}`;
}

/** Worktree name passed to `claude --worktree` (claude sanitizes `/`→`+`). */
export function worktreeName(mapNumber: number, ticket: number): string {
  return `wayfinder/${mapNumber}/${ticket}`;
}

/**
 * Shell command that launches claude on the ticket's worktree. The prompt is
 * deliberately NOT passed as an argument (that would auto-submit it); instead
 * it is typed into the ready TUI afterwards, unsubmitted — see {@link ticketPrompt}.
 */
export function launchCommand(mapNumber: number, ticket: number): string {
  return `claude --worktree ${worktreeName(mapNumber, ticket)}`;
}

/**
 * The slash-command prompt typed into claude's input box (once the TUI is
 * ready) and left UNSUBMITTED for the human to review and send.
 */
export function ticketPrompt(mapNumber: number, ticket: number): string {
  return `/wayfinder map #${mapNumber} work on ticket #${ticket}. If you end up creating files (prototype, research, etc..) ensure that you create and merge a PR containing those artifacts`;
}

// ---------- managed-tab matcher ----------

/**
 * A tab is *managed* only if its title is exactly a ticket number (`42`) or a
 * done-marked ticket number (`✓42`). Everything else — the default shell tab,
 * auto-retitled tabs, hand-renamed tabs — is left untouched. Returns the ticket
 * number, or null if the title isn't managed.
 */
export function parseManagedTabTitle(title: string): number | null {
  const m = /^✓?(\d+)$/.exec(title.trim());
  return m ? Number(m[1]) : null;
}

// ---------- tab plan (pure) ----------

export interface Tab {
  id: string;
  title: string;
}

export interface TabCreate {
  ticket: number;
  title: string; // always the bare number
  /** Shell command run in the new tab to launch claude on the worktree. */
  launch: string;
  /** Prompt typed into the ready TUI afterwards, left unsubmitted. */
  prompt: string;
}

export interface TabRename {
  id: string;
  from: string;
  to: string;
}

export interface TabClose {
  id: string;
  title: string;
  ticket: number;
}

export interface TabPlan {
  /** New tabs for frontier tickets with no tab yet, ascending by ticket. */
  creates: TabCreate[];
  /** ✓-flips: open→✓ when a ticket closed, ✓→open when it reopened. */
  renames: TabRename[];
  /**
   * Managed tabs to close (only ever populated under `--prune`): tabs whose
   * ticket is no longer open — a closed ticket (the ✓ ones) or one that has
   * vanished from the map (stale). Always `[]` on the additive path.
   */
  closes: TabClose[];
  /** Managed tabs in desired display order (ticket asc) — for reordering. */
  desiredOrder: number[];
}

export interface TabPlanOptions {
  /**
   * When true, done/stale managed tabs are closed instead of ✓-renamed — the
   * `--prune` path. A tab is closed when its ticket isn't open (closed or gone);
   * open tickets (even ones that fell off the frontier by re-blocking) keep
   * their tab, so a live session is never yanked out from under the human.
   */
  prune?: boolean;
}

/**
 * Decide the tab operations for one map's workspace.
 *
 * - Frontier tickets (open + unblocked) with no managed tab → create `<n>` and
 *   send the boot command (only ever at creation).
 * - A managed tab whose ticket is now closed → rename `<n>` → `✓<n>`.
 * - A managed tab marked `✓<n>` whose ticket is open again → flip back to `<n>`.
 * - Additive default never closes a tab; under `prune`, done/stale tabs close
 *   (see {@link TabPlanOptions.prune}) instead of being ✓-renamed.
 */
export function planTabs(
  existingTabs: Tab[],
  map: WayfinderMap,
  opts: TabPlanOptions = {},
): TabPlan {
  const prune = opts.prune ?? false;
  const byNumber = new Map<number, SubIssue>(map.subIssues.map((s) => [s.number, s]));
  const frontier = new Set(map.frontier.map((s) => s.number));

  // Existing managed tabs, keyed by ticket (first wins on the odd duplicate).
  const managed = new Map<number, Tab>();
  for (const tab of existingTabs) {
    const ticket = parseManagedTabTitle(tab.title);
    if (ticket !== null && !managed.has(ticket)) managed.set(ticket, tab);
  }

  const creates: TabCreate[] = [];
  for (const ticket of [...frontier].sort((a, b) => a - b)) {
    if (!managed.has(ticket)) {
      creates.push({
        ticket,
        title: String(ticket),
        launch: launchCommand(map.number, ticket),
        prompt: ticketPrompt(map.number, ticket),
      });
    }
  }

  const renames: TabRename[] = [];
  const closes: TabClose[] = [];
  const closedTickets = new Set<number>();
  for (const [ticket, tab] of managed) {
    const sub = byNumber.get(ticket);
    const isDone = tab.title.startsWith("✓");
    const ticketOpen = sub?.state === "open";
    // Prune: a tab whose ticket is no longer open (closed → ✓, or gone → stale)
    // is closed rather than ✓-marked. Open tickets keep their tab regardless.
    if (prune && !ticketOpen) {
      closes.push({ id: tab.id, title: tab.title, ticket });
      closedTickets.add(ticket);
      continue;
    }
    const shouldBeDone = sub?.state === "closed";
    if (shouldBeDone && !isDone) {
      renames.push({ id: tab.id, from: tab.title, to: `✓${ticket}` });
    } else if (!shouldBeDone && isDone && ticketOpen) {
      renames.push({ id: tab.id, from: tab.title, to: String(ticket) });
    }
  }

  // Desired order: every ticket that will still have a managed tab, ascending
  // (pruned-away tickets drop out).
  const tickets = new Set<number>([...managed.keys(), ...creates.map((c) => c.ticket)]);
  for (const t of closedTickets) tickets.delete(t);
  const desiredOrder = [...tickets].sort((a, b) => a - b);

  return { creates, renames, closes, desiredOrder };
}

// ---------- workspace prune (pure) ----------

export interface WorkspaceRef {
  id: string;
  title: string;
  /** Anchors carry a null description; our workspaces carry `owner/repo#map`. */
  description: string | null;
}

export interface GroupRef {
  name: string;
  member_workspace_ids: string[];
  /** The workspace cmux auto-spawned for the group — our stray anchor. */
  anchor_workspace_id?: string | null;
}

export interface WorkspaceClose {
  id: string;
  title: string;
  /**
   * `map-gone`: a wayfinder workspace whose map is closed or whose repo is no
   * longer tracked. `stray-anchor`: the empty workspace `workspace.group.create`
   * leaves behind in each of our groups.
   */
  reason: "map-gone" | "stray-anchor";
}

/**
 * Decide which workspaces `--prune` should close. Two kinds:
 *
 * 1. **map-gone** — a workspace we minted (its description parses via
 *    {@link parseWorkspaceDescription}) whose `owner/repo#map` isn't in
 *    `desiredDescriptions` (the set sync built from every tracked repo's *open*
 *    maps). That covers both a map that closed and a repo dropped from
 *    `tracked.yaml`.
 * 2. **stray-anchor** — the workspace cmux auto-spawned for one of our groups
 *    (`group.anchor_workspace_id`), which we never use. Emptying its group then
 *    auto-removes the group. We only close an anchor that still carries no
 *    identity, so a real workspace cmux later promoted to anchor is spared.
 *
 * A group counts as ours when it holds ≥1 identity workspace or its name ends
 * with " wayfinder" (the {@link groupName} suffix) — the latter so a group
 * already emptied down to just its anchor is still recognized and cleaned.
 * Scoping anchor-closing to our groups keeps other groups' anchors untouched.
 */
export function planWorkspacePrune(
  workspaces: WorkspaceRef[],
  groups: GroupRef[],
  desiredDescriptions: Set<string>,
): WorkspaceClose[] {
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const hasIdentity = (w: WorkspaceRef | undefined) =>
    !!w && parseWorkspaceDescription(w.description) !== null;

  // Anchors of our groups that are still empty (non-identity) → close targets.
  const anchorIds = new Set<string>();
  for (const g of groups) {
    const ours =
      g.name.endsWith(" wayfinder") ||
      g.member_workspace_ids.some((id) => hasIdentity(wsById.get(id)));
    const anchor = g.anchor_workspace_id;
    if (ours && anchor && !hasIdentity(wsById.get(anchor))) anchorIds.add(anchor);
  }

  const closes: WorkspaceClose[] = [];
  for (const ws of workspaces) {
    if (ws.description && parseWorkspaceDescription(ws.description) !== null) {
      if (!desiredDescriptions.has(ws.description)) {
        closes.push({ id: ws.id, title: ws.title, reason: "map-gone" });
      }
    } else if (anchorIds.has(ws.id)) {
      closes.push({ id: ws.id, title: ws.title, reason: "stray-anchor" });
    }
  }
  return closes;
}
