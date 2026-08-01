# Research: cmux file:// board tab — load, refresh, and file location

Spiked live against **cmux 0.64.17 (97) [9ed29d81a]** (`/Applications/cmux.app/Contents/Resources/bin/cmux`, Mach-O binary) on 2026-08-01. All probes ran inside one throwaway workspace (`WF-RESEARCH-THROWAWAY`, closed afterwards via `workspace.close`; test files under `~/.cache/cmux-wayfinder/test/` deleted afterwards).

## 1. Load — does a browser surface render a local file:// page?

**Yes.** The exact invocation the repo already uses (`createBrowserSurface` in `src/cmux.ts`) works unchanged with a `file://` URL:

```
$ cmux new-surface --type browser --url "file://$HOME/.cache/cmux-wayfinder/test/board.html" \
    --workspace DFBD21E7-… --focus false
OK surface:98 pane:25 workspace:21
```

`surface.list` a second later reports the new surface fully rendered, and — the key observable — **the tab title mirrors `document.title`**:

```
$ cmux rpc surface.list '{"workspace_id":"DFBD21E7-…"}'
… { "id": "3D41A1ED-…", "ref": "surface:98", "title": "WFTEST gen 1", "type": "browser", … }
```

Observation channels tested on the file:// page:

| Channel | Result |
| --- | --- |
| `cmux browser --surface <id> get title` | works — `WFTEST gen 1` |
| `cmux browser --surface <id> get url` | works — echoes the `file:///…` URL |
| `cmux browser --surface <id> get text --selector "#gen"` | works — DOM text extraction |
| `cmux browser --surface <id> eval --script "…"` | works — full JS eval (caveat: falsy results print as `false`, e.g. `eval '0'` → `false`) |
| `cmux rpc surface.read_text {surface_id}` | **fails** on browser surfaces: `Error: invalid_params: Surface is not a terminal` |

So a page can signal its state via `document.title` (e.g. a generation counter) and sync can read it back through `surface.list` — no screenshots needed.

**Missing file fails soft.** Navigating to a nonexistent `file://` path acks normally; the tab title falls back to the raw URL string (`title = "file:///…/does-not-exist.html"`). Navigating again after the file exists renders it fine. Still, the spec should write the file **before** creating the tab so the user never sees the fallback.

## 2. Refresh — how does an open tab pick up a rewritten file?

### (a) Plain rewrite → auto-reload: **NO**

Tested both write patterns a sync process would use:

- Atomic replace (`write tmp + mv`, new inode): title still `WFTEST gen 1` after 12 s of polling.
- In-place rewrite (`cat >` same inode): title still `WFTEST gen 1` after 6 s.

The webview does not watch the file. A rewrite alone never updates the open tab.

### (b) rpc reload / navigate ops: **YES — `browser.reload` exists and is the cleanest**

The v2 rpc surface has a whole `browser.*` family (found via `strings` on the cmux binary and `cmux browser --help`; an invalid rpc method only returns `method_not_found: Unknown method`, no enumeration). Both of these were verified live:

```
$ cmux rpc browser.reload '{"surface_id":"3D41A1ED-…"}'      # returns JSON ack, ~20 ms
$ cmux rpc browser.navigate '{"surface_id":"3D41A1ED-…","url":"file:///…/board.html"}'
```

After rewriting the file to "gen 3" and issuing `browser.reload`, the tab showed the new content within ~1 s:

```
after reload title: WFTEST gen 3
after reload h1:    WFTEST generation 3
```

CLI equivalents: `cmux browser --surface <id> reload | goto <url> | back | forward`.

**Scroll position across rpc reload: preserved**, with one caveat. Scrolled to y=1200, waited 3 s, rewrote file, `browser.reload` → content updated to gen 23 and `scrollY` stayed 1200. But scroll-then-reload **immediately** (<1 s) lost the position (scrollY → 0): WebKit records scroll state lazily. Irrelevant for a sync cadence measured in seconds, but worth knowing.

### (c) JS timer `location.reload()` baked into the page: **YES, works on file://**

Page contained `<script>setInterval(() => location.reload(), 3000);</script>`. Rewrote the file (macOS `sed -i`, i.e. atomic replace) and polled once per second:

```
rewritten to gen 11 at 13:45:16
t+1s title=WFTEST gen 10 scrollY=1500
t+2s title=WFTEST gen 11 scrollY=1500   ← picked up within one timer tick
t+3s … t+8s title=WFTEST gen 11 scrollY=1500
```

- The rewrite appeared within 2 s (one 3 s timer tick), with zero external involvement.
- **Scroll position survived every reload** (page was scrolled to y=1500 beforehand; stayed 1500 across ≥3 consecutive reloads).
- Flicker: not directly observable through this tooling (no visual diff); scroll persistence plus WebKit's file:// reload speed suggests it is minor, but this is **unverified**.

## 3. File location

- `~/.cache/cmux-wayfinder/test/board.html` — **loads fine** (all probes above ran from there).
- `/private/tmp/claude-501/…/scratchpad/board/loc.html` — **loads fine** (`title: WFTEST tmp-loc`).
- No path was found that failed to load; the webview showed no sandboxing constraint for either `$HOME` dotdirs or `/private/tmp`. (TCC-protected dirs like `~/Documents` were not probed — no reason to put the file there.)

So `~/.cache/cmux-wayfinder/<owner>-<repo>/<map>.html` is viable and keeps generated files out of worktrees. Note the missing-parent case: `new-surface`/`browser.navigate` do not create directories, so sync must `mkdir -p` before writing.

### Side note

cmux also ships `cmux markdown [open] <path>` — "open markdown file in formatted viewer panel **with live reload**". Not used here (the board wants controlled HTML, and the viewer panel is not a browser surface), but it exists if a markdown-native board is ever considered.

## Recommendation

- **Load:** keep the existing `createBrowserSurface` path — `cmux new-surface --type browser --url "file://<abs path>" --workspace <id> --focus false` — pointed at the generated file. Write the file before creating the tab.
- **Refresh:** belt and suspenders, both proven:
  1. **Primary: `cmux rpc browser.reload '{"surface_id":"<id>"}'`** at the end of each sync pass. Deterministic, ~20 ms, updates only when content actually changed, no reload churn between passes.
  2. **Fallback: bake `setInterval(() => location.reload(), 5000)` into the generated page**, so the tab self-heals even when sync rewrites the file while the rpc is skipped/fails (or in `--watch` gaps). Scroll position is preserved on file:// reloads, so the timer is not disruptive. 3–5 s is a sensible interval.
  - Do **not** rely on file-watching: the webview has none.
- **File location:** `~/.cache/cmux-wayfinder/<owner>-<repo>/<map>.html`. `mkdir -p` the parent each pass; write via tmp-file + `mv` (atomic replace is safe — reload after `mv` picks up the new inode).
- **Constraints the spec must honor:**
  - `surface.read_text` cannot observe browser surfaces; use `document.title` (mirrored into `surface.list` titles) or `cmux browser get …` when sync needs to verify tab state. A generation counter/timestamp in `<title>` makes staleness detectable — but note the sync tab-titling pass (`tab.action rename`) and the page's own title will fight over the same field; pick one owner.
  - A tab created before its file exists shows the raw URL as title until the next reload/navigate; ordering (write, then create) avoids it, and `browser.reload` recovers it if it ever happens.
  - Reload ops need the browser surface id, which sync already tracks from `createBrowserSurface`.
