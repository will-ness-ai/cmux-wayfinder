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

/** Max length of a derived workspace label before we clamp it with an ellipsis. */
const LABEL_MAX = 40;
/** Prefix marking a completed map's workspace (✓ + space — readable before words). */
const WS_DONE_PREFIX = "✓ ";

/**
 * Derive a short, human-scannable label from a map issue's GitHub title — the
 * name shown in the cmux sidebar instead of a bare `repo/map#` slug.
 *
 * Wayfinder map titles follow `Wayfinder map: <name> — <tagline>` (the tagline,
 * and its em/en-dash/colon separator, is optional). We strip the boilerplate
 * `Wayfinder map:` prefix and keep only the headline before the first tagline
 * separator, so `Wayfinder map: app notifications — badge counts on the shell`
 * becomes `app notifications`. A title with no tagline (e.g. `Wayfinder map:
 * nutrition.exe food + weight tracker`) keeps its whole headline. A degenerate
 * (boilerplate-only) title falls back to `map #<n>`; an over-long one is clamped
 * so the sidebar stays legible.
 */
export function mapLabel(mapTitle: string, mapNumber: number): string {
  let s = (mapTitle ?? "").trim();
  s = s.replace(/^wayfinder\s+map\s*:\s*/i, ""); // drop the "Wayfinder map:" boilerplate
  const sep = /\s+(?:—|–|-|:)\s+/.exec(s); // first space-delimited tagline separator
  if (sep) s = s.slice(0, sep.index);
  s = s.trim();
  if (!s) return `map #${mapNumber}`; // title was only boilerplate → stable fallback
  if (s.length > LABEL_MAX) s = `${s.slice(0, LABEL_MAX - 1).trimEnd()}…`;
  return s;
}

/**
 * Workspace title — the short, human-facing name shown in the cmux sidebar,
 * derived from the map's GitHub title via {@link mapLabel}. Identity lives in
 * the description, so two maps deriving the same label is harmless. `done`
 * prefixes a ✓ once the map itself is complete — see {@link isMapComplete}.
 */
export function workspaceTitle(mapTitle: string, mapNumber: number, done = false): string {
  return `${done ? WS_DONE_PREFIX : ""}${mapLabel(mapTitle, mapNumber)}`;
}

/**
 * The title format sync used before workspace titles became map-name-derived:
 * `repoShort/map` (+ a ✓ prefix when done). Still recognized as ours so a live
 * run upgrades those older workspaces to the new label in place.
 */
function legacyWorkspaceTitle(repo: string, mapNumber: number, done: boolean): string {
  return `${done ? "✓" : ""}${repoShort(repo)}/${mapNumber}`;
}

/**
 * Whether `title` is a workspace title sync minted for this map — its current
 * map-derived label, that label's ✓-done variant, or either variant of the
 * {@link legacyWorkspaceTitle} format. Only such a title is ever re-marked or
 * upgraded; a hand-renamed workspace matches none of these and is left alone.
 * (A map whose GitHub title was edited after its workspace was created no longer
 * matches either variant, so that workspace keeps its prior name rather than
 * being clobbered — renaming the map issue never retitles a live workspace.)
 */
