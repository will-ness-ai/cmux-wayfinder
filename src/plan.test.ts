import { expect, test, describe } from "bun:test";
import type { SubIssue, WayfinderMap } from "./issues.ts";
import {
  boardCacheDir,
  boardPath,
  fileUrl,
  groupName,
  isManagedWorkspaceTitle,
  isMapComplete,
  lanesTabTitle,
  launchCommand,
  mapLabel,
  mapTabTitle,
  parseManagedTabTitle,
  parseWorkspaceDescription,
  planBoardPrune,
  planTabs,
  planWorkspacePrune,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  readinessOf,
  repoShort,
  ticketPrompt,
  ticketTabTitle,
  ticketTypeOf,
  workspaceDescription,
  workspaceTitle,
  worktreeName,
  type GroupRef,
  type Tab,
  type WorkspaceRef,
} from "./plan.ts";

function sub(
  number: number,
  state: "open" | "closed",
  blockedBy = 0,
  labels: string[] = [],
): SubIssue {
  return {
    number,
    title: `Ticket ${number}`,
    state,
    blockedBy,
    unblocked: state === "open" && blockedBy === 0,
    assignees: [],
    labels,
    body: "",
    url: `https://x/${number}`,
    blockers: [],
  };
}

function mapOf(number: number, subIssues: SubIssue[]): WayfinderMap {
  return {
    number,
    title: `Map ${number}`,
    url: `https://x/${number}`,
    subIssues,
    frontier: subIssues.filter((s) => s.unblocked),
  };
}

describe("formatters", () => {
  test("identity keys", () => {
    expect(repoShort("acme/example")).toBe("example");
    expect(groupName("acme/example")).toBe("example wayfinder");
    expect(workspaceDescription("acme/example", 101)).toBe("acme/example#101");
    expect(worktreeName(101, 103)).toBe("wayfinder/101/103");
  });

  test("isMapComplete: all sub-issues closed (and non-empty)", () => {
    expect(isMapComplete(mapOf(101, [sub(1, "closed"), sub(2, "closed")]))).toBe(true);
    expect(isMapComplete(mapOf(101, [sub(1, "closed"), sub(2, "open")]))).toBe(false);
    expect(isMapComplete(mapOf(101, []))).toBe(false); // no sub-issues yet ≠ done
  });

  test("isManagedWorkspaceTitle: matches the derived label, ✓ variant, and legacy format", () => {
    const t = "Wayfinder map: app notifications — badge counts on the shell";
    // current map-derived label + its ✓ variant
    expect(isManagedWorkspaceTitle("app notifications", "acme/homebase", 212, t)).toBe(true);
    expect(isManagedWorkspaceTitle("✓ app notifications", "acme/homebase", 212, t)).toBe(true);
    // legacy repoShort/map format (+ ✓) — recognized so a live run upgrades it
    expect(isManagedWorkspaceTitle("homebase/212", "acme/homebase", 212, t)).toBe(true);
    expect(isManagedWorkspaceTitle("✓homebase/212", "acme/homebase", 212, t)).toBe(true);
    // hand-renamed / mismatched → left alone
    expect(isManagedWorkspaceTitle("notifs WIP", "acme/homebase", 212, t)).toBe(false);
    expect(isManagedWorkspaceTitle("homebase/213", "acme/homebase", 212, t)).toBe(false);
  });

  test("launch command carries the worktree but NOT the prompt", () => {
    expect(launchCommand(101, 103)).toBe("claude --worktree wayfinder/101/103");
    expect(launchCommand(101, 103)).not.toContain("wayfinder map"); // typed into the TUI instead
  });

  test("ticket prompt is the slash command typed into the TUI and submitted", () => {
    expect(ticketPrompt(101, 103)).toBe(
      "/wayfinder map #101 work on ticket #103. If you end up creating files (prototype, research, etc..) ensure that you create and merge a PR containing those artifacts",
    );
  });

  test("map tab title is a marker the numbered matcher ignores", () => {
    expect(mapTabTitle(101)).toBe("map #101");
    expect(parseManagedTabTitle(mapTabTitle(101))).toBeNull(); // not a managed ticket tab
  });

  test("lanes tab title is a marker too — tab reconciliation never touches it", () => {
    expect(lanesTabTitle(101)).toBe("lanes #101");
    expect(parseManagedTabTitle(lanesTabTitle(101))).toBeNull();
    expect(lanesTabTitle(101)).not.toBe(mapTabTitle(101));
  });
});

