#!/usr/bin/env bun
/**
 * cmux-wayfinder sync (ticket #5) — materialize wayfinder map frontiers into cmux.
 *
 *   tracked.yaml → per repo: resolve → open maps + frontier → reconcile cmux:
 *     one group per repo, one workspace per open map, one tab per open+unblocked
 *     sub-issue (booting `claude --worktree …`), ✓-marks for closed tickets and
 *     for a whole map once all its sub-issues are done, plus two enforced
 *     browser tabs — the map issue and the generated lanes board (#8).
 *
 * Default path is additive + rename-only: never closes a workspace/tab, never
 * moves focus, never deletes a file. `--prune` additionally closes done/stale
 * ticket tabs and the workspaces of closed/untracked maps (plus stray group
 * anchors), and deletes the cached board files those dead maps left behind
 * (#11) — the only path that ever removes anything. `--dry-run` prints the plan
 * without touching cmux or disk. `--watch [sec]` re-syncs every `sec` seconds
 * (default 30) until killed, with GitHub rate-budget guardrails (see `watch`).
 *
 *   bun src/sync.ts [--config tracked.yaml] [--dry-run] [--prune] [--watch [sec]]
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sh } from "./proc.ts";
import { loadTracked, type TrackedRepo } from "./config.ts";
import { readFrontierFor, resolveRepo } from "./frontier.ts";
import { blockedByEdges, type WayfinderMap } from "./issues.ts";
import * as cmux from "./cmux.ts";
import { formatGeneratedAt, renderBoard } from "./board.ts";
import {
  boardCacheDir,
  boardPath,
  fileUrl,
  groupName,
  isManagedWorkspaceTitle,
  isMapComplete,
  lanesTabTitle,
  mapTabTitle,
  parseManagedTabTitle,
  planBoardPrune,
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
  /** Re-sync every N seconds until killed; null = single run. */
  watchSec: number | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { configPath: "tracked.yaml", dryRun: false, prune: false, watchSec: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--prune") opts.prune = true;
    else if (a === "--config") opts.configPath = argv[++i]!;
    else if (a === "--watch") {
      // Optional interval argument: `--watch 60`; bare `--watch` = 30s.
      const next = argv[i + 1];
      opts.watchSec = next !== undefined && /^\d+$/.test(next) ? Number(argv[++i]) : 30;
      if (opts.watchSec < 5) {
        console.error("--watch interval must be at least 5 seconds");
        process.exit(2);
      }
    } else {
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

/** Returns how many sub-issues the pass read — one API call each (see `watch`). */
async function syncRepo(
  tracked: TrackedRepo,
  opts: Options,
  log: Logger,
  desired: Set<string>,
): Promise<number> {
  const canonical = await resolveRepo(tracked.repo);
  const maps = await readFrontierFor(canonical);
  // Every open map is a workspace that *should* exist — record it so the prune
  // pass keeps it (and prunes everything else). Done even in dry-run.
  for (const map of maps) desired.add(workspaceDescription(canonical, map.number));
  const subIssues = maps.reduce((n, m) => n + m.subIssues.length, 0);
  log.info(`\n${canonical}${canonical !== tracked.repo ? ` (was ${tracked.repo})` : ""} — ${maps.length} open map(s)`);
  if (maps.length === 0) return subIssues;

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
  return subIssues;
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
  // recreated if the user closed it.
  await ensureBrowserTab({ ws, title: mapTabTitle(map.number), url: map.url, index: 0, opts, log });

  await reconcileTabs({ ws, map, title, opts, log });

  // The lanes board goes last: it renders the state the pass just reconciled.
  await syncBoard({ canonical, map, ws, opts, log });
}

/** Reconcile a workspace's managed ticket tabs against the map's frontier. */
async function reconcileTabs(ctx: {
  ws: cmux.Workspace | undefined;
  map: WayfinderMap;
  /** The workspace's title — for the log lines only. */
  title: string;
  opts: Options;
  log: Logger;
}) {
  const { ws, map, title, opts, log } = ctx;
  // Without a live workspace (dry-run, uncreated) there are no existing tabs,
  // so the plan shows the full frontier as creates.
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
 * Ensure the workspace has an *enforced* browser tab titled `title`: if none
 * exists (the user closed it), create it open to `url` and pin it at `index`.
 * A present one is left alone — its position and current URL are the user's.
 * Matching on title + browser type means a pre-existing tab is adopted without
 * any stored state. Returns the tab's surface when we can see one (undefined in
 * a dry run, or before the workspace itself exists).
 *
 * Both enforced tabs go through here: the map issue pinned leftmost and the
 * lanes board directly right of it.
 */
async function ensureBrowserTab(ctx: {
  ws: cmux.Workspace | undefined;
  title: string;
  url: string;
  index: number;
  opts: Options;
  log: Logger;
}): Promise<cmux.Surface | undefined> {
  const { ws, title, url, index, opts, log } = ctx;
  const surfaces = ws ? await cmux.listSurfaces(ws.id) : [];
  const existing = surfaces.find((s) => s.type === "browser" && s.title === title);
  if (existing) return existing;

  log.act(`create browser tab "${title}" → ${url}`);
  if (opts.dryRun || !ws) return undefined;
  const sid = await cmux.createBrowserSurface(ws.id, url);
  await cmux.renameTab(sid, title);
  const created = await cmux.settle(async () =>
    (await cmux.listSurfaces(ws.id)).find((s) => s.id === sid && s.title === title),
  );
  await cmux.reorderTab(ws.id, sid, index);
  return created;
}

/**
 * The lanes board: generate the map's board HTML, write it to the per-repo
 * cache, ensure the enforced `lanes #<n>` tab right of the map tab, and reload
 * it. Order matters — a tab created before its file exists shows the raw URL as
 * its title until something reloads it, so the write goes first (research #3).
 *
 * The reload is the primary refresh path; the page's own ~5s timer covers a
 * skipped or failed rpc.
 */
async function syncBoard(ctx: {
  canonical: string;
  map: WayfinderMap;
  ws: cmux.Workspace | undefined;
  opts: Options;
  log: Logger;
}) {
  const { canonical, map, ws, opts, log } = ctx;
  const path = boardPath(homedir(), canonical, map.number);
  const html = renderBoard({
    map: { number: map.number, title: map.title, url: map.url },
    tickets: map.subIssues,
    edges: blockedByEdges(map.subIssues),
    generatedAt: formatGeneratedAt(new Date()),
  });

  log.act(`write board ${path} (${map.subIssues.length} ticket(s))`);
  if (!opts.dryRun) await writeAtomic(path, html);

  const title = lanesTabTitle(map.number);
  const surface = await ensureBrowserTab({
    ws,
    title,
    url: fileUrl(path),
    index: 1, // directly right of the map tab
    opts,
    log,
  });

  // A dry run has no surface to reload unless the tab already exists, but the
  // reload is still part of the plan we print.
  if (opts.dryRun || surface) log.act(`reload browser tab "${title}"`);
  if (!opts.dryRun && surface) await cmux.reloadBrowser(surface.id);
  // A live pass that cannot see the tab (creation failed to settle) skips the
  // rpc — say so rather than skip silently; the page's own timer self-heals.
  if (!opts.dryRun && !surface) {
    log.info(`    ⚠ board tab "${title}" not visible to reload — the page's timer will pick it up`);
  }
}

/** Write a file via temp + rename, creating its parent directory. */
async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
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
 * `--prune` tail pass, in two halves: the workspaces cmux still shows, then the
 * board files left in the cache. Both run after the additive pass has created
 * all desired workspaces and populated `desired`, so "not desired" is
 * unambiguous.
 */
async function prune(desired: Set<string>, opts: Options, log: Logger) {
  await pruneWorkspaces(desired, opts, log);
  await pruneBoards(desired, opts, log);
}

/**
 * Close every workspace that isn't backed by a tracked open map (dead/untracked
 * maps) plus the stray group anchors. Emptied groups auto-remove themselves.
 */
async function pruneWorkspaces(desired: Set<string>, opts: Options, log: Logger) {
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

/**
 * Delete the generated board files no desired map backs — a closed map's board
 * and every board of a repo dropped from `tracked.yaml`. The decision is pure
 * ({@link planBoardPrune}); this half only walks the cache and unlinks. The
 * empty repo directory a dropped repo leaves behind is left in place — it costs
 * nothing and the next pass for that repo would just recreate it.
 */
async function pruneBoards(desired: Set<string>, opts: Options, log: Logger) {
  const home = homedir();
  const deletes = planBoardPrune(home, await listCacheEntries(boardCacheDir(home)), desired);
  if (deletes.length === 0) {
    log.info(`prune: no stale board files`);
    return;
  }
  log.info(`prune: deleting ${deletes.length} board file(s)`);
  for (const path of deletes) {
    log.act(`delete board ${path}`);
    if (!opts.dryRun) await rm(path, { force: true });
  }
}

/**
 * Everything under the board cache root, as absolute paths — which of those are
 * board files is {@link planBoardPrune}'s call. A cache directory that doesn't
 * exist yet (nothing generated on this machine) reads as empty; any other read
 * error is a real problem and propagates.
 */
async function listCacheEntries(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries.map((e) => join(root, e));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * One full sync pass. Reloads tracked.yaml each time so watch mode picks up
 * config edits between ticks. Returns the run's shape for the watch loop's
 * rate-budget estimate.
 */
async function runSync(
  opts: Options,
  log: Logger,
): Promise<{ repos: number; maps: number; subIssues: number }> {
  const tracked = await loadTracked(opts.configPath);
  const desired = new Set<string>();
  let subIssues = 0;
  for (const repo of tracked) {
    subIssues += await syncRepo(repo, opts, log, desired);
  }
  if (opts.prune) await prune(desired, opts, log);
  console.log(opts.dryRun ? "\n(dry run — no changes made)" : "\nsync complete");
  return { repos: tracked.length, maps: desired.size, subIssues };
}

/** GitHub's primary REST budget for an authenticated user token. */
const GH_HOURLY_LIMIT = 5000;

/**
 * If the token's core REST budget is exhausted, seconds until it resets
 * (else null). `GET /rate_limit` itself never counts against the limit, so
 * this probe is free. Errors (offline, gh missing) read as "not exhausted".
 */
async function rateLimitResetDelay(): Promise<number | null> {
  try {
    const out = await sh(["gh", "api", "rate_limit", "--jq", ".resources.core | [.remaining, .reset] | @tsv"]);
    const [remaining, reset] = out.trim().split("\t").map(Number);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining > 0) return null;
    return Math.max(0, reset - Math.floor(Date.now() / 1000)) + 5;
  } catch {
    return null;
  }
}

/**
 * `--watch`: sync forever, sleeping `watchSec` between the end of one pass and
 * the start of the next (runs never overlap). Rate-limit posture: a pass costs
 * ~2 GETs per repo (resolve + map list) + 1 per open map (sub-issue listing) +
 * 1 per sub-issue (its blocked-by listing, ticket #9) against the shared
 * 5,000/hr budget — at the default 30s cadence that's 120 × (2·repos + maps +
 * sub-issues) per hour, e.g. 3 repos / 6 maps / 40 tickets ≈ 6,240/hr, well
 * over budget. We warn once if the projected spend crosses half the budget, and
 * a failed pass checks for exhaustion and sleeps until the window resets
 * instead of hammering.
 */
async function watch(opts: Options, log: Logger) {
  log.info(`watching: syncing every ${opts.watchSec}s (ctrl-c to stop)`);
  let warnedBudget = false;
  for (;;) {
    log.info(`\n── sync @ ${new Date().toLocaleTimeString()} ──`);
    try {
      const { repos, maps, subIssues } = await runSync(opts, log);
      const perHour = Math.round((3600 / opts.watchSec!) * (2 * repos + maps + subIssues));
      if (!warnedBudget && perHour > GH_HOURLY_LIMIT / 2) {
        warnedBudget = true;
        log.info(
          `⚠ projected ~${perHour} GitHub API calls/hr — over half the ${GH_HOURLY_LIMIT}/hr budget; consider a longer --watch interval`,
        );
      }
    } catch (e) {
      console.error(`sync failed: ${e instanceof Error ? e.message : e}`);
      const wait = await rateLimitResetDelay();
      if (wait !== null) {
        log.info(`⚠ GitHub rate limit exhausted — sleeping ${Math.ceil(wait / 60)} min until it resets`);
        await Bun.sleep(wait * 1000);
      }
    }
    await Bun.sleep(opts.watchSec! * 1000);
  }
}

const opts = parseArgs(process.argv.slice(2));
const log = makeLog(opts.dryRun);
if (opts.watchSec !== null) await watch(opts, log);
else await runSync(opts, log);
