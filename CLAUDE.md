# cowork-deck

## Language

**All documentation, all tasks and all pull requests are written in English.**
So is everything else committed to this repository or filed in its GitHub
project. The only exceptions are the ones written down below; anything not on
that list is English, and the list does not grow by argument.

In full, that covers:

- **Documentation** — `README.md`, this file, and every document under `docs/`
  written or edited from 2026-07-27 onward, specs and plans included. The one
  carve-out is the pre-existing record described under "History stays as
  written" below.
- **Tasks** — GitHub issue titles and bodies, checklists, epics, and comments
  posted on them.
- **Pull requests** — titles, bodies, review comments, and replies.
- **Code** — identifiers, UI strings, log and error messages.
- **Comments and doc comments**, TypeScript and Rust alike.
- **Commit messages and branch names.**

Conversation with the user is **not** covered. Reply in whatever language the
user writes in — the rule governs artefacts that outlive the conversation, not
the conversation itself.

Writing something in another language and translating it afterwards is not the
intent: draft it in English in the first place.

### Two deliberate exceptions

Some Cyrillic in the source is a test fixture or an example, not interface text,
and must survive any future translation sweep:

- `src/placeholders.ts` and `tests/placeholders.test.ts` — the placeholder regex
  uses `\p{L}`, not `\w`, so a name like `{{ветка}}` is recognised. A prompt is
  written in whatever language its author thinks in, which the UI's language
  does not constrain.
- `src/commands.ts` and `tests/commands.test.ts` — hotkeys match on `e.code`,
  the physical key, because with a Cyrillic layout active `Cmd+K` arrives as
  `л`. An English interface does not imply a Latin keyboard layout.

Deleting either would regress a real feature. The comments explain why; keep
them intact.

### History stays as written

`docs/superpowers/plans/` and `docs/superpowers/specs/` dated before 2026-07-27
are in Russian. They record work already finished, and a translated record can
drift from what actually happened with no original left to check against. **Do
not translate them.** Anything added from 2026-07-27 onward is English.

## Branches and releases

`dev` is the trunk and the default branch: **every pull request targets `dev`.**
`main` is the released state and nothing else — what is installed on the
machines of the people using the app.

A release is a pull request from `dev` into `main`, a version bump in
`src-tauri/tauri.conf.json`, and a `v*` tag pushed on the resulting `main`
commit. `.github/workflows/release.yml` triggers on that tag rather than on any
branch, and refuses to build when the tag and the config version disagree.

Two things follow, and both are easy to get wrong:

- **A pull request against `main` is a mistake unless it is the release.**
  `gh pr create` uses the default branch, so this only goes wrong when someone
  passes `--base main` by hand.
- **`main`'s README describes the shipped app.** Documentation for something not
  yet released belongs on `dev`, and reaches `main` when the release carries it
  over.

A hotfix branches from `main` and its pull request goes to `main`; `main` is then
merged back into `dev`, or the fix is lost at the next release.

> **Note, to be deleted when v0.1.2 ships:** `main` currently carries four
> commits made after `v0.1.1` — the licence, the harness's demo take, and the
> README's install section. It becomes exactly the released state at the next tag.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tracker** (834 symbols, 2232 relationships, 64 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/tracker/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "dev"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tracker/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tracker/clusters` | All functional areas |
| `gitnexus://repo/tracker/processes` | All execution flows |
| `gitnexus://repo/tracker/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
