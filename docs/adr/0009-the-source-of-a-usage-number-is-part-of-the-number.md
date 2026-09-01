---
status: Accepted (amended 2026-09-01 — see "Amendment: the row and the dialog say
  different things")
date: 2026-08-27
deciders:
  - evgenykharetski
---

# ADR-0009 — The source of a usage number is part of the number

> Numbered 0009, not 0003. The issue that commissioned this record (#307) called
> it ADR-0003; that number was taken by *Memory is a ported indexer in a sidecar*
> before this epic was written. It was then drafted as 0007, and 0007 and 0008
> were both claimed on `dev` while this branch was in flight — by the sync
> identity record and by the activity epic. The content is the one #307 asked
> for; only the number moved, twice, which is what a monotonic counter on a shared
> trunk does to a long branch.

## Context

The deck runs many `claude` sessions at once and they all draw on one budget.
When it runs out they stall together, and before this work the app had nothing to
say about it: the rails sat still, and the only way to learn that nothing would
move until 19:00 was to open a session and type `/usage`. For a window whose
premise is "twelve sessions read in one sweep", the shared ceiling above all of
them was the one piece of state that was missing.

There is more than one way to know such a number, and they are not equally good.
The account's own accounting knows what *the account* has spent, across every
machine and every terminal. What this app can count from the transcripts of its
own sessions is real, and narrower — subagents in other terminals, other
machines, and anything run outside the deck are not in it. A number from the
second source and a number from the first can differ by a factor of three on a
person who also uses Claude in a browser.

Printing them in the same typeface with no label is therefore not a cosmetic
question. It is the difference between a screen a person can act on and a screen
that quietly misleads them about how much runway they have.

## Decision

### 1. The tier is part of the number, and it is always on screen

Three tiers, and every window carries exactly one:

- **Reported** — the account's own accounting. What `/usage` draws.
- **Observed** — what the deck can see for itself, from the sessions it runs.
- **Estimated / Unknown** — it says so, and offers the action that would answer
  it.

On screen means on screen: beside the number, in the same size, in the sidebar row
and again in the dialog. Not a tooltip, not a title attribute, not a commit
message. Two numbers that look alike and mean different things are worse than one
number and a blank.

> **Amended.** The clause about the ROW — every tier, in the tier's own name —
> did not survive contact and is narrowed at the foot of this record. The rule
> above still holds for the dialog, and the *purpose* of the rule still holds
> everywhere. Read the amendment before changing anything here.

Three rules fall out of this and are enforced in code rather than left to
judgement:

- **`Unknown` is never a zero.** A provider that cannot answer produces a window
  per declared limit, each saying it does not know. Drawing `0%` would be a claim.
- **A snapshot's tier is the weakest of its windows'**, never the strongest, so a
  snapshot cannot advertise a tier one of its own numbers has not earned
  (`AiUsage::from_windows`).
- **No share, no meter.** The rolling burn the deck counts for itself is a
  numerator with no denominator — nothing in the app knows the ceiling — so it is
  shown as an absolute with the caveat in words, and no bar is drawn. Dividing by
  a guessed ceiling would make an estimate wear an observed label, which is the
  one thing this record forbids.

### 2. ADR-0001's invariant is **not** narrowed

This was the open question when the epic was written, and the answer turned out
to be better than the question assumed.

ADR-0001 left the rule as *the app does not store what another credential manager
can hold for it*. The concern was that reading Claude Code's OAuth credential
would be one step further from the original case: `gh` is a credential manager by
design, whereas Claude Code merely happens to hold a token.

That step is not taken. The reported source is obtained by asking the program
that holds the credential, exactly as `gh.rs:199` asks `gh`:

```
claude --settings '{"hooks":{}}' -p "/usage" --output-format json
```

Measured on `claude` 2.1.247: non-interactive, `total_cost_usd: 0` with zero input
and output tokens (`/usage` never reaches a model), about four seconds, no trust
prompt even in a freshly created directory. `--settings '{"hooks":{}}'` keeps the
probe from firing the person's own hooks.

So the invariant stands unchanged and is now stronger in practice: the app
neither stores **nor reads** what another credential manager holds for it.

Two surfaces were investigated and are deliberately unused. Both are recorded
because they are the obvious next ideas:

- **`GET /api/oauth/usage`** — what `/usage` reads, with the OAuth credential from
  `~/.claude/.credentials.json` (present on Linux, Keychain item
  `Claude Code-credentials` on macOS). Established by reading the shipped
  binary's own strings; **never called**. It buys a slightly richer window list —
  `seven_day_opus`, model-scoped weeks — for a permanent obligation to an
  undocumented endpoint and somebody else's token. The subprocess gets the same
  numbers with neither.
- **Claude Code's statusline payload**, which carries
  `rate_limits.five_hour.{used_percentage,resets_at}` and `.seven_day` through the
  same `--settings` mechanism this app already uses for hooks. Rejected on one
  ground: the statusline is a user-facing feature the person may already be
  using, and `--settings` is the highest-precedence layer, so installing ours
  would silently replace theirs inside deck sessions. Kept on record as the
  fallback that does not involve a credential, should the `-p "/usage"` text
  surface break.

### 3. The degradation rule

The reported source's answer is **prose**. `Current session: 23% used · resets
Aug 27, 4pm (Europe/Minsk)` is one rename away from unparseable, and a Claude Code
version bump can do it at any time.

When that happens — or when the person switches the reported source off, or is on
an API key, Bedrock, Vertex, a gateway, or is logged out — the app:

1. **keeps the block on screen**;
2. falls back to **Observed**;
3. **names the fallback**, per decision 1.

It never blanks the block and never presents the observed figure as the account's.
This is the same shape as ADR-0001's declared fallback, for the same reason: a
silent downgrade is worse than no fallback, because the person cannot weigh a risk
they were not told about. The parser is conservative by construction and the
degradation is tested before the caller — an unrecognised line yields no window
rather than a zero.

The same rule governs the observed source's own weaker signal. A limit banner read
off a PTY is matched against specific phrasings and an explicit list of the twelve
other things Claude Code calls a "limit reached" — a context limit, a subagent
limit, a spend limit. **Preferring not to match is the policy**: a false positive
sends somebody away from a working deck, a miss does not. A reset time that does
not parse is reported as absent rather than guessed, and a window known to be
spent with no known reset is a legitimate state.

Because a parser can still be wrong, the dialog carries a way to clear the
refusals the app recorded. An app insisting the budget is spent while sessions are
plainly running would be worse than one that never said so.

### 4. The reported source sits behind a switch, default on

Asking costs no quota and no credential, but it does start a short-lived `claude`
process every five minutes for as long as the app is open. That is a thing a
person may reasonably refuse. `ui_state.usageReported` is the switch, it defaults
to on, and switching it off leaves the block on screen on Observed — decision 3,
not a blank.

### 5. What is deliberately not attempted

Recorded so it is not re-litigated every six months:

- **Money.** Cost in dollars is a different question with a different audience.
  Mixing a spend figure into a screen about "can I keep working" makes both harder
  to read.
- **Throttling.** The deck reports a ceiling; it does not refuse to start a
  session near one. Enforcement is a policy decision nobody has asked for.
- **Organisation-wide reporting** (Anthropic's Admin API usage and cost reports).
  That serves an org owner, not the person at this deck, and needs a different
  credential class entirely.
- **Pausing scheduled scenarios when a window is nearly spent.** The most
  interesting thing this data unlocks, and it depends on everything here while
  nothing here depends on it. Its own epic.

## Consequences

- Every provider declares its windows before it is asked about them, so a window
  a provider stops reporting reads as "we do not know about that one" rather than
  vanishing, and a window it starts reporting cannot quietly grow a row.
- The UI can draw a provider it has never heard of. The label, the window names,
  the caveats and the command that would answer an unknown row all travel inside
  the snapshot, so `src/` contains no provider's name. Adding Gemini CLI (#308)
  changed one file, three lines of the registry, and nothing in `src/`.
- A person reading a percentage has to read a word beside it to know what it
  means. That is a real cost in glanceability, accepted knowingly: the
  alternative is a number that is sometimes three times wrong with nothing on
  screen to say which time this is.
- The reported source depends on a text surface owned by another program. This
  will break. Decision 3 is what makes the breakage a degradation rather than an
  outage, and the tests for it exist before the caller.
- Nothing here reports money, and a future decision to do so has to argue with
  decision 5 rather than around it.

## Amendment: the row and the dialog say different things

*2026-09-01, prompted by #393 and decided by this record's own author.*

### What happened

The status-area panel (ADR-0011) draws the deck's limits block, so a row of it
appeared in a 340-pixel window in a menu bar:

```
Claude  REPORTED  29% used
```

The person who wrote this record read that and asked **what the word meant.**

That is not a small usability report. If the author of the rule cannot read the
label the rule mandates, the label is not carrying the meaning — it is carrying
the *name of a category defined in this document*, which is a different thing and
is only legible to somebody who has read this document.

### What was actually being protected

The failure this record exists to prevent runs in **one direction**: this app's
own narrower count — what it saw in its own sessions — being read as the
account's figure, and someone believing they have three times the runway they do.

The other direction costs nothing. Reading the account's own figure as though it
were this app's own count makes a person *more* conservative, not less.

That asymmetry was never used. Decision 1 labelled all four tiers equally, and
three quarters of the labelling was spent on the case that cannot mislead.

### The narrowing

**A row prints a qualifier when there is something to qualify, and nothing when
there is not.** `tierNote` in `src/usage.ts`:

| Tier | A row says | Why |
|---|---|---|
| `reported` | *nothing* | An unqualified number is the account's own figure — which is what a person assumes anyway. |
| `observed` | "this app only" | The direction that misleads, stopped in words a person can act on. |
| `estimated` | "estimate" | Same. |
| `unknown` | *nothing* | `readingOf` has already printed "no reading". Two ways of saying nothing read as two facts — the rule `limitFoot` keeps about an absent reset. |

Two consequences, both deliberate:

- **The tier's NAME leaves the row and stays in the dialog.** "Observed" is what
  the tier is called; "this app only" is what it means. A dialog is where a
  vocabulary is taught, next to `sourceExplanation`, and a row is not. Every
  window in the dialog still carries its tier by name, including `Reported`.
- **The qualifier moves after the reading.** It qualifies the number, so it
  follows it. Before, it sat between the provider's name and the number and
  interrupted the one thing the row is for.

### Why this is not decision 1 being abandoned

The rejected alternative below — *"one number, best available, unlabelled"* —
remains rejected, and this is not it. Under that alternative a reported 23% and
an observed 23% are indistinguishable. Under this amendment they are not: one
carries a caveat and the other does not, and the reader's default reading of an
unqualified number is the correct one.

What is given up is the ability to tell "the account's own figure" from "this app
forgot to label the row" by looking at the row alone. That is a real loss and a
small one: the dialog answers it in one click, and every path that produces a
reading also produces its tier (`AiUsage::from_windows`), so a missing label is
not a state the model can reach.

### The rule that replaces it

**Print the tier where it changes what a person would do.** That is what decision
1 meant; "always, everywhere, by name" was a proxy for it, and the proxy is what
broke.

## Alternatives considered

- **Wait for a documented API and ship nothing until then.** A screen that waits
  for the reported number ships nothing; one built on what the deck can already
  see ships now and gets more accurate later. This is why the observed source
  landed first (#303) and the reported one was a spike (#306).
- **One number, best available, unlabelled.** Simpler to read and the reason this
  record exists. It makes a reported 23% and an observed 23% — which can mean
  wildly different amounts of remaining runway — indistinguishable. Still
  rejected after the amendment above, which is a different proposal: there, one
  of the two carries a caveat.
- **Keeping the tier's name in the row and only making it quieter** — smaller
  type, a lighter grey. Considered and rejected during the amendment: the
  complaint was not that the word was loud, it was that it did not mean anything
  to the person reading it. A quieter word nobody understands is a word nobody
  understands.
- **Borrow the OAuth credential and call `/api/oauth/usage`.** Richer, and
  discussed under decision 2. Rejected because a subprocess gets the same numbers
  without narrowing ADR-0001's invariant or depending on an undocumented endpoint.
- **Install our own statusline command to receive `rate_limits`.** Cheapest of
  all and needs no credential. Rejected under decision 2: it would replace a
  user-facing feature the person may already be using.
- **Infer a ceiling and draw a meter from the observed burn.** Would give every
  window a bar and make the screen look complete. It would also be an estimate
  presented as an observation, which decision 1 forbids.
