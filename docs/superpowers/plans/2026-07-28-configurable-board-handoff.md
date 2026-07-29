# Configurable Board — execution handoff

Execution of `2026-07-28-configurable-board.md` stopped after Task 4, at the
user's request, to be resumed from another machine. This file exists because the
plan alone is not enough to resume: the SDD workspace holding the ledger, the
task briefs and the implementer reports lives under `.superpowers/`, which is
git-ignored, so none of it travels. Everything below is what a fresh session
needs and cannot reconstruct.

**Branch:** `worktree-feat-issue-tracker`, pushed through `7219f88`.
**Spec:** `docs/superpowers/specs/2026-07-28-configurable-board-design.md`.
**Plan:** `docs/superpowers/plans/2026-07-28-configurable-board.md` — already
corrected in place where execution proved it wrong; see "Plan corrections" below.

## Where things stand

| Task | State | Commits |
| --- | --- | --- |
| 1 — the view switch | done, and twice repaired later | `a422b01..bb9bcfb`, plus `de5bb87` and `7219f88` |
| 2 — `BoardConfig` | done after 2 fix rounds | `bb9bcfb..b8f6dce` |
| 3 — `board.json` on disk | done, review clean first time | `b8f6dce..8904ae6` |
| 4 — `StepId`/`KindId` replace the enums | done; task review was still running when we stopped | `8904ae6..7219f88` |
| 5 — `task_update` | **not started.** Brief was generated and discarded with the workspace | — |
| 6–11 | not started | — |

**Gates at `7219f88`,** all verified by the controller rather than taken from a
report:

- `cd src-tauri && cargo test` — 188 passing
- `cd src-tauri && cargo clippy --all-targets` — exactly 6 warnings (4 ×
  `std::io::Error::other`, 2 × `too_many_arguments`). This is the ceiling; never
  more.
- `npx vitest run` — 257 passing, 35 files
- `npx tsc --noEmit` — clean. It was **not** clean for tasks 1–3; see below.

## Task 5 has not begun. What it still has to build

Verified against the tree at `7219f88`, so a resuming session need not re-check:

- `frontmatter::set_fields` is still **private** (`frontmatter.rs:162`). Task 5
  makes it `pub` in place, with the "values must be single-line" obligation added
  to the doc comment it already has. Do not wrap it in a forwarding function —
  the plan originally said `set_fields_pub` and that was corrected before
  execution.
- `frontmatter::replace_body` — does not exist.
- `TaskPatch` and `TaskProvider::update` — do not exist.
- `TaskError::UnknownStep` / `UnknownKind` — do not exist.
- `updateTask` in `src/ipc.ts` — does not exist.
- `frontmatter::set_step(text, step, resolved_ts: Option<&str>)` **does** exist
  (`frontmatter.rs:145`), built by Task 4. Task 5 builds on it rather than
  replacing it.

## Plan corrections already applied

The plan file on disk is the corrected one. These are recorded so nobody
"restores" them:

- Task 2's test count: the prose said 17 while its own code block held 18. One
  test folded two validation rules into one function against the principle stated
  two lines above it; it is now split, and Task 2's expectation reads 19.
- Task 3's counts follow from that: `cargo test board::` = 28, full = 175.
- Tasks 4 and 5 no longer assert absolute test totals. They were guesses. The
  gate is now an accounted delta: everything passes, the clippy count has not
  moved, and any test that disappeared is named with a reason.
- `set_fields` becomes `pub` in place rather than gaining a forwarding wrapper.

## Rulings issued during Task 4 that override the brief

Task 4 is finished, so these matter as history and as precedent — but two of them
constrain later tasks:

1. **`tasks_open_counts` uses `!board.is_terminal(&c.status)`.** "Open" means "not
   closed". Any later code counting open cards must do the same.
2. **`taskPrompt` takes its configuration from the card's own workspace**, via
   `taskCapabilities(target.id)`, not from the active one — `launchFromTask`
   exists precisely for the cross-project case. When the configuration has no
   steps the steps line is omitted rather than printed empty. **Task 11 touches
   `taskPrompt` again and must preserve this.**
3. `tests/task-form.test.ts` expects the **first configured kind** (`bug` in the
   default configuration), not `task`. With a configurable kind list there is no
   privileged default, and special-casing one would put a kind id in control flow.
4. `FsTaskProvider::new` skips loading when the root is not a directory, returning
   the default configuration with `board_error: None`. Otherwise a freshly
   configured external root reports a failure about a file nobody touched —
   `board_error` becomes a user-visible banner in Task 9.
5. The single existing value-damage test in `frontmatter.rs` was **kept**, not
   deleted; only its status assertion inverted. It uniquely covers the
   title→filename fallback.
6. `board.ts`'s ✓ gate uses `!isTerminal(cfg, t.status)`. The `status === "open"`
   comparison against `derivedStatus`'s return value is not a step id and stays.
7. The temp-litter test in `fs.rs` filters `board::BOARD_FILE` by the constant.

## Two defects Task 1 left behind, both fixed inside Task 4

Worth reading before trusting any gate in this plan.

