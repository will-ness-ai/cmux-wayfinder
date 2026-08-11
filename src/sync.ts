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
 * A ticket must clear the settle window before it gets a tab, so a map read
 * mid-charting cannot boot an agent on every ticket at once — see
 * `TICKET_SETTLE_MS`. Passes report what is settling and, in watch mode, wake
 * when it comes due.
 *
 * Default path is additive + rename-only: never closes a workspace/tab, never
 * moves focus, never deletes a file. `--prune` additionally closes done/stale
 * ticket tabs and the workspaces of closed/untracked maps (plus stray group
 * anchors), and deletes the cached board files those dead maps left behind
 * (#11) — the only path that ever removes anything. `--dry-run` prints the plan
 * without touching cmux or disk. `--watch [sec]` re-syncs every `sec` seconds
 * (default 30) until killed, probing for changes before spending the full
 * GitHub read and pacing itself against the rate budget (see `watch`).
 *
 *   bun src/sync.ts [--config tracked.yaml] [--dry-run] [--prune] [--watch [sec]]
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sh } from "./proc.ts";
import { loadTracked, type TrackedRepo } from "./config.ts";
import { probeNewestUpdate, readFrontierFor, resolveRepo, takeGhCallCount } from "./frontier.ts";
import {
  needsFullFetch,
  pacedDelaySec,
  settleAwareDelaySec,
  type PacedDelay,
  type RepoPulse,
} from "./pace.ts";
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

/** Per-repo memory between watch passes, keyed by the config's `repo` name. */
interface RepoSyncState {
  /** Canonical `full_name`, resolved once — renames are rare (see `watch`). */
  canonical: string;
  pulse: RepoPulse;
  /** The last full read, reconciled again on passes that skip GitHub. */
  maps: WayfinderMap[];
}

/**
 * The earlier of two moments, either of which may be absent — how a settle
 * deadline is folded up from tickets to map to repo to pass.
 */
function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Sync one tracked repo. In watch mode (`state` non-null) a one-call probe —
 * the repo's newest `updated_at` — decides whether to re-read maps from
 * GitHub or reuse the previous pass's; the cmux reconcile is local and free,
 * so it runs either way and a closed tab still heals at watch cadence. A
 * single run (`state` null) always reads.
 *
 * Returns when this repo's earliest settling ticket becomes takeable, or null.
 */
async function syncRepo(
  tracked: TrackedRepo,
  opts: Options,
  log: Logger,
  desired: Set<string>,
  state: Map<string, RepoSyncState> | null,
): Promise<number | null> {
  const prev = state?.get(tracked.repo);
  const canonical = prev?.canonical ?? (await resolveRepo(tracked.repo));

  let maps: WayfinderMap[];
  let freshness = "";
  if (state) {
    const probed = await probeNewestUpdate(canonical);
    const now = Date.now();
    if (needsFullFetch(prev?.pulse, probed, now, FULL_REFRESH_MS)) {
      maps = await readFrontierFor(canonical);
      state.set(tracked.repo, {
        canonical,
        // The probe ran *before* the read, so an edit landing between the two
        // shows up as a probe change next pass — an extra read, never a miss.
        pulse: { newestUpdate: probed, lastFullFetchMs: now, pendingSettling: false },
        maps,
      });
    } else {
      maps = prev!.maps;
      freshness = " — unchanged on GitHub, reconciling last read";
    }
  } else {
    maps = await readFrontierFor(canonical);
  }

  // Every open map is a workspace that *should* exist — record it so the prune
  // pass keeps it (and prunes everything else). Done even in dry-run.
  for (const map of maps) desired.add(workspaceDescription(canonical, map.number));
  log.info(
    `\n${canonical}${canonical !== tracked.repo ? ` (was ${tracked.repo})` : ""} — ${maps.length} open map(s)${freshness}`,
  );
  if (maps.length === 0) return null;

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
  let takeableAtMs: number | null = null;
  for (const map of maps) {
    takeableAtMs = earliest(
      takeableAtMs,
      await syncMap({ canonical, cwd: tracked.path, map, group, opts, log }),
    );
  }

  // Remember whether anything is still settling here: while it is, the next
  // pass must re-read this repo rather than decide on the cached maps.
  const entry = state?.get(tracked.repo);
  if (entry) entry.pulse = { ...entry.pulse, pendingSettling: takeableAtMs !== null };
  return takeableAtMs;
}