describe("mapLabel / workspaceTitle", () => {
  test("strips the 'Wayfinder map:' prefix and keeps the headline before the tagline", () => {
    expect(mapLabel("Wayfinder map: app notifications — badge counts on the shell", 212)).toBe(
      "app notifications",
    );
    expect(mapLabel("Wayfinder map: workout.exe — plan-driven lifting tracker", 195)).toBe(
      "workout.exe",
    );
  });

  test("keeps the whole headline when there is no tagline separator", () => {
    expect(mapLabel("Wayfinder map: nutrition.exe food + weight tracker", 168)).toBe(
      "nutrition.exe food + weight tracker",
    );
  });

  test("splits only on a space-delimited separator, not a mid-word hyphen", () => {
    // "plan-driven" must not split; the " — " before it is the real separator.
    expect(mapLabel("Wayfinder map: workout.exe — plan-driven lifting tracker", 1)).toBe(
      "workout.exe",
    );
  });

  test("handles titles without the boilerplate prefix", () => {
    expect(mapLabel("app notifications — later", 1)).toBe("app notifications");
    expect(mapLabel("just a plain title", 1)).toBe("just a plain title");
  });

  test("clamps an over-long headline with an ellipsis", () => {
    const label = mapLabel(`Wayfinder map: ${"x".repeat(80)}`, 1);
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.endsWith("…")).toBe(true);
  });

  test("falls back to 'map #<n>' for a boilerplate-only or empty title", () => {
    expect(mapLabel("Wayfinder map:", 7)).toBe("map #7");
    expect(mapLabel("   ", 7)).toBe("map #7");
  });

  test("workspaceTitle prefixes ✓ once the map is done", () => {
    const t = "Wayfinder map: app notifications — badge counts on the shell";
    expect(workspaceTitle(t, 212)).toBe("app notifications");
    expect(workspaceTitle(t, 212, true)).toBe("✓ app notifications");
  });
});

describe("ticket tab titles [XY]<n>", () => {
  test("type emoji from the wayfinder:<type> label; unlabeled is a task", () => {
    expect(ticketTabTitle(42, ["wayfinder:grilling"], READY_FOR_HUMAN)).toBe("[🗣️🫵]42");
    expect(ticketTabTitle(42, ["wayfinder:task"], READY_FOR_AGENT)).toBe("[🔨🤖]42");
    expect(ticketTabTitle(42, ["wayfinder:research"], READY_FOR_AGENT)).toBe("[🔎🤖]42");
    expect(ticketTabTitle(42, ["wayfinder:prototype"], READY_FOR_AGENT)).toBe("[🧪🤖]42");
    expect(ticketTabTitle(42, ["bug"], READY_FOR_AGENT)).toBe("[🔨🤖]42");
  });

  test("ticketTypeOf reads only wayfinder:<type> labels, defaulting to task", () => {
    expect(ticketTypeOf(["bug", "wayfinder:research"])).toBe("research");
    expect(ticketTypeOf(["wayfinder:map"])).toBe("task");
    expect(ticketTypeOf([])).toBe("task");
  });

  test("readiness labels are the source of truth; HITL default; human wins", () => {
    expect(readinessOf(["ready-for-human"])).toBe(READY_FOR_HUMAN);
    expect(readinessOf(["ready-for-agent"])).toBe(READY_FOR_AGENT);
    expect(readinessOf(["ready-for-human", "ready-for-agent"])).toBe(READY_FOR_HUMAN);
    expect(readinessOf(["wayfinder:research"])).toBe(READY_FOR_HUMAN); // no label → HITL
    expect(readinessOf([])).toBe(READY_FOR_HUMAN);
  });
});

