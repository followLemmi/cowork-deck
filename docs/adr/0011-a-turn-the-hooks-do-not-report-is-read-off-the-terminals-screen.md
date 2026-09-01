---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0011 — A turn the hooks do not report is read off the terminal's own screen

## Context

A session's state on the deck is reported entirely by the hooks
`src-tauri/src/hooks.rs` installs: `UserPromptSubmit` and `PreToolUse` say
`working`, `Stop` says `done`, `SessionEnd` says `ended`. `event_kind_to_state`
in `src-tauri/src/model.rs` maps them and does nothing else — there is no
fallback, no timeout, and nothing that reacts to an event that never arrives.

**Claude Code's `Stop` hook does not run when a turn ends because the person
interrupted it.** That is documented behaviour of the hook. So `Escape` in a
session's terminal left the `working` set by the last `PreToolUse` standing for
the rest of that session's life (#333), and `working` is not only a colour on a
rail:

- `shouldSkipOverlap` (`src/schedule.ts`) refuses to fire a scheduled scenario
  over a session that is `working` or `waitingInput`. One `Escape` and that
  scenario never fired again.
- `derivedStatus` (`src/tasks.ts`) keeps a card's "in progress" chip while any
  linked session is busy — under a doc comment promising that a card cannot get
  stuck in progress.
- The pill, the notifications and the waiting count all read the same field.

Two ways out were on the table, and #333 asked for the choice to be made rather
than left to review.

## Decision

**An `Escape` while Claude Code's interrupt hint is on screen, followed by that
hint going away, is an end of turn — reported as `done`, the same state `Stop`
would have reported.** No liveness timeout is added.

The hint is the evidence, and it is Claude Code's own: `esc to interrupt`,
present for exactly as long as a turn can be interrupted and gone the instant
one is. Requiring **both halves** — up when the key was pressed, gone shortly
after — is what makes this a confirmed end of turn rather than a guess about a
keystroke. An `Escape` Claude Code spends on something else, dismissing a
completion menu over a running turn, leaves the hint up; the wait gives up after
a few seconds and nothing is reported.

The wait's budget is generous on purpose, because the two ways of being wrong are
not symmetrical. Too short and a real interrupt inside a long tool call is missed
in silence, which is indistinguishable from this never having been built. Too
long and the wait may still be open when the turn ends for some other reason — at
which point it reports `done`, which is what `Stop` reports for that same ending.
A late reading agrees with the hooks; a missed one leaves #333 standing.

It is read from the **screen buffer**, not from the output stream. Claude Code
is Ink: it repaints when something changes and is otherwise silent, so a long
tool call can produce no bytes for a minute with the hint up throughout, and
"not in the output that arrived recently" says nothing about whether a turn is
running. xterm is already holding the screen; `src/interrupt.ts` carries the
matcher and `TerminalPanel.awaitInterrupt` the wait.

The correction is applied in the window that owns the tile, and only from
`working` or `waitingInput`. `waitingInput` is included because a running turn
can be sitting in it — `PermissionRequest` reports it and nothing reports the
approval that puts the agent back to work. `ended` is excluded absolutely: a
dead session's screen stops being repainted, so a frozen hint can outlive the
process, and no reading of a screen may outrank a process that is gone.

## Consequences

**There are now two sources of session state, and they are not equals.** The
hooks report every turn that ends on its own; this reports the one kind of
ending they are documented not to report, and it can only ever move a session
from busy to free. It cannot mark a session busy, cannot end one, and cannot
contradict a hook that did fire — the next `PreToolUse` puts a session back to
`working` regardless of what was read here.

**Both failure directions are self-correcting, and the safe one is the default.**
A miss leaves the session exactly as broken as it was before this existed. A
false `done` on a session still working is corrected by that session's next hook
event, and the worst it costs in between is a scheduled scenario firing over a
busy tile — which is what the overlap guard already tolerates for a session
between two tool calls.

**The state is identical to `Stop`'s; the notification is not.** Everything that
reads the field — the overlap guard, the card's chip, the pill, the waiting count
— gets exactly what `Stop` would have given it, and that is the point of going
through the same `setState`. The OS notification is the one thing held back: it
exists because a person may not be looking when a turn ends, and this ending
follows a key they just pressed themselves at the tile they pressed it in. A
notification is a side effect of the door, not part of the state going through it.

**It is Claude Code by construction**, like every hook in `hooks.rs` and unlike
the activity readers of ADR-0008. Another CLI's turn ends differently and prints
something else; the matcher is one anchored regex in one small module, and a
second CLI would bring its own rather than widen this one.

**It is coupled to a string in somebody else's interface.** If Claude Code stops
printing the hint, the deck goes back to the behaviour of #333 — stale `working`
after an interrupt — and nothing else breaks. The regex is anchored on the two
words that *are* the feature and tolerant of everything around them, because
what surrounds them (a spinner, a verb, an elapsed time, a token count, a
second hint behind a `·`) has already changed several times.

**`Ctrl+C` is not covered**, although it also interrupts. Pressed twice it quits
Claude Code, which reports `ended` through `SessionEnd` — and a `done` from this
path landing after that `ended` would bring a dead session back to life on the
deck. `Escape` has no second meaning to race.

## Alternatives considered

**A liveness timeout in the listener** — treat a `working` session with no hook
event and no terminal output for N seconds as no longer working. Rejected as the
primary answer: N does not exist. A turn that spends four minutes in one `Bash`
call produces no hook event and no output, and is indistinguishable at the
listener from a session interrupted four minutes ago; any N short enough to fix
#333 promptly is short enough to call a live session free. It is also strictly
less informed — the app can see the screen and the listener cannot.

It does cover one thing this does not: a crash that skips `SessionEnd`. That is
a different fault with a better answer available — the app already knows when a
PTY exits (`session://exit`) — and it is not what #333 is about.

**Report on the keystroke, without waiting for the hint to go.** Rejected: it is
the same guess with none of the evidence, and it downgrades a live session every
time `Escape` means something else to the program on the other end of the pty.

**Ask Claude Code for a hook that fires on an interrupt.** Not ours to decide,
and the deck would still need this for every version already installed. If such
a hook arrives, it belongs in `hooks.rs` and this becomes redundant — which is
the outcome this record would like.

## What would reopen this

**A hook, or any other reported event, that fires when a turn is interrupted.**
Then the mapping in `hooks.rs` is the whole answer and `src/interrupt.ts` should
be deleted rather than kept as a second opinion — see ADR-0008 on what two
sources for one number cost.

**A second CLI whose sessions the deck drives.** The hint is Claude Code's
sentence, not a general one. The shape that survives is a per-CLI predicate
beside the per-CLI hook settings, not one regex asked to match four interfaces.
