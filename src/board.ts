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

import type { EdgeMap, IssueState } from "./issues.ts";
import {
  DONE,
  lanesTabTitle,
  mapLabel,
  readinessOf,
  ticketTypeOf,
  TYPE_EMOJI,
  typeEmojiOf,
  type TicketType,
} from "./plan.ts";

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
  body: string;
  /** True for a *child map* — a sub-issue that is itself a wayfinder map. */
  isMap: boolean;
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
   * Each ticket's blocker numbers, open or closed, as GitHub reports them.
   * Refs to issues outside the map are dropped here (see {@link inMapEdges}) —
   * the board only draws edges it can point at.
   */
  edges: EdgeMap;
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
 *
 * A *child map* is the one row that is not a ticket, so the claim test cannot
 * place it — nobody assigns a map. It is running work in its own workspace, so
 * an open, unblocked child map reads as In progress. What matters is that it
 * never reaches Frontier: that lane means "takeable right now", and taking a
 * child map from its parent's board is exactly the thing to prevent.
 */
export function laneOf(t: BoardTicket): Lane {
  if (t.state === "closed") return "resolved";
  if (t.blockedBy > 0) return "blocked";
  if (t.isMap) return "inprogress";
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
export function inMapEdges(tickets: BoardTicket[], edges: EdgeMap): EdgeMap {
  const inMap = new Set(tickets.map((t) => t.number));
  const kept: EdgeMap = {};
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
export function dependentsOf(edges: EdgeMap): EdgeMap {
  const deps: EdgeMap = {};
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
  /** Likewise its ticket type — the modal badges and names it, never parses it. */
  type: TicketType;
  /** True for a child map, so the modal can say so instead of inferring it. */
  isMap: boolean;
}

export interface BoardPayload {
  map: BoardMap;
  tickets: Record<string, PayloadTicket>;
  edges: EdgeMap;
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
      body: t.body,
      html_url: t.url,
      lane: laneOf(t),
      type: ticketTypeOf(t.labels),
      isMap: t.isMap,
    };
  }
  const edges = inMapEdges(input.tickets, input.edges);
  return { map: { ...input.map }, tickets, edges, generatedAt: input.generatedAt };
}

// ---------- freshness stamp ----------

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

/**
 * View-time HTML escaping, as source text rather than a function: the modal
 * builds its markup out of the embedded payload inside the page, so it needs its
 * own copy of what {@link esc} does at generation time. Shipped as a string so
 * tests can evaluate the very code the page runs.
 */
export const ESC_SOURCE = `function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }`;

/**
 * The tiny markdown renderer the modal draws a ticket body with, ported from
 * the prototype. Headings, lists, code fences, inline code/bold/italic, http(s)
 * links and `#n` refs — everything else is escaped, so a body can never inject
 * markup. Deliberately no external library: the page must stay self-contained.
 *
 * Source text for the same reason as {@link ESC_SOURCE} (it uses that `esc`),
 * and tested by evaluating the pair.
 */
export const MD_SOURCE = `function md(src) {
    function inline(s) {
      return esc(s)
        .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>")
        .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<i>$2</i>")
        .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|\\s)(#\\d{1,4})\\b/g, "$1<b>$2</b>");
    }
    var lines = String(src).replace(/\\r/g, "").split("\\n");
    var out = "", inList = false, inPre = false, pre = [];
    function closeList() { if (inList) { out += "</ul>"; inList = false; } }
    function flushPre() { out += "<pre><code>" + esc(pre.join("\\n")) + "</code></pre>"; pre = []; }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (inPre) {
        if (/^\`\`\`/.test(line)) { flushPre(); inPre = false; } else pre.push(line);
        continue;
      }
      if (/^\`\`\`/.test(line)) { closeList(); inPre = true; continue; }
      var h = /^(#{1,4})\\s+(.*)/.exec(line);
      if (h) {
        closeList();
        var lv = Math.min(h[1].length + 1, 4);
        out += "<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">";
        continue;
      }
      var li = /^\\s*[-*]\\s+(.*)/.exec(line);
      if (li) {
        if (!inList) { out += "<ul>"; inList = true; }
        out += "<li>" + inline(li[1]) + "</li>";
        continue;
      }
      closeList();
      if (line.trim() === "") continue;
      out += "<p>" + inline(line) + "</p>";
    }
    // An unterminated fence still closes, rather than swallowing the rest.
    if (inPre) flushPre();
    closeList();
    return out;
  }`;

