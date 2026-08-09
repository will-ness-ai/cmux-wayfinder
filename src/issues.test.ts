import { expect, test, describe } from "bun:test";
import {
  blockedByEdges,
  MAP_LABEL,
  toBlockerNumbers,
  toSubIssue,
  type RawSubIssue,
} from "./issues.ts";

/** A raw element of GitHub's `sub_issues` listing, trimmed to what we read. */
function raw(number: number, over: Partial<RawSubIssue> = {}): RawSubIssue {
  return {
    number,
    title: `Ticket ${number}`,
    state: "open",
    issue_dependencies_summary: { blocked_by: 0 },
    assignees: [],
    labels: [],
    body: "",
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
        body: "## What to build\n\nthe thing",
      }),
      [3, 5],
    );
    expect(s).toEqual({
      number: 7,
      title: "Do the thing",
      state: "open",
      blockedBy: 1,
      unblocked: false,
      isMap: false,
      assignees: ["ann"],
      labels: ["wayfinder:task", "ready-for-agent"],
      body: "## What to build\n\nthe thing",
      url: "https://github.com/acme/example/issues/7",
      blockers: [3, 5],
    });
  });

  test("a body-less element reads as an empty body", () => {
    // GitHub sends `body: null` for an issue opened with no description.
    expect(toSubIssue(raw(1, { body: null }), []).body).toBe("");
    const { body, ...noBodyField } = raw(1);
    expect(toSubIssue(noBodyField, []).body).toBe("");
  });

  test("unblocked is open with no open blockers — closed blockers do not count", () => {
    // The summary counts open blockers only, so a ticket can be unblocked and
    // still carry historical (closed) blocker refs.
    expect(toSubIssue(raw(1), [2]).unblocked).toBe(true);
    expect(toSubIssue(raw(1, { issue_dependencies_summary: { blocked_by: 1 } }), [2]).unblocked).toBe(false);
    expect(toSubIssue(raw(1, { state: "closed" }), []).unblocked).toBe(false);
  });

  test("isMap marks a sub-issue that carries the map label — a child map", () => {
    const child = toSubIssue(raw(29, { labels: [{ name: MAP_LABEL }] }), []);
    expect(child.isMap).toBe(true);
    // unblocked stays true: it is the frontier that excludes a child map, so
    // the two facts must not be conflated.
    expect(child.unblocked).toBe(true);
    expect(toSubIssue(raw(1, { labels: [{ name: "wayfinder:task" }] }), []).isMap).toBe(false);
    expect(toSubIssue(raw(1), []).isMap).toBe(false);
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
      toSubIssue(raw(1), []),
      toSubIssue(raw(2), [1]),
      toSubIssue(raw(3), [1, 2]),
    ];
    expect(blockedByEdges(subs)).toEqual({ "1": [], "2": [1], "3": [1, 2] });
  });
});
