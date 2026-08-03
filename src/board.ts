/**
 * Pure lanes-board generator for cmux-wayfinder (ticket #8).
 *
 * Input: a map's meta, its sub-issues, the in-map blocked-by edges and a
 * generated-at stamp. Output: one complete, self-contained HTML page — the
 * sprint-lane ledger sync writes to the per-repo cache and shows in the
 * enforced `lanes #<n>` browser tab.
 *
 * Everything here is a pure function, so the whole board is testable without a
 * live cmux or GitHub (the executor in `sync.ts` only writes the string out).
 * The markup, styles and interactions are ported from the converged prototype
 * (`prototypes/lanes-board.html`, wayfinder ticket #4) minus its demo apparatus.
 *
 * The page requests nothing over the network — it must render in a webview with
 * no GitHub auth — and carries a static `<title>`; sync's tab rename owns the
 * tab title, so the page never touches `document.title`.
 */

import type { IssueState } from "./frontier.ts";
import { DONE, lanesTabTitle, mapLabel, readinessOf, typeEmojiOf } from "./plan.ts";

// ---------- inputs ----------

export interface BoardTicket {
  number: number;
  title: string;
  state: IssueState;
  /**
   * GitHub's count of *open* blockers — in-map or not. Lane placement uses this
   * true count, while {@link BoardInput.edges} holds in-map refs only, so a
   * ticket can sit in Blocked with no visible chip. Correct, not a bug.
   */
  blockedBy: number;
  assignees: string[];
  labels: string[];
  url: string;
  /** Markdown body, carried into the payload for the modal (ticket #10). */
  body?: string;
}

export interface BoardMap {
  number: number;
  title: string;
  url: string;
}

export interface BoardInput {
  map: BoardMap;
  tickets: BoardTicket[];
  /**
   * Keyed by ticket number → its blocker numbers, open or closed, as GitHub
   * reports them. Refs to issues outside the map are dropped here (see
   * {@link inMapEdges}) — the board only draws edges it can point at.
   */
  edges: Record<string, number[]>;
  /** Human-facing freshness stamp, e.g. `Aug 2 at 1:00 PM`. */
  generatedAt: string;
}

// ---------- lanes ----------

export type Lane = "inprogress" | "frontier" | "blocked" | "resolved";

/** Display order of the lanes, live work first. */
export const LANE_ORDER: Lane[] = ["inprogress", "frontier", "blocked", "resolved"];

const LANE_NAME: Record<Lane, string> = {
  inprogress: "In progress",
  frontier: "Frontier",
  blocked: "Blocked",
  resolved: "Resolved",
};

/**
 * The canonical lane partition: Resolved = closed; Blocked = open with open
 * blockers (blockage dominates a claim — a claimed-but-blocked ticket stays
 * Blocked, its assignee shown as a badge); In progress = open, unblocked and
 * claimed (any assignee = "a session has taken it", not liveness); Frontier =
 * open, unblocked and unclaimed.
 */
export function laneOf(t: BoardTicket): Lane {
  if (t.state === "closed") return "resolved";
  if (t.blockedBy > 0) return "blocked";
  return t.assignees.length > 0 ? "inprogress" : "frontier";
}

/** Tickets bucketed by {@link laneOf}, each lane keeping the input order. */
export function partitionLanes(tickets: BoardTicket[]): Record<Lane, BoardTicket[]> {
  const lanes: Record<Lane, BoardTicket[]> = {
    inprogress: [],
    frontier: [],
    blocked: [],
    resolved: [],
  };
  for (const t of tickets) lanes[laneOf(t)].push(t);
  return lanes;
}

// ---------- dependency edges ----------

/**
 * The blocked-by edges restricted to this map: both ends of every edge must be
 * a ticket on the board, since a chip the reader cannot click is noise. Lane
 * placement keeps using {@link BoardTicket.blockedBy}, GitHub's true open-blocker
 * count, so a ticket can sit in Blocked with no chip at all — that is the honest
 * rendering of "blocked by something you cannot see from here".
 */
export function inMapEdges(
  tickets: BoardTicket[],
  edges: Record<string, number[]>,
): Record<string, number[]> {
  const inMap = new Set(tickets.map((t) => t.number));
  const kept: Record<string, number[]> = {};
  for (const [n, blockers] of Object.entries(edges)) {
    if (!inMap.has(Number(n))) continue;
    kept[n] = blockers.filter((b) => inMap.has(b));
  }
  return kept;
}

/**
 * The other direction of the same edges: ticket → the tickets it unblocks.
 * Never fetched — GitHub's dependents listing would cost another call per
 * ticket, and inverting what we already have is exact.
 */
