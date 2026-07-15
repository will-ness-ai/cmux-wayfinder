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
 * per-sub-issue second call is needed.
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
  url: string;
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

function toSubIssue(raw: any): SubIssue {
  const blockedBy: number = raw.issue_dependencies_summary?.blocked_by ?? 0;
  const state: IssueState = raw.state === "closed" ? "closed" : "open";
  return {
    number: raw.number,
    title: raw.title,
    state,
    blockedBy,
    unblocked: state === "open" && blockedBy === 0,
    assignees: (raw.assignees ?? []).map((a: any) => a.login),
    url: raw.html_url,
  };
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
      const subIssues = rawSubs.map(toSubIssue).sort((a, b) => a.number - b.number);
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
        console.log(`    ${mark} #${s.number} ${s.title}${blocked}${claimed}`);
      }
      console.log(
        `    frontier: ${map.frontier.length ? map.frontier.map((s) => `#${s.number}`).join(" ") : "(empty)"}`,
      );
    }
  }
}
