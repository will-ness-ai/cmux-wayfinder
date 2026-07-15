import { expect, test, describe } from "bun:test";
import type { SubIssue, WayfinderMap } from "./frontier.ts";
import {
  groupName,
  isManagedWorkspaceTitle,
  isMapComplete,
  launchCommand,
  mapTabTitle,
  parseManagedTabTitle,
  parseWorkspaceDescription,
  planTabs,
  planWorkspacePrune,
  repoShort,
  ticketPrompt,
  workspaceDescription,
  workspaceTitle,
  worktreeName,
  type GroupRef,
  type Tab,
  type WorkspaceRef,
} from "./plan.ts";

function sub(number: number, state: "open" | "closed", blockedBy = 0): SubIssue {
  return {
    number,
    title: `Ticket ${number}`,
    state,
    blockedBy,
    unblocked: state === "open" && blockedBy === 0,
    assignees: [],
    url: `https://x/${number}`,
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
    expect(workspaceTitle("acme/example", 101)).toBe("example/101");
    expect(workspaceTitle("acme/example", 101, true)).toBe("✓example/101");
    expect(workspaceDescription("acme/example", 101)).toBe("acme/example#101");
    expect(worktreeName(101, 103)).toBe("wayfinder/101/103");
  });

  test("isMapComplete: all sub-issues closed (and non-empty)", () => {
    expect(isMapComplete(mapOf(101, [sub(1, "closed"), sub(2, "closed")]))).toBe(true);
    expect(isMapComplete(mapOf(101, [sub(1, "closed"), sub(2, "open")]))).toBe(false);
    expect(isMapComplete(mapOf(101, []))).toBe(false); // no sub-issues yet ≠ done
  });

  test("isManagedWorkspaceTitle: matches both variants, not hand-renames", () => {
    expect(isManagedWorkspaceTitle("example/101", "acme/example", 101)).toBe(true);
    expect(isManagedWorkspaceTitle("✓example/101", "acme/example", 101)).toBe(true);
    expect(isManagedWorkspaceTitle("my scratch ws", "acme/example", 101)).toBe(false);
    expect(isManagedWorkspaceTitle("example/102", "acme/example", 101)).toBe(false);
  });

  test("launch command carries the worktree but NOT the prompt (no auto-submit)", () => {
    expect(launchCommand(101, 103)).toBe("claude --worktree wayfinder/101/103");
    expect(launchCommand(101, 103)).not.toContain("wayfinder map"); // prompt is typed separately
  });

  test("ticket prompt is the slash command typed unsubmitted", () => {
    expect(ticketPrompt(101, 103)).toBe(
      "/wayfinder map #101 work on ticket #103. If you end up creating files (prototype, research, etc..) ensure that you create and merge a PR containing those artifacts",
    );
  });

  test("map tab title is a marker the numbered matcher ignores", () => {
    expect(mapTabTitle(101)).toBe("map #101");
    expect(parseManagedTabTitle(mapTabTitle(101))).toBeNull(); // not a managed ticket tab
  });
});

describe("parseManagedTabTitle", () => {
  test("matches bare and done-marked numbers", () => {
    expect(parseManagedTabTitle("42")).toBe(42);
    expect(parseManagedTabTitle("✓42")).toBe(42);
    expect(parseManagedTabTitle("  7 ")).toBe(7);
  });
  test("rejects non-managed titles", () => {
    for (const t of ["", "shell", "Claude Code", "⠂ Claude", "v101", "42a", "✓", "1.2", "✓✓4"]) {
      expect(parseManagedTabTitle(t)).toBeNull();
    }
  });
});

describe("planTabs", () => {
  const shell: Tab = { id: "s0", title: "zsh" };

  test("creates tabs for frontier tickets missing a tab, ascending, with boot cmd", () => {
    const map = mapOf(101, [sub(103, "open"), sub(107, "open"), sub(105, "open", 1)]);
    const plan = planTabs([shell], map);
    expect(plan.creates.map((c) => c.ticket)).toEqual([103, 107]); // 105 is blocked → not frontier
    expect(plan.creates[0].title).toBe("103");
    expect(plan.creates[0].launch).toBe(launchCommand(101, 103));
    expect(plan.creates[0].prompt).toBe(ticketPrompt(101, 103));
    expect(plan.renames).toEqual([]);
    expect(plan.desiredOrder).toEqual([103, 107]);
  });

  test("does not recreate an existing tab (idempotent)", () => {
    const map = mapOf(101, [sub(103, "open"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "107" }], map);
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  test("marks a closed ticket's tab done (open → ✓), never closes it", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "107" }], map);
    expect(plan.creates).toEqual([]);
    expect(plan.renames).toEqual([{ id: "t1", from: "103", to: "✓103" }]);
  });

  test("flips a reopened ticket's tab back (✓ → open)", () => {
    const map = mapOf(101, [sub(103, "open"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "✓103" }, { id: "t2", title: "107" }], map);
    // reopened + unblocked: flip back to 103, and don't re-create (tab exists)
    expect(plan.renames).toEqual([{ id: "t1", from: "✓103", to: "103" }]);
    expect(plan.creates).toEqual([]);
  });

  test("leaves a ✓ tab alone while its ticket stays closed", () => {
    const map = mapOf(101, [sub(103, "closed")]);
    const plan = planTabs([shell, { id: "t1", title: "✓103" }], map);
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
    const plan = planTabs([shell, { id: "t2", title: "107" }], map);
    expect(plan.creates.map((c) => c.ticket)).toEqual([103, 121]);
    expect(plan.desiredOrder).toEqual([103, 107, 121]);
  });

  test("additive path never populates closes", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "✓103" }, { id: "t2", title: "107" }], map);
    expect(plan.closes).toEqual([]);
  });
});

describe("planTabs --prune", () => {
  const shell: Tab = { id: "s0", title: "zsh" };
  const prune = { prune: true };

  test("closes a closed ticket's tab instead of ✓-renaming it", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "107" }], map, prune);
    expect(plan.closes).toEqual([{ id: "t1", title: "103", ticket: 103 }]);
    expect(plan.renames).toEqual([]);
    expect(plan.desiredOrder).toEqual([107]); // 103 dropped
  });

  test("closes an already-✓ tab whose ticket stays closed", () => {
    const map = mapOf(101, [sub(103, "closed")]);
    const plan = planTabs([shell, { id: "t1", title: "✓103" }], map, prune);
    expect(plan.closes).toEqual([{ id: "t1", title: "✓103", ticket: 103 }]);
    expect(plan.desiredOrder).toEqual([]);
  });

  test("closes a stale tab whose ticket vanished from the map", () => {
    const map = mapOf(101, [sub(107, "open")]); // 103 no longer a sub-issue
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "107" }], map, prune);
    expect(plan.closes).toEqual([{ id: "t1", title: "103", ticket: 103 }]);
  });

  test("keeps a still-open ticket's tab even when it fell off the frontier", () => {
    // 103 re-blocked (open, blocked_by 1) → off frontier but a live session may
    // be mid-work: prune must not close it.
    const map = mapOf(101, [sub(103, "open", 1), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "103" }, { id: "t2", title: "107" }], map, prune);
    expect(plan.closes).toEqual([]);
    expect(plan.desiredOrder).toEqual([103, 107]);
  });

  test("still creates frontier tabs while pruning", () => {
    const map = mapOf(101, [sub(103, "closed"), sub(107, "open")]);
    const plan = planTabs([shell, { id: "t1", title: "103" }], map, prune);
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
