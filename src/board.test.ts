import { expect, test, describe } from "bun:test";
import {
  boardPath,
  boardPayload,
  fileUrl,
  laneOf,
  LANE_ORDER,
  partitionLanes,
  renderBoard,
  type BoardInput,
  type BoardTicket,
} from "./board.ts";
import { lanesTabTitle } from "./plan.ts";

function ticket(number: number, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    number,
    title: `Ticket ${number}`,
    state: "open",
    blockedBy: 0,
    assignees: [],
    labels: [],
    url: `https://github.com/acme/example/issues/${number}`,
    ...over,
  };
}

function input(tickets: BoardTicket[], over: Partial<BoardInput> = {}): BoardInput {
  return {
    map: {
      number: 101,
      title: "Wayfinder map: lanes board — sprint-lane dashboard",
      url: "https://github.com/acme/example/issues/101",
    },
    tickets,
    edges: {},
    generatedAt: "Aug 2 at 1:00 PM",
    ...over,
  };
}

/** Pull the embedded payload back out of the generated page. */
function payloadOf(html: string): any {
  const m = /<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
}

describe("lane predicates", () => {
  test("closed is Resolved, whatever else is true of it", () => {
    expect(laneOf(ticket(1, { state: "closed" }))).toBe("resolved");
    expect(laneOf(ticket(1, { state: "closed", assignees: ["ann"] }))).toBe("resolved");
    expect(laneOf(ticket(1, { state: "closed", blockedBy: 2 }))).toBe("resolved");
  });

  test("open + open blockers is Blocked — blockage dominates a claim", () => {
    expect(laneOf(ticket(1, { blockedBy: 1 }))).toBe("blocked");
    expect(laneOf(ticket(1, { blockedBy: 1, assignees: ["ann"] }))).toBe("blocked");
  });

  test("open + unblocked splits on the claim: assigned = In progress, else Frontier", () => {
    expect(laneOf(ticket(1, { assignees: ["ann"] }))).toBe("inprogress");
    expect(laneOf(ticket(1))).toBe("frontier");
  });

  test("an open blocker outside the map still blocks (count, not in-map edges)", () => {
    // blockedBy is GitHub's true open-blocker count; edges hold in-map refs only.
    const t = ticket(1, { blockedBy: 1 });
    expect(laneOf(t)).toBe("blocked");
    const html = renderBoard(input([t], { edges: { 1: [] } }));
    expect(html).toContain('data-t="1" data-lane="blocked"');
  });

  test("partitionLanes buckets every ticket exactly once", () => {
    const tickets = [
      ticket(1, { assignees: ["ann"] }),
      ticket(2),
      ticket(3, { blockedBy: 1, assignees: ["bo"] }),
      ticket(4, { state: "closed" }),
      ticket(5),
    ];
    const lanes = partitionLanes(tickets);
    expect(lanes.inprogress.map((t) => t.number)).toEqual([1]);
    expect(lanes.frontier.map((t) => t.number)).toEqual([2, 5]);
    expect(lanes.blocked.map((t) => t.number)).toEqual([3]);
    expect(lanes.resolved.map((t) => t.number)).toEqual([4]);
    expect(LANE_ORDER).toEqual(["inprogress", "frontier", "blocked", "resolved"]);
  });
});

describe("embedded payload", () => {
  test("round-trips the map meta, tickets and stamp", () => {
    const t = ticket(7, {
      title: "Do the thing",
      labels: ["wayfinder:research", "ready-for-agent"],
      assignees: ["ann"],
      body: "## Heading\n\nsome *markdown*",
    });
    const data = payloadOf(renderBoard(input([t])));
    expect(data.map).toEqual({
      number: 101,
      title: "Wayfinder map: lanes board — sprint-lane dashboard",
      url: "https://github.com/acme/example/issues/101",
    });
    expect(data.generatedAt).toBe("Aug 2 at 1:00 PM");
    expect(data.tickets["7"]).toEqual({
      number: 7,
      title: "Do the thing",
      state: "open",
      assignees: ["ann"],
      labels: ["wayfinder:research", "ready-for-agent"],
      body: "## Heading\n\nsome *markdown*",
      html_url: "https://github.com/acme/example/issues/7",
      lane: "inprogress",
    });
  });

  test("carries an edges field, empty until the dependency ticket fills it", () => {
    expect(payloadOf(renderBoard(input([ticket(1)]))).edges).toEqual({});
    const withEdges = payloadOf(renderBoard(input([ticket(1), ticket(2)], { edges: { 2: [1] } })));
    expect(withEdges.edges).toEqual({ "2": [1] });
  });

  test("survives titles and bodies that would otherwise break out of the page", () => {
    const t = ticket(1, {
      title: `</script><img src=x> "quoted" & <b>bold</b>`,
      body: "</script>\n<!-- comment -->",
    });
    const html = renderBoard(input([t]));
    const data = payloadOf(html);
    expect(data.tickets["1"].title).toBe(`</script><img src=x> "quoted" & <b>bold</b>`);
    expect(data.tickets["1"].body).toBe("</script>\n<!-- comment -->");
    // …and the rendered row shows it as text, not markup.
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<img");
  });

  test("a body-less ticket round-trips as an empty body", () => {
    expect(payloadOf(renderBoard(input([ticket(1)]))).tickets["1"].body).toBe("");
  });
});

