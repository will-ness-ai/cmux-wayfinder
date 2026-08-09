import { expect, test, describe } from "bun:test";
import { needsFullFetch, pacedDelaySec, type RepoPulse } from "./pace.ts";

describe("needsFullFetch", () => {
  const pulse: RepoPulse = { newestUpdate: "2026-08-06T02:00:00Z", lastFullFetchMs: 1_000_000 };
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
    const empty: RepoPulse = { newestUpdate: "", lastFullFetchMs: 1_000_000 };
    expect(needsFullFetch(empty, "", 1_000_001, BACKSTOP)).toBe(false);
  });
});

describe("pacedDelaySec", () => {
  // 4000 remaining × 0.5 headroom = 2000 spendable over a 1800s window.
  const base = { passCalls: 90, remaining: 4000, resetInSec: 1800, baseSec: 30, headroom: 0.5 };

  test("cheap pass, sustainable at base cadence → base interval", () => {
    // 8 calls need 8×1800/2000 = 7.2s between passes — under the 30s base.
    expect(pacedDelaySec({ ...base, passCalls: 8 })).toBe(30);
  });

  test("expensive pass → stretched to the sustainable interval", () => {
    // 90 calls × 1800s / 2000 spendable = 81s.
    expect(pacedDelaySec(base)).toBe(81);
  });

  test("zero-cost pass → base interval", () => {
    expect(pacedDelaySec({ ...base, passCalls: 0 })).toBe(30);
  });

  test("stretch never passes the reset — a fresh window ends the shortage", () => {
    expect(pacedDelaySec({ ...base, passCalls: 5000 })).toBe(1805);
  });

  test("nearly exhausted window (spendable < 1) → sleep just past the reset", () => {
    expect(pacedDelaySec({ ...base, remaining: 1 })).toBe(1805);
  });

  test("fully exhausted window → sleep just past the reset", () => {
    expect(pacedDelaySec({ ...base, remaining: 0 })).toBe(1805);
  });
});