describe("parseManagedTabTitle", () => {
  test("matches [XY]<n> titles", () => {
    expect(parseManagedTabTitle("[🗣️🫵]42")).toBe(42);
    expect(parseManagedTabTitle("[🔎🤖]7")).toBe(7);
    expect(parseManagedTabTitle("[🧪✓]7")).toBe(7);
    expect(parseManagedTabTitle("[🔨🤖]103")).toBe(103);
  });
  test("matches legacy bare and done-marked numbers (upgrade path)", () => {
    expect(parseManagedTabTitle("42")).toBe(42);
    expect(parseManagedTabTitle("✓42")).toBe(42);
    expect(parseManagedTabTitle("  7 ")).toBe(7);
  });
  test("tolerates a stripped variation selector (🗣️ vs 🗣)", () => {
    expect(parseManagedTabTitle("[\u{1F5E3}🫵]42")).toBe(42); // 🗣 without U+FE0F
  });
  test("rejects non-managed titles", () => {
    for (const t of [
      "",
      "shell",
      "Claude Code",
      "⠂ Claude",
      "v101",
      "42a",
      "✓",
      "1.2",
      "✓✓4",
      "[🍕🤖]42", // unknown type emoji → hand-made, not ours
      "[🗣️]42", // missing readiness slot
      "[🗣️🫵]", // no ticket number
      "[🗣️🫵] 42", // space between bracket and number
    ]) {
      expect(parseManagedTabTitle(t)).toBeNull();
    }
  });
});

