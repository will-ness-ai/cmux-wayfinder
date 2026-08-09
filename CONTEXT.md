# CONTEXT

Ubiquitous language for cmux-wayfinder. Terms used in code, issues, and docs.

## Glossary

- **Map** — a GitHub issue labelled `wayfinder:map`; its sub-issues are the effort's tickets. One cmux workspace per open map.
- **Child map** — a sub-issue that is itself a map. It is charted work, so it shows on the parent's board, but it is never a ticket: it has its own workspace, and nobody takes it from the parent. Thus it never joins the frontier and never gets a ticket tab.
- **Ticket** — a sub-issue of a map, other than a child map. Carries a `wayfinder:<type>` label (grilling, task, research, prototype).
- **Claim** — the act of assigning a ticket to the driving dev before working it. The GitHub assignee *is* the claim; an open, unassigned ticket is unclaimed. Unassigning releases the ticket back to the frontier. A claim says "a session has started this", not "a session is live right now".
- **Blocked** (lane) — ticket is open and has ≥1 *open* blocker. Blockedness dominates: a blocked ticket sits here even if claimed.
- **Frontier** (lane) — ticket is open, unblocked, and unclaimed. Takeable right now.
- **In progress** (lane) — ticket is open, unblocked, and claimed (any assignee). A child map lands here too once open and unblocked: no assignee claims it, but its own workspace is where it runs.
- **Resolved** (lane) — ticket is closed.
- **Lane** — one of the four rows above. The four predicates partition a map's sub-issues: every ticket and child map is in exactly one lane.
