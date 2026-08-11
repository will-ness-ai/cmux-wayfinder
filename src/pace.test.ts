import { expect, test, describe } from "bun:test";
import { needsFullFetch, pacedDelaySec, settleAwareDelaySec, type RepoPulse } from "./pace.ts";

describe("needsFullFetch", () => {
  const pulse: RepoPulse = { newestUpdate: "2026-08-06T02:00:00Z", lastFullFetchMs: 1_000_000, pendingSettling: false };
  const BACKSTOP = 300_000;

  test("first sight of a repo → full fetch", () => {
    expect(needsFullFetch(undefined, "2026-08-06T02:00:00Z", 0, BACKSTOP)).toBe(true);
  });

  test("probe unchanged, inside the backstop → reuse the last read", () => {
    expect(needsFullFetch(pulse, "2026-08-06T02:00:00Z", 1_000_000 + BACKSTOP - 1, BACKSTOP)).toBe(false);
  });

  test("probe moved → full fetch", () => {
    expect(needsFullFetch(pulse, "2026-08-06T02:05:00Z", 1_000_000 + 1, BACKSTOP)).toBe(true);
  });

  test("backstop age reached → full fetch even when the probe is unchanged", () => {
    expect(needsFullFetch(pulse, "2026-08-06T02:00:00Z", 1_000_000 + BACKSTOP, BACKSTOP)).toBe(true);
  });

  test("an empty repo probes as '' — a stable value, not a change", () => {
    const empty: RepoPulse = { newestUpdate: "", lastFullFetchMs: 1_000_000, pendingSettling: false };
    expect(needsFullFetch(empty, "", 1_000_001, BACKSTOP)).toBe(false);
  });

  test("a settling ticket → full fetch, however quiet the probe is", () => {
    // The cached read may be the mid-charting one settling exists to distrust,
    // and wiring a blocked_by edge need not move any updated_at we can see. So
    // a settling ticket is only ever decided on data read this pass.
    const settling: RepoPulse = { ...pulse, pendingSettling: true };
    expect(needsFullFetch(settling, "2026-08-06T02:00:00Z", 1_000_001, BACKSTOP)).toBe(true);
  });
});

describe("settleAwareDelaySec", () => {
  const free = { sec: 30, throttled: false };

  test("nothing settling → the governor's sleep stands", () => {
    expect(settleAwareDelaySec({ paced: free, msToTakeable: null })).toBe(30);
  });

  test("wakes just after the window expires instead of at the next tick", () => {
    // Takeable in 12s: sleeping the full 30s would idle the ticket for 18s.
    expect(settleAwareDelaySec({ paced: free, msToTakeable: 12_000 })).toBe(13);
  });

  test("a window past the next tick does not stretch the sleep", () => {
    expect(settleAwareDelaySec({ paced: free, msToTakeable: 119_000 })).toBe(30);
  });

  test("the budget governor wins — a throttled sleep is never shortened", () => {
    // Throttling means the governor is protecting the API budget; an earlier
    // pass would spend calls it has already ruled out.
    expect(
      settleAwareDelaySec({ paced: { sec: 81, throttled: true }, msToTakeable: 5_000 }),
    ).toBe(81);
  });

  test("a throttled sleep SHORTER than the interval is still never shortened", () => {
    // The regression: an exhausted window resetting in 20s yields a 25s
    // throttled sleep, which is under a 30s --watch interval. Reading the
    // duration instead of the flag let a settle wake cut a rate-limit backoff
    // to ~2s, so the next pass ran straight into the exhausted budget.
    const backoff = pacedDelaySec({
      passCalls: 40,
      remaining: 0,
      resetInSec: 20,
      baseSec: 30,
      headroom: 0.5,
    });
    expect(backoff).toEqual({ sec: 25, throttled: true }); // shorter than baseSec
    expect(settleAwareDelaySec({ paced: backoff, msToTakeable: 200 })).toBe(25);
  });

  test("an already-expired window still sleeps a whole second", () => {
    expect(settleAwareDelaySec({ paced: free, msToTakeable: -5_000 })).toBe(1);
  });
});

describe("pacedDelaySec", () => {
  // 4000 remaining × 0.5 headroom = 2000 spendable over a 1800s window.
  const base = { passCalls: 90, remaining: 4000, resetInSec: 1800, baseSec: 30, headroom: 0.5 };

  test("cheap pass, sustainable at base cadence → base interval", () => {
    // 8 calls need 8×1800/2000 = 7.2s between passes — under the 30s base.
    expect(pacedDelaySec({ ...base, passCalls: 8 })).toEqual({ sec: 30, throttled: false });
  });

  test("expensive pass → stretched to the sustainable interval", () => {
    // 90 calls × 1800s / 2000 spendable = 81s.
    expect(pacedDelaySec(base)).toEqual({ sec: 81, throttled: true });
  });

  test("zero-cost pass → base interval", () => {
    expect(pacedDelaySec({ ...base, passCalls: 0 })).toEqual({ sec: 30, throttled: false });
  });

  test("stretch never passes the reset — a fresh window ends the shortage", () => {
    expect(pacedDelaySec({ ...base, passCalls: 5000 })).toEqual({ sec: 1805, throttled: true });
  });

  test("nearly exhausted window (spendable < 1) → sleep just past the reset", () => {
    expect(pacedDelaySec({ ...base, remaining: 1 })).toEqual({ sec: 1805, throttled: true });
  });

  test("fully exhausted window → sleep just past the reset", () => {
    expect(pacedDelaySec({ ...base, remaining: 0 })).toEqual({ sec: 1805, throttled: true });
  });
});
