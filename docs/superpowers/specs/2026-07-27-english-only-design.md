# English-only: design

The app's interface, comments and issue tracker are in Russian; its README, commit
messages and recent pull requests are in English. This makes the project's language
a coin flip that every contributor — human or agent — has to guess at. This change
settles it: English everywhere, and a written rule so it stays that way.

## Scope

In:

- User-facing UI strings (`src/*.ts`, `src/styles.css`) and the Rust string that
  reaches the user (`src-tauri/src/scheduler.rs`).
- Code comments and docstrings, TypeScript and Rust alike.
- Tests that assert on those strings — changed in the same commit as the strings.
- `README.md`, including the note announcing that the UI is in Russian.
- A new `CLAUDE.md` stating the language policy.
- All 36 open issues on GitHub (#24–#62): titles and bodies. Every open issue is
  in Russian.

Out:

- `docs/superpowers/plans/` and `docs/superpowers/specs/` written before this
  change (~1700 lines). They are a record of work already done, not documentation
  anybody reads to use or build the app. Translating them costs the most and
  returns the least, and a translated record can drift from what actually happened
  with no original left to check against. They stay in Russian, untouched — not
  even a marker line, so the record stays exactly as it was written. `CLAUDE.md`
  explains why, which is where somebody would look anyway.
- Merged pull requests and existing commit messages. History is immutable.

## What must not change

Two places handle Cyrillic as *behaviour*. A translation pass that treats them as
text would regress a feature:

- `src/placeholders.ts` — the placeholder regex is `[\p{L}\p{N}_-]`, not `\w`,
  so `{{ветка}}` is parsed and offered as a field. Users write prompts for Claude
  in whatever language they think in; the app's own language does not constrain
  that. Regex unchanged; only its comment's justification is rewritten, since the
  current one reasons from "the interface is Russian".
- `src/commands.ts` — hotkeys match on `e.code` (the physical key), not `e.key`,
  because with a Cyrillic layout active `Cmd+K` arrives as `л`. An English UI does
  not imply a Latin keyboard layout. Matching unchanged; comment rewritten.

## Approach

Replace each Russian literal with English at its site. No `strings.ts`, no i18n
layer.

The alternative — a central strings module keyed by identifier — was rejected. The
goal is to be English, not to be localisable; an i18n layer would add indirection
at ~180 call sites to serve a second locale nobody asked for. The codebase is
deliberately framework-free and direct, and this keeps it that way.

Russian pluralisation disappears as a consequence, which is a simplification rather
than a loss:

- `src/pill-util.ts` picks `ждёт` vs `ждут` by the `n % 10 === 1 && n % 100 !== 11`
  rule. English needs no verb agreement here: `1 waiting for input`,
  `3 waiting for input`. The helper collapses to interpolation.
- `src/workspaces.ts` picks `сценарий` / `сценария` / `сценариев` by count. English
  needs `scenario` / `scenarios`.

## String decisions

Tile state labels. The keys in the code are unchanged; only the labels are:

| key            | was        | now            |
|----------------|------------|----------------|
| `idle`         | готов      | `idle`         |
| `working`      | работает   | `working`      |
| `waitingInput` | ждёт ввода | `needs input`  |
| `done`         | доделал    | `done`         |
| `ended`        | завершён   | `exited`       |
| `error`        | ошибка     | `error`        |

`ended` becomes `exited` rather than `ended`. `done` and `ended` describe genuinely
different things — the agent finished its turn and the prompt is free, versus the
process is gone — and as adjacent labels in a list the two English words read as
near-synonyms. `exited` names the process event and keeps the pair distinct.

The rest is mechanical:

- Weekdays `Sun Mon Tue Wed Thu Fri Sat`, index 0 = Sunday, matching the existing
  `Date.getDay()` indexing.
- `сегодня` / `вчера` / `завтра` → `today` / `yesterday` / `tomorrow`.
- `каждый час в :05` → `hourly at :05`; `ежедневно 09:00` → `daily at 09:00`;
  `еженедельно пн 09:00` → `weekly on Mon at 09:00`.
- Guillemets `«»` → curly quotes `“”`.
- Vocabulary follows the README, which already settled it: workspace, scenario,
  session.

## The rule

A new `CLAUDE.md` at the repository root, holding the language policy and nothing
else. The project has no `CLAUDE.md` today, so this creates one rather than
extending it.

It states: code, comments, commit messages, pull requests, issues, and new specs
and plans are written in English. Conversation with the user is not — that stays in
whatever language the user writes in. It notes that documents under
`docs/superpowers/` predating this change are in Russian by design and are not to
be translated.

## Commits

One worktree, `worktree-chore-english-only`. Commits split by concern so each is
reviewable on its own:

1. UI strings and the tests asserting on them — together, or the branch is red.
2. Comments and docstrings.
3. Rust: the scheduler's user-facing error, the `store.rs` fixture, the `model.rs`
   comment.
4. `README.md` and the new `CLAUDE.md`.

GitHub issues are edited separately via `gh issue edit`; they are not in git and do
not belong to any commit.

## Verification

- `npm test` — 30 files, 190 tests, all passing on this branch before any change.
- `cargo test` in `src-tauri` — 44 tests, likewise green. It needs the reporter
  sidecar staged first (`npm run stage:reporter`), otherwise `tauri-build` fails
  the build on a missing `externalBin` resource.
- A grep gate proving the job is finished:
  `git ls-files | xargs grep -lP '[\x{0400}-\x{04FF}]'` must return only paths under
  `docs/superpowers/`.
- `gh issue list` must show no Cyrillic in open issue titles.
