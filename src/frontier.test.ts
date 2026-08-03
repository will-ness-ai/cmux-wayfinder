import { expect, test, describe } from "bun:test";
import { blockedByEdges, toBlockerNumbers, toSubIssue, type SubIssue } from "./frontier.ts";

/** A raw element of GitHub's `sub_issues` listing, trimmed to what we read. */
function raw(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Ticket ${number}`,
    state: "open",
    issue_dependencies_summary: { blocked_by: 0 },
    assignees: [],
    labels: [],
    html_url: `https://github.com/acme/example/issues/${number}`,
    ...over,
  };
}

describe("toSubIssue", () => {
  test("maps a listing element and carries its blocked-by numbers", () => {
    const s = toSubIssue(
      raw(7, {
        title: "Do the thing",
        issue_dependencies_summary: { blocked_by: 1 },
        assignees: [{ login: "ann" }],
        labels: [{ name: "wayfinder:task" }, { name: "ready-for-agent" }],
      }),
      [3, 5],
    );
    expect(s).toEqual({
      number: 7,
      title: "Do the thing",
      state: "open",
      blockedBy: 1,
      unblocked: false,
      assignees: ["ann"],
      labels: ["wayfinder:task", "ready-for-agent"],
      url: "https://github.com/acme/example/issues/7",
      blockers: [3, 5],
    });
  });

  test("unblocked is open with no open blockers — closed blockers do not count", () => {
    // The summary counts open blockers only, so a ticket can be unblocked and
    // still carry historical (closed) blocker refs.
    expect(toSubIssue(raw(1), [2]).unblocked).toBe(true);
    expect(toSubIssue(raw(1, { issue_dependencies_summary: { blocked_by: 1 } }), [2]).unblocked).toBe(false);
    expect(toSubIssue(raw(1, { state: "closed" }), []).unblocked).toBe(false);
  });
});

describe("toBlockerNumbers", () => {
  test("reads the issue numbers off the blocked-by listing, ascending", () => {
    expect(toBlockerNumbers([{ number: 9 }, { number: 2 }])).toEqual([2, 9]);
  });

  test("an unblocked issue's empty listing reads as no blockers", () => {
    expect(toBlockerNumbers([])).toEqual([]);
  });
});

describe("blockedByEdges", () => {
  test("keys every sub-issue to its blocker numbers", () => {
    const subs = [
      { number: 1, blockers: [] },
      { number: 2, blockers: [1] },
      { number: 3, blockers: [1, 2] },
    ] as SubIssue[];
    expect(blockedByEdges(subs)).toEqual({ "1": [], "2": [1], "3": [1, 2] });
  });
});