describe("planTabs", () => {
  const shell: Tab = { id: "s0", title: "zsh" };

  test("creates tabs for frontier tickets missing a tab, ascending, with boot cmd", () => {
    const map = mapOf(101, [
      sub(103, "open", 0, ["wayfinder:research", "ready-for-agent"]),
      sub(107, "open", 0, ["wayfinder:grilling"]),
      sub(105, "open", 1),
    ]);
    const plan = planTabs([shell], map);
    expect(plan.creates.map((c) => c.ticket)).toEqual([103, 107]); // 105 is blocked → not frontier
    expect(plan.creates[0].title).toBe("[🔎🤖]103"); // labelled ready-for-agent
    expect(plan.creates[1].title).toBe("[🗣️🫵]107"); // no readiness label → HITL
    expect(plan.creates[0].launch).toBe(launchCommand(101, 103));
    expect(plan.creates[0].prompt).toBe(ticketPrompt(101, 103));
    expect(plan.renames).toEqual([]);
    expect(plan.desiredOrder).toEqual([103, 107]);
  });

  test("does not recreate or rename an up-to-date tab (idempotent)", () => {
    const map = mapOf(101, [sub(103, "open"), sub(107, "open", 0, ["wayfinder:grilling"])]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🔨🫵]103" }, { id: "t2", title: "[🗣️🫵]107" }],
      map,
    );
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  test("upgrades a legacy bare-number tab to [XY]<n> in place", () => {
    const map = mapOf(101, [sub(103, "open", 0, ["wayfinder:prototype", "ready-for-agent"])]);
    const plan = planTabs([shell, { id: "t1", title: "103" }], map);
    expect(plan.creates).toEqual([]); // upgraded, not recreated
    expect(plan.renames).toEqual([{ id: "t1", from: "103", to: "[🧪🤖]103" }]);
  });

  test("marks a closed ticket's tab done (Y slot → ✓), never closes it", () => {
    const map = mapOf(101, [
      sub(103, "closed", 0, ["wayfinder:research", "ready-for-agent"]),
      sub(107, "open"),
    ]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🔎🤖]103" }, { id: "t2", title: "[🔨🫵]107" }],
      map,
    );
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([{ id: "t1", from: "[🔎🤖]103", to: "[🔎✓]103" }]);
  });

  test("flips a reopened ticket's tab back (✓ → label-derived readiness)", () => {
    const map = mapOf(101, [sub(103, "open", 0, ["wayfinder:grilling"]), sub(107, "open")]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🗣️✓]103" }, { id: "t2", title: "[🔨🫵]107" }],
      map,
    );
    // reopened + unblocked: flip back to 🫵 (no readiness label), don't re-create
    expect(plan.renames).toEqual([{ id: "t1", from: "[🗣️✓]103", to: "[🗣️🫵]103" }]);
    expect(plan.creates).toEqual([]);
  });

  test("does not rename-churn when a layer stripped the variation selector", () => {
    // live title is 🗣 (no U+FE0F); desired is 🗣️ — same tab, no rename
    const map = mapOf(101, [sub(103, "open", 0, ["wayfinder:grilling"])]);
    const plan = planTabs([shell, { id: "t1", title: "[\u{1F5E3}🫵]103" }], map);
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  test("follows a readiness-label flip (labels are the source of truth)", () => {
    // tab shows 🫵; ticket now carries ready-for-agent → tab flips to 🤖
    const map = mapOf(101, [sub(103, "open", 0, ["wayfinder:research", "ready-for-agent"])]);
    const plan = planTabs([shell, { id: "t1", title: "[🔎🫵]103" }], map);
    expect(plan.renames).toEqual([{ id: "t1", from: "[🔎🫵]103", to: "[🔎🤖]103" }]);
  });

  test("updates the type emoji when the ticket's label changed", () => {
    // tab was minted as research; ticket re-labelled to grilling — X updates
    const map = mapOf(101, [sub(103, "open", 0, ["wayfinder:grilling", "ready-for-agent"])]);
    const plan = planTabs([shell, { id: "t1", title: "[🔎🤖]103" }], map);
    expect(plan.renames).toEqual([{ id: "t1", from: "[🔎🤖]103", to: "[🗣️🤖]103" }]);
  });

  test("leaves a done tab alone while its ticket stays closed", () => {
    const map = mapOf(101, [sub(103, "closed")]);
    const plan = planTabs([shell, { id: "t1", title: "[🔨✓]103" }], map);
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  test("empty-frontier map yields no creates, no renames", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(104, "closed")]);
    const plan = planTabs([shell], map);
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([]);
    expect(plan.desiredOrder).toEqual([]);
  });

  test("desiredOrder merges existing + created tabs, ascending by ticket", () => {
    const map = mapOf(101, [sub(103, "open"), sub(107, "open"), sub(121, "open")]);
    const plan = planTabs([shell, { id: "t2", title: "[🔨🫵]107" }], map);
    expect(plan.creates.map((c) => c.ticket)).toEqual([103, 121]);
    expect(plan.desiredOrder).toEqual([103, 107, 121]);
  });

  test("additive path never populates closes", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🔨✓]103" }, { id: "t2", title: "[🔨🫵]107" }],
      map,
    );
    expect(plan.closes).toEqual([]);
  });

  test("leaves a stale tab (ticket gone from the map) alone on the additive path", () => {
    const map = mapOf(101, [sub(107, "open")]); // 103 vanished
    const plan = planTabs([shell, { id: "t1", title: "[🔨🫵]103" }, { id: "t2", title: "[🔨🫵]107" }], map);
    expect(plan.renames).toEqual([]);
    expect(plan.closes).toEqual([]);
  });
});

describe("planTabs --prune", () => {
  const shell: Tab = { id: "s0", title: "zsh" };
  const prune = { prune: true };

  test("closes a closed ticket's tab instead of ✓-renaming it", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🔨🫵]103" }, { id: "t2", title: "[🔨🫵]107" }],
      map,
      prune,
    );
    expect(plan.closes).toEqual([{ id: "t1", title: "[🔨🫵]103", ticket: 103 }]);
    expect(plan.renames).toEqual([]);
    expect(plan.desiredOrder).toEqual([107]); // 103 dropped
  });

  test("closes an already-done tab whose ticket stays closed", () => {
    const map = mapOf(101, [sub(103, "closed")]);
    const plan = planTabs([shell, { id: "t1", title: "[🔨✓]103" }], map, prune);
    expect(plan.closes).toEqual([{ id: "t1", title: "[🔨✓]103", ticket: 103 }]);
    expect(plan.desiredOrder).toEqual([]);
  });

  test("closes a stale tab whose ticket vanished from the map (legacy title too)", () => {
    const map = mapOf(101, [sub(107, "open")]); // 103 no longer a sub-issue
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "[🔨🫵]107" }], map, prune);
    expect(plan.closes).toEqual([{ id: "t1", title: "103", ticket: 103 }]);
  });

  test("keeps a still-open ticket's tab even when it fell off the frontier", () => {
    // 103 re-blocked (open, blocked_by 1) → off frontier but a live session may
    // be mid-work: prune must not close it.
    const map = mapOf(101, [sub(103, "open", 1), sub(107, "open")]);
    const plan = planTabs(
      [shell, { id: "t1", title: "[🔨🫵]103" }, { id: "t2", title: "[🔨🫵]107" }],
      map,
      prune,
    );
    expect(plan.closes).toEqual([]);
    expect(plan.desiredOrder).toEqual([103, 107]);
  });

  test("still creates frontier tabs while pruning", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "[🔨🫵]103" }], map, prune);
    expect(plan.creates.map((c) => c.ticket)).toEqual([107]);
    expect(plan.closes.map((c) => c.ticket)).toEqual([103]);
  });
});