export function dependentsOf(edges: Record<string, number[]>): Record<string, number[]> {
  const deps: Record<string, number[]> = {};
  for (const [n, blockers] of Object.entries(edges)) {
    for (const b of blockers) (deps[String(b)] ??= []).push(Number(n));
  }
  for (const list of Object.values(deps)) list.sort((a, b) => a - b);
  return deps;
}

// ---------- embedded payload ----------

export interface PayloadTicket {
  number: number;
  title: string;
  state: IssueState;
  assignees: string[];
  labels: string[];
  body: string;
  html_url: string;
  /** The generator's lane decision, so the page never re-derives it. */
  lane: Lane;
}

export interface BoardPayload {
  map: BoardMap;
  tickets: Record<string, PayloadTicket>;
  edges: Record<string, number[]>;
  generatedAt: string;
}

/**
 * The JSON the page embeds — the board's data of record, read back by the
 * modal (#10) and the spotlight (#9). Nothing is fetched at view time.
 */
export function boardPayload(input: BoardInput): BoardPayload {
  const tickets: Record<string, PayloadTicket> = {};
  for (const t of input.tickets) {
    tickets[String(t.number)] = {
      number: t.number,
      title: t.title,
      state: t.state,
      assignees: t.assignees,
      labels: t.labels,
      body: t.body ?? "",
      html_url: t.url,
      lane: laneOf(t),
    };
  }
  const edges = inMapEdges(input.tickets, input.edges);
  return { map: { ...input.map }, tickets, edges, generatedAt: input.generatedAt };
}

// ---------- cache file location ----------

/**
 * `~/.cache/cmux-wayfinder/<owner>-<repo>/<map>.html` — one file per map, under
 * a per-repo directory, outside every checkout.
 */
export function boardPath(home: string, canonicalRepo: string, mapNumber: number): string {
  const dir = `${home}/.cache/cmux-wayfinder/${canonicalRepo.replace(/\//g, "-")}`;
  return `${dir}/${mapNumber}.html`;
}

/** `file://` URL for an absolute path, with each segment percent-escaped. */
export function fileUrl(absPath: string): string {
  return `file://${absPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** The board's freshness stamp, in the reader's locale — e.g. `Aug 2 at 1:00 PM`. */
export function formatGeneratedAt(at: Date): string {
  return at
    .toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .replace(", ", " at ");
}

// ---------- rendering ----------

/** How often the page reloads itself when an rpc reload is missed or fails. */
export const RELOAD_MS = 5000;

/** Lane-section chevrons — the generated markup and the page script share them. */
const CHEV_COLLAPSED = "▸";
const CHEV_OPEN = "▾";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JSON safe to drop inside a `<script>` element: escaping `<` defuses both
 * `</script>` and `<!--` without changing what `JSON.parse` reads back.
 */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function statStrip(lanes: Record<Lane, BoardTicket[]>): string {
  const cards = LANE_ORDER.map((lane) => {
    const count = lanes[lane].length;
    return (
      `<div class="stat s-${lane}${count ? "" : " s-zero"}">` +
      `<b>${count}</b><span>${LANE_NAME[lane]}</span></div>`
    );
  }).join("");
  return `<div class="strip">${cards}</div>`;
}

/**
 * The edge structure a row needs: who it waits on (rendered as chips, each
 * red or grey-struck by its blocker's state) and who it unblocks (carried as
 * an attribute for the page's spotlight — the chips already carry the other
 * direction, so neither list is stored twice).
 */
interface Edges {
  blockers: Record<string, number[]>;
  dependents: Record<string, number[]>;
  stateOf: (n: number) => IssueState;
}

function waitCell(t: BoardTicket, edges: Edges): string {
  const chips = (edges.blockers[String(t.number)] ?? []).map((b) => {
    const historical = edges.stateOf(b) === "closed";
    return `<span class="wref${historical ? " hist" : ""}" data-ref="${b}">#${b}</span>`;
  });
  return `<td class="wait">${chips.join("")}</td>`;
}

function row(t: BoardTicket, lane: Lane, collapsed: boolean, edges: Edges): string {
  const done = t.state === "closed";
  const cls = `t${done ? " done" : ""}${collapsed ? " hidden-lane" : ""}`;
  const who = !done && t.assignees.length ? `@${esc(t.assignees[0]!)}` : "";
  const dependents = edges.dependents[String(t.number)] ?? [];
  const dep = dependents.length ? ` data-dep="${dependents.join(",")}"` : "";
  return (
    `<tr class="${cls}" data-t="${t.number}" data-lane="${lane}"${dep}>` +
    `<td class="num">#${t.number}</td>` +
    `<td class="emo">${typeEmojiOf(t.labels)}${done ? DONE : readinessOf(t.labels)}</td>` +
    `<td class="title">${esc(t.title)}</td>` +
    `<td class="who">${who}</td>` +
    waitCell(t, edges) +
    `</tr>`
  );
}