**The `tsc` gate was dead for three tasks.** Task 1's test imported `node:fs`,
`node:url` and `node:path`; `@types/node` is not installed and `tsconfig.json`
narrows `types`, so `npx tsc --noEmit` failed with three TS2307 errors from
`bb9bcfb` onward. The plan named `tsc` as a gate and the controller never ran it
after Task 1, taking the implementer's report on trust. Fixed in `de5bb87`
without adding a dependency: `tsconfig.json` gains `"vite/client"`, the test
reads the stylesheet as `import styles from "../src/styles.css?raw"`, and
`vite.config.ts` gains `test: { css: true }` — **that last line is load-bearing**,
because vitest stubs CSS imports by default and without it `?raw` yields an empty
string and the test passes vacuously.

**The regression test could not fail.** jsdom's `getComputedStyle` applies a
grouped selector list's highest specificity to every selector in the group.
`styles.css` grouped `#board.hidden, .tk-hidden`, so `.tk-hidden` inherited
`#board.hidden`'s weight and beat `#deck` even without the `#deck.tk-hidden`
override — the test passed against the very bug it existed to catch. Fixed in
`7219f88` by ungrouping the two rules, which is behaviour-identical in a browser
because browsers score each selector in a group on its own. The split carries a
comment explaining why it must stay split. Verified by reverting: with
`#deck.tk-hidden` removed the test fails `expected 'grid' to be 'none'`; restored,
5/5 pass.

## Process lessons that should shape tasks 5–11

- **Test any regression guard by reverting the fix.** Task 1's reviewer called two
  tests "load-bearing" by reading the code; one of them could not fail. Reading
  cannot answer "would this fail against the broken code" — only reverting can.
  Ask for this explicitly in review prompts.
- **Require captured output, never retyped.** Task 2's implementer twice put
  text in its report that resembled command output but was not: first a
  paraphrase, then rustc-shaped text with two invented line/column citations. Each
  cost a full fix round. Redirect to a file and read that file as the controller.
  Tell implementers that "I could not capture this" is a correct, cost-free
  answer and that inventing output is not.
- **Verify liveness, don't wait on notifications.** One implementer died
  mid-task without committing or reporting; several agents went idle without
  delivering their report; two messages crossed in transit and were read as
  repeats. Check files, `git log` and process state after every step. Have
  reviewers write their report to a file rather than returning it in a message.
- **A pre-flight survey pays for itself on large tasks.** Task 4's implementer
  found six collisions with its brief before writing code; five were the plan
  being wrong about the code. One message saved five fix rounds.
- **Cheap models transcribe fine and report badly.** Task 2 on the cheapest tier
  cost two fix rounds, neither about the code. Tasks 3 onward used a mid tier and
  Task 3 passed review first time.

## Deferred minor findings, for the final whole-branch review

None of these blocked a task; the final review should triage them.

- Task 1: two of the five view-switch tests exercise `applyView`'s un-toggling
  rather than the cascade, so they would pass without `#deck.tk-hidden`.
- Task 2: the duplicate-id scan is written out twice, once for steps and once for
  kinds; `board.rs` has no module-level `//!` doc comment; a comment says "the
  cases it does not exercise" where the plan said "the four cases".
- Task 3: `MigrationPlan`'s "one shared old root" is a documented precondition,
  not a type-level invariant — worth an assertion if a second producer ever
  appears. An error string repeats the filename. `Loaded` lacks `Debug`/`Clone`.
- Task 4: no RED-phase TDD evidence exists for the bulk of the work, because the
  implementer that wrote it died before reporting. Its correctness rests on the
  green suite and on review, not on TDD evidence. This is stated rather than
  papered over.

## Resuming

1. Re-read the plan's Task 5 section; it is corrected and authoritative.
2. Recreate the SDD workspace — `scripts/sdd-workspace` under the
   `superpowers:subagent-driven-development` skill — and start a fresh ledger.
   The old one is gone with the ignored directory; this file replaces it.
3. Record `BASE=7219f88` before dispatching Task 5.
4. `git push` on this repository needs a scoped token, because the active `gh`
   account is an EMU that cannot write to `followLemmi`:

   ```bash
   export GH_TOKEN=$(gh auth token --user followLemmi)
   git -c credential.helper='!f() { echo username=followLemmi; echo password=$GH_TOKEN; }; f' push
   ```

5. Task 4's review came back **Approved** after the handoff was first written.
   Two outcomes are already folded into the plan and need no further action:

   - Its one Important finding was branch-level, not a Task 4 defect:
     `boardError` crosses the IPC boundary and nothing reads it, and the
     fallback it exists to explain silently mis-classifies cards. With a broken
     `board.json` in a project whose terminal step is `shipped`, the default
     two-step fallback makes `shipped` non-terminal — every closed card
     reappears in the open column with ✓ offered, and the sidebar counts them as
     open. The board looks plausible and is wrong. **The banner therefore moved
     from Task 9 to Task 6**, which rewrites that rendering anyway; Task 9's old
     step is kept as a marker so the move is traceable.
   - Its one ⚠️ was about ruling 4: `taskPrompt` prints no steps line at all.
     That is correct — the steps line belongs to **Task 11**, not Task 4. The
     ruling ("omit the line when there are no steps") constrains Task 11, and
     the reviewer had no way to know that from a Task 4 diff.

   The review also confirmed all seven rulings followed, no step-id literal
   surviving in control flow, `BOARD_FILE` never spelled as a path, and no test
   in the diff that cannot fail — the last from reading, not reverting, which it
   labelled as such.

## GitHub

Epic #98; sub-issues #87–#97, one per plan task. #87–#90 are the finished tasks
1–4 and can be closed once Task 4's review is settled. #91 is Task 5.