/**
 * The modal's shell — empty until a row click fills it from the embedded
 * payload. The GitHub link gets its `href` then too, so the page as written
 * still points at nothing external.
 */
const MODAL = `<div id="scrim">
  <div id="modal" role="dialog" aria-modal="true">
    <div class="m-head">
      <h2 id="m-title"></h2>
      <button class="m-close" id="m-close" aria-label="Close">✕</button>
    </div>
    <div class="m-meta" id="m-meta"></div>
    <div class="m-body" id="m-body"></div>
    <div class="m-foot"><a id="m-link" target="_blank" rel="noopener">Open on GitHub ↗</a></div>
  </div>
</div>`;

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
 * What rendering a row needs to know about the dependency structure: who it
 * waits on (rendered as chips, each red or grey-struck by its blocker's state,
 * hence the state lookup) and who it unblocks (carried as an attribute for the
 * page's spotlight — the chips already carry the other direction, so neither
 * list is stored twice).
 */
interface EdgeContext {
  blockers: EdgeMap;
  dependents: EdgeMap;
  stateOf: (n: number) => IssueState;
}

function waitCell(t: BoardTicket, ctx: EdgeContext): string {
  const chips = (ctx.blockers[String(t.number)] ?? []).map((b) => {
    const historical = ctx.stateOf(b) === "closed";
    return `<span class="wref${historical ? " hist" : ""}" data-ref="${b}">#${b}</span>`;
  });
  return `<td class="wait">${chips.join("")}</td>`;
}

/**
 * The row's two-slot badge, same as a tab title carries: type emoji, then whose
 * turn it is (✓ once closed). A child map has no turn to take — its work runs
 * in its own workspace — so its second slot stays empty until it closes.
 */
function badge(t: BoardTicket): string {
  const type = typeEmojiOf(t.labels);
  if (t.state === "closed") return `${type}${DONE}`;
  return t.isMap ? type : `${type}${readinessOf(t.labels)}`;
}

function row(t: BoardTicket, lane: Lane, collapsed: boolean, ctx: EdgeContext): string {
  const done = t.state === "closed";
  const cls = `t${done ? " done" : ""}${collapsed ? " hidden-lane" : ""}`;
  const who = !done && t.assignees.length ? `@${esc(t.assignees[0]!)}` : "";
  const dependents = ctx.dependents[String(t.number)] ?? [];
  const dep = dependents.length ? ` data-dep="${dependents.join(",")}"` : "";
  return (
    `<tr class="${cls}" data-t="${t.number}" data-lane="${lane}"${dep}>` +
    `<td class="num">#${t.number}</td>` +
    `<td class="emo">${badge(t)}</td>` +
    `<td class="title">${esc(t.title)}</td>` +
    `<td class="who">${who}</td>` +
    waitCell(t, ctx) +
    `</tr>`
  );
}