/** Returns when this map's earliest settling ticket becomes takeable, or null. */
async function syncMap(ctx: {
  canonical: string;
  cwd: string;
  map: WayfinderMap;
  group: cmux.Group | undefined;
  opts: Options;
  log: Logger;
}): Promise<number | null> {
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

  const takeableAtMs = await reconcileTabs({ ws, map, title, opts, log });

  // The lanes board goes last: it renders the state the pass just reconciled.
  await syncBoard({ canonical, map, ws, opts, log });
  return takeableAtMs;
}

/**
 * Reconcile a workspace's managed ticket tabs against the map's frontier.
 * Returns when the earliest settling ticket becomes takeable (ms epoch), or
 * null when nothing is settling.
 */
async function reconcileTabs(ctx: {
  ws: cmux.Workspace | undefined;
  map: WayfinderMap;
  /** The workspace's title — for the log lines only. */
  title: string;
  opts: Options;
  log: Logger;
}): Promise<number | null> {
  const { ws, map, title, opts, log } = ctx;
  // Without a live workspace (dry-run, uncreated) there are no existing tabs,
  // so the plan shows the full frontier as creates.
  const existing: Tab[] = ws ? await cmux.listSurfaces(ws.id) : [];
  const nowMs = Date.now();
  const plan = planTabs(existing, map, { prune: opts.prune, nowMs });

  // A child-map tab is never created any more, so a stray one is a leftover.
  // Say so every pass: the additive path will not close it (a live session may
  // be in it), so the human must close it or run --prune.
  for (const s of plan.strays) {
    log.info(
      `  ⚠ workspace "${title}": tab "${s.title}" is on child map #${s.ticket}, not a ticket — ` +
        `close it by hand or run --prune`,
    );
  }

  // A settling ticket is not a problem, so say what it is and when it lands —
  // otherwise a frontier with no tab looks like sync missed it.
  let takeableAtMs: number | null = null;
  for (const s of plan.settling) {
    takeableAtMs = earliest(takeableAtMs, s.takeableAtMs);
    const inSec = Math.max(0, Math.ceil((s.takeableAtMs - nowMs) / 1000));
    log.info(
      `  ⏳ workspace "${title}": ticket #${s.ticket} is still settling — ` +
        `takeable in ${inSec}s (the map may still be charting)`,
    );
  }

  if (plan.creates.length === 0 && plan.renames.length === 0 && plan.closes.length === 0) {
    log.info(`  workspace "${title}": up to date (frontier ${fmtFrontier(map)})`);
    return takeableAtMs;
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
    const why =
      c.reason === "child-map"
        ? `#${c.ticket} is a child map, not a ticket`
        : `ticket #${c.ticket} no longer open`;
    log.act(`close tab "${c.title}" (${why})`);
    if (!opts.dryRun && ws) {
      const surf = (await cmux.listSurfaces(ws.id)).find((s) => s.id === c.id);
      if (surf) await cmux.closeSurface(surf.id);
    }
  }

  // Order managed tabs by ticket, after any non-managed (default shell) tabs.
  if (!opts.dryRun && ws) await orderTabs(ws.id, plan.desiredOrder);
  return takeableAtMs;
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
 * config edits between ticks. `state` (watch mode only) carries the probe
 * baselines and cached reads between passes; null = always read GitHub.
 *
 * Returns when the pass's earliest settling ticket becomes takeable (ms epoch),
 * or null when nothing is settling — what `watch` sleeps towards.
 */
async function runSync(
  opts: Options,
  log: Logger,
  state: Map<string, RepoSyncState> | null = null,
): Promise<number | null> {
  const tracked = await loadTracked(opts.configPath);
  const desired = new Set<string>();
  let takeableAtMs: number | null = null;
  for (const repo of tracked) {
    takeableAtMs = earliest(takeableAtMs, await syncRepo(repo, opts, log, desired, state));
  }
  if (opts.prune) await prune(desired, opts, log);
  console.log(opts.dryRun ? "\n(dry run — no changes made)" : "\nsync complete");
  return takeableAtMs;
}

/**
 * Force a full GitHub re-read at least this often per repo, probe or no
 * probe — the backstop for edits the probe cannot see (see `needsFullFetch`).
 */
const FULL_REFRESH_MS = 5 * 60_000;

/** The watch loop's share of the *remaining* budget; the rest stays free for
 *  everything else on the token (interactive `gh`, other tools). */
const GOVERNOR_HEADROOM = 0.5;

/**
 * The token's core REST budget: calls remaining and seconds until the window
 * resets. `GET /rate_limit` itself never counts against the limit, so this
 * probe is free. Errors (offline, gh missing) read as null — no data.
 */
async function ghCoreBudget(): Promise<{ remaining: number; resetInSec: number } | null> {
  try {
    const out = await sh(["gh", "api", "rate_limit", "--jq", ".resources.core | [.remaining, .reset] | @tsv"]);
    const [remaining, reset] = out.trim().split("\t").map(Number);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
    return { remaining, resetInSec: Math.max(0, reset - Math.floor(Date.now() / 1000)) };
  } catch {
    return null;
  }
}

/**
 * `--watch`: sync forever, sleeping between the end of one pass and the start
 * of the next (runs never overlap). Two guards keep the loop inside GitHub's
 * shared 5,000/hr core budget:
 *
 * 1. Probe-then-read (`syncRepo`): a steady-state pass costs one call per
 *    repo; only a probed change or the FULL_REFRESH_MS backstop triggers the
 *    full fan-out (2 per repo + 1 per open map + 1 per sub-issue).
 * 2. Governor: after each pass, stretch the sleep so the measured pass cost
 *    spends at most GOVERNOR_HEADROOM of the remaining window budget
 *    (`pacedDelaySec`) — the loop slows down *before* the limit, whatever
 *    else the token is being used for.
 *
 * A failed pass drops all cached state (a repo rename mid-watch heals on the
 * next pass) and still sleeps until the reset if the budget is exhausted.
 */
async function watch(opts: Options, log: Logger) {
  log.info(`watching: syncing every ${opts.watchSec}s (ctrl-c to stop)`);
  const state = new Map<string, RepoSyncState>();
  for (;;) {
    log.info(`\n── sync @ ${new Date().toLocaleTimeString()} ──`);
    let delaySec = opts.watchSec!;
    try {
      const takeableAtMs = await runSync(opts, log, state);
      const passCalls = takeGhCallCount();
      const budget = await ghCoreBudget();
      // No budget reading (offline, gh missing) → the configured interval, and
      // treated as un-throttled so a settling ticket can still pull it in.
      const paced: PacedDelay = budget
        ? pacedDelaySec({
            passCalls,
            remaining: budget.remaining,
            resetInSec: budget.resetInSec,
            baseSec: opts.watchSec!,
            headroom: GOVERNOR_HEADROOM,
          })
        : { sec: opts.watchSec!, throttled: false };
      if (budget) {
        log.info(
          `gh budget: pass used ${passCalls} call(s); ${budget.remaining} remaining, window resets in ${Math.ceil(budget.resetInSec / 60)} min`,
        );
        if (paced.throttled) {
          log.info(`⚠ pacing: next sync in ${paced.sec}s to stay inside the rate budget`);
        }
      }
      // Wake for a settling ticket rather than a tick after it — but never
      // ahead of a throttled sleep, which protects the rate budget.
      delaySec = settleAwareDelaySec({
        paced,
        msToTakeable: takeableAtMs === null ? null : takeableAtMs - Date.now(),
      });
      if (delaySec < paced.sec) {
        log.info(`next sync in ${delaySec}s — a settling ticket becomes takeable`);
      }
    } catch (e) {
      console.error(`sync failed: ${e instanceof Error ? e.message : e}`);
      state.clear(); // stale canonical names or cached maps may be the cause
      takeGhCallCount(); // drop the aborted pass's count
      const budget = await ghCoreBudget();
      if (budget && budget.remaining <= 0) {
        const wait = budget.resetInSec + 5;
        log.info(`⚠ GitHub rate limit exhausted — sleeping ${Math.ceil(wait / 60)} min until it resets`);
        await Bun.sleep(wait * 1000);
      }
    }
    await Bun.sleep(delaySec * 1000);
  }
}

const opts = parseArgs(process.argv.slice(2));
const log = makeLog(opts.dryRun);
if (opts.watchSec !== null) await watch(opts, log);
else await runSync(opts, log);
