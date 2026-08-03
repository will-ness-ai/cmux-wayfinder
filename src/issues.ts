/**
 * Pure issue-domain core: the shapes sync and the lanes board share, and the
 * mapping from GitHub's raw listing elements onto them.
 *
 * Everything here is a pure function over plain data, unit-tested without a
 * live `gh` (the executor in `frontier.ts` only fetches and hands the raw
 * elements over). The raw types below are deliberately *slices*: just the
 * fields this codebase reads, so a listing element with more on it is fine and
 * a missing optional reads as its documented default.
 */

export type IssueState = "open" | "closed";

/** The slice of a `sub_issues` listing element this codebase reads. */
export interface RawSubIssue {
  number: number;
  title: string;
  state: string;
  /** Open-blocker summary; absent when the issue has no dependencies at all. */
  issue_dependencies_summary?: { blocked_by?: number };
  assignees?: Array<{ login: string }>;
  labels?: Array<{ name?: string } | null>;
  /** GitHub sends `null` for an issue opened with no description. */
  body?: string | null;
  html_url: string;
}

/** The slice of a `dependencies/blocked_by` listing element this codebase reads. */
export interface RawBlocker {
  number: number;
}

/** The slice of an issues-listing element (a wayfinder map) this codebase reads. */
export interface RawMapIssue {
  number: number;
  title: string;
  html_url: string;
  /** Present when the element is really a pull request — filtered out. */
  pull_request?: unknown;
}

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

/**
 * Ticket number → blocker numbers. Keys are strings because the map travels
 * through JSON (the board's embedded payload), where object keys always are.
 */
export type EdgeMap = Record<string, number[]>;

/** One element of the `sub_issues` listing, plus its separately-read blockers. */
export function toSubIssue(raw: RawSubIssue, blockers: number[]): SubIssue {
  const blockedBy = raw.issue_dependencies_summary?.blocked_by ?? 0;
  const state: IssueState = raw.state === "closed" ? "closed" : "open";
  return {
    number: raw.number,
    title: raw.title,
    state,
    blockedBy,
    unblocked: state === "open" && blockedBy === 0,
    assignees: (raw.assignees ?? []).map((a) => a.login),
    labels: (raw.labels ?? []).map((l) => l?.name).filter((n): n is string => Boolean(n)),
    body: raw.body ?? "",
    url: raw.html_url,
    blockers,
  };
}

/** The issue numbers of a `dependencies/blocked_by` listing, ascending. */
export function toBlockerNumbers(raw: RawBlocker[]): number[] {
  return raw.map((b) => b.number).sort((a, b) => a - b);
}

/**
 * Every sub-issue keyed to its blockers — the edge list the lanes board embeds.
 * Refs to issues outside the map are the board's to drop, not this reader's.
 */
export function blockedByEdges(subIssues: SubIssue[]): EdgeMap {
  return Object.fromEntries(subIssues.map((s) => [String(s.number), s.blockers]));
}