function laneSection(lane: Lane, tickets: BoardTicket[], edges: Edges): string {
  // Resolved starts collapsed so finished work never crowds the live work.
  const collapsed = lane === "resolved";
  return (
    `<tr class="sec sec-${lane}" data-sec="${lane}"><td colspan="5">` +
    `<span class="chev">${collapsed ? CHEV_COLLAPSED : CHEV_OPEN}</span>${LANE_NAME[lane]}` +
    `<span class="cnt">${tickets.length}</span></td></tr>` +
    tickets.map((t) => row(t, lane, collapsed, edges)).join("")
  );
}

/** The two spotlight colors, spelled out so nobody has to memorize them. */
const LEGEND =
  `<div class="legend">` +
  `<span class="l-blk"><i></i>waits on (blockers)</span>` +
  `<span class="l-dep"><i></i>unblocks (dependents)</span>` +
  `</div>`;

/** The whole board: one self-contained HTML page, ready to write to disk. */
export function renderBoard(input: BoardInput): string {
  const lanes = partitionLanes(input.tickets);
  const title = lanesTabTitle(input.map.number);
  const counts = LANE_ORDER.map(
    (l) => `<span class="m-cnt c-${l}">${lanes[l].length} ${LANE_NAME[l].toLowerCase()}</span>`,
  ).join(" · ");
  const blockers = inMapEdges(input.tickets, input.edges);
  const byNumber = new Map(input.tickets.map((t) => [t.number, t]));
  const edges: Edges = {
    blockers,
    dependents: dependentsOf(blockers),
    // Every ref survived inMapEdges, so every lookup here hits.
    stateOf: (n) => byNumber.get(n)!.state,
  };
  // Empty lanes are hidden from the table (the strip still shows their zero).
  const sections = LANE_ORDER.filter((l) => lanes[l].length > 0)
    .map((l) => laneSection(l, lanes[l], edges))
    .join("");
  const mapLink =
    `<a href="${esc(input.map.url)}" target="_blank" rel="noopener">` +
    `<b>lanes</b> · ${esc(mapLabel(input.map.title, input.map.number))} ↗</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${STYLES}
</style>
</head>
<body>
<div id="stage"><div class="v-classic">
<div class="board-title">${mapLink}</div>
<div class="board-sub">${counts} · generated ${esc(input.generatedAt)}</div>
${LEGEND}
${statStrip(lanes)}
<div class="grid-wrap"><table>
<thead><tr><th>#</th><th>Type</th><th>Title</th><th>Assignee</th><th>Waiting on</th></tr></thead>
<tbody>${sections}</tbody>
</table></div>
</div></div>
<script id="board-data" type="application/json">${embeddedJson(boardPayload(input))}</script>
<script>
${pageScript(input.map.number)}
</script>
</body>
</html>
`;
}

/**
 * The page's own behaviour: collapsible lane sections (persisted best-effort in
 * localStorage, degrading silently to the generated defaults when `file://`
 * storage is unavailable), the two-way dependency spotlight, chip jumps, and
 * the fallback reload timer.
 *
 * The webview does not watch files, so a board whose rpc reload was skipped or
 * failed would otherwise sit stale — this timer is the self-heal. Written as
 * plain ES5-ish JS with no template literals so it stays readable inside the
 * generator's own template.
 */