describe("parseWorkspaceDescription", () => {
  test("round-trips workspaceDescription (repo may contain slashes)", () => {
    expect(parseWorkspaceDescription(workspaceDescription("acme/example", 101))).toEqual({
      repo: "acme/example",
      mapNumber: 101,
    });
  });
  test("splits on the last #", () => {
    expect(parseWorkspaceDescription("owner/re#po#5")).toEqual({ repo: "owner/re#po", mapNumber: 5 });
  });
  test("rejects non-identity descriptions", () => {
    for (const d of ["", "Terminal", "just text", "owner/repo", "owner/repo#", "#5"]) {
      expect(parseWorkspaceDescription(d)).toBeNull();
    }
  });
});

describe("planWorkspacePrune", () => {
  const ws = (id: string, title: string, description: string | null): WorkspaceRef => ({
    id,
    title,
    description,
  });
  const grp = (name: string, ids: string[], anchor?: string): GroupRef => ({
    name,
    member_workspace_ids: ids,
    anchor_workspace_id: anchor,
  });

  test("closes workspaces whose map is closed/untracked, keeps desired ones", () => {
    const wss = [
      ws("w1", "example/101", "acme/example#101"), // desired
      ws("w2", "example/99", "acme/example#99"), // map closed
      ws("w3", "other/5", "someone/other#5"), // untracked repo
    ];
    const groups = [grp("example wayfinder", ["w1", "w2"]), grp("other wayfinder", ["w3"])];
    const desired = new Set(["acme/example#101"]);
    const closes = planWorkspacePrune(wss, groups, desired);
    expect(closes.map((c) => c.id).sort()).toEqual(["w2", "w3"]);
    expect(closes.every((c) => c.reason === "map-gone")).toBe(true);
  });

  test("closes a group's stray anchor (null description), identified by anchor id", () => {
    const wss = [
      ws("w1", "example/101", "acme/example#101"), // real, desired
      ws("anchor", "Group 1", null), // stray anchor — null description, as live
    ];
    const groups = [grp("example wayfinder", ["w1", "anchor"], "anchor")];
    const desired = new Set(["acme/example#101"]);
    const closes = planWorkspacePrune(wss, groups, desired);
    expect(closes).toEqual([{ id: "anchor", title: "Group 1", reason: "stray-anchor" }]);
  });

  test("recognizes an emptied group by its ` wayfinder` name and cleans its anchor", () => {
    // All real workspaces already gone; only the anchor remains — the name
    // suffix is the only signal left that the group is ours.
    const wss = [ws("anchor", "Group 3", null)];
    const groups = [grp("ghost wayfinder", ["anchor"], "anchor")];
    const closes = planWorkspacePrune(wss, groups, new Set());
    expect(closes).toEqual([{ id: "anchor", title: "Group 3", reason: "stray-anchor" }]);
  });

  test("spares a real workspace cmux promoted to anchor", () => {
    // If the empty anchor is gone and a real (identity) workspace is now the
    // group anchor, it must NOT be closed as a stray.
    const wss = [ws("w1", "example/101", "acme/example#101")];
    const groups = [grp("example wayfinder", ["w1"], "w1")];
    const desired = new Set(["acme/example#101"]);
    expect(planWorkspacePrune(wss, groups, desired)).toEqual([]);
  });

  test("leaves non-wayfinder workspaces and groups (and their anchors) untouched", () => {
    const wss = [ws("u1", "scratch", null), ws("u2", "notes", "todo list")];
    const groups = [grp("Personal", ["u1", "u2"], "u1")];
    expect(planWorkspacePrune(wss, groups, new Set())).toEqual([]);
  });

  test("keeps everything when all maps are still desired (no-op)", () => {
    const wss = [ws("w1", "example/101", "acme/example#101")];
    const groups = [grp("example wayfinder", ["w1"])];
    const desired = new Set(["acme/example#101"]);
    expect(planWorkspacePrune(wss, groups, desired)).toEqual([]);
  });
});

