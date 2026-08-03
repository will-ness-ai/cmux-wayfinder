import { expect, test, describe } from "bun:test";
import {
  boardPayload,
  dependentsOf,
  ESC_SOURCE,
  inMapEdges,
  laneOf,
  LANE_ORDER,
  MD_SOURCE,
  partitionLanes,
  RELOAD_MS,
  renderBoard,
  type BoardInput,
  type BoardPayload,
  type BoardTicket,
} from "./board.ts";
import { toSubIssue } from "./issues.ts";
import { lanesTabTitle } from "./plan.ts";

function ticket(number: number, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    number,
    title: `Ticket ${number}`,
    state: "open",
    blockedBy: 0,
    assignees: [],
    labels: [],
    body: "",
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
function payloadOf(html: string): BoardPayload {
  const m = /<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("generated page carries no board-data payload");
  return JSON.parse(m[1]!);
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
      type: "research",
    });
  });

  test("carries the in-map blocked-by edges", () => {
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

  test("carries the ticket type the modal badges, defaulting an unlabeled one to task", () => {
    const tickets = [ticket(1), ticket(2, { labels: ["wayfinder:prototype", "ready-for-agent"] })];
    const data = payloadOf(renderBoard(input(tickets)));
    expect(data.tickets["1"].type).toBe("task");
    expect(data.tickets["2"].type).toBe("prototype");
  });

  test("a body-less ticket round-trips as an empty body", () => {
    expect(payloadOf(renderBoard(input([ticket(1)]))).tickets["1"].body).toBe("");
  });

  test("a sub-issue read off the listing carries its body straight through", () => {
    // The body rides the `sub_issues` listing the reader already fetches, so it
    // reaches the modal without a second call per ticket.
    const sub = toSubIssue(
      {
        number: 7,
        title: "Do the thing",
        state: "open",
        issue_dependencies_summary: { blocked_by: 0 },
        assignees: [],
        labels: [{ name: "wayfinder:task" }],
        body: "## What to build\n\n- one\n- two",
        html_url: "https://github.com/acme/example/issues/7",
      },
      [],
    );
    expect(payloadOf(renderBoard(input([sub]))).tickets["7"].body).toBe(
      "## What to build\n\n- one\n- two",
    );
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
    expect(html).toContain("location.reload");
    expect(html).toContain(`}, ${RELOAD_MS})`);
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
    // Anchors are checked over the markup only: the inline script's markdown
    // renderer holds an `<a href="$2">` *template*, which is not a request.
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
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
    expect(html).toMatch(/data-sec="resolved"><td colspan="5">\s*<span class="chev">▸<\/span>/);
    expect(html).toMatch(/data-sec="inprogress"><td colspan="5">\s*<span class="chev">▾<\/span>/);
    expect(html).toContain('class="t done hidden-lane" data-t="4"');
    expect(html).toContain('class="t" data-t="1"');
  });

  test("row anatomy: number, type + readiness emoji, title, assignee, waiting-on", () => {
    const html = renderBoard(input(tickets));
    expect(html).toContain("<th>Waiting on</th>");
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

describe("dependency edges", () => {
  test("in-map refs survive; refs to issues outside the map are dropped", () => {
    const tickets = [ticket(1), ticket(2)];
    expect(inMapEdges(tickets, { 2: [1, 99] })).toEqual({ "2": [1] });
    // …and an edge keyed by an out-of-map ticket goes with it.
    expect(inMapEdges(tickets, { 99: [1] })).toEqual({});
    // A ticket with no blockers keeps its (empty) entry — the reader lists every one.
    expect(inMapEdges(tickets, { 1: [], 2: [1] })).toEqual({ "1": [], "2": [1] });
  });

  test("dependents are the inversion of the blocked-by edges", () => {
    expect(dependentsOf({ 2: [1], 3: [1, 2] })).toEqual({ "1": [2, 3], "2": [3] });
    expect(dependentsOf({ 1: [] })).toEqual({});
  });

  test("the payload drops out-of-map refs on the way through", () => {
    const data = payloadOf(
      renderBoard(input([ticket(1), ticket(2, { blockedBy: 2 })], { edges: { 2: [1, 404] } })),
    );
    expect(data.edges).toEqual({ "2": [1] });
  });

  test("chips are red for an open blocker and grey-struck for a closed one", () => {
    const html = renderBoard(
      input([ticket(1, { state: "closed" }), ticket(2), ticket(3, { blockedBy: 1 })], {
        edges: { 3: [1, 2] },
      }),
    );
    expect(html).toContain('<span class="wref hist" data-ref="1">#1</span>');
    expect(html).toContain('<span class="wref" data-ref="2">#2</span>');
  });

  test("a ticket blocked only from outside the map sits in Blocked with no chips", () => {
    const html = renderBoard(input([ticket(1, { blockedBy: 1 })], { edges: { 1: [404] } }));
    expect(html).toContain('data-t="1" data-lane="blocked"');
    expect(html).toContain('<td class="wait"></td>');
    expect(html).not.toContain('<span class="wref');
  });

  test("rows carry their dependents so the spotlight can light both ways", () => {
    const html = renderBoard(
      input([ticket(1), ticket(2, { blockedBy: 1 }), ticket(3, { blockedBy: 1 })], {
        edges: { 2: [1], 3: [1] },
      }),
    );
    expect(html).toContain('data-t="1" data-lane="frontier" data-dep="2,3"');
    expect(html).toContain('data-t="2" data-lane="blocked"><td'); // nothing depends on #2
  });

  test("the legend names both spotlight colors", () => {
    const html = renderBoard(input([ticket(1)]));
    expect(html).toContain("waits on (blockers)");
    expect(html).toContain("unblocks (dependents)");
  });

  test("a chip click jumps to the blocker", () => {
    const script = renderBoard(input([ticket(1), ticket(2)], { edges: { 2: [1] } }));
    expect(script).toContain("scrollIntoView");
  });
});

describe("the ticket modal", () => {
  const html = renderBoard(
    input([ticket(1), ticket(2, { blockedBy: 1 })], { edges: { 2: [1] } }),
  );

  test("the page carries the modal shell — meta chips, body and the GitHub link", () => {
    expect(html).toContain('<div id="scrim">');
    expect(html).toContain('<div id="modal" role="dialog" aria-modal="true">');
    for (const id of ["m-title", "m-meta", "m-body", "m-link", "m-close"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Open on GitHub ↗");
    // The link's href is set from the payload at open time, so the static page
    // still requests nothing.
    expect(html).not.toMatch(/id="m-link"[^>]*href=/);
  });

  test("the page script wires the modal open and closed, Escape included", () => {
    // Function-presence level on purpose: the exact wiring is the page's
    // business, and pinning its spelling would break on harmless rewording.
    expect(html).toContain("function openModal");
    expect(html).toContain("function closeModal");
    expect(html).toContain('"Escape"');
  });

  test("it renders the body with the embedded renderer, not a fetched library", () => {
    expect(html).toContain(MD_SOURCE);
    expect(html).toContain(ESC_SOURCE);
    expect(html).toContain('"m-body").innerHTML = md(');
  });

  test("the reload timer does not fire while the modal is open", () => {
    expect(html).toContain("if (!modalOpen()) location.reload()");
  });
});

describe("the markdown renderer", () => {
  /** The renderer exactly as it ships in the page, evaluated on its own. */
  const md = new Function(`${ESC_SOURCE}\n${MD_SOURCE}\nreturn md;`)() as (s: string) => string;

  test("headings, lists and paragraphs", () => {
    expect(md("## Parent\n\nplain line")).toBe("<h3>Parent</h3><p>plain line</p>");
    expect(md("# Top")).toBe("<h2>Top</h2>");
    expect(md("#### four")).toBe("<h4>four</h4>");
    // Deeper than h4 is not a heading at all — it reads as plain text.
    expect(md("##### five")).toBe("<p>##### five</p>");
    expect(md("- one\n- two\n\nafter")).toBe(
      "<ul><li>one</li><li>two</li></ul><p>after</p>",
    );
    expect(md("- [ ] a checkbox item")).toBe("<ul><li>[ ] a checkbox item</li></ul>");
  });

  test("inline code, bold, italic, http links and #n refs", () => {
    expect(md("use `--prune` now")).toBe("<p>use <code>--prune</code> now</p>");
    expect(md("**bold** and *italic*")).toBe("<p><b>bold</b> and <i>italic</i></p>");
    expect(md("see [the spec](https://example.com/s)")).toBe(
      '<p>see <a href="https://example.com/s" target="_blank" rel="noopener">the spec</a></p>',
    );
    expect(md("blocked by #8")).toBe("<p>blocked by <b>#8</b></p>");
  });

  test("code fences keep their contents verbatim, markup and all", () => {
    expect(md("```\n<b>x</b> & *y*\n```")).toBe(
      "<pre><code>&lt;b&gt;x&lt;/b&gt; &amp; *y*</code></pre>",
    );
    // An unterminated fence still closes rather than swallowing the body.
    expect(md("```\nstill open")).toBe("<pre><code>still open</code></pre>");
  });

  test("everything else is escaped — a body cannot inject markup", () => {
    expect(md('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
    expect(md("<script>evil()</script>")).toBe("<p>&lt;script&gt;evil()&lt;/script&gt;</p>");
    // A non-http scheme is left as text, so no link can smuggle one in.
    expect(md("[click](javascript:alert(1))")).toBe("<p>[click](javascript:alert(1))</p>");
  });

  test("an empty body renders as nothing at all", () => {
    expect(md("")).toBe("");
    expect(md("\n\n")).toBe("");
  });
});

describe("boardPayload", () => {
  test("is the payload the page embeds", () => {
    const i = input([ticket(1, { state: "closed" })], { edges: { 1: [] } });
    expect(payloadOf(renderBoard(i))).toEqual(JSON.parse(JSON.stringify(boardPayload(i))));
  });
});