function pageScript(mapNumber: number): string {
  return `(function () {
  var KEY = "cmux-wayfinder:lanes:${mapNumber}";
  var stage = document.getElementById("stage");
  var table = stage.querySelector("table");

  function rowOf(n) { return stage.querySelector('tr.t[data-t="' + n + '"]'); }
  function rowsOf(lane) { return document.querySelectorAll('tr.t[data-lane="' + lane + '"]'); }
  function lanes() { return Array.prototype.map.call(document.querySelectorAll("tr.sec"), function (s) { return s.dataset.sec; }); }

  function setLane(lane, collapsed) {
    var rows = rowsOf(lane);
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("hidden-lane", collapsed);
    var chev = document.querySelector('tr.sec[data-sec="' + lane + '"] .chev');
    if (chev) chev.textContent = collapsed ? "${CHEV_COLLAPSED}" : "${CHEV_OPEN}";
  }
  function isCollapsed(lane) {
    var rows = rowsOf(lane);
    return rows.length > 0 && rows[0].classList.contains("hidden-lane");
  }
  function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(lanes().filter(isCollapsed))); } catch (e) {}
  }

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) {
      var want = JSON.parse(saved);
      lanes().forEach(function (lane) { setLane(lane, want.indexOf(lane) !== -1); });
    }
  } catch (e) { /* no storage on file:// — keep the generated defaults */ }

  // ---- two-way spotlight: dim the board, keep the row's edges lit ----

  var FX = ["fx-keep", "fx-src", "fx-blk", "fx-dep"];

  function clearFx() {
    var marked = stage.querySelectorAll(".fx-keep, .fx-src, .fx-blk, .fx-dep");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove.apply(marked[i].classList, FX);
    if (table) table.classList.remove("fx-on");
  }

  function spotlight(src, pairs) {
    // Nothing to relate to: leave the board undimmed rather than dim it all.
    if (!table || !pairs.length) return;
    table.classList.add("fx-on");
    if (src) src.classList.add("fx-src", "fx-keep");
    pairs.forEach(function (p) { p.row.classList.add(p.cls, "fx-keep"); });
  }

  /** The rows a row waits on (from its chips) and the rows it unblocks. */
  function relatedOf(tr) {
    var pairs = [];
    var chips = tr.querySelectorAll(".wref");
    for (var i = 0; i < chips.length; i++) {
      var blocker = rowOf(chips[i].dataset.ref);
      if (blocker) pairs.push({ row: blocker, cls: "fx-blk" });
    }
    var dep = tr.dataset.dep ? tr.dataset.dep.split(",") : [];
    dep.forEach(function (n) {
      var row = rowOf(n);
      if (row) pairs.push({ row: row, cls: "fx-dep" });
    });
    return pairs;
  }

  stage.addEventListener("mouseover", function (e) {
    clearFx();
    var chip = e.target.closest(".wref");
    if (chip) {
      var blocker = rowOf(chip.dataset.ref);
      if (blocker) spotlight(chip.closest("tr.t"), [{ row: blocker, cls: "fx-blk" }]);
      return;
    }
    var tr = e.target.closest("tr.t");
    if (tr) spotlight(tr, relatedOf(tr));
  });
  stage.addEventListener("mouseleave", clearFx);

  // ---- clicks: chips jump along an edge, section headers toggle a lane ----

  stage.addEventListener("click", function (e) {
    var chip = e.target.closest(".wref");
    if (chip) {
      var row = rowOf(chip.dataset.ref);
      if (!row) return;
      // A blocker parked in a collapsed lane (Resolved, usually) has to come
      // back into view before scrolling to it means anything.
      if (row.classList.contains("hidden-lane")) { setLane(row.dataset.lane, false); remember(); }
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.remove("flash");
      void row.offsetWidth; // restart the animation on a repeat click
      row.classList.add("flash");
      return;
    }
    var sec = e.target.closest("tr.sec");
    if (!sec) return;
    var lane = sec.dataset.sec;
    setLane(lane, !isCollapsed(lane));
    remember();
  });

  setInterval(function () { location.reload(); }, ${RELOAD_MS});
})();`;
}

