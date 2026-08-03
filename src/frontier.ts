#!/usr/bin/env bun
/**
 * GitHub frontier reader for cmux-wayfinder (ticket #4).
 *
 * Given `owner/repo`, discover open wayfinder maps and, per map, its sub-issues
 * with unblocked status — the raw material the sync CLI turns into cmux tabs.
 *
 * A sub-issue is *unblocked* when it is open AND has no open blockers.
 * GitHub's `issue_dependencies_summary.blocked_by` counts open blockers only
 * (closed blockers drop off), so `blocked_by === 0` is exactly "unblocked".
 * That summary rides inline on each element of the `sub_issues` listing, so no
 * per-sub-issue second call is needed for it.
 *
 * The *identities* of the blockers do need one: the `dependencies/blocked_by`
 * listing, one call per sub-issue per pass. Unlike the summary count it keeps
 * closed blockers, which is what the board's historical (grey-struck) chips are
 * drawn from — so the two numbers legitimately disagree.
 *
 * Run directly to print the frontier:  bun src/frontier.ts <owner/repo> [...]
 */

import { sh } from "./proc.ts";

export type IssueState = "open" | "closed";

export interface SubIssue {
  number: number;
  title: string;
  state: IssueState;
  /** Count of *open* blockers (GitHub drops closed ones from this field). */
  blockedBy: number;
  /** open && blockedBy === 0 — takeable right now. */
  unblocked: boolean;
  assignees: string[];
  /** Label names — carries the `wayfinder:<type>` ticket-type label. */
  labels: string[];
  /**
   * The issue's markdown body, as the lanes board's modal renders it. It rides
   * the `sub_issues` listing already, so carrying it costs no extra call.
   */
  body: string;
  url: string;
  /**
   * Blocker issue numbers, open *and* closed, repo-wide. {@link blockedBy} is
   * the open-only count, so this list can be longer (history) or shorter
   * (blockers this reader cannot see) — neither is a bug.
   */
  blockers: number[];
}

export interface WayfinderMap {
  number: number;
  title: string;
  url: string;
  /** All sub-issues, ascending by number. */
  subIssues: SubIssue[];
  /** The subset that is open + unblocked. */
  frontier: SubIssue[];
}

const MAP_LABEL = "wayfinder:map";

/**
 * GET a paginated list endpoint via `gh api`, returning every element across
 * all pages. `--paginate` follows Link headers; `--jq '.[]'` flattens each
 * page's array into newline-delimited JSON we parse line by line.
 */
async function ghList(path: string): Promise<any[]> {
  const out = await sh(["gh", "api", path, "--paginate", "--jq", ".[]"]);
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
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

/** One element of the `sub_issues` listing, plus its separately-read blockers. */
export function toSubIssue(raw: any, blockers: number[]): SubIssue {
  const blockedBy: number = raw.issue_dependencies_summary?.blocked_by ?? 0;
  const state: IssueState = raw.state === "closed" ? "closed" : "open";
  return {
    number: raw.number,
    title: raw.title,
    state,
    blockedBy,
    unblocked: state === "open" && blockedBy === 0,
    assignees: (raw.assignees ?? []).map((a: any) => a.login),
    labels: (raw.labels ?? []).map((l: any) => l?.name).filter(Boolean),
    // GitHub sends `null` for an issue opened with no description.
    body: raw.body ?? "",
    url: raw.html_url,
    blockers,
  };
}

/** The issue numbers of a `dependencies/blocked_by` listing, ascending. */
export function toBlockerNumbers(raw: any[]): number[] {
  return raw.map((b: any) => b.number as number).sort((a, b) => a - b);
}

/**
 * Every sub-issue keyed to its blockers — the edge list the lanes board embeds.
 * Refs to issues outside the map are the board's to drop, not this reader's.
 */
export function blockedByEdges(subIssues: SubIssue[]): Record<string, number[]> {
  return Object.fromEntries(subIssues.map((s) => [String(s.number), s.blockers]));
}

/**
 * Resolve `owner/name` to its current canonical `full_name`. Repos get renamed
 * and transferred; GitHub 301-redirects single-resource GETs (which `gh` follows),
 * but list-with-query endpoints 404 on a stale name instead of redirecting — so
 * every list call below must use the canonical name this returns.
 */
export async function resolveRepo(repo: string): Promise<string> {
  const out = await sh(["gh", "api", `repos/${repo}`, "--jq", ".full_name"]);
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
  const rawMaps = await ghList(
    `repos/${canonical}/issues?state=open&labels=${MAP_LABEL}&per_page=100`,
  );
  // The issues listing can include pull requests; the label filter already
  // excludes them, but guard anyway.
  const maps = rawMaps.filter((m) => !m.pull_request).sort((a, b) => a.number - b.number);

  return Promise.all(
    maps.map(async (m): Promise<WayfinderMap> => {
      const rawSubs = await ghList(`repos/${canonical}/issues/${m.number}/sub_issues?per_page=100`);
      // One `blocked_by` call per sub-issue — the pass's only per-ticket cost.
      const subIssues = (
        await mapPooled(rawSubs, async (raw) =>
          toSubIssue(
            raw,
            toBlockerNumbers(
              await ghList(`repos/${canonical}/issues/${raw.number}/dependencies/blocked_by`),
            ),
          ),
        )
      ).sort((a, b) => a.number - b.number);
      return {
        number: m.number,
        title: m.title,
        url: m.html_url,
        subIssues,
        frontier: subIssues.filter((s) => s.unblocked),
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
        const mark = s.state === "closed" ? "✓" : s.unblocked ? "→" : "·";
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