function laneSection(lane: Lane, tickets: BoardTicket[], ctx: EdgeContext): string {
  // Resolved starts collapsed so finished work never crowds the live work.
  const collapsed = lane === "resolved";
  return (
    `<tr class="sec sec-${lane}" data-sec="${lane}"><td colspan="5">` +
    `<span class="chev">${collapsed ? CHEV_COLLAPSED : CHEV_OPEN}</span>${LANE_NAME[lane]}` +
    `<span class="cnt">${tickets.length}</span></td></tr>` +
    tickets.map((t) => row(t, lane, collapsed, ctx)).join("")
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
  const ctx: EdgeContext = {
    blockers,
    dependents: dependentsOf(blockers),
    // Every ref survived inMapEdges, so every lookup here hits.
    stateOf: (n) => byNumber.get(n)!.state,
  };
  // Empty lanes are hidden from the table (the strip still shows their zero).
  const sections = LANE_ORDER.filter((l) => lanes[l].length > 0)
    .map((l) => laneSection(l, lanes[l], ctx))
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
${MODAL}
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
 * storage is unavailable), the two-way dependency spotlight, chip jumps, the
 * ticket modal, and the fallback reload timer.
 *
 * The webview does not watch files, so a board whose rpc reload was skipped or
 * failed would otherwise sit stale — this timer is the self-heal. Written as
 * plain ES5-ish JS with no template literals so it stays readable inside the
 * generator's own template.
 */
function pageScript(mapNumber: number): string {
  return `(function () {
  var KEY = "cmux-wayfinder:lanes:${mapNumber}";
  var DATA = JSON.parse(document.getElementById("board-data").textContent);
  var LANE_NAME = ${embeddedJson(LANE_NAME)};
  var TYPE_EMOJI = ${embeddedJson(TYPE_EMOJI)};
  var stage = document.getElementById("stage");
  var table = stage.querySelector("table");
  var scrim = document.getElementById("scrim");

  ${ESC_SOURCE}

  ${MD_SOURCE}

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

  // ---- the ticket modal: read a body without leaving cmux ----

  function modalOpen() { return scrim.classList.contains("open"); }
  function closeModal() { scrim.classList.remove("open"); }

  function openModal(n) {
    var t = DATA.tickets[n];
    if (!t) return;
    document.getElementById("m-title").innerHTML =
      TYPE_EMOJI[t.type] + ' <span class="m-num">#' + t.number + "</span> " + esc(t.title);
    var meta = [
      '<span class="lane-chip">' + esc(LANE_NAME[t.lane]) + "</span>",
      "<span>" + esc(t.type) + "</span>",
    ];
    if (t.assignees.length) meta.push("<span>@" + esc(t.assignees[0]) + "</span>");
    // In-map blockers only — the same edges the row's chips are drawn from.
    var blockers = DATA.edges[n] || [];
    if (blockers.length) meta.push("<span>blocked by #" + blockers.join(", #") + "</span>");
    document.getElementById("m-meta").innerHTML = meta.join("");
    document.getElementById("m-body").innerHTML = md(t.body || "*no description*");
    document.getElementById("m-link").href = t.html_url;
    scrim.classList.add("open");
  }

  scrim.addEventListener("click", function (e) { if (e.target === scrim) closeModal(); });
  document.getElementById("m-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  // ---- clicks: chips jump along an edge, section headers toggle a lane,
  //      and a row opens its ticket ----

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
    if (sec) {
      var lane = sec.dataset.sec;
      setLane(lane, !isCollapsed(lane));
      remember();
      return;
    }
    var tr = e.target.closest("tr.t");
    if (tr) openModal(tr.dataset.t);
  });

  // The fallback reload, paused while the modal is open so a refresh never
  // interrupts reading — the next tick after it closes picks the board back up.
  setInterval(function () {
    if (!modalOpen()) location.reload();
  }, ${RELOAD_MS});
})();`;
}

/** The converged ledger look, ported from the prototype's `.v-classic` sheet. */
const STYLES = `  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  #stage { min-height: 100vh; }
  button { font: inherit; cursor: pointer; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  /* ---- ticket modal ---- */
  #scrim { position: fixed; inset: 0; z-index: 800; background: rgba(10,12,16,0.55);
    display: none; align-items: center; justify-content: center; padding: 4vh 16px; }
  #scrim.open { display: flex; }
  #modal { width: min(680px, 100%); max-height: 88vh; overflow-y: auto;
    background: #fff; color: #23262d; border-radius: 12px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5); padding: 22px 26px; }
  #modal .m-head { display: flex; align-items: flex-start; gap: 10px; }
  #modal .m-head h2 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; text-wrap: balance; }
  #modal .m-num { color: #7a828f; font-weight: 400; }
  #modal .m-close { border: none; background: #eef0f3; border-radius: 6px; width: 28px;
    height: 28px; font-size: 14px; color: #555; }
  #modal .m-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; font-size: 11.5px; }
  #modal .m-meta span { background: #f0f2f5; border-radius: 20px; padding: 3px 10px; color: #4a5160; }
  #modal .m-meta span.lane-chip { font-weight: 600; }
  #modal .m-body { font-size: 14px; line-height: 1.65; }
  #modal .m-body h2 { font-size: 15px; margin: 18px 0 6px; }
  #modal .m-body h3 { font-size: 13.5px; margin: 14px 0 4px; }
  #modal .m-body ul { padding-left: 22px; margin: 6px 0; }
  #modal .m-body li { margin: 3px 0; }
  #modal .m-body code { background: #f0f2f5; border-radius: 4px; padding: 1px 5px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  #modal .m-body pre { background: #f0f2f5; border-radius: 8px; padding: 12px; overflow-x: auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5; }
  #modal .m-body pre code { background: none; padding: 0; }
  #modal .m-body a { color: #2563c4; }
  #modal .m-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e8eaee; }
  #modal .m-foot a { color: #2563c4; text-decoration: none; font-size: 13px; font-weight: 500; }
  #modal .m-foot a:hover { text-decoration: underline; }

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
  .v-classic tbody tr.t { cursor: pointer; }
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
