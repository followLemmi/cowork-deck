# Session activity — manual check

The thing that matters most here cannot be asserted in a unit test: **the
panel's numbers have to agree with the terminal above them.** Everything else
about this feature is covered by `tests/activity-panel.test.ts`,
`tests/sessions-activity.test.ts` and the Rust readers' own tests; the
reconciliation is a human's to run. Work through the list and record the result
in the pull request description.

Run the first two sections against the harness — `npm run dev`, then
`/harness/`. Its five tiles carry activity fixtures covering every branch the
panel has, so the layout is checkable without waiting on a real conversation.
Everything under "Against a real claude" needs the app itself and a session you
are willing to make a mess in.

## The two ways in

- [ ] Hover a tile — the chart button appears beside the pencil, carrying the session's call count. Move away — it fades. It stays on the tile that has the keyboard.
- [ ] `Tab` to it from elsewhere in the header — it takes a focus ring while invisible-on-hover, and `Enter` opens the panel.
- [ ] Click the `ctx …` token badge — the **same** panel opens. It is one surface, and two of them on screen is the defect.
- [ ] `Tab` to the token badge and press `Enter`, then `Space` — both open it. The badge is a control now, and a control the keyboard cannot reach is not one.
- [ ] `Escape` closes it, the backdrop closes it, and the Close button closes it. Focus returns to whatever had it before.
- [ ] Press the chart button again while the panel is open — it closes, rather than stacking a second copy of the same read.
- [ ] With the panel open, `Tab` all the way round — focus stays inside it and does not reach the terminal underneath.
- [ ] Zoom the window to 400% (SC 1.4.10). The panel stays reachable, the tool list scrolls inside itself, and the head stays put while it does.

## The five fixture tiles

Each one is a different branch, and the point of the section is that none of them
renders a zero where a sentence belongs.

- [ ] **`Refund webhook retries`** — the full panel. By tool with a bar per row, by agent with two subagents reading `Code Reviewer — Review the retry budget change` and indented one step, and by MCP server listing `gitnexus` and `playwright`. Check the totals: the by-tool numbers and the by-agent numbers add to the same figure in the head.
- [ ] The `Bash` row shows `3 errors` and the `Grep` row shows `1 refused`. **A refusal must not be counted as an error** — that is the one number on this screen that is easy to get wrong and impossible to notice.
- [ ] Rows with neither show nothing at all. A row reading `12 · 0 errors · 0 refused` is the defect.
- [ ] **The waiting tile** — "No tool calls yet." A log that is there and has recorded nothing.
- [ ] **The done tile** — 334 calls over five tools. The bars are what make that shape readable; if the list reads as five similar rows, the scaling is wrong.
- [ ] **The error tile** — a sentence about the log not opening. Not zeroes, and a different sentence from the waiting tile's.
- [ ] **The auto tile** — a Copilot session. **The by-agent section is absent entirely**, because that CLI's log attributes nothing. An empty "By agent" heading is the defect; so is a one-row tree.
- [ ] Open a **command** tile's panel (GitHub screen → install `gh`). It says the tile runs a command rather than an agent. A fourth distinct sentence, and no IPC call is made for it.
- [ ] Read the four empty-state sentences side by side. If any two could be swapped without a reader noticing, one of them is wrong.

## Against a real claude

This is the section the feature exists for. Everything above checks that the
panel draws what it was handed; only this checks that what it was handed is true.

- [ ] Start a session and make it work: several `Bash` calls, a couple of `Read`s, an `Edit`, a `Grep`. **Refuse one call at the permission prompt.** **Let one fail** — a `Bash` command that exits non-zero will do.
- [ ] Open the panel and reconcile **every count** against the scrollback, by hand, one tool at a time. This is tedious and it is the check: an off-by-one here is invisible in every other way.
- [ ] The refusal appears under `refused` and **not** under `errors`. The failure appears under `errors`. If they have merged, stop — the readers deliberately keep two counters and something has collapsed them.
- [ ] Nothing you did is missing. A tool the deck has never heard of should still appear, under its own name, with a category of `other`.
- [ ] **Delegate to a subagent** (`Agent`, or a skill that spawns one). The by-agent section names it — `agent type — description` — and its calls appear there **and** in the totals, counted once. Add the main chain's number to the subagents' and check it against the head.
- [ ] The main chain's `Agent` call is itself one call, in the by-tool list, under `delegate`. It is not the subagent's work and must not be conflated with it.
- [ ] A subagent that is a **teammate** rather than a delegation (`spawnDepth: 0`, no `toolUseId` in its `agent-*.meta.json`) still appears, indented one step, not level with the conversation.
- [ ] **MCP.** Make some MCP calls. They keep their full `mcp__server__tool` names in the by-tool list and are grouped by server below. The per-server totals add to the MCP rows' total.
- [ ] Leave the panel open while the session works. The numbers climb on the tick, and **the scroll position does not jump** — a list that returns to the top every five seconds is unusable.
- [ ] **`/clear` mid-session**, then make a few more calls and reopen the panel: the roll follows the **new** conversation, as the token badge does. The old conversation's calls are gone from it.
- [ ] **Restart the tile with ⟳** and reopen the panel: the numbers are still there. This is the whole reason the log is the source rather than our hooks — if this one fails, the feature has been rebuilt on the wrong foundation.
- [ ] `--resume` a session from a previous day. Its numbers are there immediately, covering the whole conversation and not just this window's part of it.
- [ ] Delete the transcript out from under a live session and reopen the panel: the sentence about a log that would not open, not zeroes.
- [ ] Compare the panel's total against the number on the chart button. They come from two different commands reading the same bytes and they must agree.

## The cost

The panel reads a file, and the argument for reading it at all is that it only
happens while the panel is open.

- [ ] Twelve tiles open, **no panel**. Watch the IPC (a temporary log in `session_activity`, or the process's file activity for a minute). **Not one activity call.** If there are any, the poll has picked this up and the cost argument is gone.
- [ ] Open one panel and leave it. One call a tick, for **one** session — not twelve.
- [ ] Close it. The calls stop within one tick.
- [ ] Open a panel on the largest session you have — several MB of transcript — and watch the window. Opening it does not stutter the terminals, and typing into another tile stays responsive while it is open.
- [ ] Close a tile while its panel is open. The panel goes with it and nothing keeps reading.

## The screen reader

- [ ] With Orca (or VoiceOver) on, `Tab` to the chart button — it announces the session's call count, not just "button".
- [ ] `Tab` to the token badge — it announces as a control, and activating it opens the panel.
- [ ] Open the panel — it announces as a dialog, named by the session.
- [ ] Arrow through the tool list — each row announces its tool name and count. The category chip should not be announced as a separate meaningless word before the name.
