---
status: Accepted
date: 2026-08-27
deciders:
  - evgenykharetski
---

# ADR-0007 — Session activity is read from the agent's own log, not from the hooks the deck installs

## Context

A tile says what a session **costs** — `ctx 83.7k`, with the spend behind its
tooltip. It says nothing about what the session **did**. Twelve tiles read in one
sweep, and the only way to learn that one of them has run 334 `Bash` calls and
nothing else, or that a subagent nobody asked about did most of the work, is to
scroll a terminal back by hand.

There are two places that answer could come from, and the cheap one is already
built. `src-tauri/src/hooks.rs` installs `PreToolUse` and maps it to the
`working` state; the reporter is a few lines from carrying `tool_name` on the
same event, and the deck would have a live tally for nothing.

The other is the agent's own log — `~/.claude/projects/<slug>/<id>.jsonl` for
Claude Code — read on demand by a component that writes nothing.

This will be re-litigated. The hook path is genuinely cheaper, the plumbing is
genuinely there, and the next person to look at this will propose it. This record
exists so they find the answer rather than the argument.

## Decision

**Activity is read from the agent's own log. The hooks the deck installs are not
a source of activity data.**

Three reasons, in the order they matter.

**It would count only what the deck watched.** `--resume` is first-class here and
so is the restart button (`src/sessions.ts`): both reopen a conversation with
hundreds of calls behind it, and a hook stream that started when the tile did
would report zero for all of them. A log is retrospective — open the panel on a
session resumed from last week and the numbers are already there. The tally
covers the conversation, not the window.

**`PreToolUse` fires before the call, not after it.** A refused call would be
counted as a made one. Refusals are not hypothetical: across one machine's
transcripts `toolDenialKind` appears on 255 lines, over four kinds —
`permission-rule` ×144, `user-rejected` ×49, `automode-blocked` ×32,
`automode-unavailable` ×26. A hook before the prompt cannot know which way the
prompt went.

**It is Claude Code by construction.** No other CLI offers that hook API.
`copilot`, `opencode` and `codex` were all found on the machine this was decided
on, and a read-only log reader is the only contract all four can satisfy.

The contract is `ActivityReader` in `src-tauri/src/activity/`: `sources()` says
where a session's logs are *now*, `fold()` turns one buffer into tallies, and
`ReaderCapabilities` declares what the CLI's log can actually answer — in the
manner of `ProviderCapabilities` in `tasks/provider.rs`, where "not supported" is
answered by hiding the control rather than by failing at call time.

**Three formats were measured against that contract before it was fixed**, which
is the part that makes this more than a preference:

| CLI | Where | One call is | Outcome | Delegation |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<id>.jsonl` | a `tool_use` block in an `assistant` message | the matching `tool_result.is_error`, with `toolDenialKind` on the line | `<stem>/subagents/agent-*.jsonl` plus `agent-*.meta.json` |
| Copilot CLI | `~/.copilot/session-state/<sessionId>.jsonl` | a `tool.execution_start` event | `tool.execution_complete`, `data.success` | none observed |
| opencode | `~/.local/share/opencode/storage/part/<messageID>/<partID>.json` | a part with `type: "tool"` | `state.status` | none observed |

Two of them cost the shape something, and both costs were paid rather than
argued away. opencode's log is a directory tree rather than a file, so `Source`
names a directory as well as a file and the read is bounded by a budget. Neither
Copilot nor opencode attributes delegated work, so `capabilities().agents` is
false for both and the panel omits the by-agent section rather than drawing a
one-row tree.

## Consequences

**The reading is only as fresh as the log**, and goes stale between a call and
the line that records it. This is exactly the staleness the token badge already
has, from the same source, and it costs nothing against the terminal above it,
which is stale in the same way.

**Reading is not free.** The heaviest transcript measured on one machine is
3.1 MB over 1728 lines, and 47 files are past 1 MB. So the breakdown does not
ride the five-second poll: `session_activity` is called when a panel opens and
re-called on the tick only while one is on screen, and a deck of twelve with
nothing open makes no activity call at all. Only the total rides the poll, in
`SessionSnapshot` — the poll has already parsed those lines for the token counts,
and walking the content blocks it parsed is cheap beside that parse.

**Two counters, not one.** A denial never ran and a failure did, and Claude Code
writes both on one line — `is_error: true` with a `toolDenialKind` beside it — so
telling them apart is a rule each reader applies rather than one the log applies
for it. Rolling them together would make a session that refused three commands
look like one that broke three times.

**`unavailable` is not `calls: 0`.** "There is no log for this session" and "the
log is here and this session has made no calls" are different sentences, and the
panel says them differently, as `SessionSnapshot` already does for tokens by
hiding the badge rather than drawing four zeroes.

**A CLI with no reader is a first-class state**, not a failure. The panel says so
in its own words, which is what let the Codex reader be deferred without leaving
anything broken.

## What would reopen this

**A CLI whose log cannot be read at all but which does offer events.** The answer
then is another `ActivityReader` backed by an event stream — a reader whose
`sources()` is a subscription — and not a second source of truth beside the log.
Two sources that disagree about one session is the outcome this decision is
shaped to avoid, and adding an event-backed reader for one CLI does not require
giving up the log for the three that have one.

## Alternatives considered

**Carry `tool_name` on the existing `PreToolUse` report.** Rejected for the three
reasons above. Worth restating that it is cheap and works — it is rejected for
what it would count, not for what it would cost.

**Add a `PostToolUse` hook so outcomes are known.** Rejected: it fixes the second
reason and neither of the others. A resumed session still reports zero, and three
of the four CLIs still have no hooks to install.

**Both: hooks while the deck is watching, the log otherwise.** Rejected as the
worst of the three. Two sources for one number means a reconciliation nobody
asked for, and the failure — a tally that changes when you restart a tile — would
be blamed on the session rather than on the deck.

**Keep a tally of our own, written as the deck observes calls.** Rejected: it is
the hook path with a cache in front of it, and it adds a file that can disagree
with the log it was derived from.
