#!/usr/bin/env bun
/**
 * GitHub frontier reader for cmux-wayfinder (ticket #4).
 *
 * Given `owner/repo`, discover open wayfinder maps and, per map, its sub-issues
 * with unblocked status — the raw material the sync CLI turns into cmux tabs.
 * All the mapping from raw listing elements onto the domain shapes is pure and
 * lives in `issues.ts`; this module is the executor that fetches.
 *
 * A sub-issue is *unblocked* when it is open AND has no open blockers.
 * GitHub's `issue_dependencies_summary.blocked_by` counts open blockers only
 * (closed blockers drop off), so `blocked_by === 0` is exactly "unblocked".
 * That summary rides inline on each element of the `sub_issues` listing, so no
 * per-sub-issue second call is needed for it.
 *
 * The *frontier* is narrower than "unblocked": a child map (a sub-issue that
 * carries the map label) is never on it. A child map is charted work the parent
 * board must show, but it is not takeable — it gets its own workspace, so
 * putting it on the parent's frontier would open a second, wrong session on it.
 *
 * The *identities* of the blockers do need one: the `dependencies/blocked_by`
 * listing, one call per sub-issue per pass. Unlike the summary count it keeps
 * closed blockers, which is what the board's historical (grey-struck) chips are
 * drawn from — so the two numbers legitimately disagree.
 *
 * Run directly to print the frontier:  bun src/frontier.ts <owner/repo> [...]
 */

import { sh } from "./proc.ts";
import {
  MAP_LABEL,
  toBlockerNumbers,
  toSubIssue,
  type RawBlocker,
  type RawMapIssue,
  type RawSubIssue,
  type WayfinderMap,
} from "./issues.ts";

/**
 * GitHub calls made through this module since the last take. `--paginate`
 * follows Link headers, so a >100-element listing costs more HTTP requests
 * than the one it counts — rare at per_page=100, and the governor only needs
 * the right order of magnitude.
 */
let ghCallCount = 0;

/** Read-and-reset the call counter — the watch governor's per-pass cost. */
export function takeGhCallCount(): number {
  const n = ghCallCount;
  ghCallCount = 0;
  return n;
}

/**
 * GET a paginated list endpoint via `gh api`, returning every element across
 * all pages. `--paginate` follows Link headers; `--jq '.[]'` flattens each
 * page's array into newline-delimited JSON we parse line by line. `T` is the
 * caller's claim about the element shape — this is the process's one untyped
 * boundary, so the raw types in `issues.ts` keep the claim to fields we read.
 */
async function ghList<T>(path: string): Promise<T[]> {
  ghCallCount++;
  const out = await sh(["gh", "api", path, "--paginate", "--jq", ".[]"]);
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

/**
 * How many `gh` calls may be in flight at once. Every sub-issue now costs a
 * call, so a busy map would otherwise fan out to dozens of concurrent
 * subprocesses in one burst — which GitHub's secondary rate limits punish and
 * the OS pays for. Results stay in input order.
 */
const POOL = 8;

async function mapPooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
  return out;
}

/**
 * Resolve `owner/name` to its current canonical `full_name`. Repos get renamed
 * and transferred; GitHub 301-redirects single-resource GETs (which `gh` follows),
 * but list-with-query endpoints 404 on a stale name instead of redirecting — so
 * every list call below must use the canonical name this returns.
 */
export async function resolveRepo(repo: string): Promise<string> {
  ghCallCount++;
  const out = await sh(["gh", "api", `repos/${repo}`, "--jq", ".full_name"]);
  return out.trim();
}

/**
 * The repo's newest `updated_at` across issues *and* PRs (the listing carries
 * both — PR churn can only cause a harmless extra re-read), or "" for a repo
 * with none. One unpaginated call: the watch probe that decides whether the
 * full fan-out can be skipped. Linking a sub-issue bumps the *child's*
 * `updated_at` (not the parent's), so charting edits still land here.
 */
export async function probeNewestUpdate(canonical: string): Promise<string> {
  ghCallCount++;
  const out = await sh([
    "gh",
    "api",
    `repos/${canonical}/issues?state=all&sort=updated&direction=desc&per_page=1`,
    "--jq",
    '.[0].updated_at // ""',
  ]);
  return out.trim();
}

/**
 * Read every open wayfinder map in `repo` (`owner/name`) and, for each, its
 * sub-issues with unblocked status computed. Maps and sub-issues are returned
 * ascending by issue number.
 */
export async function readFrontier(repo: string): Promise<WayfinderMap[]> {
  return readFrontierFor(await resolveRepo(repo));
}

/**
 * Like {@link readFrontier} but assumes `canonical` is already the current
 * `full_name` (skips the resolve step). Use when the caller has resolved once
 * and wants the canonical name for other purposes (e.g. sync identity keys).
 */
export async function readFrontierFor(canonical: string): Promise<WayfinderMap[]> {
  const rawMaps = await ghList<RawMapIssue>(
    `repos/${canonical}/issues?state=open&labels=${MAP_LABEL}&per_page=100`,
  );
  // The issues listing can include pull requests; the label filter already
  // excludes them, but guard anyway.
  const maps = rawMaps.filter((m) => !m.pull_request).sort((a, b) => a.number - b.number);

  return Promise.all(
    maps.map(async (m): Promise<WayfinderMap> => {
      const rawSubs = await ghList<RawSubIssue>(
        `repos/${canonical}/issues/${m.number}/sub_issues?per_page=100`,
      );
      // One `blocked_by` call per sub-issue — the pass's only per-ticket cost.
      const subIssues = (
        await mapPooled(rawSubs, async (raw) =>
          toSubIssue(
            raw,
            toBlockerNumbers(
              await ghList<RawBlocker>(
                `repos/${canonical}/issues/${raw.number}/dependencies/blocked_by`,
              ),
            ),
          ),
        )
      ).sort((a, b) => a.number - b.number);
      return {
        number: m.number,
        title: m.title,
        url: m.html_url,
        subIssues,
        // A child map stays in `subIssues` (the board shows it) but never joins
        // the frontier — see this module's header.
        frontier: subIssues.filter((s) => s.unblocked && !s.isMap),
      };
    }),
  );
}

// ---------- CLI ----------

if (import.meta.main) {
  const repos = process.argv.slice(2);
  if (repos.length === 0) {
    console.error("usage: bun src/frontier.ts <owner/repo> [<owner/repo> ...]");
    process.exit(2);
  }
  for (const repo of repos) {
    const maps = await readFrontier(repo);
    console.log(`\n${repo} — ${maps.length} open map(s)`);
    for (const map of maps) {
      console.log(`\n  map #${map.number} — ${map.title}`);
      for (const s of map.subIssues) {
        // A child map is marked "▣": open and unblocked, but never takeable.
        const mark = s.state === "closed" ? "✓" : s.isMap ? "▣" : s.unblocked ? "→" : "·";
        const blocked = s.state === "open" && s.blockedBy > 0 ? ` (blocked_by ${s.blockedBy})` : "";
        const claimed = s.assignees.length ? ` @${s.assignees.join(",@")}` : "";
        const waits = s.blockers.length ? ` ⟵ ${s.blockers.map((b) => `#${b}`).join(" ")}` : "";
        console.log(`    ${mark} #${s.number} ${s.title}${blocked}${claimed}${waits}`);
      }
      console.log(
        `    frontier: ${map.frontier.length ? map.frontier.map((s) => `#${s.number}`).join(" ") : "(empty)"}`,
      );
    }
  }
}
