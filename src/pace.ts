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
  /**
   * Whether the last pass left a ticket settling. Such a ticket must never be
   * taken on the strength of a cached read: the read that saw it may be the
   * mid-charting one settling exists to distrust, and the edit that corrects it
   * (a `blocked_by` edge being wired) is not guaranteed to move any
   * `updated_at` the probe can see.
   */
  pendingSettling: boolean;
}

/**
 * Whether a watch pass must do the full GitHub fan-out (maps + sub-issues +
 * blockers) or may reconcile from the previous read. Re-read when: first
 * sight of the repo, a ticket is settling, the probed `updated_at` moved, or
 * the backstop age passed. The backstop exists because not every edit bumps an
 * `updated_at` this repo can see — a cross-repo blocker closing, possibly a
 * blocked-by edit — so cached data can go quietly stale without it.
 */
export function needsFullFetch(
  prev: RepoPulse | undefined,
  probed: string,
  nowMs: number,
  backstopMs: number,
): boolean {
  if (!prev) return true;
  if (prev.pendingSettling) return true; // decide a settling ticket on fresh data
  if (probed !== prev.newestUpdate) return true;
  return nowMs - prev.lastFullFetchMs >= backstopMs;
}

/** The governor's verdict on how long to sleep after a pass. */
export interface PacedDelay {
  /** Seconds to sleep. */
  sec: number;
  /**
   * Whether the budget, rather than the configured interval, set `sec`. A
   * throttled sleep is the governor protecting the API budget, so nothing may
   * shorten it — see {@link settleAwareDelaySec}. Reported rather than inferred
   * from `sec !== baseSec`, which collides whenever the two happen to be equal.
   */
  throttled: boolean;
}

/**
 * How long to sleep after a pass so the watch stays inside the GitHub budget.
 * Spreads at most `headroom` of the remaining calls over the time left in
 * the window, assuming future passes cost about what this one did: below
 * that rate the base interval stands; above it the interval stretches, but
 * never past the reset — a fresh window makes any longer sleep pointless.
 *
 * A throttled sleep can come out *shorter* than the base interval (a window
 * about to reset), so `throttled` is the flag to read, never the duration.
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
}): PacedDelay {
  const { passCalls, remaining, resetInSec, baseSec, headroom } = args;
  const spendable = remaining * headroom;
  // Window exhausted — wait it out.
  if (spendable < 1) return { sec: resetInSec + 5, throttled: true };
  const minInterval = Math.ceil((passCalls * resetInSec) / spendable);
  if (minInterval <= baseSec) return { sec: baseSec, throttled: false };
  return { sec: Math.min(minInterval, resetInSec + 5), throttled: true };
}

/**
 * Shorten the sleep so the next pass lands just after a settling ticket becomes
 * takeable, instead of at the next tick — otherwise a ticket settling one
 * second into a sleep waits a whole interval on top of its settle window.
 *
 * The governor wins whenever it is throttling: a shorter sleep would spend
 * calls it has already ruled out, so that sleep is returned untouched.
 * Shortening only ever happens inside the interval the user asked for.
 *
 * `msToTakeable` is the wait until the *earliest* settling ticket across the
 * whole pass, or null when nothing is settling.
 */
export function settleAwareDelaySec(args: {
  /** The governor's verdict for this pass, from {@link pacedDelaySec}. */
  paced: PacedDelay;
  /** Ms until the earliest settling ticket is takeable; null if none. */
  msToTakeable: number | null;
}): number {
  const { paced, msToTakeable } = args;
  if (msToTakeable === null || paced.throttled) return paced.sec;
  // +1s so the pass runs *after* the window expires, not exactly on it.
  const wake = Math.ceil(msToTakeable / 1000) + 1;
  return Math.max(1, Math.min(paced.sec, wake));
}
