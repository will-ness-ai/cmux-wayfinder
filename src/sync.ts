#!/usr/bin/env bun
/**
 * cmux-wayfinder sync (ticket #5) — materialize wayfinder map frontiers into cmux.
 *
 *   tracked.yaml → per repo: resolve → open maps + frontier → reconcile cmux:
 *     one group per repo, one workspace per open map, one tab per open+unblocked
 *     sub-issue (booting `claude --worktree …`), ✓-marks for closed tickets and
 *     for a whole map once all its sub-issues are done.
 *
 * Default path is additive + rename-only: never closes a workspace/tab, never
 * moves focus. `--prune` additionally closes done/stale ticket tabs and the
 * workspaces of closed/untracked maps (plus stray group anchors) — the only
 * path that ever closes anything. `--dry-run` prints the plan without touching
 * cmux.
 *
 *   bun src/sync.ts [--config tracked.yaml] [--dry-run] [--prune]
 */

import { loadTracked, type TrackedRepo } from "./config.ts";
import { readFrontierFor, resolveRepo, type WayfinderMap } from "./frontier.ts";
import * as cmux from "./cmux.ts";
import {
  groupName,
  isManagedWorkspaceTitle,
  isMapComplete,
  mapTabTitle,
  parseManagedTabTitle,
  planTabs,
  planWorkspacePrune,
  workspaceDescription,
  workspaceTitle,
  type Tab,
} from "./plan.ts";