/** The converged ledger look, ported from the prototype's `.v-classic` sheet. */
const STYLES = `  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  #stage { min-height: 100vh; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  .v-classic { background: #fcfcfd; color: #24292f; min-height: 100vh; padding: 30px 36px 110px;
    font-size: 13px; }
  .v-classic .board-title { font-size: 17px; font-weight: 650; margin-bottom: 2px; }
  .v-classic .board-title a { color: inherit; text-decoration: none; }
  .v-classic .board-title a:hover { text-decoration: underline; }
  .v-classic .board-sub { font-size: 12px; color: #6e7781; margin-bottom: 14px; }
  .v-classic .board-sub .m-cnt { font-weight: 600; }
  .v-classic .board-sub .m-cnt.c-blocked { color: #c13f37; }
  .v-classic .board-sub .m-cnt.c-frontier { color: #1a7f37; }
  .v-classic .board-sub .m-cnt.c-inprogress { color: #205a9e; }
  .v-classic .board-sub .m-cnt.c-resolved { color: #6e7781; }
  .v-classic .legend { display: flex; gap: 14px; margin: 0 0 10px; font-size: 11px; color: #6e7781; }
  .v-classic .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px;
    margin-right: 5px; vertical-align: -1px; font-style: normal; }
  .v-classic .legend .l-blk i { background: #fff3cd; border: 1px solid #e8d48a; }
  .v-classic .legend .l-dep i { background: #e3f0fd; border: 1px solid #a9cdf4; }

  .v-classic .strip { display: flex; gap: 10px; margin: 0 0 16px; flex-wrap: wrap; }
  .v-classic .stat { border-radius: 8px; padding: 8px 14px 7px; min-width: 104px;
    border: 1px solid #dde1e6; background: #fff; }
  .v-classic .stat b { display: block; font-size: 20px; font-weight: 650; line-height: 1.1;
    font-variant-numeric: tabular-nums; }
  .v-classic .stat span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    font-weight: 600; }
  .v-classic .stat.s-blocked { border-color: #f1b8b4; } .v-classic .stat.s-blocked span { color: #c13f37; }
  .v-classic .stat.s-frontier { border-color: #b1dfbb; } .v-classic .stat.s-frontier span { color: #1a7f37; }
  .v-classic .stat.s-inprogress { border-color: #b6d2f2; } .v-classic .stat.s-inprogress span { color: #205a9e; }
  .v-classic .stat.s-resolved { border-color: #d8dde3; } .v-classic .stat.s-resolved span { color: #6e7781; }
  .v-classic .stat.s-zero { opacity: 0.45; }

  .v-classic .grid-wrap { overflow-x: auto; border: 1px solid #d8dde3; border-radius: 8px;
    position: relative; }
  .v-classic table { border-collapse: collapse; width: 100%; min-width: 640px; }
  .v-classic thead th { text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.07em; color: #6e7781; font-weight: 600; padding: 8px 12px;
    border-bottom: 1px solid #d8dde3; background: #f6f8fa; }
  .v-classic .sec td { padding: 7px 12px; font-size: 11.5px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; background: #f6f8fa;
    border-top: 1px solid #d8dde3; border-bottom: 1px solid #e6eaef; cursor: pointer; }
  .v-classic .sec .chev { display: inline-block; width: 14px; color: #8b949e; font-size: 9px; }
  .v-classic .sec .cnt { color: #8b949e; font-weight: 500; margin-left: 8px; }
  .v-classic .sec-blocked td { color: #c13f37; box-shadow: inset 3px 0 0 #e5534b; }
  .v-classic .sec-frontier td { color: #1a7f37; box-shadow: inset 3px 0 0 #2da44e; }
  .v-classic .sec-inprogress td { color: #205a9e; box-shadow: inset 3px 0 0 #3b82d9; }
  .v-classic .sec-resolved td { color: #6e7781; box-shadow: inset 3px 0 0 #afb8c1; }
  .v-classic tbody tr.t:hover { background: #f3f6f9; }
  .v-classic tbody tr.hidden-lane { display: none; }
  .v-classic td { padding: 7px 12px; border-bottom: 1px solid #eef1f4;
    font-variant-numeric: tabular-nums; transition: background 0.15s, opacity 0.15s; }
  .v-classic td.num { color: #6e7781; width: 56px; }
  .v-classic td.emo { width: 52px; }
  .v-classic tr.done td.title { color: #8b949e; text-decoration: line-through; }
  .v-classic td.who { width: 120px; font-size: 12px; color: #205a9e; }
  .v-classic td.wait { width: 170px; font-size: 12px; }

  /* waiting-on chips: red for a live blocker, grey-struck for a historical one */
  .wref { display: inline-block; padding: 1px 7px; border-radius: 5px; margin: 0 2px 2px 0;
    background: #ffe5e2; color: #b3372f; font-weight: 600; cursor: pointer;
    transition: background 0.12s, transform 0.12s; }
  .wref:hover { background: #f6b8b2; transform: translateY(-1px); }
  .wref.hist { background: #eef0f3; color: #8a919b; font-weight: 400;
    text-decoration: line-through; }
  .wref.hist:hover { background: #dde1e6; }

  /* chip click → jump + flash */
  @keyframes rowflash { 0% { background: #ffd9a0; } 100% { background: transparent; } }
  tr.flash td { animation: rowflash 1.4s ease-out; }

  /* two-way spotlight: dim the rest, tint the related */
  .v-classic table.fx-on tr.t:not(.fx-keep) td { opacity: 0.3; }
  .v-classic table.fx-on tr.sec td { opacity: 0.5; }
  .v-classic tr.fx-src.fx-keep td { background: #fff; }
  .v-classic tr.fx-blk td { background: #fff3cd; }
  .v-classic tr.fx-blk td.num { color: #8a6d1a; font-weight: 700; }
  .v-classic tr.fx-dep td { background: #e3f0fd; }
  .v-classic tr.fx-dep td.num { color: #205a9e; font-weight: 700; }`;