describe("the page shell", () => {
  test("carries a static title equal to the enforced tab title, and never mutates it", () => {
    const html = renderBoard(input([ticket(1)]));
    expect(html).toContain(`<title>${lanesTabTitle(101)}</title>`);
    expect(html).toContain("<title>lanes #101</title>");
    expect(html).not.toContain("document.title"); // sync's rename owns the tab title
  });

  test("embeds the fallback reload timer", () => {
    const html = renderBoard(input([ticket(1)]));
    expect(html).toMatch(/setInterval\(function \(\) \{ location\.reload\(\); \}, 5000\)/);
  });

  test("requests no external resources (plain https anchors excepted)", () => {
    const html = renderBoard(
      input([ticket(1, { title: "x", body: "see https://example.com/pic.png" })]),
    );
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h.startsWith("https://")).toBe(true);
  });
});

describe("the rendered board", () => {
  const tickets = [
    ticket(1, { title: "Claimed work", assignees: ["ann"], labels: ["wayfinder:task", "ready-for-agent"] }),
    ticket(2, { title: "Takeable", labels: ["wayfinder:research"] }),
    ticket(3, { title: "Stuck but claimed", blockedBy: 1, assignees: ["bo"] }),
    ticket(4, { title: "Finished", state: "closed", assignees: ["ann"] }),
  ];

  test("header links the map issue under its short name, with counts and the stamp", () => {
    const html = renderBoard(input(tickets));
    expect(html).toContain('href="https://github.com/acme/example/issues/101"');
    expect(html).toContain("lanes board"); // mapLabel of the map title
    expect(html).toContain("1 in progress");
    expect(html).toContain("1 frontier");
    expect(html).toContain("1 blocked");
    expect(html).toContain("1 resolved");
    expect(html).toContain("generated Aug 2 at 1:00 PM");
  });

  test("the summary strip shows all four lanes, dimming the empty ones", () => {
    const html = renderBoard(input([ticket(1, { assignees: ["ann"] })]));
    for (const lane of LANE_ORDER) expect(html).toContain(`class="stat s-${lane}`);
    expect(html).toContain(`class="stat s-inprogress"`); // the only populated lane
    expect(html).toContain(`class="stat s-frontier s-zero"`);
    expect(html).toContain(`class="stat s-resolved s-zero"`);
  });

  test("lane sections render in order, and empty lanes are hidden from the table", () => {
    const html = renderBoard(input(tickets));
    const order = [...html.matchAll(/<tr class="sec sec-(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["inprogress", "frontier", "blocked", "resolved"]);
    const oneLane = renderBoard(input([ticket(1, { assignees: ["ann"] })]));
    expect(oneLane).toContain('<tr class="sec sec-inprogress"');
    expect(oneLane).not.toContain('<tr class="sec sec-frontier"');
  });

  test("Resolved starts collapsed; the live lanes start open", () => {
    const html = renderBoard(input(tickets));
    expect(html).toMatch(/data-sec="resolved"><td colspan="4">\s*<span class="chev">▸<\/span>/);
    expect(html).toMatch(/data-sec="inprogress"><td colspan="4">\s*<span class="chev">▾<\/span>/);
    expect(html).toContain('class="t done hidden-lane" data-t="4"');
    expect(html).toContain('class="t" data-t="1"');
  });

  test("row anatomy: number, type + readiness emoji, title, assignee", () => {
    const html = renderBoard(input(tickets));
    expect(html).toContain('<td class="num">#1</td><td class="emo">🔨🤖</td>');
    expect(html).toContain('<td class="title">Claimed work</td><td class="who">@ann</td>');
    // unlabeled readiness is HITL; a closed ticket takes ✓ and a struck title
    expect(html).toContain('<td class="emo">🔎🫵</td>');
    expect(html).toContain('<td class="emo">🔨✓</td>');
    expect(html).toContain('class="t done hidden-lane" data-t="4"');
  });

  test("a blocked-but-claimed ticket sits in Blocked and still shows its assignee", () => {
    const html = renderBoard(input(tickets));
    expect(html).toContain('data-t="3" data-lane="blocked"');
    expect(html).toContain('<td class="title">Stuck but claimed</td><td class="who">@bo</td>');
  });

  test("an empty map still renders a board", () => {
    const html = renderBoard(input([]));
    expect(html).toContain("<title>lanes #101</title>");
    expect(html).toContain("0 frontier");
    expect(html).toContain("<tbody></tbody>");
    expect(html).not.toMatch(/<tr class="sec/);
  });
});

describe("cache file location", () => {
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

describe("boardPayload", () => {
  test("is the payload the page embeds", () => {
    const i = input([ticket(1, { state: "closed" })], { edges: { 1: [] } });
    expect(payloadOf(renderBoard(i))).toEqual(JSON.parse(JSON.stringify(boardPayload(i))));
  });
});