interface Options {
  configPath: string;
  dryRun: boolean;
  prune: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { configPath: "tracked.yaml", dryRun: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--prune") opts.prune = true;
    else if (a === "--config") opts.configPath = argv[++i]!;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

interface Logger {
  /** A structural/heading line. */
  info(m: string): void;
  /** A single create/rename action (prefixed `[dry-run] would` in dry runs). */
  act(m: string): void;
}

/** A tiny logger that prefixes plan-only lines with [dry-run]. */
function makeLog(dryRun: boolean): Logger {
  const tag = dryRun ? "[dry-run] would" : "";
  return {
    info: (m) => console.log(m),
    act: (m) => console.log(`  ${tag} ${m}`.replace(/\s+/g, " ").trimEnd()),
  };
}

async function syncRepo(
  tracked: TrackedRepo,
  opts: Options,
  log: Logger,
  desired: Set<string>,
) {
  const canonical = await resolveRepo(tracked.repo);
  const maps = await readFrontierFor(canonical);
  // Every open map is a workspace that *should* exist — record it so the prune
  // pass keeps it (and prunes everything else). Done even in dry-run.
  for (const map of maps) desired.add(workspaceDescription(canonical, map.number));
  log.info(`\n${canonical}${canonical !== tracked.repo ? ` (was ${tracked.repo})` : ""} — ${maps.length} open map(s)`);
  if (maps.length === 0) return;

  const before = await cmux.snapshot();
  const preexistingIds = new Set(before.workspaces.map((w) => w.id));

  // 1. One group per repo.
  const gname = groupName(canonical);
  let group = (await cmux.listGroups()).find((g) => g.name === gname);
  if (!group) {
    log.act(`create group "${gname}"`);
    if (!opts.dryRun) group = await cmux.createGroup(gname, preexistingIds);
  }

  // 2. One workspace per open map, each reconciled to its frontier tabs.
  for (const map of maps) {
    await syncMap({ canonical, cwd: tracked.path, map, group, opts, log });
  }
}

async function syncMap(ctx: {
  canonical: string;
  cwd: string;
  map: WayfinderMap;
  group: cmux.Group | undefined;
  opts: Options;
  log: Logger;
}) {
  const { canonical, cwd, map, group, opts, log } = ctx;
  const done = isMapComplete(map);
  const title = workspaceTitle(map.title, map.number, done);
  const description = workspaceDescription(canonical, map.number);

  let ws = await cmux.findWorkspaceByDescription(description);
  if (!ws) {
    log.act(`create workspace "${title}" (${description}) cwd=${cwd}`);
    if (!opts.dryRun) {
      if (!group) throw new Error("group not created (bug)");
      ws = await cmux.createWorkspace({ name: title, description, cwd, group: group.ref });
    }
  } else if (ws.title !== title && isManagedWorkspaceTitle(ws.title, canonical, map.number, map.title)) {
    // Flip the ✓ as the map completes/reopens, but only touch a title we still
    // own — a hand-renamed workspace is left alone.
    log.act(`rename workspace "${ws.title}" → "${title}"`);
    if (!opts.dryRun) await cmux.renameWorkspace(ws.id, title);
  }

  // Enforced: every map workspace has a browser tab open to the map issue,
  // recreated if the user closed it. Runs before the frontier-tab early-return.
  await ensureMapTab(ws, map, opts, log);

  // Reconcile tabs. Without a live workspace (dry-run, uncreated) there are no
  // existing tabs, so the plan shows the full frontier as creates.
  const existing: Tab[] = ws ? await cmux.listSurfaces(ws.id) : [];
  const plan = planTabs(existing, map, { prune: opts.prune });

  if (plan.creates.length === 0 && plan.renames.length === 0 && plan.closes.length === 0) {
    log.info(`  workspace "${title}": up to date (frontier ${fmtFrontier(map)})`);
    return;
  }
  log.info(`  workspace "${title}": frontier ${fmtFrontier(map)}`);

  for (const c of plan.creates) {
    log.act(`create tab "${c.title}": ${c.launch} → submit: ${c.prompt}`);
    if (!opts.dryRun && ws) {
      const sid = await cmux.createSurface(ws.id);
      await cmux.renameTab(sid, c.title);
      await cmux.settle(async () =>
        (await cmux.listSurfaces(ws!.id)).find((s) => s.id === sid && s.title === c.title),
      );
      // Launch claude, wait for its TUI, then type the prompt and submit it —
      // a new tab arrives already working its ticket.
      await cmux.sendCommand(sid, c.launch);
      const ready = await cmux.waitForClaudeReady(sid);
      if (!ready) log.info(`    ⚠ tab "${c.title}": claude TUI not detected; typed prompt anyway`);
      const landed = await cmux.sendPrompt(sid, c.prompt);
      if (!landed) log.info(`    ⚠ tab "${c.title}": prompt not seen on screen; submitted anyway`);
    }
  }

  for (const r of plan.renames) {
    log.act(`rename tab ${r.from} → ${r.to}`);
    if (!opts.dryRun && ws) {
      const surf = (await cmux.listSurfaces(ws.id)).find((s) => s.id === r.id);
      if (surf) await cmux.renameTab(surf.id, r.to);
    }
  }

  // --prune only: close done/stale ticket tabs (plan.closes is [] otherwise).
  for (const c of plan.closes) {
    log.act(`close tab "${c.title}" (ticket #${c.ticket} no longer open)`);
    if (!opts.dryRun && ws) {
      const surf = (await cmux.listSurfaces(ws.id)).find((s) => s.id === c.id);
      if (surf) await cmux.closeSurface(surf.id);
    }
  }

  // Order managed tabs by ticket, after any non-managed (default shell) tabs.
  if (!opts.dryRun && ws) await orderTabs(ws.id, plan.desiredOrder);
}

/**
 * Ensure the workspace has a browser tab open to the map issue. Unlike the
 * default shell tab, this one is *enforced*: if no browser tab titled
 * `map #<n>` exists (the user closed it), recreate it and pin it leftmost. A
 * present one is left alone — its position and current URL are the user's.
 */
async function ensureMapTab(
  ws: cmux.Workspace | undefined,
  map: WayfinderMap,
  opts: Options,
  log: Logger,
) {
  const title = mapTabTitle(map.number);
  const surfaces = ws ? await cmux.listSurfaces(ws.id) : [];
  if (surfaces.some((s) => s.type === "browser" && s.title === title)) return;

  log.act(`create browser tab "${title}" → ${map.url}`);
  if (opts.dryRun || !ws) return;
  const sid = await cmux.createBrowserSurface(ws.id, map.url);
  await cmux.renameTab(sid, title);
  await cmux.settle(async () =>
    (await cmux.listSurfaces(ws.id)).find((s) => s.id === sid && s.title === title),
  );
  await cmux.reorderTab(ws.id, sid, 0); // map tab sits leftmost
}

/**
 * Place managed tabs at consecutive indices (ticket asc) after any non-managed
 * (default shell) tabs. Surface ids are stable and `reorderTab` takes an
 * absolute index, so applying targets in ascending rank order is deterministic
 * regardless of the starting arrangement — no need to re-read between moves. We
 * skip the whole pass when the managed tabs are already in the desired order.
 */
async function orderTabs(workspaceId: string, desiredOrder: number[]) {
  const surfaces = await cmux.listSurfaces(workspaceId);
  const currentOrder = surfaces
    .map((s) => parseManagedTabTitle(s.title))
    .filter((t): t is number => t !== null);
  if (currentOrder.length === desiredOrder.length && currentOrder.every((t, i) => t === desiredOrder[i])) {
    return; // already ordered — avoid churn
  }
  const base = surfaces.filter((s) => parseManagedTabTitle(s.title) === null).length;
  for (let rank = 0; rank < desiredOrder.length; rank++) {
    const surf = surfaces.find((s) => parseManagedTabTitle(s.title) === desiredOrder[rank]);
    if (surf) await cmux.reorderTab(workspaceId, surf.id, base + rank);
  }
}

function fmtFrontier(map: WayfinderMap): string {
  return map.frontier.length ? map.frontier.map((s) => `#${s.number}`).join(" ") : "(empty)";
}

// ---------- entry ----------

/**
 * `--prune` tail pass: close every workspace that isn't backed by a tracked
 * open map (dead/untracked maps) plus the stray group anchors. Runs after the
 * additive pass has created all desired workspaces and populated `desired`, so
 * "not desired" is unambiguous. Emptied groups auto-remove themselves.
 */
async function prune(desired: Set<string>, opts: Options, log: Logger) {
  const [snap, groups] = await Promise.all([cmux.snapshot(), cmux.listGroups()]);
  const closes = planWorkspacePrune(snap.workspaces, groups, desired);
  if (closes.length === 0) {
    log.info(`\nprune: nothing to close`);
    return;
  }
  log.info(`\nprune: closing ${closes.length} workspace(s)`);
  for (const c of closes) {
    const label = c.reason === "stray-anchor" ? "stray anchor" : "dead/untracked map";
    log.act(`close workspace "${c.title}" (${label})`);
    if (!opts.dryRun) await cmux.closeWorkspace(c.id);
  }
}

const opts = parseArgs(process.argv.slice(2));
const log = makeLog(opts.dryRun);
const tracked = await loadTracked(opts.configPath);

const desired = new Set<string>();
for (const repo of tracked) {
  await syncRepo(repo, opts, log, desired);
}
if (opts.prune) await prune(desired, opts, log);

console.log(opts.dryRun ? "\n(dry run — no changes made)" : "\nsync complete");