export function isManagedWorkspaceTitle(
  title: string,
  repo: string,
  mapNumber: number,
  mapTitle: string,
): boolean {
  return (
    title === workspaceTitle(mapTitle, mapNumber, false) ||
    title === workspaceTitle(mapTitle, mapNumber, true) ||
    title === legacyWorkspaceTitle(repo, mapNumber, false) ||
    title === legacyWorkspaceTitle(repo, mapNumber, true)
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
 * not passed as an argument — it is typed into the ready TUI afterwards and
 * submitted there, so it runs as a slash command — see {@link ticketPrompt}.
 */
export function launchCommand(mapNumber: number, ticket: number): string {
  return `claude --worktree ${worktreeName(mapNumber, ticket)}`;
}

/**
 * The slash-command prompt typed into claude's input box once the TUI is ready,
 * then submitted — a freshly opened ticket tab is already working.
 */
export function ticketPrompt(mapNumber: number, ticket: number): string {
  return `/wayfinder map #${mapNumber} work on ticket #${ticket}. If you end up creating files (prototype, research, etc..) ensure that you create and merge a PR containing those artifacts`;
}

// ---------- ticket tab titles: [<type><readiness>]<n> ----------

export type TicketType = "grilling" | "task" | "research" | "prototype";

/** X slot — one emoji per `wayfinder:<type>` ticket-type label. */
const TYPE_EMOJI: Record<TicketType, string> = {
  grilling: "🗣️",
  task: "🔨",
  research: "🔎",
  prototype: "🧪",
};

/** Y slot — whose turn the tab is waiting on; ✓ takes the slot once closed. */
export const READY_FOR_HUMAN = "🫵";
export const READY_FOR_AGENT = "🤖";
const DONE = "✓";
/** What may occupy the Y slot of a managed tab title. */
type YSlot = typeof READY_FOR_HUMAN | typeof READY_FOR_AGENT | typeof DONE;

const TYPE_LABEL_RE = new RegExp(`^wayfinder:(${Object.keys(TYPE_EMOJI).join("|")})$`);

/** The ticket's `wayfinder:<type>` label; an unlabeled ticket is a task. */
export function ticketTypeOf(labels: string[]): TicketType {
  for (const l of labels) {
    const m = TYPE_LABEL_RE.exec(l);
    if (m) return m[1] as TicketType;
  }
  return "task";
}

/**
 * Y slot from the ticket's readiness labels — the source of truth, so whoever
 * flips the label on the issue (agent handing off, human handing back) flips
 * the tab on the next sync. `ready-for-human` wins if both are present; a
 * ticket carrying neither defaults HITL (🫵).
 */
export function readinessOf(labels: string[]): typeof READY_FOR_HUMAN | typeof READY_FOR_AGENT {
  if (labels.includes("ready-for-human")) return READY_FOR_HUMAN;
  if (labels.includes("ready-for-agent")) return READY_FOR_AGENT;
  return READY_FOR_HUMAN;
}

/**
 * Managed ticket tab title: `[XY]<n>` — X the ticket-type emoji, Y the
 * readiness emoji (🫵 human / 🤖 agent), replaced by ✓ once the ticket closes.
 */
export function ticketTabTitle(ticket: number, labels: string[], readiness: YSlot): string {
  return `[${TYPE_EMOJI[ticketTypeOf(labels)]}${readiness}]${ticket}`;
}

/** The title a managed tab should carry for `sub`'s current state and labels. */
function desiredTabTitle(sub: SubIssue): string {
  return ticketTabTitle(
    sub.number,
    sub.labels,
    sub.state === "closed" ? DONE : readinessOf(sub.labels),
  );
}

// ---------- managed-tab matcher ----------

/**
 * Strip emoji variation selectors (U+FE0F, e.g. the one riding 🗣️) so titles
 * parse and compare the same whether or not a layer between us and the screen
 * (cmux, hand-typing) preserves them.
 */
function canon(s: string): string {
  return s.replace(/\uFE0F/g, "");
}

const X_ALT = canon(Object.values(TYPE_EMOJI).join("|"));
const Y_ALT = [READY_FOR_HUMAN, READY_FOR_AGENT, DONE].join("|");
/** `[XY]<n>` with X and Y drawn from the known emoji sets only. */
const MANAGED_RE = new RegExp(`^\\[(?:${X_ALT})(?:${Y_ALT})\\](\\d+)$`, "u");

/**
 * A tab is *managed* only if its title is `[XY]<n>` with both emoji from the
 * known sets, or a legacy bare/✓-marked ticket number (`42` / `✓42` — still
 * recognized so a live run upgrades them in place). Everything else — the
 * default shell tab, auto-retitled tabs, hand-renamed tabs — is left untouched.
 * Returns the ticket number, or null if the title isn't managed.
 */
export function parseManagedTabTitle(title: string): number | null {
  const t = canon(title.trim());
  const m = MANAGED_RE.exec(t) ?? /^✓?(\d+)$/.exec(t);
  return m ? Number(m[1]) : null;
}

// ---------- tab plan (pure) ----------

export interface Tab {
  id: string;
  title: string;
}

export interface TabCreate {
  ticket: number;
  title: string; // `[XY]<n>` — see ticketTabTitle
  /** Shell command run in the new tab to launch claude on the worktree. */
  launch: string;
  /** Prompt typed into the ready TUI afterwards, then submitted. */
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
  /**
   * Title drift fixes: ✓-flips as tickets close/reopen, type-emoji updates
   * when a label changes, and legacy `<n>`/`✓<n>` → `[XY]<n>` upgrades.
   */
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
 * - Frontier tickets (open + unblocked) with no managed tab → create `[XY]<n>`
 *   (Y from {@link readinessOf}) and send the boot command (only ever at
 *   creation).
 * - A managed tab whose title drifted from the desired `[XY]<n>` → rename.
 *   The whole title is derived from the ticket's live labels/state (labels are
 *   the source of truth — flip readiness by relabelling the issue): ✓ into/out
 *   of the Y slot as the ticket closes/reopens, X/Y as labels change, legacy
 *   `<n>`/`✓<n>` titles upgrade in place.
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

  // Existing managed tabs, keyed by ticket (first wins on the odd duplicate).
  const managed = new Map<number, Tab>();
  for (const tab of existingTabs) {
    const ticket = parseManagedTabTitle(tab.title);
    if (ticket !== null && !managed.has(ticket)) managed.set(ticket, tab);
  }

  const creates: TabCreate[] = [];
  for (const sub of [...map.frontier].sort((a, b) => a.number - b.number)) {
    if (!managed.has(sub.number)) {
      creates.push({
        ticket: sub.number,
        title: desiredTabTitle(sub),
        launch: launchCommand(map.number, sub.number),
        prompt: ticketPrompt(map.number, sub.number),
      });
    }
  }

  const renames: TabRename[] = [];
  const closes: TabClose[] = [];
  const closedTickets = new Set<number>();
  for (const [ticket, tab] of managed) {
    const sub = byNumber.get(ticket);
    const ticketOpen = sub?.state === "open";
    // Prune: a tab whose ticket is no longer open (closed → ✓, or gone → stale)
    // is closed rather than ✓-marked. Open tickets keep their tab regardless.
    if (prune && !ticketOpen) {
      closes.push({ id: tab.id, title: tab.title, ticket });
      closedTickets.add(ticket);
      continue;
    }
    // A stale tab (ticket vanished from the map) has no labels/state to derive
    // a title from — leave it alone on the additive path.
    if (!sub) continue;
    const desired = desiredTabTitle(sub);
    // Compare variation-selector-insensitively: if a layer strips U+FE0F from
    // a live title, the tab is still "already right" — no rename churn.
    if (canon(desired) !== canon(tab.title)) {
      renames.push({ id: tab.id, from: tab.title, to: desired });
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
