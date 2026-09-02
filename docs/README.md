# docs/

Four kinds of thing live here, and the reason for this file is the third one: nine
manual-check lists were reachable only by somebody already knowing they existed.

## Decisions — [`adr/`](adr/)

Architecture Decision Records, one per decision, numbered and never renumbered again after
the collision of September 2026 (`npm run adr:check` is what makes sure). This is the repo's
single home for them; nothing writes to `docs/architecture/`.

## Design — [`design/`](design/)

**[`design/true-ink/`](design/true-ink/README.md)** is the design system: the palette and its
reasoning, the tokens, the mockups, and the contrast measurements that `npm run contrast`
re-derives rather than restates. `design/slate-ember/` is its predecessor, kept because two
ADRs argue against it by name.

## Manual checks

What a test cannot see: whether the string this hangs on is the string the installed
Claude Code actually prints, whether a record survives the window closing, whether a screen
reader says the right thing. Each one is a checklist to work through in a real window, with
its result recorded in the pull request that touches the feature.

| Check | What it covers, and why a test cannot |
| --- | --- |
| [Session activity](activity-panel-manual-check.md) | The panel's numbers have to agree with the terminal above them. Everything else is in `tests/activity-panel.test.ts`. |
| [A turn ended by Escape](interrupt-manual-check.md) | The unit tests drive a fake screen and a fake keystroke; only a real `claude` prints the real string. ADR-0015. |
| [Pull request view](pr-view-manual-check.md) | Needs a running app, a real repository and a real GitHub account. |
| [Scenario run history](scenario-run-history-manual-check.md) | Whether a record is written when the window closes, what a crash leaves behind, whether the file manager opens. |
| [Session notes](session-notes-manual-check.md) | The write path costs money on a real account; the suite runs against a closure instead. |
| [Session names and rename](session-rename-manual-check.md) | Needs a running app, a real `claude` and a screen reader. |
| [Memory sync](sync-manual-check.md) | Every interesting failure needs two machines on one GitHub account. |
| [Escape, zoom and the terminal](terminal-escape-manual-check.md) | jsdom has no pty, so neither half of the key's ownership is reachable. |
| [The status-area panel and the dock badge](tray-manual-check.md) | What the panel says is unit-tested; where the OS puts it, and what it tints, is not. |

## Agent contracts — [`agents/`](agents/)

How the skills consume this repo: [`issue-tracker.md`](agents/issue-tracker.md) (issues live in
GitHub, driven by `gh`), [`triage-labels.md`](agents/triage-labels.md) (the five canonical
triage roles), [`domain.md`](agents/domain.md) (single-context: one `CONTEXT.md` and one
`docs/adr/`).

## Images — [`images/`](images/README.md)

The README's screenshots, shot from [`harness/`](../harness) — the app with its backend
replaced by fixtures, so a re-shoot is a re-shoot and nobody's paths are published.