describe("board cache file location", () => {
  test("one file per map under a per-repo directory", () => {
    expect(boardPath("/Users/ann", "acme/example", 101)).toBe(
      "/Users/ann/.cache/cmux-wayfinder/acme-example/101.html",
    );
  });

  test("file urls escape path segments", () => {
    expect(fileUrl("/Users/ann/.cache/cmux-wayfinder/acme-example/101.html")).toBe(
      "file:///Users/ann/.cache/cmux-wayfinder/acme-example/101.html",
    );
    expect(fileUrl("/Users/an n/x.html")).toBe("file:///Users/an%20n/x.html");
  });
});

describe("planBoardPrune", () => {
  const HOME = "/Users/ann";
  const board = (repo: string, map: number) => boardPath(HOME, repo, map);
  // Built with the real producer, so the test keeps pace with the description format.
  const desired = (...pairs: [string, number][]) =>
    new Set(pairs.map(([repo, map]) => workspaceDescription(repo, map)));

  test("the cache root holds every repo's board directory", () => {
    expect(boardCacheDir(HOME)).toBe("/Users/ann/.cache/cmux-wayfinder");
    expect(board("acme/example", 101).startsWith(`${boardCacheDir(HOME)}/`)).toBe(true);
  });

  test("deletes the board of a map that is no longer desired", () => {
    const files = [board("acme/example", 101), board("acme/example", 102)];
    expect(planBoardPrune(HOME, files, desired(["acme/example", 101]))).toEqual([
      board("acme/example", 102),
    ]);
  });

  test("deletes the boards of a repo that is no longer tracked", () => {
    const files = [board("acme/example", 101), board("other/repo", 7)];
    expect(planBoardPrune(HOME, files, desired(["acme/example", 101]))).toEqual([
      board("other/repo", 7),
    ]);
  });

  test("keeps every desired map's board, deletes nothing else when all are backed", () => {
    const files = [board("acme/example", 101), board("other/repo", 7)];
    expect(planBoardPrune(HOME, files, desired(["acme/example", 101], ["other/repo", 7]))).toEqual(
      [],
    );
  });

  test("no desired maps at all means every board file goes", () => {
    const files = [board("acme/example", 101), board("other/repo", 7)];
    expect(planBoardPrune(HOME, files, new Set())).toEqual(files.slice().sort());
  });

  test("only board files are candidates — directories and other cache junk are left alone", () => {
    const paths = [
      `${boardCacheDir(HOME)}/acme-example`, // the per-repo directory itself
      `${boardCacheDir(HOME)}/acme-example/101.html.4242.tmp`,
      `${boardCacheDir(HOME)}/acme-example/notes.txt`,
      board("acme/example", 101),
    ];
    expect(planBoardPrune(HOME, paths, new Set())).toEqual([board("acme/example", 101)]);
  });

  test("descriptions that aren't ours back no file (and so keep nothing alive)", () => {
    const files = [board("acme/example", 101)];
    expect(planBoardPrune(HOME, files, new Set(["not-a-description"]))).toEqual(files);
  });

  test("deletions come out in a stable order", () => {
    const files = [board("b/two", 2), board("a/one", 1)];
    expect(planBoardPrune(HOME, files, new Set())).toEqual([board("a/one", 1), board("b/two", 2)]);
  });
});
