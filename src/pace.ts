/**
 * Pure pacing logic for `--watch`: when a pass must re-read a repo from
 * GitHub (staleness), and how long to sleep between passes so the loop can
 * never exhaust the API budget (the governor). No I/O here — the executor in
 * `sync.ts` probes GitHub and feeds the numbers in, so this unit-tests
 * without a live `gh`.
 */

/** What the last full GitHub read of a repo left behind, for staleness checks. */
export interface RepoPulse {
  /** The repo's newest issue/PR `updated_at`, probed just before that read. */
  newestUpdate: string;
  /** When the full read happened (ms epoch). */
  lastFullFetchMs: number;
}

/**
 * Whether a watch pass must do the full GitHub fan-out (maps + sub-issues +
 * blockers) or may reconcile from the previous read. Re-read when: first
 * sight of the repo, the probed `updated_at` moved, or the backstop age
 * passed. The backstop exists because not every edit bumps an `updated_at`
 * this repo can see — a cross-repo blocker closing, possibly a blocked-by
 * edit — so cached data can go quietly stale without it.
 */
export function needsFullFetch(
  prev: RepoPulse | undefined,
  probed: string,
  nowMs: number,
  backstopMs: number,
): boolean {
  if (!prev) return true;
  if (probed !== prev.newestUpdate) return true;
  return nowMs - prev.lastFullFetchMs >= backstopMs;
}

/**
 * Seconds to sleep after a pass so the watch stays inside the GitHub budget.
 * Spreads at most `headroom` of the remaining calls over the time left in
 * the window, assuming future passes cost about what this one did: below
 * that rate the base interval stands; above it the interval stretches, but
 * never past the reset — a fresh window makes any longer sleep pointless.
 */
export function pacedDelaySec(args: {
  /** GitHub calls the pass just made. */
  passCalls: number;
  /** Calls left in the current window. */
  remaining: number;
  /** Seconds until the window resets. */
  resetInSec: number;
  /** The configured --watch interval. */
  baseSec: number;
  /** Fraction of `remaining` the watch may spend; the rest stays free for
   *  everything else the token does (interactive `gh`, other tools). */
  headroom: number;
}): number {
  const { passCalls, remaining, resetInSec, baseSec, headroom } = args;
  const spendable = remaining * headroom;
  if (spendable < 1) return resetInSec + 5; // window exhausted — wait it out
  const minInterval = Math.ceil((passCalls * resetInSec) / spendable);
  if (minInterval <= baseSec) return baseSec;
  return Math.min(minInterval, resetInSec + 5);
}
